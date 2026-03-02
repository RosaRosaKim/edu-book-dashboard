// [메뉴] 스프레드시트 열 때 커스텀 메뉴 추가
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('관리 도구')
    .addItem('UUID 자동채번', 'generateExistingUUIDs')
    .addToUi();
}

// [설정] 시트 이름과 컬럼 인덱스
const LIMIT_BUDGET = 500000;
const SHEET_NAME = {
  DATA: "교육 신청서",
  BOOK: "도서 신청서",
  ADMIN: "웹페이지관리",
  MANAGER: "관리자",
  TEMPLATE: "신청 템플릿",
  NOTICE: "공지사항",
  BOARD: "게시판",
  RATING: "맛집평가"
};

const DATA_COL = {
  KNOX_ID: 9, NAME: 10, TITLE: 11, PERIOD: 12, EDU_TYPE: 13, PURPOSE: 14, VENDOR: 15, COST: 16, BILLING: 17, REMARK: 18, STATUS: 19
};
const BOOK_COL = {
  KNOX_ID: 9, NAME: 10, TITLE: 11, COST: 12, STATUS: 16
};
function colFor(row) { return row._reqType === '도서' ? BOOK_COL : DATA_COL; }

const ADMIN_COL = {
  KNOX_ID: 0, AGREE: 1, UUID: 2, LAST_LOGIN: 3, DEPT: 4, NAME: 5
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

  if (!adminSheet || !managerSheet) return createResponse({ error: "필수 시트 부재" });

  const adminData = adminSheet.getDataRange().getValues();

  // [기능 4] 관리자 → 사용자에게 잔액 정보 Flow 발송
  if (action === "sendBalanceInfo" && token && e.parameter.targetKnoxId) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });

    const currentKnoxId = adminRow[ADMIN_COL.KNOX_ID];
    const managerData = managerSheet.getDataRange().getValues();
    const isAdmin = managerData.some(row => String(row[0]).trim().toLowerCase() === String(currentKnoxId).trim().toLowerCase());
    if (!isAdmin) return createResponse({ error: "NOT_ADMIN" });

    const targetKnoxId = e.parameter.targetKnoxId;
    let allApplyData = [];
    if (dataSheet) { const d = dataSheet.getDataRange().getValues(); d.shift(); d.forEach(row => { row._reqType = "교육"; }); allApplyData.push(...d); }
    if (bookSheet) { const d = bookSheet.getDataRange().getValues(); d.shift(); d.forEach(row => { row._reqType = "도서"; }); allApplyData.push(...d); }

    let used = 0;
    allApplyData.forEach(row => {
      const c = colFor(row);
      if (String(row[c.KNOX_ID]) === targetKnoxId && row[c.STATUS] === "완료") {
        used += Number(row[c.COST]) || 0;
      }
    });

    const remain = LIMIT_BUDGET - used;
    sendFlowMsg(targetKnoxId, FLOW_MSG.balanceInfo(used, remain, LIMIT_BUDGET));
    return createResponse({ status: "success" });
  }

  // [기능 5] 알람 수신 동의 변경
  if (action === "updateAlarm" && token) {
    const rowIndex = adminData.findIndex(row => row[ADMIN_COL.UUID] === token);
    if (rowIndex === -1) return createResponse({ error: "UNAUTHORIZED" });

    const newVal = e.parameter.isAgreed === "true" ? "Y" : "N";
    adminSheet.getRange(rowIndex + 1, ADMIN_COL.AGREE + 1).setValue(newVal);
    return createResponse({ status: "success" });
  }

  // [기능 8] 밥카 알람 수신 동의 변경
  if (action === "updateCardAlarm" && token) {
    const rowIndex = adminData.findIndex(row => row[ADMIN_COL.UUID] === token);
    if (rowIndex === -1) return createResponse({ error: "UNAUTHORIZED" });

    const newVal = e.parameter.isAgreed === "true" ? "Y" : "N";
    adminSheet.getRange(rowIndex + 1, 7).setValue(newVal);  // G열: 밥카 Flow 알람
    return createResponse({ status: "success" });
  }

  // [기능 12] Bizplay 직접 인증 (로그인 화면에서 Bizplay로 로그인)
  if (action === "bizplayAuth") {
    const bizUserId = e.parameter.bizUserId;
    const bizPwd = e.parameter.bizPwd;
    if (!bizUserId || !bizPwd) return createResponse({ error: "MISSING_PARAMS" });

    // knoxId = @ 앞부분
    const knoxId = bizUserId.split('@')[0];
    const rowIndex = adminData.findIndex(row => row[ADMIN_COL.KNOX_ID] === knoxId);
    if (rowIndex === -1) return createResponse({ status: "error", message: "등록되지 않은 사번이야." });

    try {
      var result = _bizplayLoginCore(bizUserId, bizPwd);
      if (result.error) return createResponse({ status: 'fail', message: result.error });

      // UUID 토큰 발급/조회 (기존 verify 로직과 동일)
      const row = adminData[rowIndex];
      const uuid = row[ADMIN_COL.UUID] || Utilities.getUuid();
      adminSheet.getRange(rowIndex + 1, ADMIN_COL.UUID + 1).setValue(uuid);

      // Bizplay 세션 ScriptProperties에 저장 (기존 handleBizplayLogin과 동일)
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
      PropertiesService.getScriptProperties().setProperty(
        'bizplay_' + knoxId,
        JSON.stringify(sessionData)
      );

      // 비밀번호 저장 (잔액알림 등에 활용)
      const savePw = e.parameter.savePw;
      if (savePw === 'true') {
        adminSheet.getRange(rowIndex + 1, 8).setValue(_encryptPw(bizPwd)); // H열: Bizplay PW
      } else {
        adminSheet.getRange(rowIndex + 1, 8).setValue(''); // H열 클리어 (자동로그인 해제)
      }

      return createResponse({
        status: 'success',
        token: uuid,
        userName: result.userName,
        ssoComplete: result.ssoComplete,
        session: {
          userId: bizUserId,
          userName: result.userName,
          deptCd: result.deptCd || '',
          deptNm: result.deptNm || '',
          deptShort: result.deptShort || ''
        },
        debug: result.debug
      });
    } catch (err) {
      return createResponse({ error: 'BIZPLAY_ERROR', message: err.message });
    }
  }

  // [기능 6] Bizplay 로그인 프록시 (SSO 전체 흐름)
  if (action === "bizplayLogin" && token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });
    return handleBizplayLogin(adminRow, e);
  }

  // [기능 6.5] Bizplay 교육비 탭 SSO (탭 전환 시 weAuth)
  if (action === "bizplayEduInit" && token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });
    return handleBizplayEduInit(adminRow, e);
  }

  // [기능 7a] Bizplay 결재라인 조회
  if (action === "bizplayApprLine" && token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });
    return handleBizplayApprLine(adminRow, e);
  }

  // [기능 7b] Bizplay 기안문서 목록 조회
  if (action === "bizplayDraftList" && token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });
    return handleBizplayDraftList(adminRow, e);
  }

  // [기능 7] Bizplay 임시저장 (교육 신청서)
  if (action === "bizplayDraft" && token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });
    return handleBizplayDraft(adminRow, e);
  }

  // [기능 13] 맛집 평점 조회
  if (action === "cardRatings" && token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });
    return handleCardRatings(adminRow, e);
  }

  // [기능 14] 맛집 평점 등록/수정
  if (action === "cardRate" && token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });
    return handleCardRate(adminRow, e);
  }

  // [기능 9] 밥카 사용내역 조회
  if (action === "cardRecords" && token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });
    return handleCardRecords(adminRow, e);
  }

  // [기능 10] 밥카 결재 제출
  if (action === "cardApproval" && token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });
    return handleCardApproval(adminRow, e);
  }

  // [기능 12] 게시판
  if (action === "boardList" && token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });
    return handleBoardList(adminRow, e);
  }
  if (action === "boardWrite" && token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });
    return handleBoardWrite(adminRow, e);
  }
  if (action === "boardReact" && token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });
    return handleBoardReact(adminRow, e);
  }
  if (action === "boardReply" && token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });
    return handleBoardReply(adminRow, e);
  }
  if (action === "boardReplyDelete" && token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });
    return handleBoardReplyDelete(adminRow, e);
  }
  if (action === "boardPin" && token) {
    const adminRow = adminData.find(row => row[ADMIN_COL.UUID] === token);
    if (!adminRow) return createResponse({ error: "UNAUTHORIZED" });
    return handleBoardPin(adminRow, e);
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
    const myRows = allApplyData.filter(row => String(row[colFor(row).KNOX_ID]) === String(currentKnoxId));
    let myUsed = 0;
    const myHistory = myRows.map(row => {
      const c = colFor(row);
      const cost = Number(row[c.COST]) || 0;
      if (row[c.STATUS] === "완료") myUsed += cost;
      const displayTitle = `[${row._reqType}] ${row[c.TITLE]}`;
      const rec = { date: row[0], courseName: displayTitle, cost, status: row[c.STATUS], period: row._reqType === "교육" ? (row[c.PERIOD] || '') : '' };
      if (row._reqType === "교육") {
        rec.institution = row[DATA_COL.VENDOR] || '';
        rec.eduType = row[DATA_COL.EDU_TYPE] || '';
        rec.purpose = row[DATA_COL.PURPOSE] || '';
        rec.billing = row[DATA_COL.BILLING] || '';
        rec.remark = row[DATA_COL.REMARK] || '';
      }
      return rec;
    });

    // 2. 관리자 통계
    let adminStats = null;
    if (isAdmin) {
      const stats = {
        totalConfirmed: 0,
        totalPending: 0,
        totalMemberCount: adminSheet.getLastRow() - 1,
        vendors: {},
        allUserList: [],
        allRecords: []
      };

      // 전체 유저 맵 세팅 (미사용자 색출 목적)
      const userMap = new Map();
      adminData.forEach((row, idx) => {
        if (idx === 0) return;
        const uId = String(row[ADMIN_COL.KNOX_ID]);
        userMap.set(uId, { knoxId: uId, name: row[ADMIN_COL.NAME] || "미확인", dept: row[ADMIN_COL.DEPT] || "", used: 0, pending: 0, eduUsed: 0, bookUsed: 0 });
      });

      // 신청서 데이터 순회 및 집계
      allApplyData.forEach(row => {
        const c = colFor(row);
        const sId = String(row[c.KNOX_ID]);
        const cost = Number(row[c.COST]) || 0;
        const status = String(row[c.STATUS]);
        const vendor = row._reqType === "교육" ? (row[DATA_COL.VENDOR] || "기타") : "도서";
        const reqType = row._reqType;

        if (status === "완료") {
          stats.totalConfirmed += cost;
          stats.vendors[vendor] = (stats.vendors[vendor] || 0) + cost;
        } else if (status.includes("대기") || status.includes("진행")) {
          stats.totalPending += cost;
        }

        if (userMap.has(sId)) {
          const u = userMap.get(sId);

          // 웹페이지관리에 이름이 없으면 신청서에서 보충
          if (u.name === '미확인' && row[c.NAME]) {
            u.name = String(row[c.NAME]);
          }

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

      // 전체 개별 레코드 (관리자 상세 조회용) — 이름은 웹페이지관리(마스터) 우선
      stats.allRecords = allApplyData.map(row => {
        const c = colFor(row);
        const knoxId = String(row[c.KNOX_ID]);
        const masterName = userMap.has(knoxId) ? userMap.get(knoxId).name : '';
        return {
          knoxId,
          name: masterName || row[c.NAME] || '',
          courseName: `[${row._reqType}] ${row[c.TITLE]}`,
          cost: Number(row[c.COST]) || 0,
          status: row[c.STATUS] || '',
          period: row._reqType === "교육" ? (row[12] || '') : '',
          date: row[0] ? new Date(row[0]).toISOString() : '',
          reqType: row._reqType
        };
      });

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

    // 템플릿 데이터 로드
    const tplSheet = ensureTemplateSheet(ss);
    let templates = [];
    if (tplSheet && tplSheet.getLastRow() > 1) {
      const tplData = tplSheet.getDataRange().getValues();
      tplData.shift();
      templates = tplData.map(r => ({
        courseName: r[0], institution: r[1], eduType: r[2],
        billing: r[3], cost: Number(r[4]) || 0, purpose: r[5], remark: r[6]
      }));
    }

    // Bizplay PW 저장 여부 확인 (SSO는 각 모듈에서 필요 시 수행)
    let bizplaySession = null;
    const encPw = adminRow[7]; // H열: 암호화된 Bizplay PW
    if (encPw && String(encPw).trim()) {
      const propKey = 'bizplay_' + currentKnoxId;
      const existingRaw = PropertiesService.getScriptProperties().getProperty(propKey);
      const existing = existingRaw ? JSON.parse(existingRaw) : null;

      // 기본 로그인만 수행 (SSO 없음 — 각 모듈이 탭 클릭 시 자체 SSO)
      const needLogin = !existing || !existing.bizplayCookies ||
        (new Date() - new Date(existing.loginTime || 0)) > 3600000;
      if (needLogin) {
        try {
          const bizUserId = currentKnoxId + '@emro.co.kr';
          const bizPwd = _decryptPw(String(encPw));
          const loginPayload = '_JSON_=' + encodeURIComponent(JSON.stringify({
            USER_ID: bizUserId, PWD: bizPwd,
            CAPTCHA_VALUE: '', LNK_ID: '', LNK_INTT: '', LOGIN_SAVE: 'N',
            USER_OS: 'win10.0', USER_BR: 'Chrome', USER_BR_VER: '145.0.0.0',
            TMPR_CD2: '', TMPR_CD3: '', LNGG_DSNC: 'DF', '_LODING_BAR_YN_': 'Y'
          }));
          const loginResp = UrlFetchApp.fetch('https://www.bizplay.co.kr/login_proc_01.jct', {
            method: 'post',
            contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
            headers: { 'User-Agent': BROWSER_UA },
            payload: loginPayload,
            followRedirects: false,
            muteHttpExceptions: true
          });
          const body = JSON.parse(loginResp.getContentText());
          if (body.RSLT_CD === '0000') {
            const sessionData = {
              bizplayCookies: extractCookies(loginResp),
              userId: bizUserId,
              userName: body.USER_NM,
              useInttId: body.USE_INTT_ID || '',
              loginTime: new Date().toISOString()
            };
            PropertiesService.getScriptProperties().setProperty(propKey, JSON.stringify(sessionData));
            bizplaySession = { userId: bizUserId, userName: body.USER_NM };
          }
        } catch (bizErr) {
          console.log('[auto-bizplay] 자동 로그인 실패: ' + bizErr.message);
        }
      } else if (existing) {
        bizplaySession = { userId: existing.userId, userName: existing.userName };
      }
    }

    // 공지사항 로드
    let notice = null;
    try {
      const noticeSheet = ss.getSheetByName(SHEET_NAME.NOTICE);
      if (noticeSheet && noticeSheet.getLastRow() >= 2) {
        const row = noticeSheet.getRange(2, 1, 1, 4).getValues()[0];
        if (row[0] || row[1]) {
          notice = { title: String(row[0] || ''), content: String(row[1] || ''), id: String(row[2] || ''), image: String(row[3] || '') };
        }
      }
    } catch (nErr) { /* 시트 없으면 무시 */ }

    const resp = {
      userInfo: { name: myRows.length > 0 ? myRows[0][colFor(myRows[0]).NAME] : "사용자", isAdmin: isAdmin, totalBudget: LIMIT_BUDGET, usedBudget: myUsed, isAgreed: adminRow[ADMIN_COL.AGREE] === "Y", isCardAlarmAgreed: adminRow[6] === "Y", hasBizplayPw: !!(adminRow[7] && String(adminRow[7]).trim()) },
      myHistory: myHistory,
      adminStats: adminStats,
      templates: templates,
      bizplaySession: bizplaySession
    };
    if (notice) resp.notice = notice;
    return createResponse(resp);
  }
  return createResponse({ error: "INVALID_REQUEST" });
};

/**
 * 신청 템플릿 시트 자동 생성 (없으면 헤더만 삽입)
 */
function ensureTemplateSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_NAME.TEMPLATE);
  if (sheet) return sheet;
  sheet = ss.insertSheet(SHEET_NAME.TEMPLATE);
  sheet.appendRow(['교육과정명', '교육기관', '교육구분', '비용청구', '금액', '교육목적및내용', '비고']);
  return sheet;
}

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
  const eduRows = eduData.slice(1); eduRows.forEach(r => { r._reqType = '교육'; });
  const bookRows = bookData.slice(1); bookRows.forEach(r => { r._reqType = '도서'; });
  const allDataForBudget = [...eduRows, ...bookRows];

  // 4. 방금 데이터가 추가된 '현재 활성화된 시트'만 스캔하여 발송 대상 찾기
  const activeCol = activeSheetName === SHEET_NAME.BOOK ? BOOK_COL : DATA_COL;
  const currentSheetData = activeSheet.getDataRange().getValues();

  currentSheetData.forEach((row, index) => {
    if (index === 0) return; // 헤더 제외

    const docId = String(row[DOC_ID_COL]).trim();
    const status = row[activeCol.STATUS];
    const knoxId = String(row[activeCol.KNOX_ID]);
    const isAgreed = adminMap.get(knoxId);

    // [발송 조건] 완료 상태 + 수신 동의 + 발송 이력에 없는 문서번호
    if (docId && status === "완료" && isAgreed === "Y" && !sentDocIds.has(docId)) {

      // 사용자 누적액 통합 계산 (교육 + 도서 병합본에서 검색)
      let totalUsed = 0;
      allDataForBudget.forEach(r => {
        const c = colFor(r);
        if (String(r[c.KNOX_ID]) === knoxId && r[c.STATUS] === "완료") {
          totalUsed += (Number(r[c.COST]) || 0);
        }
      });

      // 5. Flow 발송 및 이력 기록
      var msg = FLOW_MSG.approvalComplete(reqType, docId, row[activeCol.TITLE], row[activeCol.COST], totalUsed, LIMIT_BUDGET - totalUsed);
      if (sendFlowMsg(knoxId, msg)) {
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

    var msg = FLOW_MSG.approvalNotice(rowData[11], rowData[16], totalUsed, LIMIT_BUDGET - totalUsed);
    if (sendFlowMsg(knoxId, msg)) {
      sheet.getRange(rowIndex, 27).setValue("Y"); // AA열 발송 완료 표시
      console.log(`Row ${rowIndex}: ${knoxId} 알람 발송 성공`);
    }
  }
};

/**
 * Flow 메신저 발송 공통 함수
 */
function sendFlowGAS(userId, content, previewLink, previewTitle) {
  const API_URL = 'https://flow.emro.co.kr/MGateway';
  const CNTS_CRTC_KEY = '20210824-d3c5eb06-b3b1-4f6e-9ba7-a61e2b71c78f';
  const fullUserId = userId.includes('@') ? userId : `${userId}@emro.co.kr`;

  const reqData = { BOT_ID: 'helpdesk', RCVR_USER_ID: fullUserId, PREVIEW_TTL: previewTitle || '교육비 알림' };
  if (previewLink) {
    reqData.PREVIEW_CNTN = content;
    reqData.PREVIEW_LINK = previewLink;
  } else {
    reqData.CNTN = content;
  }

  const payload = 'JSONData=' + encodeURIComponent(JSON.stringify({
    API_KEY: 'FLOW_BOT_NOTI_API',
    CNTS_CRTC_KEY: CNTS_CRTC_KEY,
    REQ_DATA: reqData
  }));

  const response = UrlFetchApp.fetch(API_URL, { 'method': 'post', 'contentType': 'application/x-www-form-urlencoded', 'payload': payload, 'muteHttpExceptions': true });
  try { return JSON.parse(decodeURIComponent(response.getContentText())); } catch (e) { return null; }
}

/**
 * [테스트] 타임시트 앱 API 탐색
 * GAS 편집기에서 수동 실행하여 로그 확인
 */
function testTimesheetApi() {
  var BASE_AWS = 'https://8vxu0grpsd.execute-api.ap-northeast-2.amazonaws.com';
  var BASE_PB  = 'https://m.pearbranch.com';
  var TK = 'EMRO';

  // 1) tenant - AWS (JSON)
  _testFetch('AWS tenant JSON', BASE_AWS + '/ifm/api/v5/tenant', 'post', 'application/json', JSON.stringify({ tenantKey: TK }));
  // 2) tenant - AWS (form)
  _testFetch('AWS tenant FORM', BASE_AWS + '/ifm/api/v5/tenant', 'post', 'application/x-www-form-urlencoded', 'tenantKey=' + TK);
  // 3) tenant - PB (JSON)
  _testFetch('PB tenant JSON', BASE_PB + '/ifm/api/v5/tenant', 'post', 'application/json', JSON.stringify({ tenantKey: TK }));
  // 4) tenant - PB (form)
  _testFetch('PB tenant FORM', BASE_PB + '/ifm/api/v5/tenant', 'post', 'application/x-www-form-urlencoded', 'tenantKey=' + TK);
  // 5) encryption - AWS
  _testFetch('AWS encryption POST', BASE_AWS + '/ifm/api/v5/login/encryption', 'post', 'application/json', JSON.stringify({ tenantKey: TK }));
  // 6) encryption - PB
  _testFetch('PB encryption POST', BASE_PB + '/ifm/api/v5/login/encryption', 'post', 'application/json', JSON.stringify({ tenantKey: TK }));
  // 7) encryption - AWS GET
  _testFetch('AWS encryption GET', BASE_AWS + '/ifm/api/v5/login/encryption', 'get');
  // 8) encryption - PB GET
  _testFetch('PB encryption GET', BASE_PB + '/ifm/api/v5/login/encryption', 'get');
}

function _testFetch(label, url, method, contentType, payload) {
  try {
    var opts = { method: method, muteHttpExceptions: true };
    if (contentType) opts.contentType = contentType;
    if (payload) opts.payload = payload;
    var r = UrlFetchApp.fetch(url, opts);
    var body = r.getContentText().substring(0, 800);
    // HTML 응답이면 짧게 요약
    if (body.indexOf('<!DOCTYPE') >= 0 || body.indexOf('<html') >= 0) {
      var m = body.match(/<title>([^<]+)<\/title>/);
      body = '[HTML] ' + (m ? m[1] : body.substring(0, 100));
    }
    Logger.log('[' + label + '] ' + r.getResponseCode() + ': ' + body);
  } catch(e) {
    Logger.log('[' + label + ' ERR] ' + e.message);
  }
}
