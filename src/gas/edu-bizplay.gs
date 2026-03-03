/**
 * Bizplay 연동 모듈
 * - SSO 로그인 (bizplay → weAuth → approval gate)
 * - 교육 신청서 임시저장
 *
 * code.gs의 doGet에서 호출:
 *   handleBizplayLogin(adminRow, e)
 *   handleBizplayDraft(adminRow, e)
 *   handleBizplayApprLine(adminRow, e)
 *
 * 공유 의존: createResponse() (code.gs), ADMIN_COL (code.gs)
 */

/* ═══════════════ 상수 ═══════════════ */

/** GAS 기본 UA가 앱 설치 페이지를 유발하므로 브라우저 UA 사용 */
var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Approval SSO 세션 재사용 허용 시간 (초) */
var APPROVAL_SSO_TTL = 1800; // 30분

/* ═══════════════ Approval SSO 공통 헬퍼 ═══════════════ */

/**
 * 세션에 저장된 approval 쿠키 재사용 or PW로 fresh SSO
 * PW 없어도 세션이 살아있으면 재사용 시도
 * @returns {{ sso, session, error? }}
 */
function _getApprovalSso(session, adminRow) {
  var ssoAge = session.approvalSsoTime
    ? (new Date().getTime() - new Date(session.approvalSsoTime).getTime()) / 1000
    : 9999;

  // 1) 세션 재사용 (TTL 이내)
  if (ssoAge < APPROVAL_SSO_TTL && session.approvalCookies) {
    return {
      sso: {
        approvalCookies: session.approvalCookies,
        bizplayCookies: session.bizplayCookies,
        userName: session.userName,
        useInttId: session.useInttId,
        deptCd: session.deptCd || '',
        deptNm: session.deptNm || '',
        deptShort: session.deptShort || '',
        formFields: session.formFields || {},
        debug: { reusedSession: true, ssoAge: Math.round(ssoAge) }
      },
      session: session
    };
  }

  // 2) Fresh SSO (PW 필요)
  var encPw = adminRow[7];
  if (!encPw || !String(encPw).trim()) {
    // 만료된 세션이라도 한번 시도해볼 수 있도록
    if (session.approvalCookies) {
      return {
        sso: {
          approvalCookies: session.approvalCookies,
          bizplayCookies: session.bizplayCookies,
          userName: session.userName,
          useInttId: session.useInttId,
          deptCd: session.deptCd || '',
          deptNm: session.deptNm || '',
          deptShort: session.deptShort || '',
          formFields: session.formFields || {},
          debug: { reusedExpired: true, ssoAge: Math.round(ssoAge) }
        },
        session: session,
        noPw: true  // PW 없음 표시 — 실패 시 안내 메시지용
      };
    }
    return { error: 'NO_PASSWORD' };
  }

  var bizPwd = _decryptPw(String(encPw));
  var sso = _approvalSsoOnly(session.userId, bizPwd);
  return { sso: sso, session: session };
}

/**
 * SSO 실패 시 PW로 재시도 (fresh SSO)
 * @returns {object|null} 성공 시 sso 객체, PW 없으면 null
 */
function _retryApprovalSso(session, adminRow) {
  var encPw = adminRow[7];
  if (!encPw || !String(encPw).trim()) return null;
  var bizPwd = _decryptPw(String(encPw));
  return _approvalSsoOnly(session.userId, bizPwd);
}

/**
 * SSO 후 세션 업데이트 + 저장
 */
function _saveApprovalSession(propKey, session, sso) {
  session.approvalCookies = sso.approvalCookies;
  session.bizplayCookies = sso.bizplayCookies;
  if (sso.deptCd) session.deptCd = sso.deptCd;
  if (sso.deptNm) session.deptNm = sso.deptNm;
  if (sso.deptShort) session.deptShort = sso.deptShort;
  if (sso.useInttId) session.useInttId = sso.useInttId;
  if (sso.formFields) session.formFields = sso.formFields;
  session.approvalSsoTime = new Date().toISOString();
  session.loginTime = session.approvalSsoTime;
  PropertiesService.getScriptProperties().setProperty(propKey, JSON.stringify(session));
}

/* ═══════════════ 쿠키 헬퍼 ═══════════════ */

/**
 * Set-Cookie 헤더에서 key=value 쿠키 문자열 추출
 * GAS getAllHeaders()는 헤더 키 대소문자가 서버마다 다를 수 있음
 */
function extractCookies(response) {
  const headers = response.getAllHeaders();
  let raw = null;
  for (const key in headers) {
    if (key.toLowerCase() === 'set-cookie') { raw = headers[key]; break; }
  }
  if (!raw) return '';
  const cookies = (Array.isArray(raw) ? raw : [String(raw)]);
  return cookies.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

/**
 * 기존 쿠키 문자열에 새 쿠키를 병합 (같은 키는 덮어쓰기)
 */
function mergeCookies(existing, newCookies) {
  const map = {};
  (existing || '').split(';').forEach(p => {
    const kv = p.trim();
    if (!kv) return;
    const eq = kv.indexOf('=');
    if (eq > 0) map[kv.substring(0, eq)] = kv;
  });
  (newCookies || '').split(';').forEach(p => {
    const kv = p.trim();
    if (!kv) return;
    const eq = kv.indexOf('=');
    if (eq > 0) map[kv.substring(0, eq)] = kv;
  });
  return Object.values(map).join('; ');
}

/**
 * 리다이렉트를 수동으로 따라가며 쿠키를 누적하는 fetch 헬퍼
 */
function fetchWithCookies(url, cookies, options) {
  options = options || {};
  let currentUrl = url;
  let currentCookies = cookies || '';
  let maxRedirects = options.maxRedirects || 8;
  let resp;

  while (maxRedirects-- > 0) {
    const fetchOpts = {
      method: options.method || 'get',
      headers: Object.assign({ 'User-Agent': BROWSER_UA }, options.headers || {}, { 'Cookie': currentCookies }),
      followRedirects: false,
      muteHttpExceptions: true
    };
    if (options.contentType) fetchOpts.contentType = options.contentType;
    if (options.payload) fetchOpts.payload = options.payload;

    resp = UrlFetchApp.fetch(currentUrl, fetchOpts);
    currentCookies = mergeCookies(currentCookies, extractCookies(resp));

    const code = resp.getResponseCode();
    if (code >= 300 && code < 400) {
      let loc = '';
      const respHeaders = resp.getAllHeaders();
      for (const key in respHeaders) {
        if (key.toLowerCase() === 'location') { loc = respHeaders[key]; break; }
      }
      if (!loc) break;
      if (loc.startsWith('http://') || loc.startsWith('https://')) {
        // 절대 URL — 그대로 사용
      } else if (loc.startsWith('/')) {
        // 절대 경로 — origin 붙이기
        const m = currentUrl.match(/^(https?:\/\/[^\/]+)/);
        loc = (m ? m[1] : '') + loc;
      } else {
        // 상대 경로 — 현재 URL의 디렉토리 기준으로 해석
        const base = currentUrl.replace(/[?#].*$/, '').replace(/\/[^\/]*$/, '/');
        loc = base + loc;
      }
      currentUrl = loc;
      // POST 후 리다이렉트는 GET으로 전환
      options = Object.assign({}, options, { method: 'get', payload: undefined, contentType: undefined });
    } else {
      break;
    }
  }

  return { response: resp, cookies: currentCookies, body: resp.getContentText() };
}

/* ═══════════════ Bizplay 로그인 코어 (재활용 가능) ═══════════════ */

/**
 * Bizplay 로그인 → webank SSO 코어 로직
 * @param {string} userId - Bizplay 사용자 ID (email 형태)
 * @param {string} password - Bizplay 비밀번호
 * @returns {{ error, bizplayCookies, webankCookies, approvalCookies, userName, useInttId, deptCd, deptNm, deptShort, debug }}
 */
function _bizplayLoginCore(userId, password) {
  var loginPayload = '_JSON_=' + encodeURIComponent(JSON.stringify({
    USER_ID: userId, PWD: password,
    CAPTCHA_VALUE: '', LNK_ID: '', LNK_INTT: '', LOGIN_SAVE: 'N',
    USER_OS: 'win10.0', USER_BR: 'Chrome', USER_BR_VER: '145.0.0.0',
    TMPR_CD2: '', TMPR_CD3: '', LNGG_DSNC: 'DF', '_LODING_BAR_YN_': 'Y'
  }));

  var debug = {};

  // Step 1: POST bizplay 로그인
  var loginResp = UrlFetchApp.fetch('https://www.bizplay.co.kr/login_proc_01.jct', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    headers: { 'User-Agent': BROWSER_UA },
    payload: loginPayload,
    followRedirects: false,
    muteHttpExceptions: true
  });

  var body = JSON.parse(loginResp.getContentText());
  if (body.RSLT_CD !== '0000') {
    return { error: body.RSLT_MSG || '로그인 실패', debug: debug };
  }

  var bizplayCookies = extractCookies(loginResp);
  debug.loginCookieLen = bizplayCookies.length;
  debug.loginBodyKeys = Object.keys(body).join(',');
  debug.loginDept = { DVSN_CD: body.DVSN_CD, CMPN_ORGA_CD: body.CMPN_ORGA_CD, BSUN_CD: body.BSUN_CD, JBCL_DSNC: body.JBCL_DSNC, USR_CD_ID: body.USR_CD_ID, USER_DSNC: body.USER_DSNC };

  var authVal = JSON.stringify({
    SVC_PTRN: 'M', APP_TARG: 'Y',
    RSVD1: '', RSVD2: '', RSVD3: '', RSVD4: '', RSVD5: ''
  });

  // Step 2: approval SSO (교육비용)
  var weAuthPayload = 'auth_srno=88'
    + '&auth_val=' + encodeURIComponent(authVal)
    + '&STND_PAGE=' + encodeURIComponent('https://www.bizplay.co.kr/weAuth')
    + '&quick_menu=&quick_param=&stup=';

  var weAuth = fetchWithCookies('https://www.bizplay.co.kr/weAuth', bizplayCookies, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    payload: weAuthPayload
  });
  bizplayCookies = weAuth.cookies;
  var weAuthHtml = weAuth.body;
  debug.weAuthLen = weAuthHtml.length;
  debug.weAuthStatus = weAuth.response.getResponseCode();

  var rdmMatch = weAuthHtml.match(/sendRdmKey\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
  var approvalCookies = '';
  var dvsnCd = '', dvsnNm = '', deptShort = '';
  var ssoComplete = false;

  if (rdmMatch) {
    var gateUrl = rdmMatch[1];
    var rdmKey = rdmMatch[2];
    debug.gateUrl = gateUrl;
    debug.rdmKeyPrefix = rdmKey.substring(0, 10) + '...';

    // POST approval gate → approval 쿠키 획득
    var gate = fetchWithCookies(gateUrl, '', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: 'RDM_KEY=' + encodeURIComponent(rdmKey)
    });
    approvalCookies = gate.cookies;
    debug.gateStatus = gate.response.getResponseCode();
    debug.approvalCookieLen = approvalCookies.length;

    // /consumer API로 USER_DATA 획득 (weAuth 쿠키 필요)
    try {
      var consResp = UrlFetchApp.fetch('https://www.bizplay.co.kr/consumer', {
        method: 'post',
        contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
        headers: { 'User-Agent': BROWSER_UA, 'Cookie': bizplayCookies, 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://www.bizplay.co.kr/weAuth' },
        payload: 'cntsId=88&lang=DF',
        muteHttpExceptions: true
      });
      var consData = JSON.parse(consResp.getContentText());
      debug.consumerResCd = consData.RES_CD;
      if (consData.RES_CD === '0000' && consData.USER_DATA) {
        var ud = consData.USER_DATA;
        if (typeof ud === 'string') { try { ud = JSON.parse(ud); } catch(pe){} }
        debug.consumerUserDataKeys = (typeof ud === 'object') ? Object.keys(ud).join(',') : String(ud).substring(0, 300);
        dvsnCd = (typeof ud === 'object') ? (ud.DVSN_CD || ud.DEPT_CD || ud.deptCd || '') : '';
        dvsnNm = (typeof ud === 'object') ? (ud.DVSN_NM || ud.DEPT_NM || ud.deptNm || '') : '';
        if (dvsnNm) { deptShort = dvsnNm.split(/[\s\/]/).pop() || dvsnNm; }
      }
    } catch (consErr) {
      debug.consumerError = consErr.message;
    }

    // approval 페이지에서도 부서정보 파싱 시도
    if (!dvsnCd) {
      try {
        var apprPage = fetchWithCookies('https://approval.appplay.co.kr/appr/gate/appr_doc_layout2.act', approvalCookies);
        approvalCookies = apprPage.cookies;
        var apprHtml = apprPage.body;
        debug.apprPageLen = apprHtml.length;
        var allFields = _parseFormFields(apprHtml, '');
        dvsnCd = allFields.DVSN_CD || allFields.DEPT_CD || '';
        dvsnNm = dvsnNm || allFields.DVSN_NM || allFields.DEPT_NM || '';
        if (dvsnNm && !deptShort) { deptShort = dvsnNm.split(/[\s\/]/).pop() || dvsnNm; }
      } catch (apprErr) {
        debug.apprPageError = apprErr.message;
      }
    }
    ssoComplete = true;
  } else {
    debug.weAuthFull = weAuthHtml.length <= 5000 ? weAuthHtml : weAuthHtml.substring(0, 2500) + '...' + weAuthHtml.substring(weAuthHtml.length - 2500);
  }

  // webank SSO (밥카용) — 2차 독립 로그인으로 별도 세션 획득
  var webankCookies = '';
  try {
    var loginResp2 = UrlFetchApp.fetch('https://www.bizplay.co.kr/login_proc_01.jct', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      headers: { 'User-Agent': BROWSER_UA },
      payload: loginPayload,
      followRedirects: false,
      muteHttpExceptions: true
    });
    var wbLoginCookies = extractCookies(loginResp2);
    debug.webankLoginCookieLen = wbLoginCookies.length;

    var webankPayload = 'auth_srno=11107'
      + '&auth_val=' + encodeURIComponent(authVal)
      + '&STND_PAGE=' + encodeURIComponent('https://www.bizplay.co.kr/weAuth')
      + '&quick_menu=&quick_param=&stup=';

    var webankAuth = fetchWithCookies('https://www.bizplay.co.kr/weAuth', wbLoginCookies, {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      payload: webankPayload
    });
    debug.webankWeAuthStatus = webankAuth.response.getResponseCode();
    debug.webankWeAuthLen = webankAuth.body.length;

    var webankRdm = webankAuth.body.match(/sendRdmKey\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
    if (webankRdm) {
      debug.webankMethod = 'direct_rdmKey';
      var webankGate = fetchWithCookies(webankRdm[1], '', {
        method: 'post',
        contentType: 'application/x-www-form-urlencoded',
        payload: 'RDM_KEY=' + encodeURIComponent(webankRdm[2])
      });
      webankCookies = webankGate.cookies;
      debug.webankCookieLen = webankCookies.length;
    } else {
      debug.webankMethod = 'no_rdmKey';
      debug.webankWeAuthHead = webankAuth.body.substring(0, 500);
    }
  } catch (we) {
    debug.webankError = we.message;
  }

  // webank 쿠키 미획득 시 _acquireWebankCookies 폴백
  if (!webankCookies && bizplayCookies) {
    try {
      debug.webankFallback = true;
      var fallback = _acquireWebankCookies({ bizplayCookies: bizplayCookies });
      if (fallback.cookies) {
        webankCookies = fallback.cookies;
        debug.webankFallbackSuccess = true;
        debug.webankFallbackDebug = fallback.debug;
      }
    } catch (fe) {
      debug.webankFallbackError = fe.message;
    }
  }

  // 로그인 응답 body에서 DVSN_CD 폴백 (HTML 파싱 실패 대비)
  if (!dvsnCd && body.DVSN_CD) {
    dvsnCd = body.DVSN_CD;
    debug.deptSource = 'loginBody';
  }
  if (!dvsnNm && body.BSNN_NM) {
    dvsnNm = body.BSNN_NM;
  }
  if (dvsnCd && !deptShort) {
    deptShort = dvsnNm ? dvsnNm.split(/[\s\/]/).pop() || dvsnNm : '';
  }

  return {
    bizplayCookies: bizplayCookies,
    approvalCookies: approvalCookies,
    webankCookies: webankCookies,
    userName: body.USER_NM,
    useInttId: body.USE_INTT_ID,
    rsltMsg: body.RSLT_MSG,
    deptCd: dvsnCd,
    deptNm: dvsnNm,
    deptShort: deptShort,
    ssoComplete: ssoComplete,
    debug: debug
  };
}

/* ═══════════════ Bizplay 로그인 (기본만) ═══════════════ */

/**
 * 기본 Bizplay 로그인만 수행 (SSO 없음)
 * 교육비/밥카 각 모듈은 사용 시 자체 weAuth SSO 수행
 */
function handleBizplayLogin(adminRow, e) {
  const bizUserId = e.parameter.bizUserId;
  const bizPwd = e.parameter.bizPwd;
  if (!bizUserId || !bizPwd) return createResponse({ error: "MISSING_PARAMS" });

  try {
    // 기본 로그인만
    var loginPayload = '_JSON_=' + encodeURIComponent(JSON.stringify({
      USER_ID: bizUserId, PWD: bizPwd,
      CAPTCHA_VALUE: '', LNK_ID: '', LNK_INTT: '', LOGIN_SAVE: 'N',
      USER_OS: 'win10.0', USER_BR: 'Chrome', USER_BR_VER: '145.0.0.0',
      TMPR_CD2: '', TMPR_CD3: '', LNGG_DSNC: 'DF', '_LODING_BAR_YN_': 'Y'
    }));

    var loginResp = UrlFetchApp.fetch('https://www.bizplay.co.kr/login_proc_01.jct', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      headers: { 'User-Agent': BROWSER_UA },
      payload: loginPayload,
      followRedirects: false,
      muteHttpExceptions: true
    });

    var body = JSON.parse(loginResp.getContentText());
    if (body.RSLT_CD !== '0000') {
      return createResponse({ status: 'fail', message: body.RSLT_MSG || '로그인 실패' });
    }

    var bizplayCookies = extractCookies(loginResp);

    // 세션 저장 (기본 정보만 — SSO는 각 모듈에서 수행)
    var sessionData = {
      bizplayCookies: bizplayCookies,
      userId: bizUserId,
      userName: body.USER_NM,
      useInttId: body.USE_INTT_ID,
      loginTime: new Date().toISOString()
    };
    PropertiesService.getScriptProperties().setProperty(
      'bizplay_' + adminRow[ADMIN_COL.KNOX_ID],
      JSON.stringify(sessionData)
    );

    return createResponse({
      status: 'success', userName: body.USER_NM, message: body.RSLT_MSG, ssoComplete: true,
      session: { userId: bizUserId, userName: body.USER_NM }
    });
  } catch (err) {
    return createResponse({ error: 'BIZPLAY_ERROR', message: err.message });
  }
}

/* ═══════════════ Approval 전용 SSO ═══════════════ */

/**
 * 교육비 전용: 로그인 → weAuth(auth_srno=88) → approval SSO만 수행 (webank 없음)
 * Bizplay 웹 UI처럼 모듈별 독립 SSO
 */
function _approvalSsoOnly(userId, password) {
  var debug = {};

  // Step 1: Bizplay 로그인
  var loginPayload = '_JSON_=' + encodeURIComponent(JSON.stringify({
    USER_ID: userId, PWD: password,
    CAPTCHA_VALUE: '', LNK_ID: '', LNK_INTT: '', LOGIN_SAVE: 'N',
    USER_OS: 'win10.0', USER_BR: 'Chrome', USER_BR_VER: '145.0.0.0',
    TMPR_CD2: '', TMPR_CD3: '', LNGG_DSNC: 'DF', '_LODING_BAR_YN_': 'Y'
  }));

  var loginResp = UrlFetchApp.fetch('https://www.bizplay.co.kr/login_proc_01.jct', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    headers: { 'User-Agent': BROWSER_UA },
    payload: loginPayload,
    followRedirects: false,
    muteHttpExceptions: true
  });

  var body = JSON.parse(loginResp.getContentText());
  if (body.RSLT_CD !== '0000') return { error: body.RSLT_MSG || '로그인 실패', debug: debug };

  var bizplayCookies = extractCookies(loginResp);
  debug.loginOk = true;

  // Step 2: weAuth (approval 전용, auth_srno=88)
  var authVal = JSON.stringify({ SVC_PTRN: 'M', APP_TARG: 'Y', RSVD1: '', RSVD2: '', RSVD3: '', RSVD4: '', RSVD5: '' });
  var weAuthPayload = 'auth_srno=88'
    + '&auth_val=' + encodeURIComponent(authVal)
    + '&STND_PAGE=' + encodeURIComponent('https://www.bizplay.co.kr/weAuth')
    + '&quick_menu=&quick_param=&stup=';

  var weAuth = fetchWithCookies('https://www.bizplay.co.kr/weAuth', bizplayCookies, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    payload: weAuthPayload
  });
  bizplayCookies = weAuth.cookies;
  debug.weAuthLen = weAuth.body.length;

  // Step 3: /consumer 호출 (weAuth 쿠키로 USER_DATA 획득)
  var consumerUserData = null;
  try {
    var consResp = UrlFetchApp.fetch('https://www.bizplay.co.kr/consumer', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      headers: { 'User-Agent': BROWSER_UA, 'Cookie': bizplayCookies, 'X-Requested-With': 'XMLHttpRequest', 'Referer': 'https://www.bizplay.co.kr/weAuth' },
      payload: 'cntsId=88&lang=DF',
      muteHttpExceptions: true
    });
    var consText = consResp.getContentText();
    if (consText.charAt(0) === '{') {
      var consData = JSON.parse(consText);
      debug.consumerResCd = consData.RES_CD;
      if (consData.RES_CD === '0000') {
        consumerUserData = consData.USER_DATA;
        debug.consumerUserDataType = typeof consumerUserData;
        if (typeof consumerUserData === 'object' && consumerUserData) {
          debug.consumerUserDataKeys = Object.keys(consumerUserData).join(',');
        } else if (typeof consumerUserData === 'string') {
          debug.consumerUserDataStr = consumerUserData.substring(0, 200);
        }
      }
    } else {
      debug.consumerHtml = true;
    }
  } catch (ce) { debug.consumerError = ce.message; }

  // Step 4: sendRdmKey → approval 쿠키 획득
  var approvalCookies = '';
  var dvsnCd = '', dvsnNm = '', deptShort = '';

  var rdmMatch = weAuth.body.match(/sendRdmKey\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
  if (rdmMatch) {
    var gate = fetchWithCookies(rdmMatch[1], '', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: 'RDM_KEY=' + encodeURIComponent(rdmMatch[2])
    });
    approvalCookies = gate.cookies;
    debug.gateOk = true;

    // gate 응답 분석 — 최종 랜딩 페이지 URL 및 내용 캡처
    debug.gateBodyLen = gate.body.length;
    // JavaScript에서 내부 폼 URL 추출 시도
    var actMatches = gate.body.match(/['"][^'"]*\.act[^'"]*['"]/g) || [];
    debug.gateActUrls = actMatches.slice(0, 15).map(function(m) { return m.replace(/['"]/g, ''); });
    var jctMatches = gate.body.match(/['"][^'"]*\.jct[^'"]*['"]/g) || [];
    debug.gateJctUrls = jctMatches.slice(0, 10).map(function(m) { return m.replace(/['"]/g, ''); });

    // Step 5: 레이아웃 페이지 로드 → 모든 폼 필드 캡처
    var formFields = {};
    try {
      var layoutPage = fetchWithCookies('https://approval.appplay.co.kr/appr/gate/appr_doc_layout2.act', approvalCookies);
      approvalCookies = layoutPage.cookies;
      formFields = _parseFormFields(layoutPage.body, '');
      debug.layoutFieldCount = Object.keys(formFields).length;
      // 주요 필드 값 전체 캡처
      debug.layoutValues = {};
      for (var k in formFields) { debug.layoutValues[k] = String(formFields[k]).substring(0, 80); }

      // 레이아웃 페이지 분석 — 외부 JS, URL, 인라인 스크립트 캡처
      debug.layoutBodyLen = layoutPage.body.length;

      // <script src="..."> 외부 JS 파일 목록
      var scriptSrcMatches = layoutPage.body.match(/script[^>]*src\s*=\s*['"]([^'"]+)['"]/gi) || [];
      debug.layoutScriptSrcs = scriptSrcMatches.map(function(m) {
        var srcMatch = m.match(/src\s*=\s*['"]([^'"]+)['"]/i);
        return srcMatch ? srcMatch[1] : m;
      });

      // 인라인 <script> 내용 캡처 (API URL 탐색용)
      var inlineScripts = layoutPage.body.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
      var inlineJs = '';
      inlineScripts.forEach(function(s) {
        if (!s.match(/src\s*=/i)) { // src 없는 인라인 스크립트만
          var content = s.replace(/<\/?script[^>]*>/gi, '');
          if (content.trim()) inlineJs += content + '\n';
        }
      });
      debug.layoutInlineJsLen = inlineJs.length;
      // .jct, .act, fetch, ajax, XMLHttpRequest 패턴 추출
      var apiPatterns = inlineJs.match(/['"][^'"]*(?:\.jct|\.act|appr_|c00|r00)[^'"]*['"]/g) || [];
      debug.layoutApiPatterns = apiPatterns.slice(0, 20).map(function(m) { return m.replace(/['"]/g, ''); });
      // URL 전체 추출
      var allUrls = inlineJs.match(/https?:\/\/[^\s'"<>]+/g) || [];
      debug.layoutUrls = allUrls.slice(0, 10);
      // 키워드 검색: domain, DOMAIN, DMN
      var domainRefs = inlineJs.match(/[A-Z_]*(?:DOMAIN|DMN|domain)[A-Z_]*/g) || [];
      debug.layoutDomainRefs = domainRefs.slice(0, 10);

      // iframe src 추출
      var iframeMatch = layoutPage.body.match(/iframe[^>]*src\s*=\s*['"]([^'"]+)['"]/i);
      debug.iframeSrc = iframeMatch ? iframeMatch[1] : 'none';

      dvsnCd = formFields.DVSN_CD || formFields.DEPT_CD || '';
      dvsnNm = formFields.DVSN_NM || formFields.DEPT_NM || '';
    } catch (apprErr) { debug.apprError = apprErr.message; }
  } else {
    debug.noRdmKey = true;
  }

  // consumer USER_DATA에서 DVSN_CD 시도
  if (!dvsnCd && consumerUserData) {
    var ud = consumerUserData;
    if (typeof ud === 'string') { try { ud = JSON.parse(ud); } catch(pe){} }
    if (typeof ud === 'object' && ud) {
      dvsnCd = ud.DVSN_CD || ud.DEPT_CD || ud.deptCd || '';
      dvsnNm = dvsnNm || ud.DVSN_NM || ud.DEPT_NM || ud.deptNm || '';
    }
  }

  if (dvsnNm && !deptShort) deptShort = dvsnNm.split(/[\s\/]/).pop() || dvsnNm;

  return {
    bizplayCookies: bizplayCookies,
    approvalCookies: approvalCookies,
    userName: body.USER_NM,
    useInttId: body.USE_INTT_ID,
    deptCd: dvsnCd,
    deptNm: dvsnNm || body.BSNN_NM || '',
    deptShort: deptShort,
    formFields: formFields,
    debug: debug
  };
}

/* ═══════════════ 교육비 탭 진입 SSO ═══════════════ */

/**
 * 교육비 탭 클릭 시 approval SSO 수행 (Bizplay 웹처럼 탭 전환마다 weAuth 호출)
 */
function handleBizplayEduInit(adminRow, e) {
  var propKey = 'bizplay_' + adminRow[ADMIN_COL.KNOX_ID];
  var rawSession = PropertiesService.getScriptProperties().getProperty(propKey);
  if (!rawSession) return createResponse({ error: "NO_SESSION", message: "Bizplay 로그인이 필요해." });

  var session = JSON.parse(rawSession);
  var result = _getApprovalSso(session, adminRow);
  if (result.error) return createResponse({ error: result.error, message: "비밀번호 저장 후 다시 로그인해줘." });

  var sso = result.sso;
  if (sso.error) return createResponse({ status: 'fail', message: sso.error, debug: sso.debug });

  _saveApprovalSession(propKey, session, sso);

  return createResponse({
    status: 'success', message: 'Approval SSO 완료',
    deptCd: sso.deptCd, deptNm: sso.deptNm,
    debug: sso.debug
  });
}

/* ═══════════════ Bizplay 임시저장 ═══════════════ */

function handleBizplayDraft(adminRow, e) {
  const propKey = 'bizplay_' + adminRow[ADMIN_COL.KNOX_ID];
  const rawSession = PropertiesService.getScriptProperties().getProperty(propKey);
  if (!rawSession) return createResponse({ error: "NO_SESSION", message: "Bizplay 로그인이 필요해." });

  var session = JSON.parse(rawSession);
  var p = e.parameter;
  var debug = {};

  // ── approval SSO: 세션 재사용 (30분) → 실패 시 PW로 fresh SSO ──
  var result = _getApprovalSso(session, adminRow);
  if (result.error) return createResponse({ error: result.error, message: "비밀번호 저장 후 다시 로그인해줘." });

  var sso = result.sso;
  debug.sso = sso.debug;

  if (sso.error) return createResponse({ status: 'fail', message: sso.error, debug: debug });
  if (!sso.approvalCookies) return createResponse({ status: 'fail', message: 'Approval SSO 실패. 다시 로그인해줘.', debug: debug });

  _saveApprovalSession(propKey, session, sso);

  // ── 폼 필드에서 값 가져오기 (밥카의 eaprForm 패턴) ──
  var ff = sso.formFields || {};
  var deptCd = sso.deptCd || ff.DVSN_CD || ff.DEPT_CD || '';
  var deptNm = sso.deptNm || ff.DVSN_NM || ff.DEPT_NM || '';
  var deptShort = sso.deptShort || (deptNm ? deptNm.split(/[\s\/]/).pop() : '');
  var userName = ff.USER_NM || session.userName || sso.userName || '';
  var useInttId = ff.USE_INTT_ID || session.useInttId || sso.useInttId || '';
  debug.resolvedDeptCd = deptCd;
  debug.resolvedDeptNm = deptNm;
  debug.formFieldSource = Object.keys(ff).length > 0 ? 'formPage' : 'none';

  // ── 페이로드 생성 (브라우저와 동일한 구조) ──
  var empNo = session.userId.split('@')[0];
  var itemList = [
    { ITEM_SEQ_NO: "0", ITVL_1: deptShort || '', ITVL_2: '', ITVL_3: null, ITVL_4: null },
    { ITEM_SEQ_NO: "1", ITVL_1: empNo, ITVL_2: '', ITVL_3: null, ITVL_4: null },
    { ITEM_SEQ_NO: "2", ITVL_1: userName, ITVL_2: '', ITVL_3: null, ITVL_4: null },
    { ITEM_SEQ_NO: "3", ITVL_1: p.courseName || '', ITVL_2: '', ITVL_3: null, ITVL_4: null },
    { ITEM_SEQ_NO: "4", ITVL_1: p.startDate || '', ITVL_2: p.endDate || '' },
    { ITEM_SEQ_NO: "5", ITVL_1: p.institution || '', ITVL_2: '', ITVL_3: null, ITVL_4: null },
    { ITEM_SEQ_NO: "6", ITVL_1: p.eduType || '온라인', ITVL_2: '', ITVL_3: null, ITVL_4: null },
    { ITEM_SEQ_NO: "7", ITVL_1: p.purpose || '', ITVL_2: '', ITVL_3: null, ITVL_4: null },
    { ITEM_SEQ_NO: "8", ITVL_1: (p.cost || '0').replace(/,/g, ''), ITVL_2: '', ITVL_3: null, ITVL_4: null },
    { ITEM_SEQ_NO: "9", ITVL_1: p.billing || '1회', ITVL_2: '', ITVL_3: null, ITVL_4: null },
    { ITEM_SEQ_NO: "10", ITVL_1: p.remark || '', ITVL_2: '', ITVL_3: null, ITVL_4: null }
  ];
  // 브라우저와 동일: BSNN_NO, CNTS_ID, LNGG_DSNC, DSNC, CUY_ID 미포함
  var draftJson = {
    API_YN: 'Y', APPR_SEQ_NO: '',
    PTL_ID: ff.PTL_ID || 'PTL_3',
    CHNL_ID: ff.CHNL_ID || 'CHNL_1',
    USE_INTT_ID: useInttId,
    DRAFT_USER_ID: session.userId,
    DRAFT_USER_NM: userName,
    DRAFT_USER_POS_NM: '',
    DRAFT_USER_DEPT_CD: deptCd,
    DRAFT_USER_DEPT_NM: deptNm,
    PAPER_SEQ_NO: '79697428',
    APPR_SUBJ: '교육 신청서',
    APPR_OPINION_REC: [],
    APPR_CONT: '<p>교육 신청서</p>',
    DOC_GB_CD: '0',
    PROC_GB: p.procGb === '2' ? '2' : '1',
    ERP_SEQ_NO: '', VOUCH_REC: [], ITEM_REC: itemList, STS_REC: null,
    EDITOR_ATCH_SRNO: '', PRE_APPR_SEQ_NO: '', APPR_MODE: '',
    '_LODING_BAR_YN_': 'Y'
  };

  // 결재요청(PROC_GB=2) 시 세션에 캐시된 결재라인을 STS_REC에 포함
  // 브라우저와 동일한 포맷: 부서수신(KIND=4) + 개인승인(KIND=2) 모두 포함
  if (p.procGb === '2' && session.cachedApprLine && session.cachedApprLine.length > 0) {
    draftJson.STS_REC = session.cachedApprLine.map(function(rec) {
      var gb = rec.APPR_USER_GB || '2';
      var kind = rec.APPRLINE_KIND || '2';
      var deptCd = rec.APPR_DEPT_CD || rec.DEPT_CD || '';
      var deptNm = rec.APPR_DEPT_NM || rec.DEPT_NM || '';
      var userDeptCd = rec.APPR_USER_DEPT_CD || deptCd;
      var userDeptNm = rec.APPR_USER_DEPT_NM || deptNm;
      if (gb === '1' || kind === '4') {
        // 부서수신: DEPT_CD/DEPT_NM + APPR_USER_DEPT_CD/NM 모두 동일 값
        return {
          APPR_ORD: rec.APPR_ORD || 0,
          APPR_DEPT_CD: deptCd,
          APPR_DEPT_NM: deptNm,
          DEPT_CD: deptCd,
          DEPT_NM: deptNm,
          APPR_USER_DEPT_CD: userDeptCd,
          APPR_USER_DEPT_NM: userDeptNm,
          APPRLINE_KIND: kind === '4' ? '4' : rec.APPRLINE_KIND || '4',
          APPR_USER_GB: '1',
          RECENT_SAVE_YN: 'Y',
          BOTTOM_FIXED_YN: 'N'
        };
      } else {
        // 개인승인 (Bizplay spec: APPR_USER_ID, APPR_USER_DEPT_CD/NM 필수)
        return {
          APPR_ORD: rec.APPR_ORD || '0',
          APPR_USER_ID: rec.APPR_USER_ID || '',
          APPR_USER_NM: rec.APPR_USER_NM || '',
          APPR_USER_DEPT_CD: userDeptCd,
          APPR_USER_DEPT_NM: userDeptNm,
          APPR_USER_POS_NM: rec.APPR_USER_POS_NM || '',
          APPRLINE_KIND: kind,
          APPR_USER_GB: '2',
          RECENT_SAVE_YN: 'Y',
          BOTTOM_FIXED_YN: 'N'
        };
      }
    });
    debug.stsRecCount = draftJson.STS_REC.length;
    debug.stsRecSample = draftJson.STS_REC.length > 0 ? draftJson.STS_REC[0] : null;
  }
  var draftPayload = '_JSON_=' + encodeURIComponent(JSON.stringify(draftJson));

  // ── Step 1: appr_dtl_0001.act → appr_dtl_0005.act 로드 (JEX 도메인 설정) ──
  var apprCookies = sso.approvalCookies;
  var dtlPayload = 'PTL_ID=' + encodeURIComponent(ff.PTL_ID || 'PTL_3')
    + '&CHNL_ID=' + encodeURIComponent(ff.CHNL_ID || 'CHNL_1')
    + '&USE_INTT_ID=' + encodeURIComponent(useInttId)
    + '&USER_ID=' + encodeURIComponent(session.userId)
    + '&PAPER_SEQ_NO=79697428'
    + '&MENU_TYPE=R';

  // 1a. appr_dtl_0001.act (컨테이너 프레임)
  try {
    var dtl1 = fetchWithCookies('https://approval.appplay.co.kr/appr_dtl_0001.act', apprCookies, {
      method: 'post', contentType: 'application/x-www-form-urlencoded', payload: dtlPayload
    });
    apprCookies = dtl1.cookies;
    debug.dtl1Status = dtl1.response.getResponseCode();
    debug.dtl1Len = dtl1.body.length;

    // dtl1에서 필드값 추출 (DVSN_CD, DEPT_NM 등)
    var dtl1Fields = _parseFormFields(dtl1.body, '');
    if (dtl1Fields.DVSN_CD) { deptCd = dtl1Fields.DVSN_CD; draftJson.DRAFT_USER_DEPT_CD = deptCd; }
    if (dtl1Fields.DEPT_NM) { deptNm = dtl1Fields.DEPT_NM; draftJson.DRAFT_USER_DEPT_NM = deptNm; }
    if (dtl1Fields.USER_NM) { userName = dtl1Fields.USER_NM; draftJson.DRAFT_USER_NM = userName; }
    if (dtl1Fields.POS_NM) { draftJson.DRAFT_USER_POS_NM = dtl1Fields.POS_NM; }
  } catch (e) { debug.dtl1Error = e.message; }

  // 1b. appr_dtl_0005.act (실제 폼 페이지 — 브라우저 Referer 확인)
  try {
    var dtl5 = fetchWithCookies('https://approval.appplay.co.kr/appr_dtl_0005.act', apprCookies, {
      method: 'post', contentType: 'application/x-www-form-urlencoded', payload: dtlPayload
    });
    apprCookies = dtl5.cookies;
    debug.dtl5Status = dtl5.response.getResponseCode();
    debug.dtl5Len = dtl5.body.length;
    var dtl5Title = (dtl5.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    debug.dtl5Title = dtl5Title.trim();

    // dtl5 필드 파싱
    var dtl5Fields = _parseFormFields(dtl5.body, '');
    debug.dtl5FieldCount = Object.keys(dtl5Fields).length;
    if (Object.keys(dtl5Fields).length > 0) {
      debug.dtl5FieldKeys = Object.keys(dtl5Fields).slice(0, 25).join(',');
    }
    // dtl5에서 추가 필드 업데이트
    if (dtl5Fields.DEPT_NM && dtl5Fields.DEPT_NM !== deptNm) {
      deptNm = dtl5Fields.DEPT_NM; draftJson.DRAFT_USER_DEPT_NM = deptNm;
    }
    // createAjaxUtil 서비스 ID
    var dtl5Ajax = dtl5.body.match(/createAjaxUtil\s*\(\s*['"]([^'"]+)['"]/g) || [];
    debug.dtl5AjaxServices = dtl5Ajax.map(function(m) { return m.match(/['"]([^'"]+)['"]/)[1]; });
  } catch (e) { debug.dtl5Error = e.message; }

  debug.resolvedFinal = { deptCd: deptCd, deptNm: deptNm, userName: userName };

  // ── Step 2: appr_paper_r003.jct — 양식 템플릿(PAPER_CONT) 조회 ──
  try {
    var r003Payload = '_JSON_=' + encodeURIComponent(JSON.stringify({
      PAPER_SEQ_NO: '79697428',
      USE_INTT_ID: useInttId,
      PTL_ID: ff.PTL_ID || 'PTL_3',
      CHNL_ID: ff.CHNL_ID || 'CHNL_1',
      APPR_SEQ_NO: '',
      MENU_TYPE: 'R',
      '_LODING_BAR_YN_': 'Y'
    }));
    var r003Resp = UrlFetchApp.fetch('https://approval.appplay.co.kr/appr_paper_r003.jct', {
      method: 'post', contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      headers: {
        'User-Agent': BROWSER_UA, 'Cookie': apprCookies,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://approval.appplay.co.kr/appr_dtl_0005.act'
      },
      payload: r003Payload, muteHttpExceptions: true
    });
    var r003Text = r003Resp.getContentText();
    var r003Body = JSON.parse(r003Text);
    debug.r003Code = r003Body.COMMON_HEAD ? r003Body.COMMON_HEAD.CODE : (r003Body.code || '');
    debug.r003HttpStatus = r003Resp.getResponseCode();
    if (r003Body.PAPER_CONT) {
      draftJson.APPR_CONT = r003Body.PAPER_CONT;
      debug.r003PaperContLen = r003Body.PAPER_CONT.length;
    } else {
      debug.r003Keys = Object.keys(r003Body).join(',');
      debug.r003Resp = r003Text.substring(0, 500);
    }
    if (r003Body.PAPER_NM) {
      draftJson.APPR_SUBJ = r003Body.PAPER_NM;
    }
  } catch (r003Err) { debug.r003Error = r003Err.message; }

  // ── Step 3: c002 저장 API 호출 (Referer: appr_dtl_0005.act) ──
  // Bizplay Jex 프레임워크가 JSON 필드를 이중 URL 디코딩하므로,
  // APPR_CONT 내 % 문자(CSS 등)를 %25로 이스케이프 (유효한 %XX 시퀀스는 제외)
  if (draftJson.APPR_CONT) {
    draftJson.APPR_CONT = draftJson.APPR_CONT.replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
  }
  draftPayload = '_JSON_=' + encodeURIComponent(JSON.stringify(draftJson));
  try {
    var resp = UrlFetchApp.fetch('https://approval.appplay.co.kr/appr_c002.jct', {
      method: 'post', contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      headers: {
        'User-Agent': BROWSER_UA, 'Cookie': apprCookies,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://approval.appplay.co.kr/appr_dtl_0005.act'
      },
      payload: draftPayload, muteHttpExceptions: true
    });
    var r = { code: resp.getResponseCode(), text: resp.getContentText() };
    var body;
    // 서버가 JSON 2개를 연결해서 반환하는 경우 첫 번째만 파싱
    var textToParse = r.text;
    var concatIdx = textToParse.indexOf('}{');
    if (concatIdx > 0) textToParse = textToParse.substring(0, concatIdx + 1);
    try { body = JSON.parse(textToParse); } catch (pe) { body = null; }

    // 성공 판정: COMMON_HEAD.ERROR === false (CODE는 빈문자열 또는 '0000')
    if (body && body.COMMON_HEAD && body.COMMON_HEAD.ERROR === false) {
      return createResponse({ status: 'success', message: '임시저장 완료', result: body });
    }
    if (body && (body.RSLT_CD === '0000' || body.ERR_CD === '0000')) {
      return createResponse({ status: 'success', message: '임시저장 완료', result: body });
    }

    var ch = body && body.COMMON_HEAD;
    var msg = (ch && ch.MESSAGE) || (body && (body.RSLT_MSG || body.ERR_MSG)) || '임시저장 실패';
    debug.httpStatus = r.code;
    debug.code = ch && ch.CODE;
    debug.respBody = r.text.substring(0, 300);
    return createResponse({ status: 'fail', message: msg, debug: debug });
  } catch (err) {
    debug.exception = err.message;
    return createResponse({ error: 'DRAFT_ERROR', message: err.message, debug: debug });
  }
}

/* ═══════════════ 기안문서 목록 조회 ═══════════════ */

function handleBizplayDraftList(adminRow, e) {
  const propKey = 'bizplay_' + adminRow[ADMIN_COL.KNOX_ID];
  const rawSession = PropertiesService.getScriptProperties().getProperty(propKey);
  if (!rawSession) return createResponse({ error: "NO_SESSION", message: "Bizplay 로그인이 필요해." });

  var session = JSON.parse(rawSession);
  var debug = {};

  // ── SSO 획득 (세션 재사용 30분 → 실패 시 PW로 fresh SSO) ──
  var ssoResult = _getApprovalSso(session, adminRow);
  if (ssoResult.error) return createResponse({ error: ssoResult.error, message: "비밀번호 저장 후 다시 로그인해줘." });

  // ── r007 API 호출 ──
  function callR007(sso) {
    var ff = sso.formFields || {};
    var useInttId = ff.USE_INTT_ID || session.useInttId || sso.useInttId || '';
    var now = new Date();
    var three = new Date(now); three.setMonth(three.getMonth() - 3);
    var fmt = function(d) {
      return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    };

    var r007Payload = '_JSON_=' + encodeURIComponent(JSON.stringify({
      PTL_ID: ff.PTL_ID || 'PTL_3',
      CHNL_ID: ff.CHNL_ID || 'CHNL_1',
      USE_INTT_ID: useInttId,
      DRAFT_USER_ID: session.userId,
      ST_DRAFT_DATE: fmt(three),
      EN_DRAFT_DATE: fmt(now),
      SRCH_WD: '',
      SRCH_DV: 'pp',
      DRAFT_USER_NM: 'pp',
      PG_NO: '1',
      PG_PER_CNT: '15',
      PAPER_SEQ_NO: '',
      DATE_GB: '1'
    }));

    var resp = UrlFetchApp.fetch('https://approval.appplay.co.kr/appr_r007.jct', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      headers: {
        'User-Agent': BROWSER_UA,
        'Cookie': sso.approvalCookies,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://approval.appplay.co.kr/appr/gate/appr_doc_layout2.act'
      },
      payload: r007Payload,
      muteHttpExceptions: true
    });

    return { respText: resp.getContentText(), httpStatus: resp.getResponseCode() };
  }

  // ── 1차 시도 (세션 재사용) ──
  var sso = ssoResult.sso;
  debug.sso = sso.debug;

  if (sso.error) return createResponse({ status: 'fail', message: sso.error, debug: debug });
  if (!sso.approvalCookies) return createResponse({ status: 'fail', message: 'Approval SSO 실패. 다시 로그인해줘.', debug: debug });

  try {
    var result = callR007(sso);
    debug.httpStatus = result.httpStatus;
    debug.respLen = result.respText.length;

    var body;
    try { body = JSON.parse(result.respText); } catch (pe) { body = null; }

    // 세션 만료 에러 → PW로 fresh SSO 재시도
    if (body && body.COMMON_HEAD && body.COMMON_HEAD.ERROR === true) {
      var errMsg = body.COMMON_HEAD.MESSAGE || '';
      if (errMsg.includes('로그아웃') || errMsg.includes('세션') || errMsg.includes('만료')) {
        debug.retry = true;
        debug.retryReason = errMsg;
        sso = _retryApprovalSso(session, adminRow);

        if (!sso || sso.error || !sso.approvalCookies) {
          var failMsg = ssoResult.noPw ? '세션이 만료됐어. 비밀번호 저장 후 다시 로그인해줘.' : (sso && sso.error ? sso.error : 'SSO 재시도 실패');
          return createResponse({ status: 'fail', message: failMsg, debug: debug });
        }
        debug.ssoRetry = sso.debug;

        result = callR007(sso);
        debug.retryHttpStatus = result.httpStatus;
        debug.retryRespLen = result.respText.length;
        try { body = JSON.parse(result.respText); } catch (pe) { body = null; }
      }
    }

    _saveApprovalSession(propKey, session, sso);

    if (!body) {
      debug.respHead = result.respText.substring(0, 500);
      return createResponse({ status: 'fail', message: '기안문서 응답 파싱 실패', debug: debug });
    }

    debug.respKeys = Object.keys(body).join(',');

    if (body.COMMON_HEAD && body.COMMON_HEAD.ERROR === true) {
      debug.errorMsg = body.COMMON_HEAD.MESSAGE;
      return createResponse({ status: 'fail', message: body.COMMON_HEAD.MESSAGE || '기안문서 조회 실패', debug: debug });
    }

    var draftList = body.REC || body.APPR_REC || body.LIST || [];
    if (!Array.isArray(draftList)) draftList = [];

    debug.draftListCount = draftList.length;
    if (draftList.length > 0) {
      debug.firstRecordKeys = Object.keys(draftList[0]).join(',');
    }

    return createResponse({ status: 'success', draftList: draftList, debug: debug });
  } catch (err) {
    debug.exception = err.message;
    return createResponse({ error: 'DRAFT_LIST_ERROR', message: err.message, debug: debug });
  }
}

/* ═══════════════ 기안문서 상세 조회 ═══════════════ */

function handleBizplayDraftDetail(adminRow, e) {
  const propKey = 'bizplay_' + adminRow[ADMIN_COL.KNOX_ID];
  const rawSession = PropertiesService.getScriptProperties().getProperty(propKey);
  if (!rawSession) return createResponse({ error: "NO_SESSION", message: "Bizplay 로그인이 필요해." });

  var session = JSON.parse(rawSession);
  var debug = {};
  var apprSeqNo = e.parameter.apprSeqNo || '';
  var paperSeqNo = e.parameter.paperSeqNo || '';

  if (!apprSeqNo) return createResponse({ status: 'fail', message: 'APPR_SEQ_NO 누락' });

  // ── SSO 획득 (세션 재사용 30분 → 실패 시 PW로 fresh SSO) ──
  var ssoResult = _getApprovalSso(session, adminRow);
  if (ssoResult.error) return createResponse({ error: ssoResult.error, message: "비밀번호 저장 후 다시 로그인해줘." });

  // ── r011 API 호출 ──
  function callR011(sso) {
    var ff = sso.formFields || {};
    var useInttId = ff.USE_INTT_ID || session.useInttId || sso.useInttId || '';

    var r011Payload = '_JSON_=' + encodeURIComponent(JSON.stringify({
      PTL_ID: ff.PTL_ID || 'PTL_3',
      CHNL_ID: ff.CHNL_ID || 'CHNL_1',
      USE_INTT_ID: useInttId,
      APPR_SEQ_NO: apprSeqNo,
      PAPER_SEQ_NO: paperSeqNo
    }));

    var resp = UrlFetchApp.fetch('https://approval.appplay.co.kr/appr_r011.jct', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      headers: {
        'User-Agent': BROWSER_UA,
        'Cookie': sso.approvalCookies,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://approval.appplay.co.kr/appr/gate/appr_doc_layout2.act'
      },
      payload: r011Payload,
      muteHttpExceptions: true
    });

    return { respText: resp.getContentText(), httpStatus: resp.getResponseCode() };
  }

  // ── 1차 시도 (세션 재사용) ──
  var sso = ssoResult.sso;
  debug.sso = sso.debug;

  if (sso.error) return createResponse({ status: 'fail', message: sso.error, debug: debug });
  if (!sso.approvalCookies) return createResponse({ status: 'fail', message: 'Approval SSO 실패. 다시 로그인해줘.', debug: debug });

  try {
    var result = callR011(sso);
    debug.httpStatus = result.httpStatus;
    debug.respLen = result.respText.length;

    var body;
    try { body = JSON.parse(result.respText); } catch (pe) { body = null; }

    // 세션 만료 에러 → PW로 fresh SSO 재시도
    if (body && body.COMMON_HEAD && body.COMMON_HEAD.ERROR === true) {
      var errMsg = body.COMMON_HEAD.MESSAGE || '';
      if (errMsg.includes('로그아웃') || errMsg.includes('세션') || errMsg.includes('만료')) {
        debug.retry = true;
        debug.retryReason = errMsg;
        sso = _retryApprovalSso(session, adminRow);

        if (!sso || sso.error || !sso.approvalCookies) {
          var failMsg = ssoResult.noPw ? '세션이 만료됐어. 비밀번호 저장 후 다시 로그인해줘.' : (sso && sso.error ? sso.error : 'SSO 재시도 실패');
          return createResponse({ status: 'fail', message: failMsg, debug: debug });
        }
        debug.ssoRetry = sso.debug;

        result = callR011(sso);
        debug.retryHttpStatus = result.httpStatus;
        debug.retryRespLen = result.respText.length;
        try { body = JSON.parse(result.respText); } catch (pe) { body = null; }
      }
    }

    _saveApprovalSession(propKey, session, sso);

    if (!body) {
      debug.respHead = result.respText.substring(0, 500);
      return createResponse({ status: 'fail', message: '기안문서 상세 응답 파싱 실패', debug: debug });
    }

    debug.respKeys = Object.keys(body).join(',');

    if (body.COMMON_HEAD && body.COMMON_HEAD.ERROR === true) {
      debug.errorMsg = body.COMMON_HEAD.MESSAGE;
      return createResponse({ status: 'fail', message: body.COMMON_HEAD.MESSAGE || '기안문서 상세 조회 실패', debug: debug });
    }

    // 주요 필드 추출
    var detail = {
      APPR_SUBJ: body.APPR_SUBJ || '',
      APPR_CONT: body.APPR_CONT || '',
      DOC_NO: body.DOC_NO || body.APPR_NO || '',
      DRAFT_DATE: body.DRAFT_DTTM || body.DRAFT_DATE || '',
      APPR_STS_NM: body.APPR_STS_NM || body.PROC_NM || '',
      TOT_AMT: body.TOT_AMT || '',
      REJECT_REMARK: body.REJECT_REMARK || body.RET_RSLT || body.APPR_REMARK || body.RETURN_REASON || ''
    };

    debug.respKeys = Object.keys(body).join(',');

    // ── 결재의견 조회 (appr_opinion_r001.jct) ──
    var _ff = sso.formFields || {};
    var _uid = _ff.USE_INTT_ID || session.useInttId || sso.useInttId || '';
    try {
      var opPayload = '_JSON_=' + encodeURIComponent(JSON.stringify({
        PTL_ID: _ff.PTL_ID || 'PTL_3', CHNL_ID: _ff.CHNL_ID || 'CHNL_1',
        USE_INTT_ID: _uid, APPR_SEQ_NO: apprSeqNo
      }));
      var opResp = UrlFetchApp.fetch('https://approval.appplay.co.kr/appr_opinion_r001.jct', {
        method: 'post', contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
        headers: {
          'User-Agent': BROWSER_UA, 'Cookie': sso.approvalCookies,
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://approval.appplay.co.kr/appr/gate/appr_doc_layout2.act'
        },
        payload: opPayload, muteHttpExceptions: true
      });
      var opBody = JSON.parse(opResp.getContentText());
      var opRec = opBody.APPR_OPINION_REC || [];
      if (Array.isArray(opRec)) {
        detail.opinions = opRec.map(function(rec) {
          var d = rec.OPINION_DATE || '';
          var t = rec.OPINION_TIME || '';
          var dt = '';
          if (d.length >= 8) dt = d.substring(0,4) + '-' + d.substring(4,6) + '-' + d.substring(6,8);
          if (t.length >= 4) dt += ' ' + t.substring(0,2) + ':' + t.substring(2,4);
          return {
            name: rec.USER_NM || '',
            dept: rec.DVSN_NM || '',
            pos: rec.RSPT_NM || '',
            opinion: rec.OPINION || '',
            date: dt
          };
        });
      }
    } catch(e) { debug.opinionErr = e.message; }

    return createResponse({ status: 'success', detail: detail, debug: debug });
  } catch (err) {
    debug.exception = err.message;
    return createResponse({ error: 'DRAFT_DETAIL_ERROR', message: err.message, debug: debug });
  }
}

/* ═══════════════ 결재라인 조회 ═══════════════ */

function handleBizplayApprLine(adminRow, e) {
  const propKey = 'bizplay_' + adminRow[ADMIN_COL.KNOX_ID];
  const rawSession = PropertiesService.getScriptProperties().getProperty(propKey);
  if (!rawSession) return createResponse({ error: "NO_SESSION", message: "Bizplay 로그인이 필요해." });

  var session = JSON.parse(rawSession);
  var debug = {};

  // ── approval SSO: 세션 재사용 (30분) → 실패 시 PW로 fresh SSO ──
  var ssoResult = _getApprovalSso(session, adminRow);
  if (ssoResult.error) return createResponse({ error: ssoResult.error, message: "비밀번호 저장 후 다시 로그인해줘." });

  var sso = ssoResult.sso;
  debug.sso = sso.debug;

  if (sso.error) return createResponse({ status: 'fail', message: sso.error, debug: debug });
  if (!sso.approvalCookies) return createResponse({ status: 'fail', message: 'Approval SSO 실패. 다시 로그인해줘.', debug: debug });

  _saveApprovalSession(propKey, session, sso);

  var ff = sso.formFields || {};
  var useInttId = ff.USE_INTT_ID || session.useInttId || sso.useInttId || '';
  var apprCookies = sso.approvalCookies;
  var paperSeqNo = e.parameter.paperSeqNo || '79697428'; // 교육비: 79697428, 밥카(카드영수증): 101

  // ── dtl 페이지 로드 (JEX 도메인 설정) ──
  var dtlPayload = 'PTL_ID=' + encodeURIComponent(ff.PTL_ID || 'PTL_3')
    + '&CHNL_ID=' + encodeURIComponent(ff.CHNL_ID || 'CHNL_1')
    + '&USE_INTT_ID=' + encodeURIComponent(useInttId)
    + '&USER_ID=' + encodeURIComponent(session.userId)
    + '&PAPER_SEQ_NO=' + encodeURIComponent(paperSeqNo)
    + '&MENU_TYPE=R';

  try {
    var dtl1 = fetchWithCookies('https://approval.appplay.co.kr/appr_dtl_0001.act', apprCookies, {
      method: 'post', contentType: 'application/x-www-form-urlencoded', payload: dtlPayload
    });
    apprCookies = dtl1.cookies;
    debug.dtl1Status = dtl1.response.getResponseCode();
  } catch (e) { debug.dtl1Error = e.message; }

  try {
    var dtl5 = fetchWithCookies('https://approval.appplay.co.kr/appr_dtl_0005.act', apprCookies, {
      method: 'post', contentType: 'application/x-www-form-urlencoded', payload: dtlPayload
    });
    apprCookies = dtl5.cookies;
    debug.dtl5Status = dtl5.response.getResponseCode();
  } catch (e) { debug.dtl5Error = e.message; }

  // ── 밥카 등 비교육비 양식: apprline_list 페이지로 결재선 세션 설정 ──
  var listApprlineSeqNo = '';
  if (paperSeqNo !== '79697428') {
    try {
      // USER_ID, MENU_TYPE 제외한 간단한 페이로드
      var listPayload = 'PTL_ID=' + encodeURIComponent(ff.PTL_ID || 'PTL_3')
        + '&CHNL_ID=' + encodeURIComponent(ff.CHNL_ID || 'CHNL_1')
        + '&USE_INTT_ID=' + encodeURIComponent(useInttId)
        + '&PAPER_SEQ_NO=' + encodeURIComponent(paperSeqNo);
      var listResp = fetchWithCookies('https://approval.appplay.co.kr/apprline_list_0007.act', apprCookies, {
        method: 'post', contentType: 'application/x-www-form-urlencoded', payload: listPayload
      });
      apprCookies = listResp.cookies;
      debug.listStatus = listResp.response.getResponseCode();
      // HTML 응답에서 APPRLINE_SEQ_NO 추출
      var listHtml = listResp.response.getContentText();
      debug.listLen = listHtml.length;
      var seqMatch = listHtml.match(/APPRLINE_SEQ_NO['":\s]*['"]?(\d{5,})/);
      if (seqMatch) {
        listApprlineSeqNo = seqMatch[1];
        debug.listFoundSeqNo = listApprlineSeqNo;
      }
      debug.listHead = listHtml.substring(0, 300);
    } catch (e) { debug.listError = e.message; }
  }

  var ptlId = ff.PTL_ID || 'PTL_3';
  var chnlId = ff.CHNL_ID || 'CHNL_1';
  var listReferer = (paperSeqNo !== '79697428')
    ? 'https://approval.appplay.co.kr/apprline_list_0007.act'
    : 'https://approval.appplay.co.kr/appr_dtl_0005.act';
  var apprHeaders = {
    'User-Agent': BROWSER_UA, 'Cookie': apprCookies,
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': listReferer
  };

  // ── appr_paper_r008.jct (양식 정보 → APPRLINE_SEQ_NO 획득) ──
  var apprlineSeqNo = '';
  try {
    var r008Payload = '_JSON_=' + encodeURIComponent(JSON.stringify({
      PAPER_SEQ_NO: paperSeqNo, USE_INTT_ID: useInttId,
      PTL_ID: ptlId, CHNL_ID: chnlId, APPR_SEQ_NO: '', MENU_TYPE: 'R',
      '_LODING_BAR_YN_': 'Y'
    }));
    var r008Resp = UrlFetchApp.fetch('https://approval.appplay.co.kr/appr_paper_r008.jct', {
      method: 'post', contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      headers: apprHeaders, payload: r008Payload, muteHttpExceptions: true
    });
    var r008Text = r008Resp.getContentText();
    debug.r008Status = r008Resp.getResponseCode();
    debug.r008Len = r008Text.length;
    try {
      var r008Body = JSON.parse(r008Text);
      debug.r008Keys = Object.keys(r008Body).join(',');
      apprlineSeqNo = r008Body.APPRLINE_SEQ_NO || r008Body.DEFT_APPRLINE_SEQ_NO || '';
      if (!apprlineSeqNo && r008Body.REC && r008Body.REC.length > 0) {
        apprlineSeqNo = r008Body.REC[0].APPRLINE_SEQ_NO || '';
      }
      debug.r008ApprlineSeqNo = apprlineSeqNo;
      debug.r008Body = r008Text.substring(0, 500);
    } catch (pe) { debug.r008ParseErr = pe.message; debug.r008Body = r008Text.substring(0, 500); }
  } catch (e) { debug.r008Error = e.message; }

  // ── apprline_r002.jct (결재라인 컨텍스트 설정) ──
  try {
    var r002Payload = '_JSON_=' + encodeURIComponent(JSON.stringify({
      PAPER_SEQ_NO: paperSeqNo, USE_INTT_ID: useInttId,
      PTL_ID: ptlId, CHNL_ID: chnlId, APPR_SEQ_NO: '', MENU_TYPE: 'R',
      '_LODING_BAR_YN_': 'Y'
    }));
    var r002Resp = UrlFetchApp.fetch('https://approval.appplay.co.kr/apprline_r002.jct', {
      method: 'post', contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      headers: apprHeaders, payload: r002Payload, muteHttpExceptions: true
    });
    var r002Text = r002Resp.getContentText();
    debug.r002Status = r002Resp.getResponseCode();
    debug.r002Len = r002Text.length;
    // r002에서도 APPRLINE_SEQ_NO 탐색
    try {
      var r002Body = JSON.parse(r002Text);
      debug.r002Keys = Object.keys(r002Body).join(',');
      if (!apprlineSeqNo) {
        apprlineSeqNo = r002Body.APPRLINE_SEQ_NO || r002Body.DEFT_APPRLINE_SEQ_NO || '';
      }
      debug.r002Body = r002Text.substring(0, 500);
    } catch (pe) { debug.r002Body = r002Text.substring(0, 500); }
  } catch (e) { debug.r002Error = e.message; }

  // ── apprline_list HTML에서 추출한 APPRLINE_SEQ_NO 적용 ──
  if (listApprlineSeqNo && (!apprlineSeqNo || apprlineSeqNo === '-999999999')) {
    apprlineSeqNo = listApprlineSeqNo;
    debug.seqNoSource = 'listHtml';
  }

  // ── apprline_r005.jct (사용자 저장 결재라인 조회 — fallback) ──
  if (!apprlineSeqNo || apprlineSeqNo === '-999999999') {
    try {
      var r005Payload = '_JSON_=' + encodeURIComponent(JSON.stringify({
        PTL_ID: ptlId, CHNL_ID: chnlId, USE_INTT_ID: useInttId,
        USER_ID: session.userId, PAPER_SEQ_NO: paperSeqNo,
        '_LODING_BAR_YN_': 'N'
      }));
      var r005Resp = UrlFetchApp.fetch('https://approval.appplay.co.kr/apprline_r005.jct', {
        method: 'post', contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
        headers: apprHeaders, payload: r005Payload, muteHttpExceptions: true
      });
      var r005Text = r005Resp.getContentText();
      debug.r005Status = r005Resp.getResponseCode();
      debug.r005Len = r005Text.length;
      try {
        var r005Body = JSON.parse(r005Text);
        debug.r005Keys = Object.keys(r005Body).join(',');
        debug.r005Body = r005Text.substring(0, 500);
        // REC 배열에서 사용자 저장 결재라인 탐색
        var r005Rec = r005Body.REC || r005Body.APPRLINE_REC || [];
        if (Array.isArray(r005Rec) && r005Rec.length > 0) {
          // 기본 결재라인(-999999999) 외 첫 번째 값 선택
          for (var ri = 0; ri < r005Rec.length; ri++) {
            var seq = r005Rec[ri].APPRLINE_SEQ_NO || '';
            if (seq && seq !== '-999999999') {
              apprlineSeqNo = seq;
              debug.seqNoSource = 'r005';
              debug.r005FoundSeqNo = seq;
              break;
            }
          }
          // 못 찾으면 첫 번째라도 사용
          if ((!apprlineSeqNo || apprlineSeqNo === '-999999999') && r005Rec[0].APPRLINE_SEQ_NO) {
            apprlineSeqNo = r005Rec[0].APPRLINE_SEQ_NO;
            debug.seqNoSource = 'r005-first';
          }
        }
      } catch (pe) { debug.r005ParseErr = pe.message; debug.r005Body = r005Text.substring(0, 300); }
    } catch (e) { debug.r005Error = e.message; }
  }

  debug.finalApprlineSeqNo = apprlineSeqNo;

  // ── apprline_r001.jct (결재라인 목록 조회 — 브라우저와 동일 페이로드) ──
  try {
    var apprLinePayload = '_JSON_=' + encodeURIComponent(JSON.stringify({
      PTL_ID: ptlId,
      CHNL_ID: chnlId,
      USE_INTT_ID: useInttId,
      USER_ID: session.userId,
      APPRLINE_SEQ_NO: apprlineSeqNo,
      PAPER_SEQ_NO: paperSeqNo,
      ESS_APPRLINE_REC: null,
      '_LODING_BAR_YN_': 'N'
    }));

    var resp = UrlFetchApp.fetch('https://approval.appplay.co.kr/apprline_r001.jct', {
      method: 'post', contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      headers: apprHeaders, payload: apprLinePayload, muteHttpExceptions: true
    });

    var respText = resp.getContentText();
    debug.httpStatus = resp.getResponseCode();
    debug.respLen = respText.length;

    var body;
    try { body = JSON.parse(respText); } catch (pe) { body = null; }

    if (!body) {
      debug.respHead = respText.substring(0, 500);
      return createResponse({ status: 'fail', message: '결재라인 응답 파싱 실패', debug: debug });
    }

    debug.respKeys = Object.keys(body).join(',');

    // 에러 체크
    if (body.COMMON_HEAD && body.COMMON_HEAD.ERROR === true) {
      debug.errorMsg = body.COMMON_HEAD.MESSAGE;
      return createResponse({ status: 'fail', message: body.COMMON_HEAD.MESSAGE || '결재라인 조회 실패', debug: debug });
    }

    // PAPER_APPRLINE_REC (양식 기본: 부서수신 등) + USER_REC (결재선) 병합
    var paperRec = body.PAPER_APPRLINE_REC || [];
    var userRec = body.USER_REC || [];
    if (!Array.isArray(paperRec)) paperRec = [];
    if (!Array.isArray(userRec)) userRec = [];

    // USER_REC는 결재선 메타데이터(라인 이름 등)만 포함 — 실제 결재자는 PAPER_APPRLINE_REC에 있음
    // USER_REC 중 실제 결재자 정보가 있는 항목만 추가 (메타데이터 제외)
    var apprLine = [];
    if (userRec.length > 0) {
      debug.rawUserRecFirstKeys = Object.keys(userRec[0]).join(',');
      debug.rawUserRecFirst = JSON.stringify(userRec[0]).substring(0, 500);
    }
    userRec.forEach(function(r) {
      // 메타데이터 레코드 제외: APPR_USER_ID/APPR_USER_NM/APPR_USER_GB 모두 없으면 스킵
      if (!r.APPR_USER_ID && !r.APPR_USER_NM && !r.APPR_USER_GB) return;
      if (r.APPRLINE_KIND === '9') return;
      apprLine.push(r); // 원본 그대로 추가 (PAPER_APPRLINE_REC와 동일 구조)
    });
    // PAPER_APPRLINE_REC → 실제 결재자 + 부서수신 데이터
    if (paperRec.length > 0) {
      debug.rawPaperRecFirstKeys = Object.keys(paperRec[0]).join(',');
      debug.rawPaperRecFirst = JSON.stringify(paperRec[0]).substring(0, 500);
    }
    paperRec.forEach(function(r) {
      if (r.APPRLINE_KIND === '9') return;
      // 빈 항목 제외: 부서명도 사용자명도 없는 경우
      var hasUser = r.APPR_USER_ID || (r.APPR_USER_NM && r.APPR_USER_NM.trim());
      var hasDept = r.APPR_DEPT_CD || (r.APPR_DEPT_NM && r.APPR_DEPT_NM.trim());
      if (!hasUser && !hasDept) return;
      apprLine.push(r); // 원본 그대로 추가
    });

    // fallback: 둘 다 비어있으면 기존 키 탐색
    if (apprLine.length === 0) {
      apprLine = body.REC || body.APPR_LINE_REC || [];
      if (!Array.isArray(apprLine)) apprLine = [];
    }

    debug.apprLineCount = apprLine.length;
    debug.userRecCount = userRec.length;
    debug.paperRecCount = paperRec.length;
    if (apprLine.length > 0) {
      debug.firstRecordKeys = Object.keys(apprLine[0]).join(',');
    }

    // 세션에 결재라인 저장 (handleBizplayDraft에서 procGb=2 시 사용)
    session.cachedApprLine = apprLine;
    PropertiesService.getScriptProperties().setProperty(propKey, JSON.stringify(session));

    // 밥카 c004용: 원본 USER_REC + PAPER_APPRLINE_REC를 별도 프로퍼티에 저장 (race condition 방지)
    var rawForC004 = userRec.concat(paperRec);
    PropertiesService.getScriptProperties().setProperty(propKey + '_cardApprLine', JSON.stringify(rawForC004));

    debug.rawR001Keys = Object.keys(body).join(',');
    debug.rawUserRec = body.USER_REC || [];
    debug.rawPaperRec = body.PAPER_APPRLINE_REC || [];

    return createResponse({ status: 'success', apprLine: apprLine, debug: debug });
  } catch (err) {
    debug.exception = err.message;
    return createResponse({ error: 'APPR_LINE_ERROR', message: err.message, debug: debug });
  }
}
