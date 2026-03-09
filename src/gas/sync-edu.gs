/**
 * 교육신청서 자동 동기화 모듈
 * - 관리자 시트(C열="교육") 계정으로 Bizplay 로그인 → 교육신청서 조회 → 시트 기록
 * - doGet 액션: adminAutoLogin, adminSyncEdu
 * - 독립 실행: syncEduRequests()
 */

var SYNC_EDU_SHEET = '교육 신청서';
var SYNC_EDU_HEADERS = [
  '작성일시', '기안자', '사원번호', '부서', '직위(직급)', '문서명', '문서번호',
  '제목', '부서명', '녹스ID', '성명', '교육과정명', '기간',
  '교육기관', '교육구분', '교육 목적 및 내용', '비용', '비용 청구 방식', '비고',
  '결재상태', '완료일시', '최근결재자', '다음결재자', '최종결재자', '첨부', '메모'
];
var SYNC_STS_MAP = { '9': '진행', '2': '진행', '3': '완료', '4': '반송', '5': '취소' };

/** 녹스ID에서 @emro.co.kr 제거 (일부 사용자가 이메일 전체를 입력하는 경우 대응) */
function _normalizeKnoxId(knoxId) {
  return String(knoxId || '').trim().replace(/@emro\.co\.kr$/i, '');
}

/** 관리자 시트에서 C열="교육" 행의 계정정보 읽기 */
function _getEduAdminCredentials() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var managerSheet = ss.getSheetByName(SHEET_NAME.MANAGER);
  if (!managerSheet) return null;

  var data = managerSheet.getDataRange().getValues();
  var mgrRow = null, mgrRowIdx = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][2]).trim() === '교육') { mgrRow = data[i]; mgrRowIdx = i; break; }
  }
  if (!mgrRow) return null;

  var knoxId = String(mgrRow[0]).trim();
  var rawPw = String(mgrRow[1] || '').trim();
  var bizplayId = String(mgrRow[3] || '').trim();
  if (!knoxId || !rawPw) return null;

  // 비밀번호: enc1: → 복호화, 평문 → 암호화 저장 후 사용
  var bizPwd;
  if (rawPw.indexOf('enc1:') === 0) {
    bizPwd = _decryptPw(rawPw);
  } else {
    bizPwd = rawPw;
    if (mgrRowIdx > 0) managerSheet.getRange(mgrRowIdx + 1, 2).setValue(_encryptPw(rawPw));
  }

  return {
    knoxId: knoxId,
    bizplayId: bizplayId,
    bizUserId: (bizplayId || knoxId) + '@emro.co.kr',
    bizPwd: bizPwd,
    managerSheet: managerSheet
  };
}

/** DRAFT_DATE(yyyyMMdd) + DRAFT_TIME(HHmmss) → "yyyy-MM-dd HH:mm:ss" */
function _formatDateTime(dateStr, timeStr) {
  var d = String(dateStr || '');
  var t = String(timeStr || '');
  if (d.length !== 8) return d;
  var result = d.substring(0, 4) + '-' + d.substring(4, 6) + '-' + d.substring(6, 8);
  if (t.length >= 6) {
    result += ' ' + t.substring(0, 2) + ':' + t.substring(2, 4) + ':' + t.substring(4, 6);
  }
  return result;
}

/** Bizplay approval API로 교육신청서 조회 */
function _fetchEduRecords(approvalCookies, useInttId, stDate, enDate, paperSeqNo) {
  var payload = '_JSON_=' + encodeURIComponent(JSON.stringify({
    PTL_ID: 'PTL_3', CHNL_ID: 'CHNL_1',
    USE_INTT_ID: useInttId || 'UTLZ_2108121502820',
    PAPER_SEQ_NO: paperSeqNo || '79697428',
    SRCH_WD: '', SRCH_DV: 'ppAll_mng', SRCH_DV_STS: '',
    ST_DRAFT_DATE: stDate, EN_DRAFT_DATE: enDate, DATE_GB: '1'
  }));

  var resp = UrlFetchApp.fetch('https://approval.appplay.co.kr/appr_paper_item_r001.jct', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    headers: {
      'User-Agent': BROWSER_UA,
      'Cookie': approvalCookies,
      'Referer': 'https://approval.appplay.co.kr/appr_list_0013.act',
      'X-Requested-With': 'XMLHttpRequest'
    },
    payload: payload,
    muteHttpExceptions: true
  });

  var body = JSON.parse(resp.getContentText());
  return body.REC || [];
}

/**
 * Bizplay REC 배열 → 교육 신청서와 동일한 컬럼 순서로 변환 (중복 문서번호 제외)
 *
 * 컬럼 순서 (A~Z, 26열):
 * A: 작성일시       B: 기안자         C: 사원번호       D: 부서
 * E: 직위(직급)     F: 문서명         G: 문서번호       H: 제목
 * I: 부서명         J: 녹스ID         K: 성명           L: 교육과정명
 * M: 기간           N: 교육기관       O: 교육구분       P: 교육 목적 및 내용
 * Q: 비용           R: 비용 청구 방식  S: 비고           T: 결재상태
 * U: 완료일시       V: 최근결재자     W: 다음결재자     X: 최종결재자
 * Y: 첨부           Z: 메모
 */
function _parseEduRecords(records) {
  // 문서번호 중복 시 완료(APPR_STS=3) 건 우선, 없으면 첫 건 사용
  var docMap = {};
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var dn = String(r.DOC_NO || '').trim();
    if (!dn) continue;
    if (!docMap[dn] || String(r.APPR_STS) === '3') {
      docMap[dn] = r;
    }
  }

  var newRows = [];
  var keys = Object.keys(docMap);
  for (var k = 0; k < keys.length; k++) {
    var rec = docMap[keys[k]];
    var docNo = keys[k];

    var vals1 = String(rec.ARR_ITVL_1 || '').split('|');
    var vals2 = String(rec.ARR_ITVL_2 || '').split('|');

    // 기간: 시작~종료
    var periodStart = (vals1[4] || '').trim();
    var periodEnd = (vals2[4] || '').trim();
    var period = periodStart;
    if (periodEnd) period += '~' + periodEnd;

    // 작성일시 / 완료일시
    var draftDateTime = _formatDateTime(rec.DRAFT_DATE, rec.DRAFT_TIME);
    var apprDateTime = rec.APPR_DATE ? _formatDateTime(rec.APPR_DATE, rec.APPR_TIME) : '';

    // 결재상태
    var status = SYNC_STS_MAP[String(rec.APPR_STS)] || rec.APPR_STS_NM || '';

    // 첨부: 0이면 N, 그 외 Y
    var attach = String(rec.ATTFILE_CNT || '0') === '0' ? 'N' : 'Y';

    // 비용: 콤마 유지 (텍스트)
    var cost = (vals1[8] || '').trim();

    newRows.push([
      draftDateTime,                           // A: 작성일시
      rec.DRAFT_USER_NM || '',                 // B: 기안자
      rec.ID_NUMBER || '',                     // C: 사원번호
      rec.DRAFT_USER_DEPT_NM || '',            // D: 부서
      rec.JBCL_NM || '',                       // E: 직위(직급)
      rec.MARK_DOC_NM || '',                   // F: 문서명
      docNo,                                   // G: 문서번호
      rec.APPR_SUBJ || '',                     // H: 제목
      (vals1[0] || '').trim(),                 // I: 부서명
      _normalizeKnoxId(vals1[1]),              // J: 녹스ID (@emro.co.kr 제거)
      (vals1[2] || '').trim(),                 // K: 성명
      (vals1[3] || '').trim(),                 // L: 교육과정명
      period,                                  // M: 기간
      (vals1[5] || '').trim(),                 // N: 교육기관
      (vals1[6] || '').trim(),                 // O: 교육구분
      (vals1[7] || '').trim(),                 // P: 교육 목적 및 내용
      cost,                                    // Q: 비용
      (vals1[9] || '').trim(),                 // R: 비용 청구 방식
      (vals1[10] || '').trim(),                // S: 비고
      status,                                  // T: 결재상태
      apprDateTime,                            // U: 완료일시
      rec.RECENT_APPR_USER_NM || '',           // V: 최근결재자
      rec.NEXT_APPR_USER_NM || '',             // W: 다음결재자
      rec.LAST_APPR_USER_NM || '',             // X: 최종결재자
      attach,                                  // Y: 첨부
      rec.MEMO || ''                           // Z: 메모
    ]);
  }
  return newRows;
}

/**
 * 시트에 기록 (상태 기반 upsert)
 * - 기존 시트에 해당 문서번호가 "완료"이면 → 스킵 (덮어쓰지 않음)
 * - 기존 시트에 해당 문서번호가 "완료"가 아니면 → 삭제 후 새 데이터 삽입
 * - 기존에 없는 문서번호 → 새로 삽입
 * @return {{ sheet: Sheet, completedDocs: Array }} completedDocs = 이번에 "완료"로 전환된 문서 정보 배열
 */
function _writeEduRows(ss, newRows) {
  var testSheet = ss.getSheetByName(SYNC_EDU_SHEET);
  if (!testSheet) {
    testSheet = ss.insertSheet(SYNC_EDU_SHEET);
  }
  testSheet.getRange(1, 1, 1, SYNC_EDU_HEADERS.length).setValues([SYNC_EDU_HEADERS]);

  var completedDocs = [];
  if (newRows.length === 0) return { sheet: testSheet, completedDocs: completedDocs };

  // 기존 시트의 문서번호(G열=index6) → 결재상태(T열=index19) 맵
  var existingStatus = {};  // docNo → status
  if (testSheet.getLastRow() > 1) {
    var data = testSheet.getDataRange().getValues();
    for (var j = 1; j < data.length; j++) {
      var docNo = String(data[j][6]).trim();
      if (docNo) existingStatus[docNo] = String(data[j][19]).trim();
    }
  }

  // 새로 넣을 행 필터링 + 완료 전환 감지
  var rowsToInsert = [];
  for (var i = 0; i < newRows.length; i++) {
    var inDocNo = String(newRows[i][6]).trim();
    var inStatus = String(newRows[i][19]).trim();
    var oldStatus = existingStatus[inDocNo];

    if (oldStatus === '완료' || oldStatus === '반송') {
      // 기존이 완료/반송이면 건너뜀 (덮어쓰지 않음)
      continue;
    }

    rowsToInsert.push(newRows[i]);

    // 완료 전환 감지: 새로 들어온 건이 "완료"이고, 기존이 완료가 아닌 경우 (신규 포함)
    if (inStatus === '완료') {
      completedDocs.push({
        docNo: inDocNo,
        knoxId: String(newRows[i][9]).trim(),   // J열: 녹스ID
        title: String(newRows[i][11]).trim(),    // L열: 교육과정명
        cost: String(newRows[i][16]).trim(),     // Q열: 비용
        name: String(newRows[i][10]).trim()      // K열: 성명
      });
    }
  }

  if (rowsToInsert.length === 0) return { sheet: testSheet, completedDocs: completedDocs };

  // 삽입 대상 문서번호 Set
  var insertDocNos = {};
  for (var k = 0; k < rowsToInsert.length; k++) {
    insertDocNos[String(rowsToInsert[k][6]).trim()] = true;
  }

  // 기존 행에서 삽입 대상 문서번호 행 삭제 (아래→위)
  if (testSheet.getLastRow() > 1) {
    var sheetData = testSheet.getDataRange().getValues();
    for (var m = sheetData.length - 1; m >= 1; m--) {
      var existDocNo = String(sheetData[m][6]).trim();
      if (existDocNo && insertDocNos[existDocNo]) {
        testSheet.deleteRow(m + 1);
      }
    }
  }

  // 새 데이터 추가
  testSheet.getRange(testSheet.getLastRow() + 1, 1, rowsToInsert.length, rowsToInsert[0].length).setValues(rowsToInsert);

  // 작성일시(A열) 기준 내림차순 정렬 (헤더 제외)
  if (testSheet.getLastRow() > 1) {
    testSheet.getRange(2, 1, testSheet.getLastRow() - 1, testSheet.getLastColumn()).sort({ column: 1, ascending: false });
  }
  return { sheet: testSheet, completedDocs: completedDocs };
}

/**
 * 완료 전환된 문서에 대해 Flow 알림 발송 (교육/도서 공통)
 * - Flow자동발송이력 시트에 문서번호가 없는 건만 발송
 * - 발송 후 이력 기록 (수신동의 무관하게 이력은 항상 기록)
 * @param {Spreadsheet} ss
 * @param {string} reqType - '교육비' 또는 '도서비'
 * @param {Array} completedDocs - [{ docNo, knoxId, title, cost, name }]
 * @return {number} 발송 성공 건수
 */
function _sendCompletionFlow(ss, reqType, completedDocs) {
  if (!completedDocs || completedDocs.length === 0) return 0;

  // 문서번호 오름차순 정렬 (인사-2026-0001 → 인사-2026-9999)
  completedDocs.sort(function(a, b) { return a.docNo < b.docNo ? -1 : a.docNo > b.docNo ? 1 : 0; });

  // Flow자동발송이력 시트에서 기존 발송 문서번호 Set
  var historySheet = ss.getSheetByName(SHEET_NAME_HISTORY);
  if (!historySheet) {
    historySheet = ss.insertSheet(SHEET_NAME_HISTORY);
    historySheet.getRange(1, 1, 1, 3).setValues([['문서번호', '발송일시', '녹스ID']]);
  }
  var sentDocIds = {};
  if (historySheet.getLastRow() >= 1) {
    var hData = historySheet.getDataRange().getValues();
    for (var h = 0; h < hData.length; h++) {
      sentDocIds[String(hData[h][0]).trim()] = true;
    }
  }

  // 수신동의 맵 (웹페이지관리 시트)
  var adminSheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  var agreeMap = {};
  if (adminSheet && adminSheet.getLastRow() >= 2) {
    var aData = adminSheet.getDataRange().getValues();
    for (var a = 1; a < aData.length; a++) {
      agreeMap[String(aData[a][ADMIN_COL.KNOX_ID]).trim()] = String(aData[a][ADMIN_COL.AGREE]).trim();
    }
  }

  // 예산 사용액 계산: 교육+도서 시트의 완료 건 합산
  var budgetMap = {};
  var _acc = function(sheet, colDef) {
    if (!sheet || sheet.getLastRow() < 2) return;
    var rows = sheet.getDataRange().getValues();
    for (var j = 1; j < rows.length; j++) {
      var kid = _normalizeKnoxId(rows[j][colDef.KNOX_ID]);
      if (rows[j][colDef.STATUS] === '완료') {
        budgetMap[kid] = (budgetMap[kid] || 0) + (Number(rows[j][colDef.COST]) || 0);
      }
    }
  };
  _acc(ss.getSheetByName(SHEET_NAME.DATA), DATA_COL);
  _acc(ss.getSheetByName(SHEET_NAME.BOOK), BOOK_COL);

  var sent = 0;
  for (var i = 0; i < completedDocs.length; i++) {
    var doc = completedDocs[i];
    if (!doc.knoxId) continue;
    if (sentDocIds[doc.docNo]) {
      Logger.log('[sync] 이미 발송 이력 있음: ' + doc.docNo);
      continue;
    }

    var totalUsed = budgetMap[doc.knoxId] || 0;
    var costNum = Number(String(doc.cost).replace(/,/g, '')) || 0;

    // 수신동의한 사용자에게만 Flow 발송
    if (agreeMap[doc.knoxId] === 'Y') {
      try {
        var msg = FLOW_MSG.approvalComplete(reqType, doc.docNo, doc.title, costNum, totalUsed, LIMIT_BUDGET - totalUsed);
        if (sendFlowMsg(doc.knoxId, msg)) { sent++; }
        Logger.log('[sync] Flow 발송: ' + doc.docNo + ' → ' + doc.knoxId);
      } catch (e) {
        Logger.log('[sync] Flow 발송 실패: ' + doc.docNo + ' - ' + e.message);
      }
    } else {
      Logger.log('[sync] 이력만 기록 (수신동의 미동의): ' + doc.docNo + ', ' + doc.knoxId);
    }

    // 발송 여부 무관하게 이력 기록 (중복 발송 방지)
    historySheet.appendRow([doc.docNo, new Date(), doc.knoxId]);
    sentDocIds[doc.docNo] = true;
  }
  return sent;
}

/* ═══════════════ doGet 액션 핸들러 ═══════════════ */

/** [기능 16] 관리자 자동 로그인 (doGet에서 호출) */
function handleAdminAutoLogin(managerData, managerSheet, adminByKnoxId) {
  var cred = _getEduAdminCredentials();
  if (!cred) return createResponse({ error: "NO_CREDENTIALS", message: "관리자 시트에 교육 계정정보가 없어." });

  try {
    var loginResult = _bizplayLoginCore(cred.bizUserId, cred.bizPwd);
    if (loginResult.error) {
      return createResponse({ status: "fail", message: "Bizplay 로그인 실패: " + loginResult.error, debug: { bizUserId: cred.bizUserId, knoxId: cred.knoxId } });
    }

    // 세션 저장
    PropertiesService.getScriptProperties().setProperty('bizplay_admin_' + cred.knoxId, JSON.stringify({
      bizplayCookies: loginResult.bizplayCookies,
      approvalCookies: loginResult.approvalCookies || '',
      webankCookies: loginResult.webankCookies || '',
      userId: cred.bizUserId,
      userName: loginResult.userName,
      useInttId: loginResult.useInttId || '',
      loginTime: new Date().toISOString()
    }));

    // 토큰 생성
    var adminEntry = adminByKnoxId.get(cred.knoxId);
    var encPw = adminEntry ? String(adminEntry.row[7] || '') : '';
    var tkn = _generateToken(cred.knoxId, encPw);

    return createResponse({
      status: "success", token: tkn,
      knoxId: cred.knoxId, userName: loginResult.userName || cred.knoxId,
      message: "Bizplay 자동 로그인 성공"
    });
  } catch (err) {
    return createResponse({ status: "fail", message: "로그인 오류: " + err.message });
  }
}

/** [기능 17] 교육신청서 동기화 (doGet에서 호출) */
function handleAdminSyncEdu(e) {
  var cred = _getEduAdminCredentials();
  if (!cred) return createResponse({ error: "NO_EDU_ADMIN" });

  var sessionRaw = PropertiesService.getScriptProperties().getProperty('bizplay_admin_' + cred.knoxId);
  if (!sessionRaw) return createResponse({ error: "NO_SESSION", message: "먼저 관리자 자동 로그인을 해줘." });
  var session = JSON.parse(sessionRaw);
  if (!session.approvalCookies) return createResponse({ error: "NO_APPROVAL", message: "Approval 쿠키가 없어. 다시 로그인해줘." });

  var now = new Date();
  var enDate = e.parameter.enDate || Utilities.formatDate(now, 'Asia/Seoul', 'yyyyMMdd');
  var stDate = e.parameter.stDate || Utilities.formatDate(new Date(now.getTime() - 30 * 86400000), 'Asia/Seoul', 'yyyyMMdd');
  var paperSeqNo = e.parameter.paperSeqNo || '79697428';

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var records = _fetchEduRecords(session.approvalCookies, session.useInttId, stDate, enDate, paperSeqNo);
    if (records.length === 0) return createResponse({ status: "success", message: "조회 결과 0건", count: 0 });

    var newRows = _parseEduRecords(records);
    var result = _writeEduRows(ss, newRows);

    // 완료 전환된 건에 대해 Flow 발송
    var flowSent = _sendCompletionFlow(ss, '교육비', result.completedDocs);

    return createResponse({
      status: "success",
      message: records.length + "건 조회, " + newRows.length + "건 파싱, 완료전환 " + result.completedDocs.length + "건" + (flowSent > 0 ? ", Flow " + flowSent + "건 발송" : ""),
      totalFetched: records.length, parsed: newRows.length,
      completedCount: result.completedDocs.length, flowSent: flowSent
    });
  } catch (err) {
    return createResponse({ status: "fail", message: "동기화 오류: " + err.message });
  }
}

/* ═══════════════ 독립 실행 함수 ═══════════════ */

/**
 * 교육신청서 + 도서신청서 통합 동기화 (GAS 편집기에서 직접 실행 또는 트리거 등록)
 * - 로그인 1회 → 교육/도서 순차 처리
 */
function syncEduBookRequests() {
  var now = new Date();
  var dow = now.getDay();
  if (dow === 0 || dow === 6) { Logger.log('[sync] 주말 스킵'); return; }
  if (_isHolidayServer(now)) { Logger.log('[sync] 공휴일 스킵'); return; }

  var cred = _getEduAdminCredentials();
  if (!cred) { Logger.log('[sync] 관리자 시트에 교육 계정정보 없음'); return; }

  // 관리자 시트 Knox ID 목록 (실패 시 알림 대상)
  var adminKnoxIds = _getAdminKnoxIds();

  Logger.log('[sync] 로그인 시도: ' + cred.bizUserId);
  var loginResult;
  try {
    loginResult = _bizplayLoginCore(cred.bizUserId, cred.bizPwd);
    if (loginResult.error) {
      _notifySyncFail(adminKnoxIds, '로그인 실패: ' + loginResult.error);
      return;
    }
  } catch (err) {
    _notifySyncFail(adminKnoxIds, '로그인 오류: ' + err.message);
    return;
  }

  if (!loginResult.approvalCookies) {
    _notifySyncFail(adminKnoxIds, 'Approval 쿠키 없음. 재로그인 필요.');
    return;
  }
  Logger.log('[sync] 로그인 성공: ' + (loginResult.userName || cred.bizUserId));

  var now = new Date();
  var enDate = Utilities.formatDate(now, 'Asia/Seoul', 'yyyyMMdd');
  var stDate = Utilities.formatDate(new Date(now.getTime() - 30 * 86400000), 'Asia/Seoul', 'yyyyMMdd');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cookies = loginResult.approvalCookies;
  var inttId = loginResult.useInttId;
  var errors = [];

  // ── Flow발송이력 3개월 이전 정리 ──
  _cleanupFlowHistory(ss, now);

  // ── 교육신청서 ──
  try {
    var eduRecords = _fetchEduRecords(cookies, inttId, stDate, enDate);
    Logger.log('[sync] 교육 조회: ' + eduRecords.length + '건');
    if (eduRecords.length > 0) {
      var eduRows = _parseEduRecords(eduRecords);
      var eduResult = _writeEduRows(ss, eduRows);
      var eduFlow = _sendCompletionFlow(ss, '교육비', eduResult.completedDocs);
      Logger.log('[sync] 교육 반영: ' + eduRows.length + '건 파싱, 완료전환 ' + eduResult.completedDocs.length + '건, Flow ' + eduFlow + '건');
    }
  } catch (err) {
    Logger.log('[sync] 교육 오류: ' + err.message);
    errors.push('교육: ' + err.message);
  }

  // ── 도서신청서 ──
  try {
    var bookRecords = _fetchEduRecords(cookies, inttId, stDate, enDate, SYNC_BOOK_PAPER_SEQ_NO);
    Logger.log('[sync] 도서 조회: ' + bookRecords.length + '건');
    if (bookRecords.length > 0) {
      var bookRows = _parseBookRecords(bookRecords);
      var bookResult = _writeBookRows(ss, bookRows);
      var bookFlow = _sendCompletionFlow(ss, '도서비', bookResult.completedDocs);
      Logger.log('[sync] 도서 반영: ' + bookRows.length + '건 파싱, 완료전환 ' + bookResult.completedDocs.length + '건, Flow ' + bookFlow + '건');
    }
  } catch (err) {
    Logger.log('[sync] 도서 오류: ' + err.message);
    errors.push('도서: ' + err.message);
  }

  if (errors.length > 0) {
    _notifySyncFail(adminKnoxIds, errors.join('\n'));
  }

  Logger.log('[sync] 완료');
}

/** 관리자 시트에서 Knox ID 목록 조회 */
function _getAdminKnoxIds() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME.MANAGER);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var data = sheet.getDataRange().getValues();
  var ids = [];
  for (var i = 1; i < data.length; i++) {
    var kid = String(data[i][0]).trim();
    if (kid) ids.push(kid);
  }
  return ids;
}

/** 관리자 목록에 동기화 실패 Flow 발송 */
function _notifySyncFail(knoxIds, reason) {
  Logger.log('[sync] 실패 알림: ' + reason);
  var msg = FLOW_MSG.syncFail(reason);
  for (var i = 0; i < knoxIds.length; i++) {
    try { sendFlowMsg(knoxIds[i], msg); } catch (e) {}
  }
}

/** Flow자동발송이력에서 3개월 이전 행 삭제 (B열=발송일시 기준) */
function _cleanupFlowHistory(ss, now) {
  var sheet = ss.getSheetByName(SHEET_NAME_HISTORY);
  if (!sheet || sheet.getLastRow() <= 1) return;

  var cutoff = new Date(now.getTime() - 90 * 86400000);
  var data = sheet.getDataRange().getValues();
  var deleted = 0;

  for (var i = data.length - 1; i >= 1; i--) {
    var dt = data[i][1];
    if (dt instanceof Date && dt < cutoff) {
      sheet.deleteRow(i + 1);
      deleted++;
    }
  }
  if (deleted > 0) Logger.log('[sync] 발송이력 정리: ' + deleted + '건 삭제 (3개월 이전)');
}

/* ═══════════════════════════════════════════════════════════════
 *  도서신청서 동기화
 * ═══════════════════════════════════════════════════════════════ */

var SYNC_BOOK_SHEET = '도서 신청서';
var SYNC_BOOK_PAPER_SEQ_NO = '16206240';
var SYNC_BOOK_HEADERS = [
  '작성일시', '기안자', '사원번호', '부서', '직위(직급)', '문서명', '문서번호',
  '제목', '부서명', '녹스ID', '성명', '도서명', '비용', '구입목적', '도서목차', '비고',
  '결재상태', '완료일시', '최근결재자', '다음결재자', '최종결재자', '첨부', '메모'
];

/**
 * Bizplay REC 배열 → 도서 신청서 컬럼 순서로 변환 (중복 문서번호 제외)
 *
 * 컬럼 순서 (A~W, 23열):
 * A: 작성일시   B: 기안자     C: 사원번호   D: 부서       E: 직위(직급)
 * F: 문서명     G: 문서번호   H: 제목       I: 부서명     J: 녹스ID
 * K: 성명       L: 도서명     M: 비용       N: 구입목적   O: 도서목차
 * P: 비고       Q: 결재상태   R: 완료일시   S: 최근결재자 T: 다음결재자
 * U: 최종결재자 V: 첨부       W: 메모
 */
function _parseBookRecords(records) {
  var docMap = {};
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var dn = String(r.DOC_NO || '').trim();
    if (!dn) continue;
    if (!docMap[dn] || String(r.APPR_STS) === '3') {
      docMap[dn] = r;
    }
  }

  var newRows = [];
  var keys = Object.keys(docMap);
  for (var k = 0; k < keys.length; k++) {
    var rec = docMap[keys[k]];
    var docNo = keys[k];
    var vals1 = String(rec.ARR_ITVL_1 || '').split('|');

    var draftDateTime = _formatDateTime(rec.DRAFT_DATE, rec.DRAFT_TIME);
    var apprDateTime = rec.APPR_DATE ? _formatDateTime(rec.APPR_DATE, rec.APPR_TIME) : '';
    var status = SYNC_STS_MAP[String(rec.APPR_STS)] || rec.APPR_STS_NM || '';
    var attach = String(rec.ATTFILE_CNT || '0') === '0' ? 'N' : 'Y';

    newRows.push([
      draftDateTime,                           // A: 작성일시
      rec.DRAFT_USER_NM || '',                 // B: 기안자
      rec.ID_NUMBER || '',                     // C: 사원번호
      rec.DRAFT_USER_DEPT_NM || '',            // D: 부서
      rec.JBCL_NM || '',                       // E: 직위(직급)
      rec.MARK_DOC_NM || '',                   // F: 문서명
      docNo,                                   // G: 문서번호
      rec.APPR_SUBJ || '',                     // H: 제목
      (vals1[0] || '').trim(),                 // I: 부서명
      _normalizeKnoxId(vals1[1]),              // J: 녹스ID (@emro.co.kr 제거)
      (vals1[2] || '').trim(),                 // K: 성명
      (vals1[3] || '').trim(),                 // L: 도서명
      (vals1[4] || '').trim(),                 // M: 비용
      (vals1[5] || '').trim(),                 // N: 구입목적
      (vals1[6] || '').trim(),                 // O: 도서목차
      (vals1[7] || '').trim(),                 // P: 비고
      status,                                  // Q: 결재상태
      apprDateTime,                            // R: 완료일시
      rec.RECENT_APPR_USER_NM || '',           // S: 최근결재자
      rec.NEXT_APPR_USER_NM || '',             // T: 다음결재자
      rec.LAST_APPR_USER_NM || '',             // U: 최종결재자
      attach,                                  // V: 첨부
      rec.MEMO || ''                           // W: 메모
    ]);
  }
  return newRows;
}

/**
 * 도서신청서 시트에 기록 (상태 기반 upsert)
 * - 문서번호: index 6 (G열), 결재상태: index 16 (Q열)
 */
function _writeBookRows(ss, newRows) {
  var sheet = ss.getSheetByName(SYNC_BOOK_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SYNC_BOOK_SHEET);
  }
  sheet.getRange(1, 1, 1, SYNC_BOOK_HEADERS.length).setValues([SYNC_BOOK_HEADERS]);

  var completedDocs = [];
  if (newRows.length === 0) return { sheet: sheet, completedDocs: completedDocs };

  var DOC_NO_IDX = 6, STATUS_IDX = 16;

  // 기존 시트의 문서번호 → 결재상태 맵
  var existingStatus = {};
  if (sheet.getLastRow() > 1) {
    var data = sheet.getDataRange().getValues();
    for (var j = 1; j < data.length; j++) {
      var docNo = String(data[j][DOC_NO_IDX]).trim();
      if (docNo) existingStatus[docNo] = String(data[j][STATUS_IDX]).trim();
    }
  }

  // 필터링 + 완료 전환 감지
  var rowsToInsert = [];
  for (var i = 0; i < newRows.length; i++) {
    var inDocNo = String(newRows[i][DOC_NO_IDX]).trim();
    var inStatus = String(newRows[i][STATUS_IDX]).trim();
    var oldStatus = existingStatus[inDocNo];

    if (oldStatus === '완료' || oldStatus === '반송') continue;

    rowsToInsert.push(newRows[i]);

    if (inStatus === '완료') {
      completedDocs.push({
        docNo: inDocNo,
        knoxId: String(newRows[i][9]).trim(),    // J: 녹스ID
        title: String(newRows[i][11]).trim(),     // L: 도서명
        cost: String(newRows[i][12]).trim(),      // M: 비용
        name: String(newRows[i][10]).trim()       // K: 성명
      });
    }
  }

  if (rowsToInsert.length === 0) return { sheet: sheet, completedDocs: completedDocs };

  // 삽입 대상 문서번호 Set
  var insertDocNos = {};
  for (var k = 0; k < rowsToInsert.length; k++) {
    insertDocNos[String(rowsToInsert[k][DOC_NO_IDX]).trim()] = true;
  }

  // 기존 행 삭제 (아래→위)
  if (sheet.getLastRow() > 1) {
    var sheetData = sheet.getDataRange().getValues();
    for (var m = sheetData.length - 1; m >= 1; m--) {
      var existDocNo = String(sheetData[m][DOC_NO_IDX]).trim();
      if (existDocNo && insertDocNos[existDocNo]) {
        sheet.deleteRow(m + 1);
      }
    }
  }

  sheet.getRange(sheet.getLastRow() + 1, 1, rowsToInsert.length, rowsToInsert[0].length).setValues(rowsToInsert);

  // 작성일시(A열) 기준 내림차순 정렬 (헤더 제외)
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).sort({ column: 1, ascending: false });
  }
  return { sheet: sheet, completedDocs: completedDocs };
}


/** [기능 18] 도서신청서 동기화 (doGet에서 호출) */
function handleAdminSyncBook(e) {
  var cred = _getEduAdminCredentials();
  if (!cred) return createResponse({ error: "NO_EDU_ADMIN" });

  var sessionRaw = PropertiesService.getScriptProperties().getProperty('bizplay_admin_' + cred.knoxId);
  if (!sessionRaw) return createResponse({ error: "NO_SESSION", message: "먼저 관리자 자동 로그인을 해줘." });
  var session = JSON.parse(sessionRaw);
  if (!session.approvalCookies) return createResponse({ error: "NO_APPROVAL", message: "Approval 쿠키가 없어. 다시 로그인해줘." });

  var now = new Date();
  var enDate = e.parameter.enDate || Utilities.formatDate(now, 'Asia/Seoul', 'yyyyMMdd');
  var stDate = e.parameter.stDate || Utilities.formatDate(new Date(now.getTime() - 30 * 86400000), 'Asia/Seoul', 'yyyyMMdd');
  var paperSeqNo = e.parameter.paperSeqNo || SYNC_BOOK_PAPER_SEQ_NO;

  if (!paperSeqNo) return createResponse({ error: "NO_PAPER_SEQ", message: "도서신청서 PAPER_SEQ_NO가 설정되지 않았어." });

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var records = _fetchEduRecords(session.approvalCookies, session.useInttId, stDate, enDate, paperSeqNo);
    if (records.length === 0) return createResponse({ status: "success", message: "조회 결과 0건", count: 0 });

    var newRows = _parseBookRecords(records);
    var result = _writeBookRows(ss, newRows);

    var flowSent = _sendCompletionFlow(ss, '도서비', result.completedDocs);

    return createResponse({
      status: "success",
      message: records.length + "건 조회, " + newRows.length + "건 파싱, 완료전환 " + result.completedDocs.length + "건" + (flowSent > 0 ? ", Flow " + flowSent + "건 로그" : ""),
      totalFetched: records.length, parsed: newRows.length,
      completedCount: result.completedDocs.length, flowSent: flowSent
    });
  } catch (err) {
    return createResponse({ status: "fail", message: "도서 동기화 오류: " + err.message });
  }
}

