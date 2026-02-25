const LIMIT_BUDGET = 500000;

// [설정] 시트 이름과 컬럼 인덱스
const SHEET_NAME = {
  DATA: "교육 신청서",
  ADMIN: "웹페이지관리"
};

const DATA_COL = {
  KNOX_ID: 9, NAME: 10, TITLE: 11, CONTENT: 12, PERIOD: 13, COST: 16, STATUS: 19, ALARM_SENT: 26 // AA열
};

const ADMIN_COL = {
  KNOX_ID: 0, AGREE: 1, UUID: 2, LAST_LOGIN: 3, AUTH_CODE: 4, AUTH_TIME: 5 // A~F열
};

/**
 * 웹 요청 처리 (조회, 알람업데이트, 인증번호발송, 검증)
 */
const doGet = (e) => {
  const { action, token, knoxId, authCode, isAgreed } = e.parameter;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName(SHEET_NAME.DATA);
  const adminSheet = ss.getSheetByName(SHEET_NAME.ADMIN);

  if (!adminSheet) return createResponse({ error: "관리 시트 부재" });
  const adminData = adminSheet.getDataRange().getValues();

  // [기능 1] 인증번호 발송 (웹페이지 사번 입력 시)
  if (action === "sendCode" && knoxId) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const rowIndex = adminData.findIndex(row => row[ADMIN_COL.KNOX_ID] === knoxId);

    if (rowIndex !== -1) {
      adminSheet.getRange(rowIndex + 1, ADMIN_COL.AUTH_CODE + 1).setValue(code);
      adminSheet.getRange(rowIndex + 1, ADMIN_COL.AUTH_TIME + 1).setValue(new Date());
    } else {
      adminSheet.appendRow([knoxId, "N", "", "", code, new Date()]);
    }

    sendFlowGAS(knoxId, `[교육비 조회 인증]\n인증번호: [${code}]\n3분 이내에 입력해주세요.`);
    return createResponse({ status: "success" });
  }

  // [기능 2] 인증번호 검증 및 UUID 발급
  if (action === "verify" && knoxId && authCode) {
    const rowIndex = adminData.findIndex(row => row[ADMIN_COL.KNOX_ID] === knoxId);
    if (rowIndex === -1) return createResponse({ error: "NOT_FOUND" });

    const row = adminData[rowIndex];
    const diff = (new Date() - new Date(row[ADMIN_COL.AUTH_TIME])) / 1000 / 60;

    if (String(row[ADMIN_COL.AUTH_CODE]) === authCode && diff <= 3) {
      const uuid = row[ADMIN_COL.UUID] || Utilities.getUuid();
      adminSheet.getRange(rowIndex + 1, ADMIN_COL.UUID + 1).setValue(uuid);
      return createResponse({ status: "success", token: uuid });
    }
    return createResponse({ error: "INVALID_OR_EXPIRED" });
  }

  // [기능 3] 알람 수신 여부 업데이트
  if (action === "updateAlarm" && token) {
    const rowIndex = adminData.findIndex(row => row[ADMIN_COL.UUID] === token);
    if (rowIndex !== -1) {
      adminSheet.getRange(rowIndex + 1, ADMIN_COL.AGREE + 1).setValue(isAgreed === "true" || isAgreed === true ? "Y" : "N");
      return createResponse({ status: "success" });
    }
  }

  // [기능 4] 데이터 조회
  if (token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });

    const currentKnoxId = adminRow[ADMIN_COL.KNOX_ID];
    const isAgreed = adminRow[ADMIN_COL.AGREE];

    const allData = dataSheet.getDataRange().getValues();
    const userRows = allData.filter(row => row[DATA_COL.KNOX_ID] === currentKnoxId);

    let totalUsed = 0;
    const history = userRows.map(row => {
      const cost = Number(row[DATA_COL.COST]) || 0;
      if (row[DATA_COL.STATUS] === "완료") totalUsed += cost;
      return { courseName: row[DATA_COL.TITLE], content: row[DATA_COL.CONTENT], cost, period: row[DATA_COL.PERIOD], status: row[DATA_COL.STATUS] };
    });

    const adminRowIdx = adminData.findIndex(row => row[ADMIN_COL.UUID] === token);
    adminSheet.getRange(adminRowIdx + 1, ADMIN_COL.LAST_LOGIN + 1).setValue(new Date());

    return createResponse({
      userInfo: { name: userRows.length > 0 ? userRows[0][DATA_COL.NAME] : "사용자", isAgreed: isAgreed === "Y", totalBudget: LIMIT_BUDGET, usedBudget: totalUsed, remainingBudget: LIMIT_BUDGET - totalUsed },
      history
    });
  }
  return createResponse({ error: "INVALID_REQUEST" });
};

/**
 * 시트 수정 트리거 (결재 완료 시 자동 발송)
 */
const onDataEdited = (e) => {
  const range = e.range;
  const sheet = range.getSheet();
  if (sheet.getName() !== SHEET_NAME.DATA || range.getColumn() !== 20) return;

  const rowIndex = range.getRow();
  if (rowIndex === 1) return;

  const rowData = sheet.getRange(rowIndex, 1, 1, 27).getValues()[0];
  const status = rowData[DATA_COL.STATUS];
  const knoxId = rowData[DATA_COL.KNOX_ID];
  const isAlarmSent = rowData[DATA_COL.ALARM_SENT];

  if (status === "완료" && isAlarmSent !== "Y") {
    const adminSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME.ADMIN);
    const adminData = adminSheet.getDataRange().getValues();
    const userAdminInfo = adminData.find(row => row[ADMIN_COL.KNOX_ID] === knoxId);

    if (userAdminInfo && userAdminInfo[ADMIN_COL.AGREE] === "Y") {
      const allData = sheet.getDataRange().getValues();
      let totalUsed = 0;
      allData.forEach(r => { if (r[DATA_COL.KNOX_ID] === knoxId && r[DATA_COL.STATUS] === "완료") totalUsed += (Number(r[DATA_COL.COST]) || 0); });

      const content = `[교육비 결재 완료]\n- 과정: ${rowData[DATA_COL.TITLE]}\n- 금액: ${Number(rowData[DATA_COL.COST]).toLocaleString()}원\n- 총 사용: ${totalUsed.toLocaleString()}원\n- 잔액: ${(LIMIT_BUDGET - totalUsed).toLocaleString()}원`;
      if (sendFlowGAS(knoxId, content)) {
        sheet.getRange(rowIndex, DATA_COL.ALARM_SENT + 1).setValue("Y");
      }
    }
  }
};

/**
 * Flow 메신저 발송 공통 함수
 */
function sendFlowGAS(userId, content) {
  const API_URL = 'https://flow.emro.co.kr/MGateway';
  const CNTS_CRTC_KEY = '20210824-d3c5eb06-b3b1-4f6e-9ba7-a61e2b71c78f';
  const fullUserId = userId.includes('@') ? userId : `${userId}@emro.co.kr`;

  const payload = 'JSONData=' + encodeURIComponent(JSON.stringify({
    API_KEY: 'FLOW_BOT_NOTI_API',
    CNTS_CRTC_KEY: CNTS_CRTC_KEY,
    REQ_DATA: { BOT_ID: 'd2sbot', RCVR_USER_ID: fullUserId, CNTN: content, PREVIEW_TTL: '교육비 알림', PREVIEW_CNTN: '상세내역 확인' }
  }));

  const response = UrlFetchApp.fetch(API_URL, { 'method': 'post', 'contentType': 'application/x-www-form-urlencoded', 'payload': payload, 'muteHttpExceptions': true });
  try { return JSON.parse(decodeURIComponent(response.getContentText())); } catch (e) { return null; }
}

const createResponse = (obj) => ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
