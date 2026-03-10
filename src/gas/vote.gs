/**
 * 투표 모듈
 * 시트: 투표(세션 마스터), 투표응답(투표자별 응답), 투표템플릿
 */

/* ═══════════════ 상수 ═══════════════ */
var VOTE_SHEET = '투표';
var VOTE_RESP  = '투표응답';
var VOTE_TPL   = '투표템플릿';

var VOTE_COL = { SID: 0, CREATOR_KNOX: 1, CREATOR_NAME: 2, TITLE: 3, ITEMS: 4, DEADLINE: 5, STATUS: 6, CREATED: 7, TOTAL: 8, OPTIONS: 9 };
var VOTE_R_COL = { SID: 0, KNOX: 1, NAME: 2, CHOICES: 3, VOTED_AT: 4 };
var VOTE_TPL_COL = { KNOX: 0, TITLE: 1, ITEMS: 2, OPTIONS: 3, UPDATED: 4 };

/* ═══════════════ 세션 생성 ═══════════════ */

function handleCreateVote(adminRow, e) {
  var title   = String(e.parameter.title || '').trim();
  var items   = String(e.parameter.items || '[]');
  var minutes = parseInt(e.parameter.minutes) || 60;
  var membersJson = String(e.parameter.members || '[]');
  var options = String(e.parameter.options || '{}');

  if (!title) return createResponse({ error: '제목을 입력해줘.' });

  var itemsArr;
  try { itemsArr = JSON.parse(items); } catch (_) { return createResponse({ error: '항목 정보 오류' }); }
  if (itemsArr.length < 2) return createResponse({ error: '항목을 2개 이상 입력해줘.' });

  var members;
  try { members = JSON.parse(membersJson); } catch (_) { return createResponse({ error: '멤버 정보 오류' }); }
  if (!members.length) return createResponse({ error: '멤버를 선택해줘.' });

  var creatorKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim();
  var creatorName = String(adminRow[ADMIN_COL.NAME]).trim();

  var now = new Date();
  var deadline = new Date(now.getTime() + minutes * 60000);
  var sid = Utilities.getUuid();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 세션 마스터 기록
  var masterSheet = ss.getSheetByName(VOTE_SHEET);
  if (!masterSheet) {
    masterSheet = ss.insertSheet(VOTE_SHEET);
    masterSheet.appendRow(['세션ID','생성자Knox','생성자이름','제목','항목JSON','마감시간','상태','생성시각','총인원','옵션JSON']);
  }

  // 생성자 포함 전체 멤버
  var allMembers = [{ knoxId: creatorKnox, name: creatorName }];
  for (var i = 0; i < members.length; i++) {
    if (String(members[i].knoxId).trim().toLowerCase() !== creatorKnox.toLowerCase()) {
      allMembers.push(members[i]);
    }
  }

  masterSheet.appendRow([sid, creatorKnox, creatorName, title, items, deadline, 'open', now, allMembers.length, options]);

  // 응답 시트에 전원 행 삽입
  var respSheet = ss.getSheetByName(VOTE_RESP);
  if (!respSheet) {
    respSheet = ss.insertSheet(VOTE_RESP);
    respSheet.appendRow(['세션ID','투표자Knox','투표자이름','선택항목JSON','투표시각']);
  }
  var respRows = [];
  for (var j = 0; j < allMembers.length; j++) {
    respRows.push([sid, allMembers[j].knoxId, allMembers[j].name, '', '']);
  }
  if (respRows.length) respSheet.getRange(respSheet.getLastRow() + 1, 1, respRows.length, 5).setValues(respRows);

  // Flow 발송 (본인 포함)
  var deadlineStr = Utilities.formatDate(deadline, 'Asia/Seoul', 'HH:mm');
  var failedUsers = [];
  for (var k = 0; k < allMembers.length; k++) {
    try {
      var msg = FLOW_MSG.voteInvite(creatorName, title, deadlineStr, sid);
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

function handleGetVote(adminRow, e) {
  var sid = String(e.parameter.sessionId || '').trim();
  if (!sid) return createResponse({ error: '세션ID가 없어.' });

  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var masterSheet = ss.getSheetByName(VOTE_SHEET);
  if (!masterSheet) return createResponse({ error: '세션을 찾을 수 없어.' });
  var masterData = masterSheet.getDataRange().getValues();
  var session = null;
  for (var i = 1; i < masterData.length; i++) {
    if (String(masterData[i][VOTE_COL.SID]) === sid) {
      var opts = {};
      try { opts = JSON.parse(String(masterData[i][VOTE_COL.OPTIONS] || '{}')); } catch (_) {}
      session = {
        sessionId: sid,
        creatorKnox: String(masterData[i][VOTE_COL.CREATOR_KNOX]),
        creatorName: String(masterData[i][VOTE_COL.CREATOR_NAME]),
        title: String(masterData[i][VOTE_COL.TITLE]),
        items: String(masterData[i][VOTE_COL.ITEMS]),
        deadline: new Date(masterData[i][VOTE_COL.DEADLINE]).toISOString(),
        status: String(masterData[i][VOTE_COL.STATUS]),
        total: Number(masterData[i][VOTE_COL.TOTAL]),
        options: opts
      };
      break;
    }
  }
  if (!session) return createResponse({ error: '세션을 찾을 수 없어.' });

  // 응답 조회
  var respSheet = ss.getSheetByName(VOTE_RESP);
  var responses = [];
  var myResponse = null;
  var isMember = false;
  var votedCount = 0;
  if (respSheet) {
    var respData = respSheet.getDataRange().getValues();
    for (var j = 1; j < respData.length; j++) {
      if (String(respData[j][VOTE_R_COL.SID]) !== sid) continue;
      var choicesStr = String(respData[j][VOTE_R_COL.CHOICES] || '');
      var hasVoted = !!choicesStr;
      var resp = {
        knoxId: String(respData[j][VOTE_R_COL.KNOX]),
        name: String(respData[j][VOTE_R_COL.NAME]),
        choices: choicesStr,
        voted: hasVoted
      };
      responses.push(resp);
      if (hasVoted) votedCount++;
      if (resp.knoxId.toLowerCase() === myKnox) {
        myResponse = resp;
        isMember = true;
      }
    }
  }

  if (!isMember) return createResponse({ error: '이 투표에 포함되지 않았어.' });

  // 집계 (비익명이거나 마감됐으면 상세 포함)
  var isAnon = !!session.options.anon;
  var isClosed = session.status === 'closed';
  var tally = _tallyVotes(responses, isAnon, isClosed);

  return createResponse({
    status: 'success',
    session: session,
    responses: (isAnon && !isClosed) ? [] : responses,
    myResponse: myResponse,
    isCreator: session.creatorKnox.toLowerCase() === myKnox,
    votedCount: votedCount,
    tally: tally
  });
}

/* ═══════════════ 투표 집계 (내부) ═══════════════ */

function _tallyVotes(responses, isAnon, isClosed) {
  // 익명 + 진행중이면 집계 안함
  if (isAnon && !isClosed) return null;

  var tally = {}; // { item: { count, names[] } }
  for (var i = 0; i < responses.length; i++) {
    if (!responses[i].choices) continue;
    var choices = [];
    try { choices = JSON.parse(responses[i].choices); } catch (_) {}
    for (var c = 0; c < choices.length; c++) {
      var item = choices[c];
      if (!tally[item]) tally[item] = { count: 0, names: [] };
      tally[item].count++;
      if (!isAnon) tally[item].names.push(responses[i].name);
    }
  }
  return tally;
}

/* ═══════════════ 투표 확정 ═══════════════ */

function handleSubmitVote(adminRow, e) {
  var sid = String(e.parameter.sessionId || '').trim();
  var choices = String(e.parameter.choices || '[]');

  if (!sid) return createResponse({ error: '세션ID가 없어.' });

  var choicesArr;
  try { choicesArr = JSON.parse(choices); } catch (_) { return createResponse({ error: '선택 정보 오류' }); }
  if (!choicesArr.length) return createResponse({ error: '항목을 선택해줘.' });

  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 세션 확인
  var masterSheet = ss.getSheetByName(VOTE_SHEET);
  if (!masterSheet) return createResponse({ error: '세션을 찾을 수 없어.' });
  var masterData = masterSheet.getDataRange().getValues();
  var sessionIdx = -1;
  var sessionRow = null;
  for (var i = 1; i < masterData.length; i++) {
    if (String(masterData[i][VOTE_COL.SID]) === sid) { sessionIdx = i; sessionRow = masterData[i]; break; }
  }
  if (!sessionRow) return createResponse({ error: '세션을 찾을 수 없어.' });
  if (String(sessionRow[VOTE_COL.STATUS]) === 'closed') return createResponse({ error: '이미 마감된 투표야.' });

  // 응답 업데이트
  var respSheet = ss.getSheetByName(VOTE_RESP);
  if (!respSheet) return createResponse({ error: '응답 시트 오류' });
  var respData = respSheet.getDataRange().getValues();
  var updated = false;
  var allVoted = true;

  for (var j = 1; j < respData.length; j++) {
    if (String(respData[j][VOTE_R_COL.SID]) !== sid) continue;
    if (String(respData[j][VOTE_R_COL.KNOX]).trim().toLowerCase() === myKnox) {
      // 이미 투표했으면 거부
      if (String(respData[j][VOTE_R_COL.CHOICES]).trim()) {
        return createResponse({ error: '이미 투표했어. 변경할 수 없어.' });
      }
      var rowNum = j + 1;
      respSheet.getRange(rowNum, VOTE_R_COL.CHOICES + 1).setValue(choices);
      respSheet.getRange(rowNum, VOTE_R_COL.VOTED_AT + 1).setValue(new Date());
      updated = true;
    } else {
      if (!String(respData[j][VOTE_R_COL.CHOICES]).trim()) allVoted = false;
    }
  }

  if (!updated) return createResponse({ error: '이 투표에 포함되지 않았어.' });

  // 전원 투표 시 즉시 마감
  if (allVoted) {
    _closeVoteSession(ss, masterSheet, respSheet, sid, sessionIdx);
  }

  return createResponse({ status: 'success', allVoted: allVoted });
}

/* ═══════════════ 항목 추가 + 자동 투표 ═══════════════ */

function handleAddVoteItem(adminRow, e) {
  var sid = String(e.parameter.sessionId || '').trim();
  var newItem = String(e.parameter.item || '').trim();

  if (!sid || !newItem) return createResponse({ error: '세션ID 또는 항목이 없어.' });

  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var masterSheet = ss.getSheetByName(VOTE_SHEET);
  if (!masterSheet) return createResponse({ error: '세션을 찾을 수 없어.' });
  var masterData = masterSheet.getDataRange().getValues();
  var sessionIdx = -1;
  var sessionRow = null;
  for (var i = 1; i < masterData.length; i++) {
    if (String(masterData[i][VOTE_COL.SID]) === sid) { sessionIdx = i; sessionRow = masterData[i]; break; }
  }
  if (!sessionRow) return createResponse({ error: '세션을 찾을 수 없어.' });
  if (String(sessionRow[VOTE_COL.STATUS]) === 'closed') return createResponse({ error: '이미 마감된 투표야.' });

  // 항목 추가 허용 확인
  var opts = {};
  try { opts = JSON.parse(String(sessionRow[VOTE_COL.OPTIONS] || '{}')); } catch (_) {}
  if (!opts.addable) return createResponse({ error: '이 투표는 항목 추가가 허용되지 않았어.' });

  // 기존 항목에 중복 체크
  var existingItems = [];
  try { existingItems = JSON.parse(String(sessionRow[VOTE_COL.ITEMS])); } catch (_) {}
  if (existingItems.indexOf(newItem) !== -1) return createResponse({ error: '이미 있는 항목이야.' });

  // 마스터 시트에 항목 추가
  existingItems.push(newItem);
  masterSheet.getRange(sessionIdx + 1, VOTE_COL.ITEMS + 1).setValue(JSON.stringify(existingItems));

  // 자동 투표: 응답 시트에서 내 행 업데이트
  var respSheet = ss.getSheetByName(VOTE_RESP);
  var respData = respSheet.getDataRange().getValues();
  var allVoted = true;

  for (var j = 1; j < respData.length; j++) {
    if (String(respData[j][VOTE_R_COL.SID]) !== sid) continue;
    if (String(respData[j][VOTE_R_COL.KNOX]).trim().toLowerCase() === myKnox) {
      var existingChoices = [];
      try { existingChoices = JSON.parse(String(respData[j][VOTE_R_COL.CHOICES]) || '[]'); } catch (_) {}

      var isMulti = !!opts.multi;
      if (isMulti) {
        existingChoices.push(newItem);
      } else {
        existingChoices = [newItem];
      }
      var rowNum = j + 1;
      respSheet.getRange(rowNum, VOTE_R_COL.CHOICES + 1).setValue(JSON.stringify(existingChoices));
      respSheet.getRange(rowNum, VOTE_R_COL.VOTED_AT + 1).setValue(new Date());
    } else {
      if (!String(respData[j][VOTE_R_COL.CHOICES]).trim()) allVoted = false;
    }
  }

  // 전원 투표 시 즉시 마감
  if (allVoted) {
    _closeVoteSession(ss, masterSheet, respSheet, sid, sessionIdx);
  }

  return createResponse({ status: 'success', items: existingItems, allVoted: allVoted });
}

/* ═══════════════ 마감 처리 (내부) ═══════════════ */

function _closeVoteSession(ss, masterSheet, respSheet, sid, masterIdx) {
  masterSheet.getRange(masterIdx + 1, VOTE_COL.STATUS + 1).setValue('closed');

  var masterData = masterSheet.getDataRange().getValues();
  var title = String(masterData[masterIdx][VOTE_COL.TITLE]);
  var opts = {};
  try { opts = JSON.parse(String(masterData[masterIdx][VOTE_COL.OPTIONS] || '{}')); } catch (_) {}
  var isAnon = !!opts.anon;

  // 응답 수집
  var respData = respSheet.getDataRange().getValues();
  var responses = [];
  var allKnox = [];
  for (var i = 1; i < respData.length; i++) {
    if (String(respData[i][VOTE_R_COL.SID]) !== sid) continue;
    responses.push({
      knoxId: String(respData[i][VOTE_R_COL.KNOX]),
      name: String(respData[i][VOTE_R_COL.NAME]),
      choices: String(respData[i][VOTE_R_COL.CHOICES])
    });
    allKnox.push(String(respData[i][VOTE_R_COL.KNOX]).trim());
  }

  // 집계
  var tally = _tallyVotes(responses, isAnon, true);
  var items = [];
  try { items = JSON.parse(String(masterData[masterIdx][VOTE_COL.ITEMS])); } catch (_) {}

  // 결과 Flow 전원 발송
  var msg = FLOW_MSG.voteResult(title, items, tally, responses.length, isAnon);
  for (var k = 0; k < allKnox.length; k++) {
    try { sendFlowMsg(allKnox[k], msg); } catch (_) {}
  }

  // 1시간 후 데이터 삭제
  ScriptApp.newTrigger('_cleanupVote')
    .timeBased().after(60 * 60 * 1000).create();
  var pending = PropertiesService.getScriptProperties().getProperty('VOTE_CLEANUP') || '';
  var list = pending ? pending.split(',') : [];
  list.push(sid);
  PropertiesService.getScriptProperties().setProperty('VOTE_CLEANUP', list.join(','));
}

/* ═══════════════ 템플릿 ═══════════════ */

function _getOrCreateVoteTplSheet(ss) {
  var sheet = ss.getSheetByName(VOTE_TPL);
  if (!sheet) {
    sheet = ss.insertSheet(VOTE_TPL);
    sheet.appendRow(['knoxId','제목','항목JSON','옵션JSON','수정시각']);
  }
  return sheet;
}

function handleGetVoteTemplates(adminRow, e) {
  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(VOTE_TPL);
  if (!sheet || sheet.getLastRow() < 2) return createResponse({ ok: true, templates: [] });

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
    var knox = String(data[i][VOTE_TPL_COL.KNOX]).trim().toLowerCase();
    templates.push({
      idx: i,
      title: String(data[i][VOTE_TPL_COL.TITLE]),
      items: String(data[i][VOTE_TPL_COL.ITEMS]),
      options: String(data[i][VOTE_TPL_COL.OPTIONS]),
      updated: data[i][VOTE_TPL_COL.UPDATED] ? Utilities.formatDate(new Date(data[i][VOTE_TPL_COL.UPDATED]), 'Asia/Seoul', 'M/d HH:mm') : '',
      isMine: knox === myKnox,
      ownerName: nameMap[knox] || ''
    });
  }
  return createResponse({ ok: true, templates: templates });
}

function handleSaveVoteTemplate(adminRow, e) {
  var title = String(e.parameter.title || '').trim();
  var items = String(e.parameter.items || '[]');
  var options = String(e.parameter.options || '{}');
  if (!title) return createResponse({ error: '제목을 입력해줘.' });

  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _getOrCreateVoteTplSheet(ss);
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][VOTE_TPL_COL.KNOX]).trim().toLowerCase() === myKnox &&
        String(data[i][VOTE_TPL_COL.TITLE]).trim() === title) {
      sheet.getRange(i + 1, VOTE_TPL_COL.ITEMS + 1).setValue(items);
      sheet.getRange(i + 1, VOTE_TPL_COL.OPTIONS + 1).setValue(options);
      sheet.getRange(i + 1, VOTE_TPL_COL.UPDATED + 1).setValue(new Date());
      return createResponse({ ok: true });
    }
  }
  sheet.appendRow([myKnox, title, items, options, new Date()]);
  return createResponse({ ok: true });
}

function handleDeleteVoteTemplate(adminRow, e) {
  var title = String(e.parameter.title || '').trim();
  if (!title) return createResponse({ error: '제목이 없어.' });

  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(VOTE_TPL);
  if (!sheet || sheet.getLastRow() < 2) return createResponse({ error: '템플릿이 없어.' });

  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][VOTE_TPL_COL.KNOX]).trim().toLowerCase() === myKnox &&
        String(data[i][VOTE_TPL_COL.TITLE]).trim() === title) {
      sheet.deleteRow(i + 1);
      return createResponse({ ok: true });
    }
  }
  return createResponse({ error: '템플릿을 찾을 수 없어.' });
}

/* ═══════════════ 수동 마감 ═══════════════ */

function handleCloseVote(adminRow, e) {
  var sid = String(e.parameter.sessionId || '').trim();
  if (!sid) return createResponse({ error: '세션ID가 없어.' });

  var myKnox = String(adminRow[ADMIN_COL.KNOX_ID]).trim().toLowerCase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var masterSheet = ss.getSheetByName(VOTE_SHEET);
  if (!masterSheet) return createResponse({ error: '세션을 찾을 수 없어.' });
  var masterData = masterSheet.getDataRange().getValues();
  var sessionIdx = -1;
  for (var i = 1; i < masterData.length; i++) {
    if (String(masterData[i][VOTE_COL.SID]) === sid) { sessionIdx = i; break; }
  }
  if (sessionIdx === -1) return createResponse({ error: '세션을 찾을 수 없어.' });
  if (String(masterData[sessionIdx][VOTE_COL.STATUS]) === 'closed') return createResponse({ error: '이미 마감된 투표야.' });
  if (String(masterData[sessionIdx][VOTE_COL.CREATOR_KNOX]).trim().toLowerCase() !== myKnox) {
    return createResponse({ error: '생성자만 마감할 수 있어.' });
  }

  var respSheet = ss.getSheetByName(VOTE_RESP);
  if (!respSheet) return createResponse({ error: '응답 시트 오류' });

  _closeVoteSession(ss, masterSheet, respSheet, sid, sessionIdx);
  return createResponse({ status: 'success' });
}

/* ═══════════════ 5분 폴링 트리거 ═══════════════ */

function pollVoteClose() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var masterSheet = ss.getSheetByName(VOTE_SHEET);
  if (!masterSheet || masterSheet.getLastRow() < 2) return;

  var now = new Date();
  var data = masterSheet.getDataRange().getValues();
  var respSheet = ss.getSheetByName(VOTE_RESP);
  if (!respSheet) return;
  var respData = respSheet.getDataRange().getValues();

  var props = PropertiesService.getScriptProperties();
  var reminded = (props.getProperty('VOTE_REMINDED') || '').split(',').filter(Boolean);
  var remindedSet = {};
  reminded.forEach(function(s) { remindedSet[s] = true; });

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][VOTE_COL.STATUS]) !== 'open') continue;
    var deadline = new Date(data[i][VOTE_COL.DEADLINE]);
    var sid = String(data[i][VOTE_COL.SID]);

    if (now >= deadline) {
      _closeVoteSession(ss, masterSheet, respSheet, sid, i);
      continue;
    }

    // 마감 5분 전 리마인드 (미투표자에게)
    var minLeft = (deadline.getTime() - now.getTime()) / 60000;
    if (minLeft <= 5 && !remindedSet[sid]) {
      var title = String(data[i][VOTE_COL.TITLE]);
      var dlStr = Utilities.formatDate(deadline, 'Asia/Seoul', 'HH:mm');
      for (var j = 1; j < respData.length; j++) {
        if (String(respData[j][VOTE_R_COL.SID]) !== sid) continue;
        if (String(respData[j][VOTE_R_COL.CHOICES]).trim()) continue;
        try {
          var msg = FLOW_MSG.voteReminder(title, dlStr, sid);
          sendFlowMsg(String(respData[j][VOTE_R_COL.KNOX]).trim(), msg);
        } catch (_) {}
      }
      reminded.push(sid);
      remindedSet[sid] = true;
    }
  }

  props.setProperty('VOTE_REMINDED', reminded.join(','));
}

/* ═══════════════ 데이터 정리 ═══════════════ */

function _cleanupVote() {
  var prop = PropertiesService.getScriptProperties();
  var pending = prop.getProperty('VOTE_CLEANUP') || '';
  if (!pending) return;

  var sids = pending.split(',').filter(Boolean);
  if (!sids.length) return;

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var respSheet = ss.getSheetByName(VOTE_RESP);
  if (respSheet && respSheet.getLastRow() > 1) {
    var respData = respSheet.getDataRange().getValues();
    var sidSet = {};
    for (var s = 0; s < sids.length; s++) sidSet[sids[s]] = true;
    for (var i = respData.length - 1; i >= 1; i--) {
      if (sidSet[String(respData[i][VOTE_R_COL.SID])]) respSheet.deleteRow(i + 1);
    }
  }

  var masterSheet = ss.getSheetByName(VOTE_SHEET);
  if (masterSheet && masterSheet.getLastRow() > 1) {
    var masterData = masterSheet.getDataRange().getValues();
    for (var j = masterData.length - 1; j >= 1; j--) {
      if (sids.indexOf(String(masterData[j][VOTE_COL.SID])) !== -1) masterSheet.deleteRow(j + 1);
    }
  }

  prop.deleteProperty('VOTE_CLEANUP');

  var triggers = ScriptApp.getProjectTriggers();
  for (var t = 0; t < triggers.length; t++) {
    if (triggers[t].getHandlerFunction() === '_cleanupVote') {
      ScriptApp.deleteTrigger(triggers[t]);
    }
  }
}
