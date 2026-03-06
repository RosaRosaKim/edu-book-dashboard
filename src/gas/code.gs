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
  RATING: "맛집평가",
  CARD_INFO: "사용자카드정보"
};

const DATA_COL = {
  KNOX_ID: 9, NAME: 10, TITLE: 11, PERIOD: 12, EDU_TYPE: 13, PURPOSE: 14, VENDOR: 15, COST: 16, BILLING: 17, REMARK: 18, STATUS: 19
};
const BOOK_COL = {
  KNOX_ID: 9, NAME: 10, TITLE: 11, COST: 12, STATUS: 16
};
function colFor(row) { return row._reqType === '도서' ? BOOK_COL : DATA_COL; }

const ADMIN_COL = {
  KNOX_ID: 0, AGREE: 1, LAST_LOGIN: 3, DEPT: 4, NAME: 5, BIZPLAY_ID: 8  // I열 = index 8
};

/** knoxId + 암호화PW + salt 기반 토큰 생성 */
function _generateToken(knoxId, encPw) {
  const salt = PropertiesService.getScriptProperties().getProperty('TOKEN_SALT') || '';
  const raw = knoxId + ':' + (encPw || '') + ':' + salt;
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw)
    .map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
  return knoxId + ':' + hash;
}

/** 토큰 검증 → 일치하면 { row, idx } 반환, 아니면 null */
function _verifyToken(token, adminByKnoxId) {
  if (!token || token.indexOf(':') === -1) return null;
  var knoxId = token.substring(0, token.indexOf(':'));
  var entry = adminByKnoxId.get(knoxId);
  if (!entry) return null;
  var encPw = String(entry.row[7] || '');
  var expected = _generateToken(knoxId, encPw);
  return token === expected ? entry : null;
}

/**
 * 웹 요청 처리 (교육/도서 병합 및 AI 3컬럼 분류 반영)
 */
const doGet = (e) => {
  const { action, token, knoxId, authCode } = e.parameter;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const phase = e.parameter.phase; // '1'=fast, '2'=heavy, undefined=전체(하위호환)
  const dataSheet = (phase !== '1') ? ss.getSheetByName(SHEET_NAME.DATA) : null;
  const bookSheet = (phase !== '1') ? ss.getSheetByName(SHEET_NAME.BOOK) : null;
  const adminSheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  const managerSheet = ss.getSheetByName(SHEET_NAME.MANAGER);

  if (!adminSheet || !managerSheet) return createResponse({ error: "필수 시트 부재" });

  const adminData = adminSheet.getDataRange().getValues();

  // ── O(1) 룩업용 Map 구축 ──
  const adminByKnoxId = new Map();
  const adminByBizplayId = new Map();
  adminData.forEach((row, idx) => {
    if (idx === 0) return;
    const kid = String(row[ADMIN_COL.KNOX_ID]).trim();
    const bid = String(row[ADMIN_COL.BIZPLAY_ID] || '').trim();
    if (kid) adminByKnoxId.set(kid, { row, idx });
    if (bid) adminByBizplayId.set(bid, { row, idx });
  });

  // ── 관리자 Set 구축 (managerSheet 1회 읽기) ──
  const managerData = managerSheet.getDataRange().getValues();
  const managerSet = new Set(managerData.slice(1).map(row => String(row[0]).trim().toLowerCase()));

  // [기능 4] 관리자 → 사용자에게 잔액 정보 Flow 발송
  if (action === "sendBalanceInfo" && token && e.parameter.targetKnoxId) {
    const entry = _verifyToken(token, adminByKnoxId);
    if (!entry) return createResponse({ error: "UNAUTHORIZED" });
    const adminRow = entry.row;

    const currentKnoxId = adminRow[ADMIN_COL.KNOX_ID];
    const isAdmin = managerSet.has(String(currentKnoxId).trim().toLowerCase());
    if (!isAdmin) return createResponse({ error: "NOT_ADMIN" });

    const targetKnoxId = e.parameter.targetKnoxId;
    let allApplyData = [];
    if (dataSheet) { const d = dataSheet.getDataRange().getValues(); d.shift(); d.forEach(row => { row._reqType = "교육"; }); allApplyData.push(...d); }
    if (bookSheet) { const d = bookSheet.getDataRange().getValues(); d.shift(); d.forEach(row => { row._reqType = "도서"; }); allApplyData.push(...d); }

    let used = 0, pending = 0;
    allApplyData.forEach(row => {
      const c = colFor(row);
      if (String(row[c.KNOX_ID]) !== targetKnoxId) return;
      const status = String(row[c.STATUS]);
      const cost = Number(row[c.COST]) || 0;
      if (status === "완료") used += cost;
      else if (status.includes("대기") || status.includes("진행")) pending += cost;
    });

    const remain = LIMIT_BUDGET - used;
    sendFlowMsg(targetKnoxId, FLOW_MSG.balanceInfo(used, remain, LIMIT_BUDGET, pending));
    return createResponse({ status: "success" });
  }

  // [기능 5] 알람 수신 동의 변경
  if (action === "updateAlarm" && token) {
    const entry = _verifyToken(token, adminByKnoxId);
    if (!entry) return createResponse({ error: "UNAUTHORIZED" });
    const rowIndex = entry.idx;

    const newVal = e.parameter.isAgreed === "true" ? "Y" : "N";
    adminSheet.getRange(rowIndex + 1, ADMIN_COL.AGREE + 1).setValue(newVal);
    return createResponse({ status: "success" });
  }

  // [기능 8] 밥카 알람 수신 동의 변경
  if (action === "updateCardAlarm" && token) {
    const entry = _verifyToken(token, adminByKnoxId);
    if (!entry) return createResponse({ error: "UNAUTHORIZED" });
    const rowIndex = entry.idx;

    const newVal = e.parameter.isAgreed === "true" ? "Y" : "N";
    adminSheet.getRange(rowIndex + 1, 7).setValue(newVal);  // G열: 밥카 Flow 알람
    return createResponse({ status: "success" });
  }

  // [기능 15] 밥카 자동결재 모드 변경
  if (action === "updateCardAutoMode" && token) {
    const entry = _verifyToken(token, adminByKnoxId);
    if (!entry) return createResponse({ error: "UNAUTHORIZED" });
    return handleUpdateCardAutoMode(entry.row, e);
  }

  // [기능 12] Bizplay 직접 인증 (로그인 화면에서 Bizplay로 로그인)
  if (action === "bizplayAuth") {
    const bizUserId = e.parameter.bizUserId;
    const bizPwd = e.parameter.bizPwd;
    if (!bizUserId || !bizPwd) return createResponse({ error: "MISSING_PARAMS" });

    const bizplayId = bizUserId.split('@')[0]; // @ 앞부분

    // 1) Bizplay 서버 인증 먼저 수행
    try {
      var result = _bizplayLoginCore(bizUserId, bizPwd);
      if (result.error) return createResponse({ status: 'fail', message: result.error });
    } catch (err) {
      return createResponse({ error: 'BIZPLAY_ERROR', message: err.message });
    }

    // 2) I열(BIZPLAY_ID)에서 매핑된 Knox ID 검색
    const mappedEntry = adminByBizplayId.get(bizplayId);
    const mappedRowIndex = mappedEntry ? mappedEntry.idx : -1;

    if (mappedRowIndex === -1) {
      // 매핑 없음 → Flow 인증 필요. Bizplay 세션을 임시 저장
      var tempSessionData = {
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
        'bizplay_temp_' + bizplayId,
        JSON.stringify(tempSessionData)
      );
      return createResponse({ status: 'needVerify', userName: result.userName });
    }

    // 3) 매핑 있음 → 해당 행의 Knox ID로 세션 생성
    const knoxId = adminData[mappedRowIndex][ADMIN_COL.KNOX_ID];
    const row = adminData[mappedRowIndex];

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
    var savedEncPw = '';
    if (savePw === 'true') {
      savedEncPw = _encryptPw(bizPwd);
      adminSheet.getRange(mappedRowIndex + 1, 8).setValue(savedEncPw); // H열: Bizplay PW
    } else {
      adminSheet.getRange(mappedRowIndex + 1, 8).setValue(''); // H열 클리어 (자동로그인 해제)
    }

    return createResponse({
      status: 'success',
      token: _generateToken(knoxId, savedEncPw),
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
  }

  // [기능 12-2] Flow 인증번호 발송
  if (action === "sendFlowVerifyCode") {
    const bizplayId = e.parameter.bizplayId;
    const knoxId = e.parameter.knoxId;
    if (!bizplayId || !knoxId) return createResponse({ error: "MISSING_PARAMS" });

    // Knox ID가 A열에 존재하는지 확인 (없으면 신규 등록 예정이므로 통과)
    const knoxEntry = adminByKnoxId.get(knoxId);
    const knoxRowIndex = knoxEntry ? knoxEntry.idx : -1;

    // 6자리 랜덤 인증번호 생성
    const code = String(Math.floor(100000 + Math.random() * 900000));

    // ScriptProperties에 저장 (5분 만료)
    const verifyData = {
      code: code,
      knoxId: knoxId,
      knoxRowIndex: knoxRowIndex,
      expiry: new Date().getTime() + 5 * 60 * 1000
    };
    PropertiesService.getScriptProperties().setProperty(
      'verify_' + bizplayId,
      JSON.stringify(verifyData)
    );

    // Flow로 인증번호 발송
    sendFlowMsg(knoxId, FLOW_MSG.verifyCode(code));

    return createResponse({ status: 'success' });
  }

  // [기능 12-3] Flow 인증번호 검증
  if (action === "verifyFlowCode") {
    const bizplayId = e.parameter.bizplayId;
    const knoxId = e.parameter.knoxId;
    const code = e.parameter.code;
    if (!bizplayId || !knoxId || !code) return createResponse({ error: "MISSING_PARAMS" });

    // ScriptProperties에서 인증 데이터 조회
    const verifyRaw = PropertiesService.getScriptProperties().getProperty('verify_' + bizplayId);
    if (!verifyRaw) return createResponse({ status: 'fail', message: '인증번호를 먼저 받아줘.' });

    const verifyData = JSON.parse(verifyRaw);

    // 만료 확인
    if (new Date().getTime() > verifyData.expiry) {
      PropertiesService.getScriptProperties().deleteProperty('verify_' + bizplayId);
      return createResponse({ status: 'fail', message: '인증번호가 만료됐어. 다시 받아줘.' });
    }

    // 코드 + knoxId 일치 확인
    if (verifyData.code !== code || verifyData.knoxId !== knoxId) {
      return createResponse({ status: 'fail', message: '인증번호가 틀렸어.' });
    }

    // 인증 성공 → 인증 데이터 삭제
    PropertiesService.getScriptProperties().deleteProperty('verify_' + bizplayId);

    // Knox ID가 웹페이지관리에 있는지 확인, 없으면 새 행 추가
    let rowIndex = verifyData.knoxRowIndex;
    if (rowIndex === -1) {
      // 신규 사용자: 웹페이지관리에 행 추가 (A~I열)
      const newRow = ['', '', '', '', '', '', '', '', ''];
      newRow[ADMIN_COL.KNOX_ID] = knoxId;    // A열
      newRow[ADMIN_COL.BIZPLAY_ID] = bizplayId; // I열
      adminSheet.appendRow(newRow);
      rowIndex = adminSheet.getLastRow() - 1; // 0-based index
    } else {
      // 기존 사용자: I열에 Bizplay ID 기록
      adminSheet.getRange(rowIndex + 1, ADMIN_COL.BIZPLAY_ID + 1).setValue(bizplayId);
    }

    // Bizplay 세션: temp → 정식 이동
    const props = PropertiesService.getScriptProperties();
    const tempRaw = props.getProperty('bizplay_temp_' + bizplayId);
    if (tempRaw) {
      props.setProperty('bizplay_' + knoxId, tempRaw);
      props.deleteProperty('bizplay_temp_' + bizplayId);
    }

    // 비밀번호 저장
    const savePw = e.parameter.savePw;
    const bizPwd = e.parameter.bizPwd;
    var verifyEncPw = '';
    if (savePw === 'true' && bizPwd) {
      verifyEncPw = _encryptPw(bizPwd);
      adminSheet.getRange(rowIndex + 1, 8).setValue(verifyEncPw); // H열
    }

    // 세션 정보 구성
    const tempSession = tempRaw ? JSON.parse(tempRaw) : {};
    return createResponse({
      status: 'success',
      token: _generateToken(knoxId, verifyEncPw),
      userName: tempSession.userName || '',
      session: {
        userId: tempSession.userId || (bizplayId + '@emro.co.kr'),
        userName: tempSession.userName || '',
        deptCd: tempSession.deptCd || '',
        deptNm: tempSession.deptNm || '',
        deptShort: tempSession.deptShort || ''
      }
    });
  }

  // ── 토큰 인증이 필요한 액션들: Map O(1) 룩업 ──
  const TOKEN_ACTIONS = {
    bizplayLogin: handleBizplayLogin,       // [기능 6]
    bizplayEduInit: handleBizplayEduInit,   // [기능 6.5]
    bizplayApprLine: handleBizplayApprLine, // [기능 7a]
    bizplaySearchUser: handleBizplaySearchUser, // [기능 7a-2]
    bizplayDraftList: handleBizplayDraftList,   // [기능 7b]
    bizplayDraftDetail: handleBizplayDraftDetail, // [기능 7c]
    bizplayDraft: handleBizplayDraft,       // [기능 7]
    cardRatings: handleCardRatings,         // [기능 13]
    cardRate: handleCardRate,               // [기능 14]
    cardRecords: handleCardRecords,         // [기능 9]
    cardApproval: handleCardApproval,       // [기능 10]
    cardInfo: handleCardInfo,               // [기능 17] 사용자카드정보 CRUD
    boardList: handleBoardList,             // [기능 12]
    boardWrite: handleBoardWrite,
    boardReact: handleBoardReact,
    boardReply: (row, ev) => handleBoardReply(row, ev, managerSet),
    boardReplyDelete: (row, ev) => handleBoardReplyDelete(row, ev, managerSet),
    boardPin: (row, ev) => handleBoardPin(row, ev, managerSet)
  };
  if (TOKEN_ACTIONS[action] && token) {
    const entry = _verifyToken(token, adminByKnoxId);
    if (!entry) return createResponse({ error: "UNAUTHORIZED" });
    return TOKEN_ACTIONS[action](entry.row, e);
  }

  // [기능 3] 통합 데이터 조회
  if (token) {
    const entry = _verifyToken(token, adminByKnoxId);
    if (!entry) return createResponse({ error: "UNAUTHORIZED" });
    const adminRow = entry.row;

    const currentKnoxId = adminRow[ADMIN_COL.KNOX_ID];
    const isAdmin = managerSet.has(String(currentKnoxId).trim().toLowerCase());

    // ── Phase 1: 빠른 기본 정보 (data/book 시트 생략) ──
    if (phase === '1') {
      adminSheet.getRange(entry.idx + 1, ADMIN_COL.LAST_LOGIN + 1).setValue(new Date());

      let notice = null;
      try {
        const noticeSheet = ss.getSheetByName(SHEET_NAME.NOTICE);
        if (noticeSheet && noticeSheet.getLastRow() >= 2) {
          const row = noticeSheet.getRange(2, 1, 1, 4).getValues()[0];
          if (row[0] || row[1]) {
            notice = { title: String(row[0] || ''), content: String(row[1] || ''), id: String(row[2] || ''), image: String(row[3] || '') };
          }
        }
      } catch (nErr) {}

      let cardInfo = [];
      try { cardInfo = _getUserCards(currentKnoxId); } catch (ciErr) {}

      const resp = {
        userInfo: { name: adminRow[ADMIN_COL.NAME] || '사용자', isAdmin: isAdmin, totalBudget: LIMIT_BUDGET, usedBudget: null, isAgreed: adminRow[ADMIN_COL.AGREE] === "Y", isCardAlarmAgreed: adminRow[6] === "Y", hasBizplayPw: !!(adminRow[7] && String(adminRow[7]).trim()), cardAutoMode: String(adminRow[9] || 'off').trim().toLowerCase() },
        myHistory: null,
        cardInfo: cardInfo,
        phase: 1
      };
      if (notice) resp.notice = notice;
      return createResponse(resp);
    }

    // ── Phase 2: 교육/도서 내역 + 템플릿 + Bizplay + 관리자통계 ──
    if (phase === '2') {
      let allApplyData = [];
      if (dataSheet) { const d = dataSheet.getDataRange().getValues(); d.shift(); d.forEach(row => { row._reqType = "교육"; allApplyData.push(row); }); }
      if (bookSheet) { const d = bookSheet.getDataRange().getValues(); d.shift(); d.forEach(row => { row._reqType = "도서"; allApplyData.push(row); }); }

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

      let adminStats = null;
      if (isAdmin) {
        const stats = { totalConfirmed: 0, totalPending: 0, totalMemberCount: adminSheet.getLastRow() - 1, vendors: {}, allUserList: [], allRecords: [] };
        const userMap = new Map();
        adminData.forEach((row, idx) => { if (idx === 0) return; const uId = String(row[ADMIN_COL.KNOX_ID]); userMap.set(uId, { knoxId: uId, name: row[ADMIN_COL.NAME] || "미확인", dept: row[ADMIN_COL.DEPT] || "", used: 0, pending: 0, eduUsed: 0, bookUsed: 0 }); });
        allApplyData.forEach(row => { const c = colFor(row); const sId = String(row[c.KNOX_ID]); const cost = Number(row[c.COST]) || 0; const status = String(row[c.STATUS]); const vendor = row._reqType === "교육" ? (row[DATA_COL.VENDOR] || "기타") : "도서"; if (status === "완료") { stats.totalConfirmed += cost; stats.vendors[vendor] = (stats.vendors[vendor] || 0) + cost; } else if (status.includes("대기") || status.includes("진행")) { stats.totalPending += cost; } if (userMap.has(sId)) { const u = userMap.get(sId); if (u.name === '미확인' && row[c.NAME]) u.name = String(row[c.NAME]); if (status === "완료") { u.used += cost; if (row._reqType === "교육") u.eduUsed += cost; else if (row._reqType === "도서") u.bookUsed += cost; } else if (status.includes("대기") || status.includes("진행")) { u.pending += cost; } } });
        stats.allRecords = allApplyData.map(row => { const c = colFor(row); const knoxId = String(row[c.KNOX_ID]); const masterName = userMap.has(knoxId) ? userMap.get(knoxId).name : ''; return { knoxId, name: masterName || row[c.NAME] || '', courseName: `[${row._reqType}] ${row[c.TITLE]}`, cost: Number(row[c.COST]) || 0, status: row[c.STATUS] || '', period: row._reqType === "교육" ? (row[12] || '') : '', date: row[0] ? new Date(row[0]).toISOString() : '', reqType: row._reqType }; });
        stats.allUserList = Array.from(userMap.values()).map(u => ({ ...u, isOverLimit: u.used >= 450000, isZeroUsage: u.used === 0 }));
        adminStats = stats;
      }

      const tplSheet = ensureTemplateSheet(ss);
      let templates = [];
      if (tplSheet && tplSheet.getLastRow() > 1) { const tplData = tplSheet.getDataRange().getValues(); tplData.shift(); templates = tplData.map(r => ({ courseName: r[0], institution: r[1], eduType: r[2], billing: r[3], cost: Number(r[4]) || 0, purpose: r[5], remark: r[6] })); }

      let bizplaySession = null;
      const encPw = adminRow[7];
      if (encPw && String(encPw).trim()) {
        const propKey = 'bizplay_' + currentKnoxId;
        const existingRaw = PropertiesService.getScriptProperties().getProperty(propKey);
        const existing = existingRaw ? JSON.parse(existingRaw) : null;
        const needLogin = !existing || !existing.bizplayCookies || (new Date() - new Date(existing.loginTime || 0)) > 3600000;
        if (needLogin) {
          try {
            const savedBizplayId = String(adminRow[ADMIN_COL.BIZPLAY_ID] || '').trim();
            const bizUserId = (savedBizplayId || currentKnoxId) + '@emro.co.kr';
            const bizPwd = _decryptPw(String(encPw));
            const loginPayload = '_JSON_=' + encodeURIComponent(JSON.stringify({ USER_ID: bizUserId, PWD: bizPwd, CAPTCHA_VALUE: '', LNK_ID: '', LNK_INTT: '', LOGIN_SAVE: 'N', USER_OS: 'win10.0', USER_BR: 'Chrome', USER_BR_VER: '145.0.0.0', TMPR_CD2: '', TMPR_CD3: '', LNGG_DSNC: 'DF', '_LODING_BAR_YN_': 'Y' }));
            const loginResp = UrlFetchApp.fetch('https://www.bizplay.co.kr/login_proc_01.jct', { method: 'post', contentType: 'application/x-www-form-urlencoded; charset=UTF-8', headers: { 'User-Agent': BROWSER_UA }, payload: loginPayload, followRedirects: false, muteHttpExceptions: true });
            const body = JSON.parse(loginResp.getContentText());
            if (body.RSLT_CD === '0000') { const sessionData = { bizplayCookies: extractCookies(loginResp), userId: bizUserId, userName: body.USER_NM, useInttId: body.USE_INTT_ID || '', loginTime: new Date().toISOString() }; PropertiesService.getScriptProperties().setProperty(propKey, JSON.stringify(sessionData)); bizplaySession = { userId: bizUserId, userName: body.USER_NM }; }
          } catch (bizErr) { console.log('[auto-bizplay] 자동 로그인 실패: ' + bizErr.message); }
        } else if (existing) { bizplaySession = { userId: existing.userId, userName: existing.userName }; }
      }

      var weatherAlert = null;
      try { weatherAlert = _getWeatherAlert(); } catch(we) {}
      var weatherNow = null;
      if (!weatherAlert) { try { weatherNow = _getWeatherNow(); } catch(wn) {} }
      var stockInfo = null;
      try { stockInfo = _getStockInfo(); } catch(se) {}
      var ddayInfo = [];
      try { ddayInfo = _getDday() || []; } catch(de) {}
      var airQuality = null;
      try { airQuality = _getAirQuality(); } catch(ae) {}
      var newsHeadlines = [];
      try { newsHeadlines = _getNewsHeadlines() || []; } catch(ne) {}

      return createResponse({ myHistory: myHistory, usedBudget: myUsed, templates: templates, adminStats: adminStats, bizplaySession: bizplaySession, weatherAlert: weatherAlert, weatherNow: weatherNow, stockInfo: stockInfo, ddayInfo: ddayInfo, airQuality: airQuality, newsHeadlines: newsHeadlines, phase: 2 });
    }

    // --- 교육/도서 데이터 병합 (phase 없음 = 하위호환 전체 응답) ---
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

    adminSheet.getRange(entry.idx + 1, ADMIN_COL.LAST_LOGIN + 1).setValue(new Date());

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
          const savedBizplayId = String(adminRow[ADMIN_COL.BIZPLAY_ID] || '').trim();
          const bizUserId = (savedBizplayId || currentKnoxId) + '@emro.co.kr';
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

    // 사용자 카드정보 로드
    let cardInfo = [];
    try { cardInfo = _getUserCards(currentKnoxId); } catch (ciErr) { /* 시트 없으면 무시 */ }

    const resp = {
      userInfo: { name: myRows.length > 0 ? myRows[0][colFor(myRows[0]).NAME] : "사용자", isAdmin: isAdmin, totalBudget: LIMIT_BUDGET, usedBudget: myUsed, isAgreed: adminRow[ADMIN_COL.AGREE] === "Y", isCardAlarmAgreed: adminRow[6] === "Y", hasBizplayPw: !!(adminRow[7] && String(adminRow[7]).trim()), cardAutoMode: String(adminRow[9] || 'off').trim().toLowerCase() },
      myHistory: myHistory,
      adminStats: adminStats,
      templates: templates,
      bizplaySession: bizplaySession,
      cardInfo: cardInfo
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

  // 3. 누적 사용액 사전 계산 (budgetMap: knoxId → 완료 합계)
  const eduData = dataSheet.getDataRange().getValues();
  const bookData = bookSheet.getDataRange().getValues();
  const budgetMap = new Map();
  const _accBudget = (rows, colDef) => {
    for (let i = 1; i < rows.length; i++) {
      const kid = String(rows[i][colDef.KNOX_ID]);
      if (rows[i][colDef.STATUS] === "완료") {
        budgetMap.set(kid, (budgetMap.get(kid) || 0) + (Number(rows[i][colDef.COST]) || 0));
      }
    }
  };
  _accBudget(eduData, DATA_COL);
  _accBudget(bookData, BOOK_COL);

  // 4. 방금 데이터가 추가된 '현재 활성화된 시트'만 스캔하여 발송 대상 찾기
  const activeCol = activeSheetName === SHEET_NAME.BOOK ? BOOK_COL : DATA_COL;
  const currentSheetData = activeSheet.getDataRange().getValues();

  currentSheetData.forEach((row, index) => {
    if (index === 0) return; // 헤더 제외

    const docId = String(row[DOC_ID_COL]).trim();
    const status = row[activeCol.STATUS];
    const knoxId = String(row[activeCol.KNOX_ID]);
    const isAgreed = adminMap.get(knoxId);

    // [이력 기록 조건] 완료 상태 + 발송 이력에 없는 문서번호 → 수신동의 무관하게 이력 추가
    if (docId && status === "완료" && !sentDocIds.has(docId)) {

      // 수신동의한 사용자에게만 실제 알림 발송
      if (isAgreed === "Y") {
        const totalUsed = budgetMap.get(knoxId) || 0;

        var msg = FLOW_MSG.approvalComplete(reqType, docId, row[activeCol.TITLE], row[activeCol.COST], totalUsed, LIMIT_BUDGET - totalUsed);
        if (sendFlowMsg(knoxId, msg)) {
          console.log(`신규 알람 발송 완료: ${docId} (${reqType})`);
        }
      } else {
        console.log(`이력만 기록 (수신동의 미동의): ${docId}, ${knoxId}`);
      }

      // 발송 여부와 무관하게 이력 기록 (중복 발송 방지)
      historySheet.appendRow([docId, new Date(), knoxId]);
      sentDocIds.add(docId);
    }
  });
};

/**
 * 실제 알람 발송 프로세스 (중복 코드 방지를 위해 분리)
 */
function processAlarm(sheet, rowIndex, knoxId, rowData) {
  const adminSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME.ADMIN);
  const adminData = adminSheet.getDataRange().getValues();
  const userAdminInfo = adminData.find(row => String(row[ADMIN_COL.KNOX_ID]).trim() === knoxId);

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
    reqData.PREVIEW_LINK = previewLink.includes('?') ? previewLink : previewLink + '?';
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

