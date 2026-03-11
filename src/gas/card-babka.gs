/**
 * 밥카(법인카드 중식대) 모듈
 * - 밥카 알람 수신 설정 (웹페이지관리 시트 G열 + H열)
 * - 트리거: sendDailyAlarm (잔액+식단 통합), sendCardAlarmDay14, sendCardAlarmReminder, sendCardRefundAlert
 *
 * code.gs의 doGet에서 호출:
 *   handleUpdateCardAlarm(adminRow, e)
 *
 * 공유 의존: createResponse() (code.gs), SHEET_NAME (code.gs)
 */

/* ═══════════════ 상수 ═══════════════ */

/** 웹페이지관리 시트 밥카 Flow 알람 컬럼 (G열 = index 6) — 통합 토글 */
var CARD_ALARM_COL = 7; // 1-based: G열

/** 웹페이지관리 시트 암호화된 Bizplay PW 컬럼 (H열 = index 7) */
var CARD_DAILY_COL = 8; // 1-based: H열

/** 웹페이지관리 시트 Bizplay ID 컬럼 (I열 = index 8) */
var BIZPLAY_ID_COL = 9; // 1-based: I열

/** 웹페이지관리 시트 밥카 자동결재 모드 컬럼 (J열 = index 9) */
var CARD_AUTO_MODE_COL = 10; // 1-based: J열  값: off, alarm, draft, submit

// 암호화 함수 → utils.gs로 이동 (ENCRYPT_SECRET, _encryptPw, _decryptPw 등)

/** 교통비 업종명 */
var TRANSPORT_CATEGORY = '대중교통';
/** 교통비 제외 키워드 (가맹점명 포함 여부) */
var TRANSPORT_KEYWORDS = ['티머니 버스', '티머니 지하철', '시내버스', '시외버스'];

function isTransportRecord(r) {
  if ((r.category || '') === TRANSPORT_CATEGORY) return true;
  var m = (r.merchant || '').trim();
  for (var i = 0; i < TRANSPORT_KEYWORDS.length; i++) {
    if (m.indexOf(TRANSPORT_KEYWORDS[i]) !== -1) return true;
  }
  return false;
}

/* ═══════════════ 사용자카드정보 CRUD ═══════════════ */

/** 사용자 카드 목록 조회 */
function _getUserCards(knoxId) {
  var data = getCachedData(SHEET_NAME.CARD_INFO);
  if (data.length < 2) return [];
  var result = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === knoxId) {
      result.push({
        cardNo: String(data[i][1] || ''),
        alias: String(data[i][2] || ''),
        limit: Number(data[i][3]) || 0,
        isLunchCard: String(data[i][4]).trim().toUpperCase() === 'Y'
      });
    }
  }
  return result;
}

/** 사용자 카드 목록 저장 (기존 행 덮어쓰기) */
function _saveUserCards(knoxId, cards) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME.CARD_INFO);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME.CARD_INFO);
    sheet.appendRow(['녹스ID', '카드번호', '별칭', '한도', '중식대여부']);
  }
  // 기존 행 삭제 (역순)
  if (sheet.getLastRow() >= 2) {
    var data = getCachedData(SHEET_NAME.CARD_INFO);
    for (var i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]).trim() === knoxId) sheet.deleteRow(i + 1);
    }
  }
  // 새 행 추가
  cards.forEach(function(c) {
    sheet.appendRow([knoxId, c.cardNo, c.alias || '', c.limit || 0, c.isLunchCard ? 'Y' : 'N']);
  });
  invalidateCache(SHEET_NAME.CARD_INFO);
}

/** 기존 설정 유지하며 새 카드만 추가 */
function _mergeNewCards(knoxId, newCardNos) {
  var existing = _getUserCards(knoxId);
  var existingMap = {};
  existing.forEach(function(c) { existingMap[c.cardNo] = c; });
  var merged = existing.slice();
  newCardNos.forEach(function(no) {
    if (!existingMap[no]) {
      merged.push({ cardNo: no, alias: '', limit: 0, isLunchCard: false });
    }
  });
  if (merged.length > existing.length) {
    _saveUserCards(knoxId, merged);
  }
  return merged;
}

/** 중식대 카드 자동 감지 (raw webank 내역에서 TRAN_KIND_NM 확인) */
function _autoDetectLunchCard(webankCookies, cards) {
  if (cards.length === 1) return { auto: true, lunchCardNo: cards[0].cardNo };

  // 1개월 전부터 오늘까지 조회
  var now = new Date();
  var oneMonthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
  var fromDt = Utilities.formatDate(oneMonthAgo, 'Asia/Seoul', 'yyyyMMdd');
  var toDt = Utilities.formatDate(now, 'Asia/Seoul', 'yyyyMMdd');

  var payload = '_JSON_=' + encodeURIComponent(JSON.stringify({
    PAGE_NO: '1', PAGE_SZ: '300',
    APV_YN: 'A', PROC_STS: '', ORD_COL: 'APV_DT', ORD_MT: 'DESC',
    BOX_CD: '0', SEARCH_NM: '',
    FROM_APV_DT: fromDt, TO_APV_DT: toDt,
    PAGE_URL_ADR: 'eusr_0001_01',
    CNTS_IDNT_ID: 'CRD_MAGR_NEW', GB: 'R'
  }));
  var resp = UrlFetchApp.fetch('https://webank.appplay.co.kr/eusr_9001_01_r001.jct', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    headers: { 'User-Agent': BROWSER_UA, 'Cookie': webankCookies },
    payload: payload, muteHttpExceptions: true
  });
  var body = resp.getContentText();
  var data;
  try { data = JSON.parse(body); } catch (e) { return { auto: false, candidates: cards }; }
  if (!data.REC) return { auto: false, candidates: cards };

  var cardNoSet = {};
  cards.forEach(function(c) { cardNoSet[c.cardNo] = true; });
  var lunchCardNos = {};
  (data.REC || []).forEach(function(r) {
    var kind = String(r.TRAN_KIND_NM || '');
    var cardNo = String(r.CARD_NO || '');
    if (kind.indexOf('중식대') >= 0 && cardNoSet[cardNo]) {
      lunchCardNos[cardNo] = true;
    }
  });

  var detected = Object.keys(lunchCardNos);
  if (detected.length === 1) return { auto: true, lunchCardNo: detected[0] };
  if (detected.length > 1) return { auto: false, candidates: detected.map(function(no) { return cards.find(function(c) { return c.cardNo === no; }) || { cardNo: no }; }) };
  return { auto: false, candidates: cards };
}

/** 사용자카드정보 핸들러 (subAction 분기) */
function handleCardInfo(adminRow, e) {
  var knoxId = adminRow[ADMIN_COL.KNOX_ID];
  var subAction = e.parameter.subAction || 'get';

  if (subAction === 'get') {
    return createResponse({ status: 'success', cards: _getUserCards(knoxId) });
  }

  if (subAction === 'register') {
    // Bizplay 로그인 → webank 쿠키 → 카드 목록 추출
    var propKey = 'bizplay_' + knoxId;
    var rawSession = PropertiesService.getScriptProperties().getProperty(propKey);
    if (!rawSession) return createResponse({ error: 'NO_SESSION', message: 'Bizplay 로그인이 필요해.' });
    var session = JSON.parse(rawSession);
    var webankCookies = session.webankCookies || '';
    if (!webankCookies) {
      var acquired = _acquireWebankCookies(session);
      if (acquired.cookies) {
        webankCookies = acquired.cookies;
        session.webankCookies = webankCookies;
        PropertiesService.getScriptProperties().setProperty(propKey, JSON.stringify(session));
      }
    }
    if (!webankCookies) {
      var reloginResult = _cardTryRelogin(adminRow, propKey);
      if (reloginResult.webankCookies) webankCookies = reloginResult.webankCookies;
    }
    if (!webankCookies) return createResponse({ error: 'WEBANK_SSO_FAIL', message: 'webank 인증 실패' });

    // 현재 기간 + 1개월전 내역에서 카드번호 추출
    var result = _callWebankApi(webankCookies);
    if (result.expired || result.error) return createResponse({ error: 'API_FAIL', message: '카드 내역 조회 실패' });

    var cardNoSet = {};
    (result.records || []).forEach(function(r) { if (r.cardNo) cardNoSet[r.cardNo] = true; });
    var cardNos = Object.keys(cardNoSet);
    if (cardNos.length === 0) return createResponse({ error: 'NO_CARDS', message: '카드 내역이 없어.' });

    var cards = cardNos.map(function(no) { return { cardNo: no, alias: '', limit: 0, isLunchCard: false }; });

    // 중식대 자동 감지
    var detection = _autoDetectLunchCard(webankCookies, cards);
    if (detection.auto) {
      cards.forEach(function(c) { c.isLunchCard = c.cardNo === detection.lunchCardNo; });
      _saveUserCards(knoxId, cards);
      return createResponse({ status: 'success', cards: cards, autoDetected: true });
    }
    // 사용자 선택 필요
    return createResponse({ status: 'needsChoice', candidates: detection.candidates, allCards: cards });
  }

  if (subAction === 'setLunchCard') {
    var lunchCardNo = e.parameter.cardNo || '';
    var cards = _getUserCards(knoxId);
    if (cards.length === 0) return createResponse({ error: 'NO_CARDS' });
    cards.forEach(function(c) { c.isLunchCard = c.cardNo === lunchCardNo; });
    // 선택한 카드가 목록에 없으면 (register 직후 allCards에서 온 경우)
    if (!cards.some(function(c) { return c.isLunchCard; })) {
      return createResponse({ error: 'CARD_NOT_FOUND' });
    }
    _saveUserCards(knoxId, cards);
    return createResponse({ status: 'success', cards: cards });
  }

  if (subAction === 'updateAlias') {
    var cardNo = e.parameter.cardNo || '';
    var alias = e.parameter.alias || '';
    var cards = _getUserCards(knoxId);
    var found = false;
    cards.forEach(function(c) { if (c.cardNo === cardNo) { c.alias = alias; found = true; } });
    if (!found) return createResponse({ error: 'CARD_NOT_FOUND' });
    _saveUserCards(knoxId, cards);
    return createResponse({ status: 'success', cards: cards });
  }

  if (subAction === 'updateLimit') {
    var cardNo = e.parameter.cardNo || '';
    var limit = Number(e.parameter.limit) || 0;
    var cards = _getUserCards(knoxId);
    var found = false;
    cards.forEach(function(c) { if (c.cardNo === cardNo) { c.limit = limit; found = true; } });
    if (!found) return createResponse({ error: 'CARD_NOT_FOUND' });
    _saveUserCards(knoxId, cards);
    return createResponse({ status: 'success', cards: cards });
  }

  if (subAction === 'refresh') {
    var propKey = 'bizplay_' + knoxId;
    var rawSession = PropertiesService.getScriptProperties().getProperty(propKey);
    if (!rawSession) return createResponse({ error: 'NO_SESSION' });
    var session = JSON.parse(rawSession);
    var webankCookies = session.webankCookies || '';
    if (!webankCookies) {
      var acquired = _acquireWebankCookies(session);
      if (acquired.cookies) webankCookies = acquired.cookies;
    }
    if (!webankCookies) return createResponse({ error: 'WEBANK_SSO_FAIL' });

    var result = _callWebankApi(webankCookies);
    if (result.expired || result.error) return createResponse({ error: 'API_FAIL' });
    var cardNoSet = {};
    (result.records || []).forEach(function(r) { if (r.cardNo) cardNoSet[r.cardNo] = true; });
    var newCardNos = Object.keys(cardNoSet);
    var merged = _mergeNewCards(knoxId, newCardNos);
    return createResponse({ status: 'success', cards: merged });
  }

  // allCards 저장 (register에서 needsChoice 후 사용자가 선택 전 전체 카드 저장)
  if (subAction === 'saveAllCards') {
    var cardsJson = e.parameter.cards || '[]';
    var cards;
    try { cards = JSON.parse(cardsJson); } catch (pe) { return createResponse({ error: 'INVALID_JSON' }); }
    _saveUserCards(knoxId, cards);
    return createResponse({ status: 'success', cards: cards });
  }

  return createResponse({ error: 'INVALID_SUB_ACTION' });
}

/* ═══════════════ 밥카 알람 설정 ═══════════════ */

/**
 * 밥카 알람 수신 동의/해제
 * action=updateCardAlarm&token={knoxId:hash}&isAgreed={true/false}
 */
function handleUpdateCardAlarm(adminRow, e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var mgmtSheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  var isAgreed = (e.parameter.isAgreed === 'true');
  var newVal = isAgreed ? 'Y' : 'N';

  // adminRow: 웹페이지관리 시트의 해당 사용자 행 번호
  mgmtSheet.getRange(adminRow, CARD_ALARM_COL).setValue(newVal);      // G열: 밥카 Flow 알람

  return createResponse({ status: 'success' });
}

/**
 * 밥카 자동결재 모드 변경
 * action=updateCardAutoMode&token={knoxId:hash}&mode={off|alarm|draft|submit}
 */
function handleUpdateCardAutoMode(adminRow, e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var mgmtSheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  var mode = String(e.parameter.mode || 'off').trim().toLowerCase();

  var validModes = ['off', 'alarm', 'draft', 'submit'];
  if (validModes.indexOf(mode) === -1) {
    return createResponse({ error: 'INVALID_MODE', message: '유효하지 않은 모드야.' });
  }

  var adminData = mgmtSheet.getDataRange().getValues();
  var adminByKnoxId = new Map();
  adminData.forEach(function(row, idx) {
    if (idx === 0) return;
    var kid = String(row[ADMIN_COL.KNOX_ID]).trim();
    if (kid) adminByKnoxId.set(kid, { row: row, idx: idx });
  });
  var entry = _verifyToken(e.parameter.token, adminByKnoxId);
  if (!entry) return createResponse({ error: 'UNAUTHORIZED' });
  var rowIndex = entry.idx;

  // draft/submit은 PW 필수
  if (mode === 'draft' || mode === 'submit') {
    var encPw = adminData[rowIndex][CARD_DAILY_COL - 1];
    if (!encPw || !String(encPw).trim()) {
      return createResponse({ error: 'NO_PASSWORD', message: '비밀번호 저장이 필요해.' });
    }
  }

  mgmtSheet.getRange(rowIndex + 1, CARD_AUTO_MODE_COL).setValue(mode);
  return createResponse({ status: 'success', cardAutoMode: mode });
}


/* ═══════════════ 밥카 자동 알림 ═══════════════ */

/**
 * 월간 밥카 알림 트리거 (매일 등록, 해당일만 실행)
 * - 14일+1영업일: 결재 안내 + 자동결재
 * - 14일부터 3번째 영업일: 미상신자 리마인더
 * - 매월 1영업일: 초과 환불 안내
 */
function sendMonthlyCardAlarm() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = ss.getSheetByName(SHEET_NAME.ADMIN).getDataRange().getValues();

  try { sendCardAlarmDay14(data); } catch (e) { Logger.log('[월간알림] sendCardAlarmDay14 실패: ' + e.message); }
  try { sendCardAlarmReminder(data); } catch (e) { Logger.log('[월간알림] sendCardAlarmReminder 실패: ' + e.message); }
  try { sendCardRefundAlert(data); } catch (e) { Logger.log('[월간알림] sendCardRefundAlert 실패: ' + e.message); }
}

/**
 * 밥카 자동결재/알람 처리 (14일+1영업일)
 * J열 cardAutoMode별 분기:
 *   off/빈값 → 스킵
 *   alarm   → Flow 알람만 발송
 *   draft   → 자동 임시저장
 *   submit  → 자동 결재요청
 */
function sendCardAlarmDay14(data) {
  var now = new Date();
  if (!_isFirstBizDayFrom14(now)) return;

  if (!Array.isArray(data)) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    data = ss.getSheetByName(SHEET_NAME.ADMIN).getDataRange().getValues();
  }

  for (var i = 1; i < data.length; i++) {
    var knoxId = data[i][0];
    if (!knoxId) continue;

    var encPw = data[i][CARD_DAILY_COL - 1]; // H열
    var autoMode = String(data[i][CARD_AUTO_MODE_COL - 1] || '').trim().toLowerCase(); // J열

    if (!autoMode || autoMode === 'off') continue;

    if (autoMode === 'alarm') {
      try {
        sendFlowMsg(knoxId, FLOW_MSG.cardAutoAlarm('alarm'));
        Logger.log('[자동결재] alarm 발송 - ' + knoxId);
      } catch (e) {
        Logger.log('[자동결재] alarm 실패 - ' + knoxId + ': ' + e.message);
      }
    } else {
      _processAutoMode(knoxId, encPw, autoMode);
    }
  }
}

/**
 * 사용자별 자동결재 모드 처리 (draft / submit)
 */
function _processAutoMode(knoxId, encPw, mode) {
  if (!encPw || !String(encPw).trim()) {
    Logger.log('[자동결재] PW 없음 스킵 - ' + knoxId);
    try { sendFlowMsg(knoxId, FLOW_MSG.cardAutoFail(mode, '비밀번호가 저장되어 있지 않아.')); } catch (e) {}
    return;
  }

  try {
    var userId = knoxId + '@emro.co.kr';
    var password = _decryptPw(String(encPw));

    // Step 1: 로그인 + webank SSO
    var loginResult = _bizplayLoginCore(userId, password);
    if (loginResult.error || !loginResult.webankCookies) {
      Logger.log('[자동결재] 로그인 실패 - ' + knoxId);
      sendFlowMsg(knoxId, FLOW_MSG.cardAutoFail(mode, 'Bizplay 로그인 실패. 비밀번호를 확인해줘.'));
      return;
    }

    // Step 2: 전체 카드 내역 조회
    var rawResult = _callWebankApiRaw(loginResult.webankCookies);
    if (rawResult.expired || !rawResult.records || rawResult.records.length === 0) {
      Logger.log('[자동결재] 카드 내역 없음 - ' + knoxId);
      // 내역이 없으면 성공도 실패도 아님 — 알림만
      sendFlowMsg(knoxId, FLOW_MSG.cardAutoFail(mode, '카드 사용내역이 없거나 조회에 실패했어.'));
      return;
    }

    // 중식대 카드 필터링 (다중카드 대응)
    var userCards = [];
    try { userCards = _getUserCards(knoxId); } catch (uce) {}
    var lunchCard = userCards.find(function(c) { return c.isLunchCard; });
    if (lunchCard) {
      rawResult.records = rawResult.records.filter(function(r) {
        return String(r.CARD_NO || '') === lunchCard.cardNo;
      });
    }

    // 교통비 제외
    var records = rawResult.records.filter(function(r) {
      return !isTransportRecord(r);
    });

    if (records.length === 0) {
      Logger.log('[자동결재] 교통비 제외 후 내역 없음 - ' + knoxId);
      sendFlowMsg(knoxId, FLOW_MSG.cardAutoFail(mode, '교통비를 제외하면 결재할 내역이 없어.'));
      return;
    }

    // Step 3: 핵심 결재 로직
    var apprMode = (mode === 'submit') ? 'approve' : 'temp';
    var result = _cardApprovalCore(loginResult.webankCookies, records, apprMode);

    if (result.status === 'success') {
      var totalCost = 0;
      records.forEach(function(r) { totalCost += Number(r.cost || r.APV_AMT || 0); });
      Logger.log('[자동결재] 성공 - ' + knoxId + ' (' + mode + ', ' + records.length + '건, ' + totalCost + '원, 교통비 제외)');
      sendFlowMsg(knoxId, FLOW_MSG.cardAutoAlarm(mode, totalCost));
    } else {
      Logger.log('[자동결재] 실패 - ' + knoxId + ': ' + (result.message || result.error));
      sendFlowMsg(knoxId, FLOW_MSG.cardAutoFail(mode, result.message || '알 수 없는 오류'));
    }
  } catch (ex) {
    Logger.log('[자동결재] 예외 - ' + knoxId + ': ' + ex.message);
    try { sendFlowMsg(knoxId, FLOW_MSG.cardAutoFail(mode, ex.message)); } catch (e) {}
  }
}

/**
 * 미결재 리마인드 스마트 알림 (매일 오전 트리거)
 * 14일부터 3번째 영업일에만 실행, 이미 상신한 사용자 제외
 * 트리거 설정: 시간 기반 트리거 → 매일 오전 9~10시
 */
function sendCardAlarmReminder(data) {
  var now = new Date();
  if (!_isCardAlarmDay(now)) return;

  if (!Array.isArray(data)) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    data = ss.getSheetByName(SHEET_NAME.ADMIN).getDataRange().getValues();
  }

  for (var i = 1; i < data.length; i++) {
    var knoxId = data[i][0]; // A열: knoxId
    var bizplayId = String(data[i][BIZPLAY_ID_COL - 1] || '').trim(); // I열: Bizplay ID
    var alarmOn = data[i][CARD_ALARM_COL - 1]; // G열: 밥카 Flow 알람
    var encPw = data[i][CARD_DAILY_COL - 1]; // H열: 암호화된 PW

    if (!knoxId || alarmOn !== 'Y') continue;

    if (!encPw || !String(encPw).trim()) {
      Logger.log('[리마인더] 스킵(PW없음) - ' + knoxId);
      continue;
    }

    var bizUserId = (bizplayId || knoxId) + '@emro.co.kr';
    try {
      if (_checkUserHasCardDraft(bizUserId, encPw)) {
        Logger.log('[리마인더] 스킵(상신완료) - ' + knoxId);
        continue;
      }
      sendFlowMsg(knoxId, FLOW_MSG.cardReminder());
      Logger.log('[리마인더] 발송 완료 - ' + knoxId);
    } catch (e) {
      Logger.log('[리마인더] 실패 - ' + knoxId + ': ' + e.message);
    }
  }
}

/**
 * 공통 알림 발송 로직 (msg: FLOW_MSG 객체)
 */
function _sendCardAlarm(msg) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var mgmtSheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  var data = mgmtSheet.getDataRange().getValues();

  // 헤더 제외
  for (var i = 1; i < data.length; i++) {
    var knoxId = data[i][0]; // A열: knoxId
    var alarmOn = data[i][CARD_ALARM_COL - 1]; // G열: 밥카 Flow 알람

    if (!knoxId || alarmOn !== 'Y') continue;

    try {
      sendFlowMsg(knoxId, msg);
    } catch (e) {
      Logger.log('[밥카알림] 발송 실패 - ' + knoxId + ': ' + e.message);
    }
  }
}

/**
 * 매월 첫 영업일: 직전 종료 기간 초과분 환불 안내
 * 예) 3월 첫 영업일 → 1/15~2/14 기간 초과분 체크
 */
function sendCardRefundAlert(data) {
  var now = new Date();
  if (!_isFirstBizDayOfMonth(now)) return;

  // 직전 종료 기간 계산: (M-2)월 15일 ~ (M-1)월 14일
  var m = now.getMonth(), y = now.getFullYear();
  var prevStart = new Date(y, m - 2, 15);
  var prevEnd = new Date(y, m - 1, 14);
  var fmt = function(dt) {
    return '' + dt.getFullYear() + ('0' + (dt.getMonth() + 1)).slice(-2) + ('0' + dt.getDate()).slice(-2);
  };
  var fromDt = fmt(prevStart);
  var toDt = fmt(prevEnd);
  var budget = _calcCardBudgetForPeriod(fromDt, toDt);

  var periodLabel = prevStart.getFullYear() + '.' + ('0' + (prevStart.getMonth() + 1)).slice(-2) + '.' + ('0' + prevStart.getDate()).slice(-2)
    + ' ~ ' + prevEnd.getFullYear() + '.' + ('0' + (prevEnd.getMonth() + 1)).slice(-2) + '.' + ('0' + prevEnd.getDate()).slice(-2);

  if (!Array.isArray(data)) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    data = ss.getSheetByName(SHEET_NAME.ADMIN).getDataRange().getValues();
  }

  for (var i = 1; i < data.length; i++) {
    var knoxId = data[i][0];
    var bizplayId = String(data[i][BIZPLAY_ID_COL - 1] || '').trim(); // I열: Bizplay ID
    var alarmOn = data[i][CARD_ALARM_COL - 1];
    var encPw = data[i][CARD_DAILY_COL - 1];
    if (!knoxId || alarmOn !== 'Y' || !encPw) continue;

    try {
      var userId = (bizplayId || knoxId) + '@emro.co.kr';
      var password = _decryptPw(encPw);
      var loginResult = _bizplayLoginCore(userId, password);
      if (loginResult.error || !loginResult.webankCookies) {
        Logger.log('[환불알림] 로그인 실패 - ' + knoxId);
        continue;
      }

      var result = _callWebankApi(loginResult.webankCookies, fromDt, toDt);
      if (result.expired || result.error) {
        Logger.log('[환불알림] 조회 실패 - ' + knoxId);
        continue;
      }

      var usedSum = 0;
      (result.records || []).forEach(function(r) {
        if (isTransportRecord(r)) return;
        usedSum += Number(r.cost) || 0;
      });

      var remain = budget - usedSum;
      if (remain < 0) {
        var msg = FLOW_MSG.cardRefund(Math.abs(remain), periodLabel);
        sendFlowMsg(knoxId, msg);
        Logger.log('[환불알림] 발송 완료 - ' + knoxId + ': 초과 ' + Math.abs(remain) + '원');
      } else {
        Logger.log('[환불알림] 초과 없음 - ' + knoxId);
      }
    } catch (ex) {
      Logger.log('[환불알림] 예외 - ' + knoxId + ': ' + ex.message);
    }
  }
}

// 날짜/공휴일/영업일/예산 함수 → card-utils.gs로 이동

/**
 * 사용자가 이미 "지출결의서(법인카드)"를 상신했는지 확인
 * approval SSO → r007 기안문서 목록 조회 → PAPER_NM 매칭
 */
function _checkUserHasCardDraft(bizUserId, encPw) {
  var userId = bizUserId;
  var password = _decryptPw(String(encPw));

  // approval SSO 획득
  var sso = _approvalSsoOnly(userId, password);
  if (!sso.approvalCookies) return false; // SSO 실패 → 판별 불가, 알림 발송

  // r007 호출: 검색 기간 = 결재월 15일 ~ 오늘
  var period = _getCardQueryPeriod();
  var now = new Date();
  var enDate = now.getFullYear() + ('0' + (now.getMonth() + 1)).slice(-2) + ('0' + now.getDate()).slice(-2);
  var ff = sso.formFields || {};

  var r007Payload = '_JSON_=' + encodeURIComponent(JSON.stringify({
    PTL_ID: ff.PTL_ID || 'PTL_3',
    CHNL_ID: ff.CHNL_ID || 'CHNL_1',
    USE_INTT_ID: ff.USE_INTT_ID || sso.useInttId || '',
    DRAFT_USER_ID: userId,
    ST_DRAFT_DATE: period.from,
    EN_DRAFT_DATE: enDate,
    SRCH_WD: '',
    SRCH_DV: 'pp',
    DRAFT_USER_NM: 'pp',
    PG_NO: '1',
    PG_PER_CNT: '30',
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

  var data;
  try { data = JSON.parse(resp.getContentText()); } catch (e) { return false; }

  // 상신해야 할 월: period.from 기준 YYYYMM
  var targetYM = period.from.substring(0, 6);
  var recs = data.REC || [];
  for (var i = 0; i < recs.length; i++) {
    var paperNm = recs[i].PAPER_NM || '';
    var draftDttm = recs[i].DRAFT_DTTM || '';
    var stsNm = recs[i].APPR_STS_NM || recs[i].PROC_NM || '';
    if (paperNm.indexOf('지출결의서(법인카드)') >= 0 && draftDttm.substring(0, 6) === targetYM
        && (stsNm.indexOf('진행') >= 0 || stsNm.indexOf('완료') >= 0)) {
      return true; // 이미 상신함 (진행 or 완료)
    }
  }
  return false;
}

// 암호화/복호화 함수 → utils.gs (_encryptPw, _decryptPw, _hmacKeystream, _randomBytes, _decryptPwLegacyXor)

// migratePasswords → card-utils.gs로 이동

/* ═══════════════ 평일 잔액알림 설정 ═══════════════ */

/* ═══════════════ 평일 잔액알림 발송 ═══════════════ */

/**
 * 매일 평일 트리거: 밥카 잔액 + 식단 통합 알림 발송
 * 식단이 없으면 → 잔액 먼저 발송 → OCR 재시도 → 결과에 따라 후속 발송
 * 주말 + 공휴일(근로자의날 포함) 제외
 */
function sendDailyAlarm(data) {
  var now = new Date();
  var dow = now.getDay();
  if (dow === 0 || dow === 6) { Logger.log('[일일알림] 주말 스킵 (dow=' + dow + ')'); return; }
  if (_isHolidayServer(now)) { Logger.log('[일일알림] 공휴일 스킵'); return; }
  Logger.log('[일일알림] 시작 - ' + now.toLocaleString());

  if (!Array.isArray(data)) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    data = ss.getSheetByName(SHEET_NAME.ADMIN).getDataRange().getValues();
  }

  // 사용자카드정보 전체 로드 (한번에)
  var allCardInfo = {};
  try {
    var ciSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME.CARD_INFO);
    if (ciSheet && ciSheet.getLastRow() >= 2) {
      var ciData = ciSheet.getDataRange().getValues();
      for (var ci = 1; ci < ciData.length; ci++) {
        var kid = String(ciData[ci][0]).trim();
        if (!kid) continue;
        if (!allCardInfo[kid]) allCardInfo[kid] = [];
        allCardInfo[kid].push({
          cardNo: String(ciData[ci][1] || ''),
          alias: String(ciData[ci][2] || ''),
          limit: Number(ciData[ci][3]) || 0,
          isLunchCard: String(ciData[ci][4]).trim().toUpperCase() === 'Y'
        });
      }
    }
  } catch (ciErr) {}

  // 식단 정보 조회
  var menuInfo = _getTodayMenu();
  var menuMissing = !menuInfo;
  var menuOnlyUsers = [];
  Logger.log('[일일알림] 사용자 ' + (data.length - 1) + '명, 식단=' + (menuInfo ? '있음' : '없음'));

  for (var i = 1; i < data.length; i++) {
    var knoxId = data[i][0]; // A열: knoxId
    var bizplayId = String(data[i][BIZPLAY_ID_COL - 1] || '').trim(); // I열: Bizplay ID
    var cardAlarm = data[i][CARD_ALARM_COL - 1]; // G열: 잔액알림 수신여부
    var encPw = data[i][CARD_DAILY_COL - 1]; // H열: 암호화된 PW
    var menuAlarm = String(data[i][10] || '').trim().toUpperCase(); // K열: 식단알림
    var menuLike = String(data[i][11] || '').trim();   // L열: 선호 키워드
    var menuDislike = String(data[i][12] || '').trim(); // M열: 비선호 키워드

    if (!knoxId) continue;
    var hasCard = (cardAlarm === 'Y' && encPw);
    var wantsMenu = (menuAlarm === 'Y');
    if (!hasCard && !wantsMenu) continue;

    // 선호/비선호 키워드 필터
    if (wantsMenu && menuInfo && !_shouldSendMenu(menuInfo.todayMenu, menuLike, menuDislike)) {
      Logger.log('[일일알림] 선호 미매칭 → 식단 생략 - ' + knoxId);
      wantsMenu = false;
    }

    if (!hasCard && !wantsMenu) continue;

    // ── 식단만 Y (밥카 N) ──
    if (!hasCard) {
      if (menuInfo) {
        sendFlowMsg(knoxId, FLOW_MSG.todayMenu(menuInfo.todayStr, menuInfo.todayMenu));
        Logger.log('[일일알림] 식단 단독 발송 - ' + knoxId);
      } else {
        menuOnlyUsers.push({ knoxId: knoxId, like: menuLike, dislike: menuDislike });
      }
      continue;
    }

    // ── 밥카 Y → 잔액 조회 후 발송 ──
    try {
      var userId = (bizplayId || knoxId) + '@emro.co.kr';
      var password = _decryptPw(encPw);

      var loginResult = _bizplayLoginCore(userId, password);
      if (loginResult.error || !loginResult.webankCookies) {
        Logger.log('[일일알림] 로그인 실패 - ' + knoxId + ': ' + (loginResult.error || 'webank 쿠키 없음'));
        continue;
      }

      var result = _callWebankApi(loginResult.webankCookies);
      if (result.expired || result.error) {
        Logger.log('[일일알림] 조회 실패 - ' + knoxId + ': ' + (result.error || 'expired'));
        continue;
      }

      var records = result.records || [];
      var userCardsArr = allCardInfo[knoxId] || [];
      var msg;

      if (userCardsArr.length >= 2) {
        var lunchBudget = _calcCardBudget();
        var byCard = {};
        records.forEach(function(r) {
          var cn = r.cardNo || 'unknown';
          if (!byCard[cn]) byCard[cn] = { used: 0, count: 0 };
          if (isTransportRecord(r)) return;
          byCard[cn].used += Number(r.cost) || 0;
          byCard[cn].count++;
        });

        var summaries = userCardsArr.map(function(c) {
          var stats = byCard[c.cardNo] || { used: 0, count: 0 };
          var cardBudget = c.isLunchCard ? lunchBudget : c.limit;
          var last4 = c.cardNo.length >= 4 ? c.cardNo.substring(c.cardNo.length - 4) : c.cardNo;
          var name = c.isLunchCard ? '밥카' : (c.alias ? c.alias + '(' + last4 + ')' : '카드(' + last4 + ')');
          return {
            name: name,
            remain: cardBudget - stats.used,
            used: stats.used,
            hasLimit: c.isLunchCard || c.limit > 0,
            isLunch: c.isLunchCard
          };
        });

        msg = FLOW_MSG.cardDailyBalanceMulti(summaries);
      } else {
        var usedSum = 0;
        var usedCount = 0;
        var lunchCard = userCardsArr.find(function(c) { return c.isLunchCard; });
        records.forEach(function(r) {
          if (lunchCard && r.cardNo !== lunchCard.cardNo) return;
          if (isTransportRecord(r)) return;
          usedSum += Number(r.cost) || 0;
          usedCount++;
        });

        var budget = _calcCardBudget();
        var remain = budget - usedSum;

        msg = FLOW_MSG.cardDailyBalance(remain, budget, usedSum, usedCount);
      }

      // 식단 합산 or 대기 안내
      if (wantsMenu && menuInfo) {
        msg.content += '\n\n🍽 오늘의 식단 (' + menuInfo.todayStr + ')\n' + menuInfo.todayMenu;
      } else if (wantsMenu && menuMissing) {
        msg.content += '\n\n🍽 오늘 식단정보가 아직 없어. 찾아보고 있으면 보내줄게';
      }
      sendFlowMsg(knoxId, msg);
      Logger.log('[일일알림] 발송 완료 - ' + knoxId + (wantsMenu && menuInfo ? ' (+식단)' : wantsMenu ? ' (식단대기)' : ''));
    } catch (ex) {
      Logger.log('[일일알림] 예외 - ' + knoxId + ': ' + ex.message);
    }
  }

  // ── 2단계: 식단이 없었으면 OCR 재시도 후 후속 발송 ──
  if (menuMissing && menuOnlyUsers.length > 0) {
    Logger.log('[일일알림] 식단 없음 → OCR 재시도');
    try { _trySyncMenu(); } catch (ex) { Logger.log('[일일알림] OCR 재시도 실패: ' + ex.message); }
    var retryMenu = _getTodayMenu();

    for (var j = 0; j < menuOnlyUsers.length; j++) {
      var u = menuOnlyUsers[j];
      if (retryMenu) {
        if (!_shouldSendMenu(retryMenu.todayMenu, u.like, u.dislike)) {
          Logger.log('[일일알림] 재시도 선호 미매칭 → 생략 - ' + u.knoxId);
          continue;
        }
        sendFlowMsg(u.knoxId, FLOW_MSG.todayMenu(retryMenu.todayStr, retryMenu.todayMenu));
        Logger.log('[일일알림] 식단 재시도 발송 - ' + u.knoxId);
      } else {
        sendFlowMsg(u.knoxId, { content: '오늘은 식단정보가 업로드 되지 않았어..', link: '', previewTitle: '🍽 오늘은 식단정보가 없어' });
        Logger.log('[일일알림] 식단 미등록 안내 - ' + u.knoxId);
      }
    }
  }
}

/** 잔액알림 수동 발송 (주말/공휴일 체크 없이 즉시 실행, GAS 에디터에서 직접 실행) */
function resendDailyAlarm() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = ss.getSheetByName(SHEET_NAME.ADMIN).getDataRange().getValues();

  var allCardInfo = {};
  try {
    var ciSheet = ss.getSheetByName(SHEET_NAME.CARD_INFO);
    if (ciSheet && ciSheet.getLastRow() >= 2) {
      var ciData = ciSheet.getDataRange().getValues();
      for (var ci = 1; ci < ciData.length; ci++) {
        var kid = String(ciData[ci][0]).trim();
        if (!kid) continue;
        if (!allCardInfo[kid]) allCardInfo[kid] = [];
        allCardInfo[kid].push({
          cardNo: String(ciData[ci][1] || ''),
          alias: String(ciData[ci][2] || ''),
          limit: Number(ciData[ci][3]) || 0,
          isLunchCard: String(ciData[ci][4]).trim().toUpperCase() === 'Y'
        });
      }
    }
  } catch (ciErr) {}

  for (var i = 1; i < data.length; i++) {
    var knoxId = data[i][0];
    var bizplayId = String(data[i][BIZPLAY_ID_COL - 1] || '').trim();
    var cardAlarm = data[i][CARD_ALARM_COL - 1];
    var encPw = data[i][CARD_DAILY_COL - 1];
    if (!knoxId || cardAlarm !== 'Y' || !encPw) continue;

    try {
      var userId = (bizplayId || knoxId) + '@emro.co.kr';
      var password = _decryptPw(encPw);
      var loginResult = _bizplayLoginCore(userId, password);
      if (loginResult.error || !loginResult.webankCookies) {
        Logger.log('[수동발송] 로그인 실패 - ' + knoxId); continue;
      }
      var result = _callWebankApi(loginResult.webankCookies);
      if (result.expired || result.error) {
        Logger.log('[수동발송] 조회 실패 - ' + knoxId); continue;
      }

      var records = result.records || [];
      var userCardsArr = allCardInfo[knoxId] || [];
      var msg;

      if (userCardsArr.length >= 2) {
        var lunchBudget = _calcCardBudget();
        var byCard = {};
        records.forEach(function(r) {
          var cn = r.cardNo || 'unknown';
          if (!byCard[cn]) byCard[cn] = { used: 0, count: 0 };
          if (isTransportRecord(r)) return;
          byCard[cn].used += Number(r.cost) || 0;
          byCard[cn].count++;
        });
        var summaries = userCardsArr.map(function(c) {
          var stats = byCard[c.cardNo] || { used: 0, count: 0 };
          var cardBudget = c.isLunchCard ? lunchBudget : c.limit;
          var last4 = c.cardNo.length >= 4 ? c.cardNo.substring(c.cardNo.length - 4) : c.cardNo;
          var name = c.isLunchCard ? '밥카' : (c.alias ? c.alias + '(' + last4 + ')' : '카드(' + last4 + ')');
          return { name: name, remain: cardBudget - stats.used, used: stats.used, hasLimit: c.isLunchCard || c.limit > 0, isLunch: c.isLunchCard };
        });
        msg = FLOW_MSG.cardDailyBalanceMulti(summaries);
      } else {
        var usedSum = 0, usedCount = 0;
        var lunchCard = userCardsArr.find(function(c) { return c.isLunchCard; });
        records.forEach(function(r) {
          if (lunchCard && r.cardNo !== lunchCard.cardNo) return;
          if (isTransportRecord(r)) return;
          usedSum += Number(r.cost) || 0;
          usedCount++;
        });
        var budget = _calcCardBudget();
        msg = FLOW_MSG.cardDailyBalance(budget - usedSum, budget, usedSum, usedCount);
      }

      sendFlowMsg(knoxId, msg);
      Logger.log('[수동발송] 완료 - ' + knoxId);
    } catch (ex) {
      Logger.log('[수동발송] 예외 - ' + knoxId + ': ' + ex.message);
    }
  }
}

// _isHolidayServer, _calcRemainingBizDays, _calcCardBudget, _parseDateStr, _fmtMoney → card-utils.gs로 이동

/* ═══════════════ 밥카 사용내역 조회 ═══════════════ */

/**
 * 밥카(법인카드) 사용내역 조회
 * action=cardRecords&token={knoxId:hash}
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
    var filterCardNo = e.parameter.cardNo || ''; // 카드번호 필터
    var result = _callWebankApi(webankCookies, fromDt, toDt);

    if (result.expired) {
      // 쿠키 만료 → 재로그인으로 한번 더 시도
      console.log('[card] webank 세션 만료 → 재로그인 시도');
      var retry = _cardTryRelogin(adminRow, propKey);
      if (retry.webankCookies) {
        result = _callWebankApi(retry.webankCookies, fromDt, toDt);
        if (!result.expired && !result.error) {
          var recs = filterCardNo ? result.records.filter(function(r) { return r.cardNo === filterCardNo; }) : result.records;
          return createResponse({ status: 'success', records: recs, totalCount: recs.length });
        }
      }
      session.webankCookies = '';
      PropertiesService.getScriptProperties().setProperty(propKey, JSON.stringify(session));
      return createResponse({ error: 'SESSION_EXPIRED', message: '세션이 만료됐어. Bizplay 재로그인 해줘.' });
    }

    if (result.error) {
      return createResponse({ error: result.error, message: result.message });
    }

    var records = filterCardNo ? result.records.filter(function(r) { return r.cardNo === filterCardNo; }) : result.records;
    return createResponse({ status: 'success', records: records, totalCount: records.length });
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
      rawDate: r.APV_DT || '',
      merchant: r.MEST_NM || '',
      cost: Math.round(Number(r.BUY_SUM) || 0),
      category: r.CARD_TPBZ_NM || '',
      apvNo: r.APV_NO || '',
      purpose: r.PROC_STS || '',
      cardNo: r.CARD_NO || '',
      txSeq: r.TX_SEQ || '',
      seq: r.SEQ || '',
      address: ((r.MEST_ADDR_1 || '') + ' ' + (r.MEST_ADDR_2 || '')).trim()
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
 * action=cardApproval&token={knoxId:hash}&selectedRecords={JSON}
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

  // 카드 내역 raw API 호출 → 선택 레코드 매칭
  var rawResult = _callWebankApiRaw(webankCookies);
  if (rawResult.expired) {
    session.webankCookies = '';
    PropertiesService.getScriptProperties().setProperty(propKey, JSON.stringify(session));
    return createResponse({ error: 'SESSION_EXPIRED', message: '세션 만료' });
  }

  var matched = [];
  selected.forEach(function(sel) {
    var found = rawResult.records.filter(function(r) {
      return r.CARD_NO === sel.cardNo
        && String(r.SEQ) === String(sel.seq)
        && (!sel.apvNo || String(r.APV_NO) === String(sel.apvNo));
    });
    if (found.length > 0) matched.push(found[0]);
  });

  if (matched.length === 0) {
    return createResponse({ error: 'NO_MATCH', message: '선택한 레코드를 찾을 수 없어.' });
  }

  // 수정된 결재라인 파라미터 확인
  var modifiedApprLine = null;
  var modifiedParam = e.parameter.modifiedApprLine || '';
  if (modifiedParam) {
    try { modifiedApprLine = JSON.parse(modifiedParam); } catch (mpe) { /* ignore */ }
  }

  var result = _cardApprovalCore(webankCookies, matched, mode, propKey, modifiedApprLine);

  // 세션 만료 처리
  if (result.error === 'SESSION_EXPIRED') {
    session.webankCookies = '';
    PropertiesService.getScriptProperties().setProperty(propKey, JSON.stringify(session));
  }

  return createResponse(result);
}

/**
 * 밥카 결재 코어 로직 (eusr → eapr → r010 → c004)
 * handleCardApproval 및 자동결재 트리거에서 공용 사용
 *
 * @param {string} webankCookies - webank 세션 쿠키
 * @param {Array} matched - raw 카드 내역 레코드 배열
 * @param {string} mode - 'temp' (임시저장) | 'approve' (결재요청)
 * @param {string} [propKey] - PropertiesService 키 (결재라인 조회/삭제용, 없으면 하드코딩 사용)
 * @param {Array} [modifiedApprLine] - 수정된 결재라인 (HTTP handler에서만 전달)
 * @returns {{ status: string, message?: string, error?: string, mode?: string, debug?: object }}
 */
function _cardApprovalCore(webankCookies, matched, mode, propKey, modifiedApprLine) {
  var debug = {};
  var isTemp = (mode !== 'approve');

  try {
    // Step 1: eusr_9001_01.act → Form1 hidden 필드
    var actResp = UrlFetchApp.fetch('https://webank.appplay.co.kr/eusr_9001_01.act', {
      method: 'get',
      headers: { 'User-Agent': BROWSER_UA, 'Cookie': webankCookies },
      muteHttpExceptions: true, followRedirects: false
    });
    if (actResp.getResponseCode() === 302 || actResp.getResponseCode() === 301) {
      return { error: 'SESSION_EXPIRED', message: '세션이 만료됐어.' };
    }
    var actHtml = actResp.getContentText();

    // Form1 hidden 필드 파싱
    var formFields = _parseFormFields(actHtml, 'Form1');

    // Step 2: 파이프 구분 리스트 구성
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

    // Step 3: Form1 POST → eapr_1001_01.act
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

    // 에러 페이지 체크
    if (eaprHtml.indexOf('페이지 오류 안내') >= 0) {
      return { error: 'EAPR_ERROR', message: 'eapr 팝업 로드 실패' };
    }

    // eapr 폼 필드 전체 파싱
    var eaprForm = _parseFormFields(eaprHtml, '');
    debug = { eaprStatus: eaprResp.getResponseCode(), matchedCount: matched.length };

    // === Step 4: r010 검증 호출 ===
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

    // 결재라인 처리
    var savedApprLineSeqNo = '';
    if (!isTemp && propKey) {
      var alProp = PropertiesService.getScriptProperties().getProperty(propKey + '_cardApprLine');
      if (alProp) {
        try {
          var savedApprLineRaw = JSON.parse(alProp);
          savedApprLineRaw.forEach(function(r) {
            if (!savedApprLineSeqNo && r.APPRLINE_SEQ_NO && r.APPRLINE_SEQ_NO !== '0') {
              savedApprLineSeqNo = r.APPRLINE_SEQ_NO;
            }
          });
          // 수정된 결재라인이 있으면 대체
          if (modifiedApprLine && modifiedApprLine.length > 0) {
            debug.usingModifiedApprLine = true;
          }
        } catch (pe) { /* ignore */ }
      }
    }

    var r010Json = {
      PTL_ID: eaprForm.PTL_ID || 'PTL_3',
      USE_INTT_ID: eaprForm.USE_INTT_ID || '',
      CHNL_ID: eaprForm.CHNL_ID || 'CHNL_1',
      RCPT_REC: rcptRec,
      CARD_REC: rcptRec
    };
    // 밥카 결재라인 고정: APPRLINE_SEQ_NO + REC 하드코딩
    if (!isTemp) {
      r010Json.APPRLINE_SEQ_NO = savedApprLineSeqNo || '84768443';
      r010Json.REC = [
        { APPR_ORD: '1', APPR_USER_GB: '1', APPRLINE_KIND: '2', RECENT_SAVE_YN: 'Y', BOTTOM_FIXED_YN: 'N', DEPT_CD: '19', DEPT_NM: '재무그룹' },
        { APPR_ORD: '0', APPR_USER_GB: '1', APPRLINE_KIND: '4', RECENT_SAVE_YN: 'Y', BOTTOM_FIXED_YN: 'N', DEPT_CD: '157', DEPT_NM: '관리그룹' }
      ];
    } else if (savedApprLineSeqNo) {
      r010Json.APPRLINE_SEQ_NO = savedApprLineSeqNo;
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
    var r010Data;
    try { r010Data = JSON.parse(r010Body); } catch (pe) { r010Data = null; }

    if (!r010Data || r010Data.RSLT_CD !== '0000') {
      return { error: 'R010_FAIL', message: 'r010 검증 실패: ' + (r010Data ? r010Data.RSLT_MSG : '파싱 오류'), debug: debug };
    }

    // === Step 5: c004 저장 호출 (r010 성공 후) ===
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
    }
    // _cardApprLine 프로퍼티 정리
    if (!isTemp && propKey) {
      PropertiesService.getScriptProperties().deleteProperty(propKey + '_cardApprLine');
    }

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
    var c004Data;
    try { c004Data = JSON.parse(c004Body); } catch (pe) { c004Data = null; }

    if (c004Data && c004Data.RSLT_CD === '0000') {
      var msg = isTemp ? '임시저장 완료' : '결재요청 완료';
      return { status: 'success', message: c004Data.RSLT_MSG || msg, mode: mode, debug: debug };
    }

    debug.c004Result = c004Data || c004Body.substring(0, 2000);
    return { error: 'C004_FAIL', message: 'c004 저장 실패: ' + (c004Data ? c004Data.RSLT_MSG : '파싱 오류'), debug: debug };

  } catch (err) {
    debug.exception = err.message;
    return { error: 'APPROVAL_ERROR', message: err.message, debug: debug };
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

/* ═══════════════ 맛집 평가 ═══════════════ */

/**
 * 맛집평가 시트 자동 생성 (없으면 헤더 삽입)
 * 기존 별점(2~5) → 좋아요(1) 자동 변환
 */
function ensureRatingSheet(ss) {
  var sheet = ss.getSheetByName(SHEET_NAME.RATING);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME.RATING);
    sheet.appendRow(['사용처', 'knoxId', '평점', '날짜']);
    return sheet;
  }
  // 기존 별점(2~5) → 좋아요(1) 변환
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var score = Number(data[i][2]);
    if (score >= 2 && score <= 5) {
      sheet.getRange(i + 1, 3).setValue(1);
    }
  }
  return sheet;
}

/**
 * 전체 좋아요/싫어요 집계 + 내 평가 반환
 * action=cardRatings&token={knoxId:hash}
 */
function handleCardRatings(adminRow, e) {
  var knoxId = String(adminRow[ADMIN_COL.KNOX_ID]);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureRatingSheet(ss);
  var data = sheet.getDataRange().getValues();

  var ratings = {}; // { merchant: { likes, dislikes, myRating } }
  for (var i = 1; i < data.length; i++) {
    var merchant = String(data[i][0]).trim();
    var rater = String(data[i][1]).trim();
    var score = Number(data[i][2]);
    if (!merchant || isNaN(score) || score < 0) continue;

    if (!ratings[merchant]) ratings[merchant] = { likes: 0, dislikes: 0, myRating: -1 };
    if (score > 0) ratings[merchant].likes++;
    else ratings[merchant].dislikes++;
    if (rater === knoxId) ratings[merchant].myRating = score > 0 ? 1 : 0;
  }

  var result = {};
  for (var m in ratings) {
    var r = ratings[m];
    result[m] = {
      likes: r.likes,
      dislikes: r.dislikes,
      count: r.likes + r.dislikes,
      myRating: r.myRating
    };
  }

  return createResponse({ status: 'success', ratings: result });
}

/**
 * 좋아요/싫어요 저장/수정
 * action=cardRate&token={knoxId:hash}&merchant={name}&rating={1=좋아요, 0=싫어요}
 */
function handleCardRate(adminRow, e) {
  var knoxId = String(adminRow[ADMIN_COL.KNOX_ID]);
  var merchant = (e.parameter.merchant || '').trim();
  var rating = Number(e.parameter.rating);

  if (!merchant) return createResponse({ error: 'MISSING_MERCHANT' });
  if (rating !== 0 && rating !== 1) return createResponse({ error: 'INVALID_RATING' });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureRatingSheet(ss);
  var data = sheet.getDataRange().getValues();

  // 기존 행 찾기
  var existingRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === merchant && String(data[i][1]).trim() === knoxId) {
      existingRow = i + 1; // 1-based
      break;
    }
  }

  var now = new Date().toISOString();
  if (existingRow > 0) {
    sheet.getRange(existingRow, 3).setValue(rating);
    sheet.getRange(existingRow, 4).setValue(now);
  } else {
    sheet.appendRow([merchant, knoxId, rating, now]);
  }

  // 해당 음식점 집계 반환
  var allData = sheet.getDataRange().getValues();
  var likes = 0, dislikes = 0;
  for (var j = 1; j < allData.length; j++) {
    if (String(allData[j][0]).trim() === merchant) {
      var s = Number(allData[j][2]);
      if (!isNaN(s) && s >= 0) {
        if (s > 0) likes++; else dislikes++;
      }
    }
  }

  return createResponse({
    status: 'success',
    merchant: merchant,
    likes: likes,
    dislikes: dislikes,
    count: likes + dislikes,
    myRating: rating
  });
}

// _cleanAmt, _getCardQueryPeriod, _fmtApvDt → card-utils.gs로 이동
