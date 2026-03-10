/**
 * 이쏜미 (It's On Me) - 그룹 주문 취합 모듈
 * 시트: 이쏜미(세션 마스터), 이쏜미응답(수신자별 응답)
 */

/* ═══════════════ 상수 ═══════════════ */
var IOM_SHEET   = '이쏜미';
var IOM_RESP    = '이쏜미응답';
var IOM_TPL     = '이쏜미템플릿';

// 이쏜미 시트 컬럼 (0-based)
var IOM_COL = { SID: 0, CREATOR_KNOX: 1, CREATOR_NAME: 2, STORE: 3, DEADLINE: 4, STATUS: 5, CREATED: 6, TOTAL: 7, CUSTOM_MENUS: 8, BETTING: 9 };
// 이쏜미템플릿 시트 컬럼 (0-based)
var IOM_TPL_COL = { KNOX: 0, STORE: 1, MENUS: 2, UPDATED: 3 };
// 이쏜미응답 시트 컬럼 (0-based)
var IOM_R_COL = { SID: 0, KNOX: 1, NAME: 2, MENU: 3, OPTIONS: 4, PRICE: 5, UPDATED: 6, GAME_SCORE: 7 };

/* ═══════════════ 회의실 위치 Flow 공유 ═══════════════ */

function handleSendFindRoomFlow(adminRow, e) {
  var targetKnox = String(e.parameter.targetKnoxId || '').trim();
  var roomName = String(e.parameter.roomName || '').trim();
  var floor = String(e.parameter.floor || '').trim();
  if (!targetKnox || !roomName || !floor) return createResponse({ error: '필수 정보가 없어.' });

  var senderName = String(adminRow[ADMIN_COL.NAME] || '').trim();
  var msg = FLOW_MSG.findRoom(senderName, roomName, floor);
  var ids = targetKnox.split(',');
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i].trim();
    if (id) sendFlowMsg(id, msg);
  }
  return createResponse({ status: 'success', count: ids.length });
}

/* ═══════════════ BizFlow 사용자 검색 ═══════════════ */

function handleSearchBizFlowUsers(adminRow, e) {
  var word = String(e.parameter.searchWord || '').trim().toLowerCase();
  if (word.length < 1) return createResponse({ status: 'success', users: [] });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  if (!sheet || sheet.getLastRow() < 2) return createResponse({ status: 'success', users: [] });

  var data = sheet.getDataRange().getValues();
  data.shift();
  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var results = [];

  for (var i = 0; i < data.length; i++) {
    var knoxId = String(data[i][ADMIN_COL.KNOX_ID] || '').trim();
    var name   = String(data[i][ADMIN_COL.NAME] || '').trim();
    var dept   = String(data[i][ADMIN_COL.DEPT] || '').trim();
    if (!knoxId) continue;
    if (knoxId.toLowerCase() === myKnox) continue;
    if (name.toLowerCase().indexOf(word) !== -1 || knoxId.toLowerCase().indexOf(word) !== -1) {
      results.push({ knoxId: knoxId, name: name, dept: dept });
    }
    if (results.length >= 20) break;
  }
  return createResponse({ status: 'success', users: results });
}

/**
 * 사용자 목록 일괄 반환 (인코딩)
 * - Network 탭에서 평문 노출 방지: 간단한 문자 시프트 + base64
 */
function handleGetBizFlowUserList(adminRow, e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  if (!sheet || sheet.getLastRow() < 2) return createResponse({ ok: true, d: '' });

  var data = sheet.getDataRange().getValues();
  data.shift();
  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var myDept = '';
  var users = [];
  for (var i = 0; i < data.length; i++) {
    var knoxId = String(data[i][ADMIN_COL.KNOX_ID] || '').trim();
    var name   = String(data[i][ADMIN_COL.NAME] || '').trim();
    var dept   = String(data[i][ADMIN_COL.DEPT] || '').trim();
    if (!knoxId) continue;
    if (knoxId.toLowerCase() === myKnox) { myDept = dept; /* continue; // 테스트용 본인포함 */ }
    users.push([knoxId, name, dept]);
  }
  // JSON → base64 → 문자열 반전 (평문 노출 방지)
  var json = JSON.stringify(users);
  var b64 = Utilities.base64Encode(json, Utilities.Charset.UTF_8);
  var reversed = b64.split('').reverse().join('');

  // 이전 세션 목록 조회 (최근 5개, 세션별 멤버 포함)
  var prevSessions = [];
  var masterSheet = ss.getSheetByName(IOM_SHEET);
  if (masterSheet && masterSheet.getLastRow() > 1) {
    var masterData = masterSheet.getDataRange().getValues();
    // 역순으로 내 세션 최대 5개
    for (var k = masterData.length - 1; k >= 1 && prevSessions.length < 5; k--) {
      if (String(masterData[k][IOM_COL.CREATOR_KNOX]).trim().toLowerCase() === myKnox) {
        prevSessions.push({
          sid: String(masterData[k][IOM_COL.SID]),
          store: String(masterData[k][IOM_COL.STORE]),
          created: Utilities.formatDate(new Date(masterData[k][IOM_COL.CREATED]), 'Asia/Seoul', 'M/d HH:mm'),
          members: [] // 아래에서 채움
        });
      }
    }
    if (prevSessions.length) {
      var respSheet = ss.getSheetByName(IOM_RESP);
      if (respSheet && respSheet.getLastRow() > 1) {
        var respData = respSheet.getDataRange().getValues();
        var sidMap = {};
        for (var s = 0; s < prevSessions.length; s++) sidMap[prevSessions[s].sid] = prevSessions[s];
        for (var r = 1; r < respData.length; r++) {
          var rSid = String(respData[r][IOM_R_COL.SID]);
          if (!sidMap[rSid]) continue;
          var rKnox = String(respData[r][IOM_R_COL.KNOX]).trim();
          if (rKnox.toLowerCase() === myKnox) continue;
          sidMap[rSid].members.push(rKnox);
        }
      }
    }
  }

  return createResponse({ ok: true, d: reversed, m: myKnox, dept: myDept, p: prevSessions });
}

/* ═══════════════ 세션 생성 ═══════════════ */

function handleCreateItsOnMe(adminRow, e) {
  var store    = String(e.parameter.store || '').trim();
  var minutes  = parseInt(e.parameter.minutes) || 30;
  var membersJson = String(e.parameter.members || '[]');
  var customMenus = String(e.parameter.customMenus || '');
  var betting  = String(e.parameter.betting || '').trim() === 'Y' ? 'Y' : '';

  if (!store) return createResponse({ error: '가게를 선택해줘.' });

  var members;
  try { members = JSON.parse(membersJson); } catch (_) { return createResponse({ error: '멤버 정보 오류' }); }
  if (!members.length) return createResponse({ error: '멤버를 선택해줘.' });

  var creatorKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim();
  var creatorName = String(adminRow[ADMIN_COL.NAME]).trim();

  // 마감시간 계산 (5분 단위 올림)
  var now = new Date();
  var deadline = new Date(now.getTime() + minutes * 60000);

  var sid = Utilities.getUuid();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 세션 마스터 기록
  var masterSheet = ss.getSheetByName(IOM_SHEET);
  if (!masterSheet) {
    masterSheet = ss.insertSheet(IOM_SHEET);
    masterSheet.appendRow(['세션ID','생성자Knox','생성자이름','가게명','마감시간','상태','생성시각','총인원']);
  }

  // 생성자 포함해서 전체 멤버 구성
  var allMembers = [{ knoxId: creatorKnox, name: creatorName }];
  for (var i = 0; i < members.length; i++) {
    if (String(members[i].knoxId).trim().toLowerCase() !== creatorKnox.toLowerCase()) {
      allMembers.push(members[i]);
    }
  }

  masterSheet.appendRow([sid, creatorKnox, creatorName, store,
    deadline, 'open', now, allMembers.length, customMenus, betting]);

  // 응답 시트에 전원 행 삽입
  var respSheet = ss.getSheetByName(IOM_RESP);
  if (!respSheet) {
    respSheet = ss.insertSheet(IOM_RESP);
    respSheet.appendRow(['세션ID','수신자Knox','수신자이름','선택메뉴','옵션상세','가격','선택시각']);
  }
  var respRows = [];
  for (var j = 0; j < allMembers.length; j++) {
    respRows.push([sid, allMembers[j].knoxId, allMembers[j].name, '', '', '', '', '']);
  }
  if (respRows.length) respSheet.getRange(respSheet.getLastRow() + 1, 1, respRows.length, 8).setValues(respRows);

  // Flow 발송 (생성자 제외)
  var deadlineStr = Utilities.formatDate(deadline, 'Asia/Seoul', 'HH:mm');
  var failedUsers = [];
  for (var k = 0; k < allMembers.length; k++) {
    // if (allMembers[k].knoxId.toLowerCase() === creatorKnox.toLowerCase()) continue; // 테스트: 본인에게도 발송
    try {
      var msg = betting === 'Y'
        ? FLOW_MSG.itsOnMeBettingInvite(creatorName, store, deadlineStr, sid)
        : FLOW_MSG.itsOnMeInvite(creatorName, store, deadlineStr, sid);
      sendFlowMsg(allMembers[k].knoxId, msg);
    } catch (ex) {
      failedUsers.push(allMembers[k].name);
    }
  }

  return createResponse({
    status: 'success',
    sessionId: sid,
    deadline: deadline.toISOString(),
    deadlineStr: deadlineStr,
    totalMembers: allMembers.length,
    failedUsers: failedUsers
  });
}

/* ═══════════════ 세션 조회 ═══════════════ */

function handleGetItsOnMe(adminRow, e) {
  var sid = String(e.parameter.sessionId || '').trim();
  if (!sid) return createResponse({ error: '세션ID가 없어.' });

  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 세션 마스터 조회
  var masterSheet = ss.getSheetByName(IOM_SHEET);
  if (!masterSheet) return createResponse({ error: '세션을 찾을 수 없어.' });
  var masterData = masterSheet.getDataRange().getValues();
  var session = null;
  for (var i = 1; i < masterData.length; i++) {
    if (String(masterData[i][IOM_COL.SID]) === sid) {
      session = {
        sessionId: sid,
        creatorKnox: String(masterData[i][IOM_COL.CREATOR_KNOX]),
        creatorName: String(masterData[i][IOM_COL.CREATOR_NAME]),
        store: String(masterData[i][IOM_COL.STORE]),
        deadline: new Date(masterData[i][IOM_COL.DEADLINE]).toISOString(),
        status: String(masterData[i][IOM_COL.STATUS]),
        total: Number(masterData[i][IOM_COL.TOTAL]),
        customMenus: String(masterData[i][IOM_COL.CUSTOM_MENUS] || ''),
        betting: String(masterData[i][IOM_COL.BETTING] || '')
      };
      break;
    }
  }
  if (!session) return createResponse({ error: '세션을 찾을 수 없어.' });

  // 응답 조회
  var respSheet = ss.getSheetByName(IOM_RESP);
  var responses = [];
  var myResponse = null;
  var isMember = false;
  if (respSheet) {
    var respData = respSheet.getDataRange().getValues();
    for (var j = 1; j < respData.length; j++) {
      if (String(respData[j][IOM_R_COL.SID]) !== sid) continue;
      var rawScore = respData[j][IOM_R_COL.GAME_SCORE];
      var resp = {
        knoxId: String(respData[j][IOM_R_COL.KNOX]),
        name: String(respData[j][IOM_R_COL.NAME]),
        menu: String(respData[j][IOM_R_COL.MENU]),
        options: String(respData[j][IOM_R_COL.OPTIONS]),
        gameScore: (rawScore !== '' && rawScore !== null && rawScore !== undefined) ? Number(rawScore) : null,
        updated: respData[j][IOM_R_COL.UPDATED] ? new Date(respData[j][IOM_R_COL.UPDATED]).toISOString() : ''
      };
      responses.push(resp);
      if (resp.knoxId.toLowerCase() === myKnox) {
        myResponse = resp;
        isMember = true;
      }
    }
  }

  if (!isMember) return createResponse({ error: '이 주문에 포함되지 않았어.' });

  // 먹던대로: 이 사용자의 가장 최근 주문(이 세션 제외)
  var lastOrder = null;
  if (respSheet) {
    var allResp = respSheet.getDataRange().getValues();
    for (var r = allResp.length - 1; r >= 1; r--) {
      if (String(allResp[r][IOM_R_COL.SID]) === sid) continue;
      if (String(allResp[r][IOM_R_COL.KNOX]).trim().toLowerCase() === myKnox && String(allResp[r][IOM_R_COL.MENU]).trim()) {
        lastOrder = { menu: String(allResp[r][IOM_R_COL.MENU]).trim(), options: String(allResp[r][IOM_R_COL.OPTIONS]).trim(), price: Number(allResp[r][IOM_R_COL.PRICE]) || 0 };
        break;
      }
    }
  }

  // 선택 현황
  var doneCount = 0;
  for (var rc = 0; rc < responses.length; rc++) {
    if (responses[rc].menu) doneCount++;
  }

  return createResponse({
    status: 'success',
    session: session,
    responses: responses,
    myResponse: myResponse,
    isCreator: session.creatorKnox.toLowerCase() === myKnox,
    lastOrder: lastOrder,
    doneCount: doneCount
  });
}

/* ═══════════════ 메뉴 선택/수정 ═══════════════ */

function handleSubmitItsOnMeMenu(adminRow, e) {
  var sid   = String(e.parameter.sessionId || '').trim();
  var menu  = String(e.parameter.menu || '').trim();
  var opts  = String(e.parameter.options || '');
  var price = parseInt(e.parameter.price) || 0;

  if (!sid || !menu) return createResponse({ error: '세션ID 또는 메뉴가 없어.' });

  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 세션 상태 확인
  var masterSheet = ss.getSheetByName(IOM_SHEET);
  if (!masterSheet) return createResponse({ error: '세션을 찾을 수 없어.' });
  var masterData = masterSheet.getDataRange().getValues();
  var sessionIdx = -1;
  var sessionStatus = '';
  for (var i = 1; i < masterData.length; i++) {
    if (String(masterData[i][IOM_COL.SID]) === sid) {
      sessionIdx = i;
      sessionStatus = String(masterData[i][IOM_COL.STATUS]);
      break;
    }
  }
  if (sessionIdx === -1) return createResponse({ error: '세션을 찾을 수 없어.' });
  if (sessionStatus === 'closed') return createResponse({ error: '이미 마감된 주문이야.' });

  // 응답 업데이트
  var respSheet = ss.getSheetByName(IOM_RESP);
  if (!respSheet) return createResponse({ error: '응답 시트 오류' });
  var respData = respSheet.getDataRange().getValues();
  var updated = false;
  var allDone = true;

  for (var j = 1; j < respData.length; j++) {
    if (String(respData[j][IOM_R_COL.SID]) !== sid) continue;
    if (String(respData[j][IOM_R_COL.KNOX]).trim().toLowerCase() === myKnox) {
      // 내 행 업데이트
      var rowNum = j + 1;
      respSheet.getRange(rowNum, IOM_R_COL.MENU + 1).setValue(menu);
      respSheet.getRange(rowNum, IOM_R_COL.OPTIONS + 1).setValue(opts);
      respSheet.getRange(rowNum, IOM_R_COL.PRICE + 1).setValue(price);
      respSheet.getRange(rowNum, IOM_R_COL.UPDATED + 1).setValue(new Date());
      updated = true;
      // 이 행은 방금 업데이트했으니 done
    } else {
      // 다른 사람 행 체크
      if (!String(respData[j][IOM_R_COL.MENU]).trim()) allDone = false;
    }
  }

  if (!updated) return createResponse({ error: '이 주문에 포함되지 않았어.' });

  // 전원 완료 시 즉시 마감
  if (allDone) {
    _closeItsOnMeSession(ss, masterSheet, respSheet, sid, sessionIdx);
  }

  return createResponse({ status: 'success', allDone: allDone });
}

/* ═══════════════ 인원 추가 ═══════════════ */

function handleAddItsOnMeMembers(adminRow, e) {
  var sid = String(e.parameter.sessionId || '').trim();
  var newMembersJson = String(e.parameter.members || '[]');

  if (!sid) return createResponse({ error: '세션ID가 없어.' });

  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 세션 확인 (생성자만 가능)
  var masterSheet = ss.getSheetByName(IOM_SHEET);
  if (!masterSheet) return createResponse({ error: '세션을 찾을 수 없어.' });
  var masterData = masterSheet.getDataRange().getValues();
  var sessionIdx = -1;
  var session = null;
  for (var i = 1; i < masterData.length; i++) {
    if (String(masterData[i][IOM_COL.SID]) === sid) {
      sessionIdx = i;
      session = masterData[i];
      break;
    }
  }
  if (!session) return createResponse({ error: '세션을 찾을 수 없어.' });
  if (String(session[IOM_COL.STATUS]) === 'closed') return createResponse({ error: '이미 마감된 주문이야.' });

  // 참여자(멤버) 여부 확인
  var respSheet = ss.getSheetByName(IOM_RESP);
  var respData = respSheet.getDataRange().getValues();
  var existingKnox = {};
  var isMember = false;
  for (var j = 1; j < respData.length; j++) {
    if (String(respData[j][IOM_R_COL.SID]) === sid) {
      var rk = String(respData[j][IOM_R_COL.KNOX]).trim().toLowerCase();
      existingKnox[rk] = true;
      if (rk === myKnox) isMember = true;
    }
  }
  if (!isMember) return createResponse({ error: '이 주문에 포함되지 않았어.' });

  var newMembers;
  try { newMembers = JSON.parse(newMembersJson); } catch (_) { return createResponse({ error: '멤버 정보 오류' }); }
  if (!newMembers.length) return createResponse({ error: '추가할 멤버가 없어.' });

  var added = [];
  var respRows = [];
  for (var k = 0; k < newMembers.length; k++) {
    var knox = String(newMembers[k].knoxId).trim().toLowerCase();
    if (existingKnox[knox]) continue;
    respRows.push([sid, newMembers[k].knoxId, newMembers[k].name, '', '', '', '', '']);
    added.push(newMembers[k]);
    existingKnox[knox] = true;
  }

  if (respRows.length) {
    respSheet.getRange(respSheet.getLastRow() + 1, 1, respRows.length, 7).setValues(respRows);
    // 총 인원 업데이트
    var newTotal = Number(session[IOM_COL.TOTAL]) + respRows.length;
    masterSheet.getRange(sessionIdx + 1, IOM_COL.TOTAL + 1).setValue(newTotal);
  }

  // 추가된 멤버에게 Flow 발송
  var creatorKnox = String(session[IOM_COL.CREATOR_KNOX]).trim().toLowerCase();
  var creatorName = String(session[IOM_COL.CREATOR_NAME]);
  var store = String(session[IOM_COL.STORE]);
  var isBetting = String(session[IOM_COL.BETTING]) === 'Y';
  var deadlineStr = Utilities.formatDate(new Date(session[IOM_COL.DEADLINE]), 'Asia/Seoul', 'HH:mm');
  for (var m = 0; m < added.length; m++) {
    try {
      var msg = isBetting
        ? FLOW_MSG.itsOnMeBettingInvite(creatorName, store, deadlineStr, sid)
        : FLOW_MSG.itsOnMeInvite(creatorName, store, deadlineStr, sid);
      sendFlowMsg(added[m].knoxId, msg);
    } catch (_) {}
  }

  // 발송자에게 알림 (본인이 아닌 경우)
  if (added.length && myKnox !== creatorKnox) {
    var myName = String(adminRow[ADMIN_COL.NAME]).trim();
    var addedNames = added.map(function(a) { return a.name; }).join(', ');
    try {
      sendFlowMsg(creatorKnox, FLOW_MSG.itsOnMeUpdate(myName, addedNames + ' 추가'));
    } catch (_) {}
  }

  return createResponse({ status: 'success', addedCount: added.length });
}

/* ═══════════════ 마감시간 연장 ═══════════════ */

function handleExtendItsOnMe(adminRow, e) {
  var sid = String(e.parameter.sessionId || '').trim();
  var addMinutes = parseInt(e.parameter.minutes) || 10;

  if (!sid) return createResponse({ error: '세션ID가 없어.' });

  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var masterSheet = ss.getSheetByName(IOM_SHEET);
  if (!masterSheet) return createResponse({ error: '세션을 찾을 수 없어.' });
  var masterData = masterSheet.getDataRange().getValues();
  var sessionIdx = -1;
  var session = null;
  for (var i = 1; i < masterData.length; i++) {
    if (String(masterData[i][IOM_COL.SID]) === sid) { sessionIdx = i; session = masterData[i]; break; }
  }
  if (!session) return createResponse({ error: '세션을 찾을 수 없어.' });
  if (String(session[IOM_COL.STATUS]) === 'closed') return createResponse({ error: '이미 마감된 주문이야.' });

  // 참여자 확인
  var respSheet = ss.getSheetByName(IOM_RESP);
  var respData = respSheet.getDataRange().getValues();
  var isMember = false;
  for (var j = 1; j < respData.length; j++) {
    if (String(respData[j][IOM_R_COL.SID]) === sid && String(respData[j][IOM_R_COL.KNOX]).trim().toLowerCase() === myKnox) {
      isMember = true; break;
    }
  }
  if (!isMember) return createResponse({ error: '이 주문에 포함되지 않았어.' });

  var oldDeadline = new Date(session[IOM_COL.DEADLINE]);
  var base = new Date() > oldDeadline ? new Date() : oldDeadline;
  var newDeadline = new Date(base.getTime() + addMinutes * 60000);
  masterSheet.getRange(sessionIdx + 1, IOM_COL.DEADLINE + 1).setValue(newDeadline);

  var dlStr = Utilities.formatDate(newDeadline, 'Asia/Seoul', 'HH:mm');

  // 발송자에게 알림 (본인이 아닌 경우)
  var creatorKnox = String(session[IOM_COL.CREATOR_KNOX]).trim().toLowerCase();
  if (myKnox !== creatorKnox) {
    var myName = String(adminRow[ADMIN_COL.NAME]).trim();
    try {
      sendFlowMsg(creatorKnox, FLOW_MSG.itsOnMeUpdate(myName, '마감시간 ' + dlStr + '로 연장'));
    } catch (_) {}
  }

  return createResponse({ status: 'success', newDeadline: newDeadline.toISOString(), deadlineStr: dlStr });
}

/* ═══════════════ 내기 모드: 게임 점수 저장 ═══════════════ */

function handleSubmitItsOnMeGameScore(adminRow, e) {
  var sid = String(e.parameter.sessionId || '').trim();
  var gameScore = parseInt(e.parameter.gameScore, 10);
  if (!sid || isNaN(gameScore) || gameScore < 0) return createResponse({ error: '잘못된 요청' });

  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 세션 확인 (open + betting)
  var masterSheet = ss.getSheetByName(IOM_SHEET);
  if (!masterSheet) return createResponse({ error: '세션을 찾을 수 없어.' });
  var masterData = masterSheet.getDataRange().getValues();
  var found = false;
  var masterIdx = -1;
  for (var i = 1; i < masterData.length; i++) {
    if (String(masterData[i][IOM_COL.SID]) === sid) {
      if (String(masterData[i][IOM_COL.STATUS]) === 'closed') return createResponse({ error: '이미 마감된 주문이야.' });
      if (String(masterData[i][IOM_COL.BETTING]) !== 'Y') return createResponse({ error: '내기 모드가 아니야.' });
      masterIdx = i;
      found = true;
      break;
    }
  }
  if (!found) return createResponse({ error: '세션을 찾을 수 없어.' });

  // 응답 행에서 내 행 찾기
  var respSheet = ss.getSheetByName(IOM_RESP);
  if (!respSheet) return createResponse({ error: '응답 시트 오류' });
  var respData = respSheet.getDataRange().getValues();

  for (var j = 1; j < respData.length; j++) {
    if (String(respData[j][IOM_R_COL.SID]) !== sid) continue;
    if (String(respData[j][IOM_R_COL.KNOX]).trim().toLowerCase() !== myKnox) continue;

    // 이미 점수가 있으면 재플레이 불가
    var existing = respData[j][IOM_R_COL.GAME_SCORE];
    if (existing !== '' && existing !== null && existing !== undefined) {
      return createResponse({ error: '이미 게임을 했어! 재도전은 안 돼.' });
    }

    respSheet.getRange(j + 1, IOM_R_COL.GAME_SCORE + 1).setValue(gameScore);

    // 전원 게임 완료 체크 → 꼴찌 결정 + Flow 발송
    var refreshed = respSheet.getDataRange().getValues();
    var allPlayed = true;
    var scoreboard = [];
    for (var k = 1; k < refreshed.length; k++) {
      if (String(refreshed[k][IOM_R_COL.SID]) !== sid) continue;
      var sc = refreshed[k][IOM_R_COL.GAME_SCORE];
      if (sc === '' || sc === null || sc === undefined) { allPlayed = false; break; }
      scoreboard.push({
        knoxId: String(refreshed[k][IOM_R_COL.KNOX]).trim(),
        name: String(refreshed[k][IOM_R_COL.NAME]),
        gameScore: Number(sc)
      });
    }

    if (allPlayed && scoreboard.length > 0) {
      // 꼴찌 결정
      scoreboard.sort(function(a, b) { return a.gameScore - b.gameScore; });
      var lowestScore = scoreboard[0].gameScore;
      var losers = scoreboard.filter(function(r) { return r.gameScore === lowestScore; });
      var loser = losers[Math.floor(Math.random() * losers.length)];

      // 전원에게 꼴찌 발표 + 메뉴 선택 안내
      var store = String(masterData[masterIdx][IOM_COL.STORE]);
      var msg = FLOW_MSG.itsOnMeBettingAllPlayed(store, scoreboard, loser, sid);
      for (var m = 0; m < scoreboard.length; m++) {
        try { sendFlowMsg(scoreboard[m].knoxId, msg); } catch (_) {}
      }
    }

    return createResponse({ status: 'success', score: gameScore, allPlayed: allPlayed });
  }

  return createResponse({ error: '이 주문에 포함되지 않았어.' });
}

/* ═══════════════ 마감 처리 (내부) ═══════════════ */

function _closeItsOnMeSession(ss, masterSheet, respSheet, sid, masterIdx) {
  // 상태를 closed로
  masterSheet.getRange(masterIdx + 1, IOM_COL.STATUS + 1).setValue('closed');

  // 응답 수집
  var masterRow = masterSheet.getDataRange().getValues()[masterIdx];
  var respData = respSheet.getDataRange().getValues();
  var responses = [];
  var creatorKnox = String(masterRow[IOM_COL.CREATOR_KNOX]);
  var store = String(masterRow[IOM_COL.STORE]);
  var isBetting = String(masterRow[IOM_COL.BETTING]) === 'Y';

  for (var i = 1; i < respData.length; i++) {
    if (String(respData[i][IOM_R_COL.SID]) !== sid) continue;
    var rawScore = respData[i][IOM_R_COL.GAME_SCORE];
    responses.push({
      knoxId: String(respData[i][IOM_R_COL.KNOX]).trim(),
      name: String(respData[i][IOM_R_COL.NAME]),
      menu: String(respData[i][IOM_R_COL.MENU]).trim(),
      options: String(respData[i][IOM_R_COL.OPTIONS]).trim(),
      price: Number(respData[i][IOM_R_COL.PRICE]) || 0,
      gameScore: (rawScore !== '' && rawScore !== null && rawScore !== undefined) ? Number(rawScore) : null
    });
  }

  if (isBetting) {
    // 내기 모드: 게임 참여자만 대상, 미참여자는 제외
    var scored = [];
    for (var s = 0; s < responses.length; s++) {
      if (responses[s].gameScore !== null) {
        scored.push({
          knoxId: responses[s].knoxId,
          name: responses[s].name,
          gameScore: responses[s].gameScore
        });
      }
    }

    if (scored.length > 0) {
      scored.sort(function(a, b) { return a.gameScore - b.gameScore; });
      // 동점 꼴찌 중 랜덤 선택
      var lowestScore = scored[0].gameScore;
      var losers = scored.filter(function(r) { return r.gameScore === lowestScore; });
      var loser = losers[Math.floor(Math.random() * losers.length)];

      // 게임 참여자에게만 결과 + 메뉴 취합 발송 (참여자 기준)
      var playedResponses = responses.filter(function(r) { return r.gameScore !== null; });
      var msg = FLOW_MSG.itsOnMeBettingSummary(store, playedResponses, scored, loser);
      for (var m = 0; m < scored.length; m++) {
        try { sendFlowMsg(scored[m].knoxId, msg); } catch (_) {}
      }
    }
  } else {
    // 일반 모드: 생성자에게만 취합 발송
    var msg = FLOW_MSG.itsOnMeSummary(store, responses);
    sendFlowMsg(creatorKnox, msg);
  }

  // 1시간 후 데이터 삭제 트리거
  ScriptApp.newTrigger('_cleanupItsOnMe')
    .timeBased().after(60 * 60 * 1000).create();
  // sid를 PropertiesService에 기록 (cleanup에서 참조)
  var pending = PropertiesService.getScriptProperties().getProperty('IOM_CLEANUP') || '';
  var list = pending ? pending.split(',') : [];
  list.push(sid);
  PropertiesService.getScriptProperties().setProperty('IOM_CLEANUP', list.join(','));
}

/* ═══════════════ 커스텀 가게 템플릿 ═══════════════ */

function _getOrCreateTplSheet(ss) {
  var sheet = ss.getSheetByName(IOM_TPL);
  if (!sheet) {
    sheet = ss.insertSheet(IOM_TPL);
    sheet.appendRow(['knoxId','상호명','메뉴목록JSON','수정시각']);
  }
  return sheet;
}

function handleGetItsOnMeTemplates(adminRow, e) {
  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(IOM_TPL);
  if (!sheet || sheet.getLastRow() < 2) return createResponse({ ok: true, templates: [] });

  // knoxId → 이름 맵 구축
  var adminSheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  var nameMap = {};
  if (adminSheet) {
    var ad = adminSheet.getDataRange().getValues();
    for (var a = 1; a < ad.length; a++) {
      var ak = String(ad[a][ADMIN_COL.KNOX_ID] || '').trim().toLowerCase();
      if (ak) nameMap[ak] = String(ad[a][ADMIN_COL.NAME] || '').trim();
    }
  }

  var data = sheet.getDataRange().getValues();
  var templates = [];
  for (var i = 1; i < data.length; i++) {
    var knox = String(data[i][IOM_TPL_COL.KNOX]).trim().toLowerCase();
    templates.push({
      idx: i,
      store: String(data[i][IOM_TPL_COL.STORE]),
      menus: String(data[i][IOM_TPL_COL.MENUS]),
      updated: data[i][IOM_TPL_COL.UPDATED] ? Utilities.formatDate(new Date(data[i][IOM_TPL_COL.UPDATED]), 'Asia/Seoul', 'M/d HH:mm') : '',
      isMine: knox === myKnox,
      ownerName: nameMap[knox] || ''
    });
  }
  return createResponse({ ok: true, templates: templates });
}

function handleSaveItsOnMeTemplate(adminRow, e) {
  var store = String(e.parameter.store || '').trim();
  var menus = String(e.parameter.menus || '[]');
  if (!store) return createResponse({ error: '상호명을 입력해줘.' });

  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _getOrCreateTplSheet(ss);
  var data = sheet.getDataRange().getValues();

  // 같은 상호명이 있으면 덮어쓰기
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][IOM_TPL_COL.KNOX]).trim().toLowerCase() === myKnox &&
        String(data[i][IOM_TPL_COL.STORE]).trim() === store) {
      sheet.getRange(i + 1, IOM_TPL_COL.MENUS + 1).setValue(menus);
      sheet.getRange(i + 1, IOM_TPL_COL.UPDATED + 1).setValue(new Date());
      return createResponse({ ok: true });
    }
  }
  // 신규
  sheet.appendRow([myKnox, store, menus, new Date()]);
  return createResponse({ ok: true });
}

function handleDeleteItsOnMeTemplate(adminRow, e) {
  var store = String(e.parameter.store || '').trim();
  if (!store) return createResponse({ error: '상호명이 없어.' });

  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(IOM_TPL);
  if (!sheet || sheet.getLastRow() < 2) return createResponse({ error: '템플릿이 없어.' });

  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][IOM_TPL_COL.KNOX]).trim().toLowerCase() === myKnox &&
        String(data[i][IOM_TPL_COL.STORE]).trim() === store) {
      sheet.deleteRow(i + 1);
      return createResponse({ ok: true });
    }
  }
  return createResponse({ error: '템플릿을 찾을 수 없어.' });
}

/* ═══════════════ 5분 폴링 트리거 ═══════════════ */

function pollItsOnMeClose() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var masterSheet = ss.getSheetByName(IOM_SHEET);
  if (!masterSheet || masterSheet.getLastRow() < 2) return;

  var now = new Date();
  var data = masterSheet.getDataRange().getValues();
  var respSheet = ss.getSheetByName(IOM_RESP);
  if (!respSheet) return;
  var respData = respSheet.getDataRange().getValues();

  var props = PropertiesService.getScriptProperties();
  var reminded = (props.getProperty('IOM_REMINDED') || '').split(',').filter(Boolean);
  var remindedSet = {};
  reminded.forEach(function(s) { remindedSet[s] = true; });

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][IOM_COL.STATUS]) !== 'open') continue;
    var deadline = new Date(data[i][IOM_COL.DEADLINE]);
    var sid = String(data[i][IOM_COL.SID]);

    if (now >= deadline) {
      _closeItsOnMeSession(ss, masterSheet, respSheet, sid, i);
      continue;
    }

    // 마감 5분 전 리마인드 (미선택자에게)
    var minLeft = (deadline.getTime() - now.getTime()) / 60000;
    if (minLeft <= 5 && !remindedSet[sid]) {
      var store = String(data[i][IOM_COL.STORE]);
      var isBetting = String(data[i][IOM_COL.BETTING]) === 'Y';
      var dlStr = Utilities.formatDate(deadline, 'Asia/Seoul', 'HH:mm');
      for (var j = 1; j < respData.length; j++) {
        if (String(respData[j][IOM_R_COL.SID]) !== sid) continue;
        // 내기 모드: 게임 미플레이 OR 메뉴 미선택이면 리마인드
        var needRemind = isBetting
          ? (respData[j][IOM_R_COL.GAME_SCORE] === '' || respData[j][IOM_R_COL.GAME_SCORE] === null || !String(respData[j][IOM_R_COL.MENU]).trim())
          : !String(respData[j][IOM_R_COL.MENU]).trim();
        if (!needRemind) continue;
        try {
          var msg = isBetting
            ? FLOW_MSG.itsOnMeBettingReminder(store, dlStr, sid)
            : FLOW_MSG.itsOnMeReminder(store, dlStr, sid);
          sendFlowMsg(String(respData[j][IOM_R_COL.KNOX]).trim(), msg);
        } catch (_) {}
      }
      reminded.push(sid);
      remindedSet[sid] = true;
    }
  }

  props.setProperty('IOM_REMINDED', reminded.join(','));
}

/* ═══════════════ 데이터 정리 (마감 1시간 후) ═══════════════ */

function _cleanupItsOnMe() {
  var prop = PropertiesService.getScriptProperties();
  var pending = prop.getProperty('IOM_CLEANUP') || '';
  if (!pending) return;

  var sids = pending.split(',').filter(Boolean);
  if (!sids.length) return;

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 응답 시트 정리
  var respSheet = ss.getSheetByName(IOM_RESP);
  if (respSheet && respSheet.getLastRow() > 1) {
    var respData = respSheet.getDataRange().getValues();
    var sidSet = {};
    for (var s = 0; s < sids.length; s++) sidSet[sids[s]] = true;
    // 뒤에서부터 삭제
    for (var i = respData.length - 1; i >= 1; i--) {
      if (sidSet[String(respData[i][IOM_R_COL.SID])]) {
        respSheet.deleteRow(i + 1);
      }
    }
  }

  // 마스터 시트 정리
  var masterSheet = ss.getSheetByName(IOM_SHEET);
  if (masterSheet && masterSheet.getLastRow() > 1) {
    var masterData = masterSheet.getDataRange().getValues();
    for (var j = masterData.length - 1; j >= 1; j--) {
      if (sids.indexOf(String(masterData[j][IOM_COL.SID])) !== -1) {
        masterSheet.deleteRow(j + 1);
      }
    }
  }

  prop.deleteProperty('IOM_CLEANUP');

  // 1회성 트리거 자신을 삭제
  var triggers = ScriptApp.getProjectTriggers();
  for (var t = 0; t < triggers.length; t++) {
    if (triggers[t].getHandlerFunction() === '_cleanupItsOnMe') {
      ScriptApp.deleteTrigger(triggers[t]);
    }
  }
}
