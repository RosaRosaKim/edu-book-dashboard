// [설정] 시트 이름과 컬럼 인덱스
const LIMIT_BUDGET = 500000;
const SHEET_NAME = {
  DATA: "교육 신청서",
  BOOK: "도서 신청서",
  ADMIN: "웹페이지관리",
  MANAGER: "관리자",
  AI: "AI자동분류"
};

const DATA_COL = {
  KNOX_ID: 9, NAME: 10, TITLE: 11, COST: 16, VENDOR: 17, STATUS: 19
};

const ADMIN_COL = {
  KNOX_ID: 0, AGREE: 1, UUID: 2, LAST_LOGIN: 3, AUTH_CODE: 4, AUTH_TIME: 5
};

/**
 * 웹 요청 처리 (교육/도서 병합 및 AI 3컬럼 분류 반영)
 */
const doGet = (e) => {
  const { action, token, knoxId, authCode } = e.parameter;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName(SHEET_NAME.DATA);
  const bookSheet = ss.getSheetByName(SHEET_NAME.BOOK);
  const adminSheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  const managerSheet = ss.getSheetByName(SHEET_NAME.MANAGER);
  const aiSheet = ss.getSheetByName(SHEET_NAME.AI);

  if (!adminSheet || !managerSheet) return createResponse({ error: "필수 시트 부재" });

  const adminData = adminSheet.getDataRange().getValues();

  // [기능 1] 인증번호 발송
  if (action === "sendCode" && knoxId) {
    const rowIndex = adminData.findIndex(row => row[ADMIN_COL.KNOX_ID] === knoxId);
    if (rowIndex === -1) return createResponse({ status: "error", message: "등록되지 않은 사번입니다." });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    adminSheet.getRange(rowIndex + 1, ADMIN_COL.AUTH_CODE + 1).setValue(code);
    adminSheet.getRange(rowIndex + 1, ADMIN_COL.AUTH_TIME + 1).setValue(new Date());

    sendFlowGAS(knoxId, `[비용 조회 인증]\n인증번호: [${code}]\n3분 이내에 입력해주세요.`);
    return createResponse({ status: "success" });
  }

  // [기능 2] 인증번호 검증
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

  // [기능 3] 통합 데이터 조회
  if (token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });

    const currentKnoxId = adminRow[ADMIN_COL.KNOX_ID];
    const managerData = managerSheet.getDataRange().getValues();
    const isAdmin = managerData.some(row => String(row[0]).trim().toLowerCase() === String(currentKnoxId).trim().toLowerCase());

    // --- 교육/도서 데이터 병합 ---
    let allApplyData = [];
    if (dataSheet) {
      const eduData = dataSheet.getDataRange().getValues();
      eduData.shift();
      eduData.forEach(row => { row._reqType = "교육"; allApplyData.push(row); });
    }
    if (bookSheet) {
      const bData = bookSheet.getDataRange().getValues();
      bData.shift();
      bData.forEach(row => { row._reqType = "도서"; allApplyData.push(row); });
    }

    // 1. 일반 사용자 본인 내역
    const myRows = allApplyData.filter(row => String(row[DATA_COL.KNOX_ID]) === String(currentKnoxId));
    let myUsed = 0;
    const myHistory = myRows.map(row => {
      const cost = Number(row[DATA_COL.COST]) || 0;
      if (row[DATA_COL.STATUS] === "완료") myUsed += cost;
      const displayTitle = `[${row._reqType}] ${row[DATA_COL.TITLE]}`;
      return { date: row[0], courseName: displayTitle, cost, status: row[DATA_COL.STATUS], period: row._reqType === "교육" ? (row[12] || '') : '' };
    });

    // 2. 관리자 통계
    let adminStats = null;
    if (isAdmin) {
      const stats = {
        totalConfirmed: 0,
        totalPending: 0,
        totalMemberCount: adminSheet.getLastRow() - 1,
        categories: [],
        vendors: {},
        allUserList: [],
        allRecords: []
      };

      // --- [핵심 수정] AI자동분류 시트 데이터 3컬럼 매핑 ---
      if (aiSheet) {
        const aiData = aiSheet.getDataRange().getValues();
        aiData.shift(); // 헤더(1행) 제거
        stats.categories = aiData.map(row => {
          // A컬럼(분류명)이 비어있지 않은 데이터만 필터링하여 매핑
          if (row[0]) {
            return {
              name: row[0],                        // A컬럼: 분류명
              frequency: Number(row[1]) || 0,      // B컬럼: 빈도 (숫자로 변환)
              amount: Number(row[2]) || 0          // C컬럼: 금액 (숫자로 변환)
            };
          }
          return null;
        }).filter(item => item !== null); // 빈 행 제거
      }
      // ---------------------------------------------------

      // 전체 유저 맵 세팅 (미사용자 색출 목적)
      const userMap = new Map();
      adminData.forEach((row, idx) => {
        if (idx === 0) return;
        const uId = String(row[ADMIN_COL.KNOX_ID]);
        userMap.set(uId, { knoxId: uId, name: "미확인", used: 0, pending: 0, eduUsed: 0, bookUsed: 0 });
      });

      // 신청서 데이터 순회 및 집계
      allApplyData.forEach(row => {
        const sId = String(row[DATA_COL.KNOX_ID]);
        const cost = Number(row[DATA_COL.COST]) || 0;
        const status = String(row[DATA_COL.STATUS]);
        const vendor = row[DATA_COL.VENDOR] || "기타";
        const reqType = row._reqType;

        if (status === "완료") {
          stats.totalConfirmed += cost;
          stats.vendors[vendor] = (stats.vendors[vendor] || 0) + cost;
        } else if (status.includes("대기") || status.includes("진행")) {
          stats.totalPending += cost;
        }

        if (userMap.has(sId)) {
          const u = userMap.get(sId);
          u.name = row[DATA_COL.NAME] || u.name;

          if (status === "완료") {
            u.used += cost;
            if (reqType === "교육") u.eduUsed += cost;
            else if (reqType === "도서") u.bookUsed += cost;
          }
          else if (status.includes("대기") || status.includes("진행")) {
            u.pending += cost;
          }
        }
      });

      // 전체 개별 레코드 (관리자 상세 조회용)
      stats.allRecords = allApplyData.map(row => ({
        knoxId: String(row[DATA_COL.KNOX_ID]),
        name: row[DATA_COL.NAME] || '',
        courseName: `[${row._reqType}] ${row[DATA_COL.TITLE]}`,
        cost: Number(row[DATA_COL.COST]) || 0,
        status: row[DATA_COL.STATUS] || '',
        period: row._reqType === "교육" ? (row[12] || '') : ''
      }));

      // 검색/필터용 플래그 부착
      stats.allUserList = Array.from(userMap.values()).map(u => ({
        ...u,
        isOverLimit: u.used >= 450000,
        isZeroUsage: u.used === 0
      }));

      adminStats = stats;
    }

    const adminRowIdx = adminData.findIndex(row => row[ADMIN_COL.UUID] === token);
    adminSheet.getRange(adminRowIdx + 1, ADMIN_COL.LAST_LOGIN + 1).setValue(new Date());

    return createResponse({
      userInfo: { name: myRows.length > 0 ? myRows[0][DATA_COL.NAME] : "사용자", isAdmin: isAdmin, totalBudget: LIMIT_BUDGET, usedBudget: myUsed },
      myHistory: myHistory,
      adminStats: adminStats
    });
  }
  return createResponse({ error: "INVALID_REQUEST" });
};

const createResponse = (obj) => ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);


// [설정 유지]
const DOC_ID_COL = 6; // G열: 문서번호 (0부터 시작하므로 6)
const SHEET_NAME_HISTORY = "Flow자동발송이력";

/**
 * 시트 전체를 검사하되, '교육 신청서'와 '도서 신청서' 모두 감지하여 알림 발송
 */
const onSpreadsheetChange = (e) => {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName(SHEET_NAME.DATA); // 교육 신청서
  const bookSheet = ss.getSheetByName(SHEET_NAME.BOOK); // 도서 신청서
  const adminSheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  const historySheet = ss.getSheetByName(SHEET_NAME_HISTORY);

  if (!dataSheet || !bookSheet || !adminSheet || !historySheet) return;

  // 1. 현재 변경이 일어난 시트가 '교육'인지 '도서'인지 판별
  const activeSheet = ss.getActiveSheet();
  const activeSheetName = activeSheet.getName();

  // 교육/도서 신청서가 아니면 작동 중단
  if (activeSheetName !== SHEET_NAME.DATA && activeSheetName !== SHEET_NAME.BOOK) return;

  // 알림 타이틀 분기 처리
  const reqType = activeSheetName === SHEET_NAME.DATA ? "교육비" : "도서비";

  // 2. 발송 이력 (Set) 및 관리자 동의 (Map) 생성
  const historyValues = historySheet.getDataRange().getValues();
  const sentDocIds = new Set(historyValues.map(row => String(row[0]).trim()));

  const adminValues = adminSheet.getDataRange().getValues();
  const adminMap = new Map();
  adminValues.forEach(row => adminMap.set(String(row[ADMIN_COL.KNOX_ID]), row[ADMIN_COL.AGREE]));

  // 3. 누적 사용액 계산을 위해 '교육 + 도서' 전체 데이터를 하나의 배열로 병합
  const eduData = dataSheet.getDataRange().getValues();
  const bookData = bookSheet.getDataRange().getValues();
  // 헤더(첫 줄)를 제외하고 두 데이터를 합침
  const allDataForBudget = [...eduData.slice(1), ...bookData.slice(1)];

  // 4. 방금 데이터가 추가된 '현재 활성화된 시트'만 스캔하여 발송 대상 찾기
  const currentSheetData = activeSheet.getDataRange().getValues();

  currentSheetData.forEach((row, index) => {
    if (index === 0) return; // 헤더 제외

    const docId = String(row[DOC_ID_COL]).trim();
    const status = row[DATA_COL.STATUS];
    const knoxId = String(row[DATA_COL.KNOX_ID]);
    const isAgreed = adminMap.get(knoxId);

    // [발송 조건] 완료 상태 + 수신 동의 + 발송 이력에 없는 문서번호
    if (docId && status === "완료" && isAgreed === "Y" && !sentDocIds.has(docId)) {

      // 사용자 누적액 통합 계산 (교육 + 도서 병합본에서 검색)
      let totalUsed = 0;
      allDataForBudget.forEach(r => {
        if (String(r[DATA_COL.KNOX_ID]) === knoxId && r[DATA_COL.STATUS] === "완료") {
          totalUsed += (Number(r[DATA_COL.COST]) || 0);
        }
      });

      // 동적으로 [교육비 결재 완료] 또는 [도서비 결재 완료] 출력
      const content = `[${reqType} 결재 완료]\n- 문서번호: ${docId}\n- 과정/도서명: ${row[DATA_COL.TITLE]}\n- 금액: ${Number(row[DATA_COL.COST]).toLocaleString()}원\n- 총 사용: ${totalUsed.toLocaleString()}원\n- 잔액: ${(LIMIT_BUDGET - totalUsed).toLocaleString()}원`;

      // 5. Flow 발송 및 이력 기록
      if (sendFlowGAS(knoxId, content)) {
        historySheet.appendRow([docId, new Date(), knoxId]);
        sentDocIds.add(docId); // 루프 내 중복 발송 방지
        console.log(`신규 알람 발송 완료: ${docId} (${reqType})`);
      }
    }
  });
};

/**
 * 실제 알람 발송 프로세스 (중복 코드 방지를 위해 분리)
 */
function processAlarm(sheet, rowIndex, knoxId, rowData) {
  const adminSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME.ADMIN);
  const adminData = adminSheet.getDataRange().getValues();
  const userAdminInfo = adminData.find(row => row[ADMIN_COL.KNOX_ID] === knoxId);

  // 알람 동의 확인
  if (userAdminInfo && userAdminInfo[ADMIN_COL.AGREE] === "Y") {
    // 잔액 재계산 로직
    const allData = sheet.getDataRange().getValues();
    let totalUsed = 0;
    allData.forEach(r => {
      if (r[9] === knoxId && r[19] === "완료") totalUsed += (Number(r[16]) || 0);
    });

    const content = `과정: ${rowData[11]}\n- 금액: ${Number(rowData[16]).toLocaleString()}원\n- 총 사용: ${totalUsed.toLocaleString()}원\n- 잔액: ${(LIMIT_BUDGET - totalUsed).toLocaleString()}원`;

    if (sendFlowGAS(knoxId, content)) {
      sheet.getRange(rowIndex, 27).setValue("Y"); // AA열 발송 완료 표시
      console.log(`Row ${rowIndex}: ${knoxId} 알람 발송 성공`);
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
