/**
 * Bizplay 연동 모듈
 * - SSO 로그인 (bizplay → weAuth → approval gate)
 * - 교육 신청서 임시저장
 *
 * code.gs의 doGet에서 호출:
 *   handleBizplayLogin(adminRow, e)
 *   handleBizplayDraft(adminRow, e)
 *
 * 공유 의존: createResponse() (code.gs), ADMIN_COL (code.gs)
 */

/* ═══════════════ 상수 ═══════════════ */

/** GAS 기본 UA가 앱 설치 페이지를 유발하므로 브라우저 UA 사용 */
var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

    // GET approval 페이지 → 부서정보 파싱
    try {
      var apprPage = fetchWithCookies('https://approval.appplay.co.kr/appr/gate/appr_doc_layout2.act', approvalCookies);
      approvalCookies = apprPage.cookies;
      var apprHtml = apprPage.body;
      debug.apprPageStatus = apprPage.response.getResponseCode();
      debug.apprPageLen = apprHtml.length;

      var dvsnCdMatch = apprHtml.match(/id="DVSN_CD"[^>]*value="([^"]*)"/);
      var dvsnNmMatch = apprHtml.match(/id="DVSN_NM"[^>]*value="([^"]*)"/);
      if (dvsnCdMatch) dvsnCd = dvsnCdMatch[1];
      if (dvsnNmMatch) dvsnNm = dvsnNmMatch[1];
      if (dvsnNm) {
        var parts = dvsnNm.split(/[\s\/]/);
        deptShort = parts[parts.length - 1] || dvsnNm;
      }
    } catch (apprErr) {
      debug.apprPageError = apprErr.message;
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

/* ═══════════════ Bizplay 로그인 (SSO) ═══════════════ */

function handleBizplayLogin(adminRow, e) {
  const bizUserId = e.parameter.bizUserId;
  const bizPwd = e.parameter.bizPwd;
  if (!bizUserId || !bizPwd) return createResponse({ error: "MISSING_PARAMS" });

  try {
    var result = _bizplayLoginCore(bizUserId, bizPwd);
    if (result.error) {
      return createResponse({ status: 'fail', message: result.error });
    }

    if (!result.ssoComplete) {
      PropertiesService.getScriptProperties().setProperty(
        'bizplay_' + adminRow[ADMIN_COL.KNOX_ID],
        JSON.stringify({ bizplayCookies: result.bizplayCookies, userId: bizUserId, userName: result.userName, useInttId: result.useInttId, loginTime: new Date().toISOString() })
      );
      return createResponse({ status: 'success', userName: result.userName, message: result.rsltMsg, ssoComplete: false, debug: result.debug });
    }

    // 세션 저장
    var sessionData = {
      bizplayCookies: result.bizplayCookies,
      approvalCookies: result.approvalCookies,
      webankCookies: result.webankCookies,
      userId: bizUserId,
      userName: result.userName,
      deptCd: result.deptCd,
      deptNm: result.deptNm,
      deptShort: result.deptShort,
      useInttId: result.useInttId,
      loginTime: new Date().toISOString()
    };
    PropertiesService.getScriptProperties().setProperty(
      'bizplay_' + adminRow[ADMIN_COL.KNOX_ID],
      JSON.stringify(sessionData)
    );

    return createResponse({
      status: 'success', userName: result.userName, message: result.rsltMsg, ssoComplete: true,
      session: { userId: bizUserId, userName: result.userName, deptCd: result.deptCd, deptNm: result.deptNm, deptShort: result.deptShort },
      debug: result.debug
    });
  } catch (err) {
    return createResponse({ error: 'BIZPLAY_ERROR', message: err.message });
  }
}

/* ═══════════════ Bizplay 임시저장 ═══════════════ */

function handleBizplayDraft(adminRow, e) {
  const propKey = 'bizplay_' + adminRow[ADMIN_COL.KNOX_ID];
  const rawSession = PropertiesService.getScriptProperties().getProperty(propKey);
  if (!rawSession) return createResponse({ error: "NO_SESSION", message: "Bizplay 로그인이 필요합니다." });

  const session = JSON.parse(rawSession);
  if (!session.approvalCookies) return createResponse({ error: "NO_APPROVAL_SESSION", message: "SSO 세션이 없습니다. 다시 로그인해주세요." });

  try {
    const p = e.parameter;
    const empNo = session.userId.split('@')[0];

    // ITEM_REC 구성 (SEQ 0~10)
    const itemList = [
      { ITEM_SEQ_NO: "0", ITVL_1: session.deptShort || '', ITVL_2: '' },
      { ITEM_SEQ_NO: "1", ITVL_1: empNo, ITVL_2: '' },
      { ITEM_SEQ_NO: "2", ITVL_1: session.userName || '', ITVL_2: '' },
      { ITEM_SEQ_NO: "3", ITVL_1: p.courseName || '', ITVL_2: '' },
      { ITEM_SEQ_NO: "4", ITVL_1: (p.startDate || '').replace(/-/g, ''), ITVL_2: (p.endDate || '').replace(/-/g, '') },
      { ITEM_SEQ_NO: "5", ITVL_1: p.institution || '', ITVL_2: '' },
      { ITEM_SEQ_NO: "6", ITVL_1: p.eduType || '온라인', ITVL_2: '' },
      { ITEM_SEQ_NO: "7", ITVL_1: p.purpose || '', ITVL_2: '' },
      { ITEM_SEQ_NO: "8", ITVL_1: (p.cost || '0').replace(/,/g, ''), ITVL_2: '' },
      { ITEM_SEQ_NO: "9", ITVL_1: p.billing || '1회', ITVL_2: '' },
      { ITEM_SEQ_NO: "10", ITVL_1: p.remark || '', ITVL_2: '' }
    ];

    const apprCont = '<p>교육 신청서</p>';

    const draftPayload = '_JSON_=' + encodeURIComponent(JSON.stringify({
      API_YN: 'Y',
      APPR_SEQ_NO: '',
      PTL_ID: 'PTL_3',
      CHNL_ID: 'CHNL_1',
      USE_INTT_ID: session.useInttId,
      DRAFT_USER_ID: session.userId,
      DRAFT_USER_NM: session.userName,
      DRAFT_USER_POS_NM: '',
      DRAFT_USER_DEPT_CD: session.deptCd,
      DRAFT_USER_DEPT_NM: session.deptNm,
      PAPER_SEQ_NO: '79697428',
      APPR_SUBJ: '교육 신청서',
      APPR_CONT: apprCont,
      DOC_GB_CD: '',
      PROC_GB: p.procGb === '2' ? '2' : '1',
      ERP_SEQ_NO: '',
      VOUCH_REC: [],
      ITEM_REC: itemList,
      STS_REC: {},
      EDITOR_ATCH_SRNO: '',
      PRE_APPR_SEQ_NO: '',
      APPR_MODE: '',
      '_LODING_BAR_YN_': 'Y'
    }));

    const draftResp = UrlFetchApp.fetch('https://approval.appplay.co.kr/appr_c002.jct', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      headers: { 'User-Agent': BROWSER_UA, 'Cookie': session.approvalCookies },
      payload: draftPayload,
      muteHttpExceptions: true
    });

    const draftBody = JSON.parse(draftResp.getContentText());
    if (draftBody.RSLT_CD === '0000' || draftBody.ERR_CD === '0000' || !draftBody.ERR_CD) {
      return createResponse({ status: 'success', message: '임시저장 완료', result: draftBody });
    }
    return createResponse({ status: 'fail', message: draftBody.RSLT_MSG || draftBody.ERR_MSG || '임시저장 실패', result: draftBody });
  } catch (err) {
    return createResponse({ error: 'DRAFT_ERROR', message: err.message });
  }
}
