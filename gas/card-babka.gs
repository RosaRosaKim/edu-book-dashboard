/**
 * 밥카(법인카드 중식대) 모듈
 * - 밥카 알람 수신 설정 (웹페이지관리 시트 I열 + K열)
 * - 매월 16일 / 18일 자동 알림 발송 (K열 기준)
 *
 * code.gs의 doGet에서 호출:
 *   handleUpdateCardAlarm(adminRow, e)
 *
 * 공유 의존: createResponse() (code.gs), SHEET_NAME (code.gs)
 */

/* ═══════════════ 상수 ═══════════════ */

/** 웹페이지관리 시트 밥카 알람 컬럼 (G열 = index 6) */
var CARD_ALARM_COL = 7; // 1-based: G열

/** 웹페이지관리 시트 밥카 평일 잔액알림 PW 컬럼 (H열 = index 7) */
var CARD_DAILY_COL = 8; // 1-based: H열

/** 웹페이지관리 시트 밥카 16일 결재 알람 컬럼 (I열 = index 8) */
var CARD_16_ALARM_COL = 9; // 1-based: I열

/** XOR 암호화 키 */
var ENCRYPT_SECRET = 'edu-book-dashboard-card-v1';

/* ═══════════════ 밥카 알람 설정 ═══════════════ */

/**
 * 밥카 알람 수신 동의/해제
 * action=updateCardAlarm&token={UUID}&isAgreed={true/false}
 */
function handleUpdateCardAlarm(adminRow, e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var mgmtSheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  var isAgreed = (e.parameter.isAgreed === 'true');
  var newVal = isAgreed ? 'Y' : 'N';

  // adminRow: 웹페이지관리 시트의 해당 사용자 행 번호
  mgmtSheet.getRange(adminRow, CARD_ALARM_COL).setValue(newVal);      // I열 (기존 호환)
  mgmtSheet.getRange(adminRow, CARD_16_ALARM_COL).setValue(newVal);   // K열 (16일 결재 알람)

  return createResponse({ status: 'success' });
}

/* ═══════════════ 밥카 자동 알림 ═══════════════ */

/**
 * 매월 16일 트리거: 밥카 결재 요청 알림 발송
 * 트리거 설정: 시간 기반 트리거 → 매월 16일 오전 9시
 */
function sendCardAlarmDay16() {
  _sendCardAlarm('밥카 결재 진행해줘! 🍚');
}

/**
 * 매월 18일 트리거: 미상신자 리마인더
 * 트리거 설정: 시간 기반 트리거 → 매월 18일 오전 9시
 */
function sendCardAlarmDay18() {
  // TODO: 결재상신 내역 체크 후 미상신자만 발송
  _sendCardAlarm('밥카 결재 아직 안 했어? 잊지 말고 상신해줘! 🍚');
}

/**
 * 공통 알림 발송 로직
 */
function _sendCardAlarm(message) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var mgmtSheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  var data = mgmtSheet.getDataRange().getValues();

  // 헤더 제외
  for (var i = 1; i < data.length; i++) {
    var knoxId = data[i][0]; // A열: knoxId
    var card16Alarm = data[i][CARD_16_ALARM_COL - 1]; // K열: 밥카16일알람수신여부

    if (!knoxId || card16Alarm !== 'Y') continue;

    try {
      _sendFlowCardMessage(knoxId, message);
    } catch (e) {
      Logger.log('[밥카알림] 발송 실패 - ' + knoxId + ': ' + e.message);
    }
  }
}

/**
 * Flow 메신저로 밥카 알림 발송
 */
function _sendFlowCardMessage(knoxId, message) {
  var link = 'https://rosarosakim.github.io/edu-book-dashboard/edu-book-dashboard.html?tab=card';
  sendFlowGAS(knoxId, message, link, '밥카 알림');
}

/* ═══════════════ 암호화/복호화 ═══════════════ */

function _encryptPw(plain) {
  var key = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, ENCRYPT_SECRET);
  var bytes = Utilities.newBlob(plain).getBytes();
  var enc = bytes.map(function(b, i) { return b ^ key[i % key.length]; });
  return Utilities.base64Encode(enc);
}

function _decryptPw(cipher) {
  var key = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, ENCRYPT_SECRET);
  var enc = Utilities.base64Decode(cipher);
  var dec = enc.map(function(b, i) { return b ^ key[i % key.length]; });
  return Utilities.newBlob(dec).getDataAsString();
}

/* ═══════════════ 평일 잔액알림 설정 ═══════════════ */

/**
 * 평일 잔액알림 수신 동의/해제
 * action=saveCardDailyAlarm&token={UUID}&isAgreed={true/false}
 * I열만 Y/N으로 변경 (J열 PW는 건드리지 않음)
 *
 * @param {number} rowIndex - 0-based 행 인덱스 (adminData 배열 기준)
 * @param {object} e - request event
 */
function handleSaveCardDailyAlarm(rowIndex, e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var adminSheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  var isAgreed = (e.parameter.isAgreed === 'true');

  adminSheet.getRange(rowIndex + 1, CARD_ALARM_COL).setValue(isAgreed ? 'Y' : 'N'); // I열: 잔액알림 수신여부

  return createResponse({ status: 'success' });
}

/* ═══════════════ 평일 잔액알림 발송 ═══════════════ */

/**
 * 매일 평일 11시 트리거: 밥카 잔액 알림 발송
 * 트리거 설정: 시간 기반 트리거 → 매일 오전 11시
 * 주말 + 공휴일(근로자의날 포함) 제외
 */
function sendCardDailyBalance() {
  var now = new Date();
  var dow = now.getDay();
  if (dow === 0 || dow === 6) return;
  if (_isHolidayServer(now)) return;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var adminSheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  var data = adminSheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    var knoxId = data[i][0]; // A열: knoxId
    var dailyAlarm = data[i][CARD_ALARM_COL - 1]; // I열: 잔액알림 수신여부
    var encPw = data[i][CARD_DAILY_COL - 1]; // J열: 암호화된 PW

    if (!knoxId || dailyAlarm !== 'Y' || !encPw) continue;

    try {
      var userId = knoxId + '@emro.co.kr';
      var password = _decryptPw(encPw);

      // 로그인 → webank 쿠키 획득
      var loginResult = _bizplayLoginCore(userId, password);
      if (loginResult.error || !loginResult.webankCookies) {
        Logger.log('[잔액알림] 로그인 실패 - ' + knoxId + ': ' + (loginResult.error || 'webank 쿠키 없음'));
        continue;
      }

      // 사용내역 조회
      var result = _callWebankApi(loginResult.webankCookies);
      if (result.expired || result.error) {
        Logger.log('[잔액알림] 조회 실패 - ' + knoxId + ': ' + (result.error || 'expired'));
        continue;
      }

      // 잔액 계산 (교통비 제외)
      var transportKeywords = ['티머니 버스', '티머니 지하철'];
      var usedSum = 0;
      var usedCount = 0;
      var records = result.records || [];
      records.forEach(function(r) {
        var merchant = (r.merchant || '').trim();
        if (transportKeywords.some(function(k) { return merchant.indexOf(k) >= 0; })) return;
        usedSum += Number(r.cost) || 0;
        usedCount++;
      });

      // 예산 계산 (영업일 × 10000원)
      var budget = _calcCardBudget();
      var remain = budget - usedSum;

      var msg = '밥카 잔액: ' + _fmtMoney(remain) + '원 / ' + _fmtMoney(budget) + '원 (사용 ' + _fmtMoney(usedSum) + '원, ' + usedCount + '건)';
      _sendFlowCardMessage(knoxId, msg);
      Logger.log('[잔액알림] 발송 완료 - ' + knoxId + ': ' + msg);
    } catch (ex) {
      Logger.log('[잔액알림] 예외 - ' + knoxId + ': ' + ex.message);
    }
  }
}

/** 공휴일 여부 체크 (holidays.hyunbin.page API + 근로자의 날) */
function _isHolidayServer(date) {
  var yyyy = date.getFullYear();
  var mm = ('0' + (date.getMonth() + 1)).slice(-2);
  var dd = ('0' + date.getDate()).slice(-2);
  var dateStr = yyyy + '-' + mm + '-' + dd;

  // 근로자의 날
  if (mm === '05' && dd === '01') return true;

  try {
    var resp = UrlFetchApp.fetch('https://holidays.hyunbin.page/' + yyyy + '.json', { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return false;
    var holidays = JSON.parse(resp.getContentText());
    return dateStr in holidays;
  } catch (e) {
    Logger.log('[잔액알림] 공휴일 API 실패: ' + e.message);
    return false;
  }
}

/** 현재 기간 영업일 수 기반 예산 계산 (공휴일+근로자의날 제외) */
function _calcCardBudget() {
  var period = _getCardQueryPeriod();
  var start = _parseDateStr(period.from);
  var end = _parseDateStr(period.to);

  // 기간에 걸치는 연도의 공휴일 로드
  var holidaySet = {};
  var years = {};
  years[start.getFullYear()] = true;
  years[end.getFullYear()] = true;
  for (var y in years) {
    try {
      var resp = UrlFetchApp.fetch('https://holidays.hyunbin.page/' + y + '.json', { muteHttpExceptions: true });
      if (resp.getResponseCode() === 200) {
        var data = JSON.parse(resp.getContentText());
        for (var k in data) holidaySet[k] = true;
      }
    } catch (e) {}
    // 근로자의 날
    holidaySet[y + '-05-01'] = true;
  }

  var bizDays = 0;
  var d = new Date(start);
  while (d <= end) {
    var dow = d.getDay();
    var mm = ('0' + (d.getMonth() + 1)).slice(-2);
    var dd = ('0' + d.getDate()).slice(-2);
    var dateStr = d.getFullYear() + '-' + mm + '-' + dd;
    if (dow !== 0 && dow !== 6 && !holidaySet[dateStr]) bizDays++;
    d.setDate(d.getDate() + 1);
  }
  return bizDays * 10000;
}

/** "20260215" → Date */
function _parseDateStr(s) {
  return new Date(Number(s.substring(0, 4)), Number(s.substring(4, 6)) - 1, Number(s.substring(6, 8)));
}

/** 금액 포맷 (천단위 콤마) */
function _fmtMoney(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ═══════════════ 밥카 사용내역 조회 ═══════════════ */

/**
 * 밥카(법인카드) 사용내역 조회
 * action=cardRecords&token={UUID}
 *
 * Bizplay SSO 세션 → webank 인증 → 카드 사용내역 API 호출
 */
function handleCardRecords(adminRow, e) {
  var propKey = 'bizplay_' + adminRow[ADMIN_COL.KNOX_ID];
  var rawSession = PropertiesService.getScriptProperties().getProperty(propKey);
  if (!rawSession) return _cardAutoRelogin(adminRow, e, propKey);

  var session = JSON.parse(rawSession);
  if (!session.bizplayCookies) return _cardAutoRelogin(adminRow, e, propKey);

  try {
    var webankCookies = session.webankCookies || '';

    // 자동 복구 1: webankCookies 없으면 bizplayCookies로 SSO 획득 시도
    if (!webankCookies) {
      console.log('[card] webankCookies 없음 → _acquireWebankCookies 시도');
      var acquired = _acquireWebankCookies(session);
      if (acquired.cookies) {
        webankCookies = acquired.cookies;
        session.webankCookies = webankCookies;
        PropertiesService.getScriptProperties().setProperty(propKey, JSON.stringify(session));
        console.log('[card] webank 쿠키 복구 성공');
      }
    }

    // 자동 복구 2: 여전히 없으면 저장된 PW로 재로그인
    if (!webankCookies) {
      console.log('[card] webank 쿠키 복구 실패 → 재로그인 시도');
      var reloginResult = _cardTryRelogin(adminRow, propKey);
      if (reloginResult.webankCookies) {
        webankCookies = reloginResult.webankCookies;
        session = reloginResult.session;
      }
    }

    if (!webankCookies) {
      return createResponse({ error: 'WEBANK_SSO_FAIL', message: 'webank 인증 정보가 없어. Bizplay 재로그인 해줘.' });
    }

    // API 호출 (기간 파라미터 지원)
    var fromDt = e.parameter.fromDt || '';
    var toDt = e.parameter.toDt || '';
    var result = _callWebankApi(webankCookies, fromDt, toDt);

    if (result.expired) {
      // 쿠키 만료 → 재로그인으로 한번 더 시도
      console.log('[card] webank 세션 만료 → 재로그인 시도');
      var retry = _cardTryRelogin(adminRow, propKey);
      if (retry.webankCookies) {
        result = _callWebankApi(retry.webankCookies, fromDt, toDt);
        if (!result.expired && !result.error) {
          return createResponse({ status: 'success', records: result.records, totalCount: result.totalCount });
        }
      }
      session.webankCookies = '';
      PropertiesService.getScriptProperties().setProperty(propKey, JSON.stringify(session));
      return createResponse({ error: 'SESSION_EXPIRED', message: '세션이 만료됐어. Bizplay 재로그인 해줘.' });
    }

    if (result.error) {
      return createResponse({ error: result.error, message: result.message });
    }

    return createResponse({ status: 'success', records: result.records, totalCount: result.totalCount });
  } catch (err) {
    return createResponse({ error: 'CARD_API_ERROR', message: err.message });
  }
}

/** 저장된 PW로 Bizplay 재로그인 → webank 쿠키 획득 */
function _cardTryRelogin(adminRow, propKey) {
  var encPw = adminRow[7]; // H열: 암호화된 Bizplay PW
  if (!encPw || !String(encPw).trim()) return { webankCookies: '' };

  try {
    var bizUserId = adminRow[ADMIN_COL.KNOX_ID] + '@emro.co.kr';
    var bizPwd = _decryptPw(String(encPw));
    var result = _bizplayLoginCore(bizUserId, bizPwd);
    if (result.error || !result.webankCookies) {
      // _bizplayLoginCore의 webank SSO 실패 시 _acquireWebankCookies로 재시도
      if (!result.error && result.bizplayCookies) {
        var acquired = _acquireWebankCookies({ bizplayCookies: result.bizplayCookies });
        if (acquired.cookies) result.webankCookies = acquired.cookies;
      }
    }
    if (!result.error) {
      var sessionData = {
        bizplayCookies: result.bizplayCookies,
        approvalCookies: result.approvalCookies || '',
        webankCookies: result.webankCookies || '',
        userId: bizUserId,
        userName: result.userName,
        deptCd: result.deptCd || '',
        deptNm: result.deptNm || '',
        deptShort: result.deptShort || '',
        useInttId: result.useInttId || '',
        loginTime: new Date().toISOString()
      };
      PropertiesService.getScriptProperties().setProperty(propKey, JSON.stringify(sessionData));
      console.log('[card] 재로그인 성공, webankCookies: ' + (result.webankCookies ? 'Y' : 'N'));
      return { webankCookies: result.webankCookies || '', session: sessionData };
    }
  } catch (err) {
    console.log('[card] 재로그인 실패: ' + err.message);
  }
  return { webankCookies: '' };
}

/** 세션 없을 때 자동 재로그인 시도 후 카드 조회 */
function _cardAutoRelogin(adminRow, e, propKey) {
  var retry = _cardTryRelogin(adminRow, propKey);
  if (retry.webankCookies) {
    var fromDt = e.parameter.fromDt || '';
    var toDt = e.parameter.toDt || '';
    var result = _callWebankApi(retry.webankCookies, fromDt, toDt);
    if (!result.expired && !result.error) {
      return createResponse({ status: 'success', records: result.records, totalCount: result.totalCount });
    }
  }
  return createResponse({ error: 'NO_SESSION', message: 'Bizplay 로그인이 필요해.' });
}

/** webank 카드 내역 API 호출 (분리) */
function _callWebankApi(webankCookies, fromDt, toDt) {
  var period = (fromDt && toDt) ? { from: fromDt, to: toDt } : _getCardQueryPeriod();

  var payload = '_JSON_=' + encodeURIComponent(JSON.stringify({
    PAGE_NO: '1', PAGE_SZ: '100',
    APV_YN: 'A', PROC_STS: '', ORD_COL: 'APV_DT', ORD_MT: 'DESC',
    BOX_CD: '0', SEARCH_NM: '',
    FROM_APV_DT: period.from, TO_APV_DT: period.to,
    PAGE_URL_ADR: 'eusr_0001_01',
    CNTS_IDNT_ID: 'CRD_MAGR_NEW', GB: 'R'
  }));

  var resp = UrlFetchApp.fetch('https://webank.appplay.co.kr/eusr_9001_01_r001.jct', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    headers: { 'User-Agent': BROWSER_UA, 'Cookie': webankCookies },
    payload: payload,
    muteHttpExceptions: true
  });

  var body = resp.getContentText();
  var data;
  try { data = JSON.parse(body); } catch (pe) {
    return { expired: true };
  }

  if (data.COMMON_HEAD && data.COMMON_HEAD.ERROR) {
    return { expired: true };
  }

  var records = (data.REC || []).map(function(r) {
    return {
      date: _fmtApvDt(r.APV_DT, r.APV_TM),
      merchant: r.MEST_NM || '',
      cost: Math.round(Number(r.BUY_SUM) || 0),
      category: r.CARD_TPBZ_NM || '',
      apvNo: r.APV_NO || '',
      purpose: r.PROC_STS || '',
      cardNo: r.CARD_NO || '',
      txSeq: r.TX_SEQ || '',
      seq: r.SEQ || ''
    };
  });

  return { records: records, totalCount: Number(data.TOT_CNT) || 0 };
}

/* ─── webank SSO 쿠키 획득 ─── */

/**
 * Bizplay 세션 쿠키를 이용하여 webank SSO 수행
 * weAuth → sendRdmKey 파싱 → gate URL POST → webank 쿠키
 */
function _acquireWebankCookies(session) {
  var debug = {};
  try {
    debug.bizplayCookieLen = (session.bizplayCookies || '').length;

    // Step 1: POST weAuth → 폼 페이지 또는 sendRdmKey
    var authVal = JSON.stringify({
      SVC_PTRN: 'M', APP_TARG: 'Y',
      RSVD1: '', RSVD2: '', RSVD3: '', RSVD4: '', RSVD5: ''
    });
    var weAuthPayload = 'auth_srno=88'
      + '&auth_val=' + encodeURIComponent(authVal)
      + '&STND_PAGE=' + encodeURIComponent('https://webank.appplay.co.kr/rcard_main.act')
      + '&quick_menu=&quick_param=&stup=';

    var weAuth = fetchWithCookies('https://www.bizplay.co.kr/weAuth', session.bizplayCookies, {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      payload: weAuthPayload
    });

    var html = weAuth.body;
    debug.weAuthStatus = weAuth.response.getResponseCode();
    debug.weAuthLen = html.length;

    // (A) 직접 sendRdmKey가 있으면 바로 사용 (세션이 살아있는 경우)
    var rdmMatch = html.match(/sendRdmKey\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
    if (rdmMatch) {
      debug.method = 'direct_rdmKey';
      return _followRdmKey(rdmMatch[1], rdmMatch[2], debug);
    }

    // (B) weAuth 폼 페이지 → /consumer → AUTH_SERVLET → gate
    debug.method = 'form_consumer';

    // Step 2: 폼 hidden input 파싱
    var inputs = {};
    var inputRegex = /<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/gi;
    var m;
    while ((m = inputRegex.exec(html)) !== null) { inputs[m[1]] = m[2]; }
    // value가 name보다 앞에 오는 경우도 처리
    var inputRegex2 = /<input[^>]*value="([^"]*)"[^>]*name="([^"]+)"[^>]*>/gi;
    while ((m = inputRegex2.exec(html)) !== null) { if (!inputs[m[2]]) inputs[m[2]] = m[1]; }
    debug.formKeys = Object.keys(inputs);

    // cntsId 추출: 인라인 스크립트에서 execute('xxx') 패턴 찾기
    var execMatch = html.match(/execute\s*\(\s*['"]([^'"]+)['"]/);
    var cntsId = execMatch ? execMatch[1] : (inputs['APP_SRNO'] || '88');
    debug.cntsId = cntsId;

    // Step 3: POST /consumer → AUTH_SERVLET, USER_DATA
    debug.weAuthCookieLen = (weAuth.cookies || '').length;
    var consumerResp = UrlFetchApp.fetch('https://www.bizplay.co.kr/consumer', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      headers: {
        'User-Agent': BROWSER_UA,
        'Cookie': weAuth.cookies,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.bizplay.co.kr/weAuth'
      },
      payload: 'cntsId=' + encodeURIComponent(cntsId) + '&lang=DF',
      muteHttpExceptions: true
    });

    var consumerBody = consumerResp.getContentText();
    debug.consumerStatus = consumerResp.getResponseCode();

    var consumerData;
    try { consumerData = JSON.parse(consumerBody); } catch (pe) {
      debug.consumerBody = consumerBody.substring(0, 500);
      return { cookies: '', debug: debug };
    }

    debug.consumerResCd = consumerData.RES_CD;
    if (consumerData.RES_CD !== '0000') {
      debug.consumerMsg = consumerData.RES_MSG || '';
      return { cookies: '', debug: debug };
    }

    var authServlet = consumerData.AUTH_SERVLET;
    var userData = consumerData.USER_DATA;
    debug.authServlet = authServlet;

    // Step 4: 폼 submit → AUTH_SERVLET
    var formParts = [];
    for (var key in inputs) {
      formParts.push(encodeURIComponent(key) + '=' + encodeURIComponent(inputs[key]));
    }
    formParts.push('userData=' + encodeURIComponent(JSON.stringify(userData)));
    var formPayload = formParts.join('&');

    var authResp = fetchWithCookies(authServlet, weAuth.cookies, {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: formPayload
    });

    debug.authStatus = authResp.response.getResponseCode();
    debug.authBodyLen = authResp.body.length;
    debug.authCookieLen = authResp.cookies.length;

    // AUTH_SERVLET 응답에서 sendRdmKey 탐색
    var rdmMatch2 = authResp.body.match(/sendRdmKey\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
    if (rdmMatch2) {
      return _followRdmKey(rdmMatch2[1], rdmMatch2[2], debug);
    }

    // sendRdmKey 없으면 리다이렉트로 쿠키를 얻었을 수 있음
    debug.authBodyHead = authResp.body.substring(0, 500);
    if (authResp.cookies && authResp.cookies.length > 50) {
      return { cookies: authResp.cookies, debug: debug };
    }

    return { cookies: '', debug: debug };
  } catch (e) {
    debug.error = e.message;
    return { cookies: '', debug: debug };
  }
}

/** sendRdmKey gate 호출 공통 */
function _followRdmKey(gateUrl, rdmKey, debug) {
  debug.gateUrl = gateUrl;
  var gate = fetchWithCookies(gateUrl, '', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: 'RDM_KEY=' + encodeURIComponent(rdmKey)
  });
  debug.gateStatus = gate.response.getResponseCode();
  debug.gateCookieLen = (gate.cookies || '').length;
  return { cookies: gate.cookies, debug: debug };
}

/* ═══════════════ 밥카 결재 제출 ═══════════════ */

/**
 * 밥카 결재 올리기 (USER_NO_REC 제출)
 * action=cardApproval&token={UUID}&selectedRecords={JSON}
 *
 * 1. eapr_1001_01.act 페이지 GET → 사용자 정보 파싱
 * 2. USER_NO_REC 구성
 * 3. 결재 API POST
 */
function handleCardApproval(adminRow, e) {
  var propKey = 'bizplay_' + adminRow[ADMIN_COL.KNOX_ID];
  var rawSession = PropertiesService.getScriptProperties().getProperty(propKey);
  if (!rawSession) return createResponse({ error: 'NO_SESSION', message: 'Bizplay 로그인이 필요해.' });

  var session = JSON.parse(rawSession);
  var webankCookies = session.webankCookies || '';
  if (!webankCookies) return createResponse({ error: 'NO_SESSION', message: 'webank 인증 정보가 없어. Bizplay 재로그인 해줘.' });

  var mode = e.parameter.mode || 'temp'; // 'temp' = 임시저장, 'approve' = 결재요청
  var selectedJson = e.parameter.selectedRecords;
  if (!selectedJson) return createResponse({ error: 'NO_SELECTION', message: '선택된 레코드가 없어.' });

  var selected;
  try { selected = JSON.parse(selectedJson); } catch (pe) {
    return createResponse({ error: 'INVALID_PARAM', message: '선택 레코드 파싱 실패' });
  }
  if (!selected || selected.length === 0) return createResponse({ error: 'NO_SELECTION', message: '선택된 레코드가 없어.' });

  var debug = {};
  try {
    // Step 1: eusr_9001_01.act → Form1 hidden 필드
    var actResp = UrlFetchApp.fetch('https://webank.appplay.co.kr/eusr_9001_01.act', {
      method: 'get',
      headers: { 'User-Agent': BROWSER_UA, 'Cookie': webankCookies },
      muteHttpExceptions: true, followRedirects: false
    });
    if (actResp.getResponseCode() === 302 || actResp.getResponseCode() === 301) {
      session.webankCookies = '';
      PropertiesService.getScriptProperties().setProperty(propKey, JSON.stringify(session));
      return createResponse({ error: 'SESSION_EXPIRED', message: '세션이 만료됐어.' });
    }
    var actHtml = actResp.getContentText();
    debug.webankCookieLen = webankCookies.length;

    // Form1 hidden 필드 파싱
    var formFields = _parseFormFields(actHtml, 'Form1');
    debug.formFields = formFields;

    // Step 2: 카드 내역 raw API 호출 → 선택 레코드 매칭
    var rawResult = _callWebankApiRaw(webankCookies);
    if (rawResult.expired) {
      session.webankCookies = '';
      PropertiesService.getScriptProperties().setProperty(propKey, JSON.stringify(session));
      return createResponse({ error: 'SESSION_EXPIRED', message: '세션 만료' });
    }
    debug.rawRecCount = (rawResult.records || []).length;

    // 선택된 레코드 매칭 (CARD_NO + SEQ + APV_NO)
    var matched = [];
    selected.forEach(function(sel) {
      var found = rawResult.records.filter(function(r) {
        return r.CARD_NO === sel.cardNo
          && String(r.SEQ) === String(sel.seq)
          && (!sel.apvNo || String(r.APV_NO) === String(sel.apvNo));
      });
      if (found.length > 0) matched.push(found[0]);
    });
    debug.matchedCount = matched.length;

    if (matched.length === 0) {
      return createResponse({ error: 'NO_MATCH', message: '선택한 레코드를 찾을 수 없어.', debug: debug });
    }

    // Step 3: 파이프 구분 리스트 구성
    var lists = { CARD_NO: [], APV_DT: [], APV_NO: [], APV_CAN_YN: [], SEQ: [], CHNL_ID: [], CNTS_ID: [] };
    matched.forEach(function(r) {
      lists.CARD_NO.push(r.CARD_NO || '');
      lists.APV_DT.push(r.APV_DT || '');
      lists.APV_NO.push(r.APV_NO || '');
      lists.APV_CAN_YN.push(r.APV_CAN_YN || '');
      lists.SEQ.push(r.SEQ || '');
      lists.CHNL_ID.push(r.CHNL_ID || formFields.CHNL_ID || 'CHNL_1');
      lists.CNTS_ID.push(r.CNTS_ID || formFields.CNTS_ID || 'CRD_MAGR_NEW_USR');
    });

    // Step 4: Form1 POST → eapr_1001_01.act
    var postData = {};
    for (var k in formFields) postData[k] = formFields[k];
    postData['CARD_NO_LIST'] = lists.CARD_NO.join('|');
    postData['APV_DT_LIST'] = lists.APV_DT.join('|');
    postData['APV_NO_LIST'] = lists.APV_NO.join('|');
    postData['APV_CAN_YN_LIST'] = lists.APV_CAN_YN.join('|');
    postData['SEQ_LIST'] = lists.SEQ.join('|');
    postData['CHNL_LIST'] = lists.CHNL_ID.join('|');
    postData['CNTS_LIST'] = lists.CNTS_ID.join('|');
    postData['LNGG_DSNC'] = 'ko';

    debug.postLists = {
      CARD_NO_LIST: postData['CARD_NO_LIST'],
      APV_DT_LIST: postData['APV_DT_LIST'],
      APV_NO_LIST: postData['APV_NO_LIST'],
      SEQ_LIST: postData['SEQ_LIST']
    };

    var formPayload = Object.keys(postData).map(function(key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(postData[key]);
    }).join('&');

    var eaprResp = UrlFetchApp.fetch('https://webank.appplay.co.kr/eapr_1001_01.act', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      headers: {
        'User-Agent': BROWSER_UA,
        'Cookie': webankCookies,
        'Referer': 'https://webank.appplay.co.kr/eusr_9001_01.act'
      },
      payload: formPayload,
      muteHttpExceptions: true
    });

    var eaprHtml = eaprResp.getContentText();
    debug.eaprStatus = eaprResp.getResponseCode();
    debug.eaprLen = eaprHtml.length;

    // 에러 페이지 체크
    if (eaprHtml.indexOf('페이지 오류 안내') >= 0) {
      debug.eaprHead = eaprHtml.substring(0, 1000);
      return createResponse({ error: 'EAPR_ERROR', message: 'eapr 팝업 로드 실패', debug: debug });
    }

    // eapr 폼 필드 전체 파싱
    var eaprForm = _parseFormFields(eaprHtml, '');
    var isTemp = (mode !== 'approve');
    debug = { eaprStatus: eaprResp.getResponseCode(), matchedCount: matched.length };
    debug.eaprKeyFields = {
      APPR_DEFAULT_TYPE: eaprForm.APPR_DEFAULT_TYPE || '',
      PAPER_SEQ_NO: eaprForm.PAPER_SEQ_NO || '',
      APPR_SEQ_NO: eaprForm.APPR_SEQ_NO || '',
      APPR_STS: eaprForm.APPR_STS || '',
      CNTS_ID: eaprForm.CNTS_ID || ''
    };

    // === Step 6: r010 검증 호출 ===
    var rcptRec = matched.map(function(r) {
      return {
        DEDCT_YN: 'Y',
        CURR_CD: r.CURR_CD || 'KRW',
        FX_RATE: 'null',
        OVRS_TX_AMT: 'NaN',
        CARD_NO: r.CARD_NO || '',
        CNTS_ID: 'CRD_MAGR_NEW',
        BANK_CD: r.BANK_CD || '',
        APV_DT: r.APV_DT || '',
        APV_TM: r.APV_TM || '',
        TRAN_NO: r.APV_CAN_YN || 'A',
        APV_CAN_YN: r.APV_CAN_YN || 'A',
        TRAN_DATE: r.APV_DT || '',
        APPR_NO: r.APV_NO || '',
        TOT_AMT: _cleanAmt(r.BUY_SUM),
        SUPPLY_AMT: _cleanAmt(r.SPLY_AMT),
        VAT_AMT: _cleanAmt(r.VAT_AMT),
        SEQ: r.SEQ || '',
        CARD_CORP_CD: r.BANK_CD || '',
        APPR_SEQ_NO: '',
        MEST_TAXT_TYP_INFO: '일반',
        TRAN_KIND_CD: 'C0093',
        TRAN_KIND_NM: '중식대(공통)',
        TRAN_KIND_ERP_CD: '54901',
        MGMT1: '중식대',
        MGMT_NM1: '* 적요',
        SUMMARY: '중식대',
        REQ_AMT: _cleanAmt(r.BUY_SUM),
        TX_DTM: r.APV_DT || '',
        BGT_DVSN_CD: '1',
        BGT_DVSN_NM: '제조회계단위',
        MGMT7: '',
        MGMT_NM7: '퇴근시간',
        BIZ_UNIT: '41999',
        BIZ_UNIT_NM: '중식대',
        BIZ_UNIT_ERP_CD: 'EX049',
        ADD_ITEM_REC: [],
        API_REC: []
      };
    });

    // 결재요청 시: bizplayApprLine에서 저장한 APPRLINE_SEQ_NO를 r010에 전달
    var savedApprLineSeqNo = '';
    var savedApprLineRaw = null;
    if (!isTemp) {
      var alProp = PropertiesService.getScriptProperties().getProperty(propKey + '_cardApprLine');
      if (alProp) {
        try {
          savedApprLineRaw = JSON.parse(alProp);
          // APPRLINE_SEQ_NO 추출 (첫 번째 비-0 값)
          savedApprLineRaw.forEach(function(r) {
            if (!savedApprLineSeqNo && r.APPRLINE_SEQ_NO && r.APPRLINE_SEQ_NO !== '0') {
              savedApprLineSeqNo = r.APPRLINE_SEQ_NO;
            }
          });
          debug.savedApprLineSeqNo = savedApprLineSeqNo;
        } catch (pe) { debug.alPropParseFail = pe.message; }
      }
    }

    var r010Json = {
      PTL_ID: eaprForm.PTL_ID || 'PTL_3',
      USE_INTT_ID: eaprForm.USE_INTT_ID || '',
      CHNL_ID: eaprForm.CHNL_ID || 'CHNL_1',
      RCPT_REC: rcptRec,
      CARD_REC: rcptRec
    };
    // 결재요청: APPRLINE_SEQ_NO + 결재라인 REC를 r010에 전달 (브라우저와 동일 형식)
    if (savedApprLineSeqNo) {
      r010Json.APPRLINE_SEQ_NO = savedApprLineSeqNo;
    }
    if (!isTemp && savedApprLineRaw && savedApprLineRaw.length > 0) {
      // 브라우저와 동일한 최소 필드만 전달 (7개)
      r010Json.REC = savedApprLineRaw.map(function(r) {
        return {
          APPR_ORD: r.APPR_ORD || '0',
          APPR_USER_GB: r.APPR_USER_GB || '1',
          APPRLINE_KIND: r.APPRLINE_KIND || '2',
          RECENT_SAVE_YN: r.RECENT_SAVE_YN || 'Y',
          BOTTOM_FIXED_YN: r.BOTTOM_FIXED_YN || 'N',
          DEPT_CD: r.DEPT_CD || r.APPR_DEPT_CD || '',
          DEPT_NM: r.DEPT_NM || r.APPR_DEPT_NM || ''
        };
      });
      debug.r010ApprLineRec = r010Json.REC;
    }

    var r010Payload = '_JSON_=' + encodeURIComponent(JSON.stringify(r010Json));
    var r010Resp = UrlFetchApp.fetch('https://webank.appplay.co.kr/eapr_1001_01_r010.jct', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      headers: {
        'User-Agent': BROWSER_UA,
        'Cookie': webankCookies,
        'Referer': 'https://webank.appplay.co.kr/eapr_1001_01.act'
      },
      payload: r010Payload,
      muteHttpExceptions: true
    });

    var r010Body = r010Resp.getContentText();
    debug.r010Status = r010Resp.getResponseCode();
    debug.r010BodyLen = r010Body.length;
    var r010Data;
    try { r010Data = JSON.parse(r010Body); } catch (pe) { r010Data = null; }
    debug.r010Result = r010Data ? { RSLT_CD: r010Data.RSLT_CD, RSLT_MSG: r010Data.RSLT_MSG, hasApprLine: !!(r010Data.APPRLINE_REC && r010Data.APPRLINE_REC.length > 0) } : r010Body.substring(0, 1000);

    if (!r010Data || r010Data.RSLT_CD !== '0000') {
      debug.r010Full = r010Body.substring(0, 2000);
      debug.rcptRecSample = rcptRec.length > 0 ? rcptRec[0] : null;
      debug.rcptRecCount = rcptRec.length;
      debug.r010Sent = JSON.stringify(r010Json).substring(0, 2000);
      return createResponse({ status: 'debug', message: 'r010 검증 실패', debug: debug });
    }

    // === Step 7: c004 저장 호출 (r010 성공 후) ===
    var totAmt = 0;
    matched.forEach(function(r) { totAmt += Math.round(Number(r.BUY_SUM) || 0); });

    var c004Json = {
      USER_NM: eaprForm.USER_NM || '',
      USER_NO: eaprForm.USER_NO || '',
      USER_ID: eaprForm.USER_ID || '',
      DEPT_NM: eaprForm.DEPT_NM || '',
      BIZ_NO: eaprForm.BIZ_NO || '',
      POS_NM: eaprForm.POS_NM || '',
      DEPT_CD: eaprForm.DEPT_CD || '',
      DVSN_CD: eaprForm.DVSN_CD || '',
      SITE_CD: eaprForm.SITE_CD || '',
      SITE_NM: eaprForm.SITE_NM || '',
      CLPH_NO: eaprForm.CLPH_NO || '',
      PTL_ID: eaprForm.PTL_ID || '',
      USE_INTT_ID: eaprForm.USE_INTT_ID || '',
      CHNL_ID: eaprForm.CHNL_ID || '',
      BASE_CHNL_ID: eaprForm.BASE_CHNL_ID || eaprForm.CHNL_ID || '',
      CNTS_ID: eaprForm.CNTS_ID || 'CRD_MAGR_NEW',
      CORPCARD_PRE_APPR_SEQ_NO: eaprForm.CORPCARD_PRE_APPR_SEQ_NO || '',
      APPR_SEQ_NO: eaprForm.APPR_SEQ_NO || '',
      DRAFT_DATE: '',
      APPR_TYPE: eaprForm.APPR_DEFAULT_TYPE || '',
      APPR_OPIN: '',
      APPR_SUBJ: (function() {
        var mon = new Date().getMonth() + 1;
        var cardNo = (matched[0] && matched[0].CARD_NO) || '';
        var last4 = cardNo.length >= 4 ? cardNo.slice(-4) : cardNo;
        return mon + '월중식대(' + last4 + ')';
      })(),
      APPR_CONT: '중식대 결재',
      TMP_APPR_CONT: '중식대 결재',
      TEMP_APPR_YN: isTemp ? 'Y' : 'N',
      TOT_PAY_AMT: String(totAmt),
      PAPER_SEQ_NO: eaprForm.PAPER_SEQ_NO || '',
      LNGG_DSNC: 'ko',
      REAL_YN: eaprForm.REAL_YN || 'Y',
      CLOUD_YN: eaprForm.CLOUD_YN || 'Y',
      PRV_YN: eaprForm.PRV_YN || 'C',
      DVSN_ERP_CD: eaprForm.DVSN_ERP_CD || '',
      RCPT_VER: eaprForm.RCPT_VER || '3',
      RESOL_KIND: eaprForm.RESOL_KIND || 'CARD',
      APPR_STS: eaprForm.APPR_STS || '',
      ITEM_INPUT_GB: eaprForm.ITEM_INPUT_GB || '',
      REC: rcptRec
    };
    // 결재요청: r010에서 받은 APPRLINE_REC을 c004에 전달
    if (!isTemp && r010Data.APPRLINE_REC && r010Data.APPRLINE_REC.length > 0) {
      c004Json.APPRLINE_REC = r010Data.APPRLINE_REC;
      debug.apprLineSource = 'r010';
      debug.apprLineCount = r010Data.APPRLINE_REC.length;
    }
    // _cardApprLine 프로퍼티 정리
    if (!isTemp) {
      PropertiesService.getScriptProperties().deleteProperty(propKey + '_cardApprLine');
    }
    debug.c004TempApprYn = c004Json.TEMP_APPR_YN;

    var c004Payload = '_JSON_=' + encodeURIComponent(JSON.stringify(c004Json));
    var c004Resp = UrlFetchApp.fetch('https://webank.appplay.co.kr/eapr_1001_01_c004.jct', {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      headers: {
        'User-Agent': BROWSER_UA,
        'Cookie': webankCookies,
        'Referer': 'https://webank.appplay.co.kr/eapr_1001_01.act'
      },
      payload: c004Payload,
      muteHttpExceptions: true
    });

    var c004Body = c004Resp.getContentText();
    debug.c004Status = c004Resp.getResponseCode();
    debug.c004BodyLen = c004Body.length;
    var c004Data;
    try { c004Data = JSON.parse(c004Body); } catch (pe) { c004Data = null; }

    if (c004Data && c004Data.RSLT_CD === '0000') {
      var msg = isTemp ? '임시저장 완료' : '결재요청 완료';
      return createResponse({ status: 'success', message: c004Data.RSLT_MSG || msg, mode: mode, debug: debug });
    }

    debug.c004Result = c004Data || c004Body.substring(0, 2000);
    return createResponse({ status: 'debug', message: 'c004 응답 확인', debug: debug });

  } catch (err) {
    debug.exception = err.message;
    return createResponse({ error: 'APPROVAL_ERROR', message: err.message, debug: debug });
  }
}

/** HTML form의 hidden 필드를 파싱하여 {name: value} 반환 */
function _parseFormFields(html, formId) {
  var fields = {};
  // formId가 있으면 해당 form 영역만 추출
  var region = html;
  if (formId) {
    var start = html.indexOf('id="' + formId + '"');
    if (start === -1) start = html.indexOf("id='" + formId + "'");
    if (start >= 0) {
      var end = html.indexOf('</form>', start);
      if (end > start) region = html.substring(start, end);
    }
  }
  var m;
  var regex1 = /name\s*=\s*["']([^"']+)["'][^>]*value\s*=\s*["']([^"']*)["']/gi;
  while ((m = regex1.exec(region)) !== null) fields[m[1]] = m[2];
  var regex2 = /value\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']([^"']+)["']/gi;
  while ((m = regex2.exec(region)) !== null) { if (!fields[m[2]]) fields[m[2]] = m[1]; }
  return fields;
}

/** webank 카드 내역 raw API 호출 (매핑하지 않은 원본 REC 반환) */
function _callWebankApiRaw(webankCookies) {
  var period = _getCardQueryPeriod();
  var payload = '_JSON_=' + encodeURIComponent(JSON.stringify({
    PAGE_NO: '1', PAGE_SZ: '100',
    APV_YN: 'A', PROC_STS: '', ORD_COL: 'APV_DT', ORD_MT: 'DESC',
    BOX_CD: '0', SEARCH_NM: '',
    FROM_APV_DT: period.from, TO_APV_DT: period.to,
    PAGE_URL_ADR: 'eusr_0001_01',
    CNTS_IDNT_ID: 'CRD_MAGR_NEW', GB: 'R'
  }));

  var resp = UrlFetchApp.fetch('https://webank.appplay.co.kr/eusr_9001_01_r001.jct', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    headers: { 'User-Agent': BROWSER_UA, 'Cookie': webankCookies },
    payload: payload,
    muteHttpExceptions: true
  });

  var body = resp.getContentText();
  var data;
  try { data = JSON.parse(body); } catch (pe) { return { expired: true }; }
  if (data.COMMON_HEAD && data.COMMON_HEAD.ERROR) return { expired: true };
  return { records: data.REC || [] };
}

/** eapr_1001_01.act 페이지에서 사용자 정보 파싱 */
function _parseEaprUserInfo(html) {
  var info = {};

  // 패턴 1: hidden input에서 추출
  var inputPatterns = [
    { key: 'USER_NO', regex: /name\s*=\s*["']USER_NO["'][^>]*value\s*=\s*["']([^"']+)["']/i },
    { key: 'USER_NM', regex: /name\s*=\s*["']USER_NM["'][^>]*value\s*=\s*["']([^"']+)["']/i },
    { key: 'PROC_USER_NO', regex: /name\s*=\s*["']PROC_USER_NO["'][^>]*value\s*=\s*["']([^"']+)["']/i },
    { key: 'PROC_USER_NM', regex: /name\s*=\s*["']PROC_USER_NM["'][^>]*value\s*=\s*["']([^"']+)["']/i },
    { key: 'USE_INTT_ID', regex: /name\s*=\s*["']USE_INTT_ID["'][^>]*value\s*=\s*["']([^"']+)["']/i }
  ];

  inputPatterns.forEach(function(p) {
    var m = html.match(p.regex);
    if (m) info[p.key] = m[1];
  });

  // 패턴 1b: value가 name보다 앞에 오는 경우
  var inputPatterns2 = [
    { key: 'USER_NO', regex: /value\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']USER_NO["']/i },
    { key: 'USER_NM', regex: /value\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']USER_NM["']/i },
    { key: 'PROC_USER_NO', regex: /value\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']PROC_USER_NO["']/i },
    { key: 'PROC_USER_NM', regex: /value\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']PROC_USER_NM["']/i },
    { key: 'USE_INTT_ID', regex: /value\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']USE_INTT_ID["']/i }
  ];

  inputPatterns2.forEach(function(p) {
    if (!info[p.key]) {
      var m = html.match(p.regex);
      if (m) info[p.key] = m[1];
    }
  });

  // 패턴 2: JS 변수에서 추출 (var USER_NO = "xxx" 또는 gUserNo = "xxx")
  var jsPatterns = [
    { key: 'USER_NO', regex: /(?:var\s+)?(?:USER_NO|gUserNo|userNo)\s*[:=]\s*["']([^"']+)["']/i },
    { key: 'USER_NM', regex: /(?:var\s+)?(?:USER_NM|gUserNm|userNm)\s*[:=]\s*["']([^"']+)["']/i },
    { key: 'USE_INTT_ID', regex: /(?:var\s+)?(?:USE_INTT_ID|gUseInttId|useInttId)\s*[:=]\s*["']([^"']+)["']/i }
  ];

  jsPatterns.forEach(function(p) {
    if (!info[p.key]) {
      var m = html.match(p.regex);
      if (m) info[p.key] = m[1];
    }
  });

  return info;
}

/* ─── 유틸리티 ─── */

/** 금액 문자열 정리: "37300.00" → "37300", null → "0" */
function _cleanAmt(val) {
  if (val == null || val === '') return '0';
  var n = Number(String(val).replace(/,/g, ''));
  if (isNaN(n)) return '0';
  return String(Math.round(n));
}

/** 카드 조회 기간 (매월 15일 ~ 다음달 14일) */
function _getCardQueryPeriod() {
  var now = new Date();
  var y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  var start, end;
  if (d >= 15) {
    start = new Date(y, m, 15);
    end = new Date(y, m + 1, 14);
  } else {
    start = new Date(y, m - 1, 15);
    end = new Date(y, m, 14);
  }
  var fmt = function(dt) {
    var mm = ('0' + (dt.getMonth() + 1)).slice(-2);
    var dd = ('0' + dt.getDate()).slice(-2);
    return '' + dt.getFullYear() + mm + dd;
  };
  return { from: fmt(start), to: fmt(end) };
}

/** 승인일시 포맷: 20260227 + 151510 → 02.27 15:15 */
function _fmtApvDt(apvDt, apvTm) {
  if (!apvDt) return '';
  var s = String(apvDt);
  var result = s.substring(4, 6) + '.' + s.substring(6, 8);
  if (apvTm) {
    var t = ('000000' + apvTm).slice(-6);
    result += ' ' + t.substring(0, 2) + ':' + t.substring(2, 4);
  }
  return result;
}
