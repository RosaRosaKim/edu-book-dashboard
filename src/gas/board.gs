// [게시판] 컬럼 인덱스 (A~G)
const BOARD_COL = { ID: 0, CONTENT: 1, DATE: 2, LIKES: 3, DISLIKES: 4, REPLY: 5, PINNED: 6 };

/**
 * 게시판 목록 조회
 */
function handleBoardList(adminRow, e) {
  const token = String(adminRow[ADMIN_COL.KNOX_ID]);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const data = getCachedData(SHEET_NAME.BOARD);
  if (data.length < 2) return createResponse({ status: 'success', posts: [] });


  const posts = data.slice(1).map(row => {
    const likes = row[BOARD_COL.LIKES] ? String(row[BOARD_COL.LIKES]).split(',').filter(Boolean) : [];
    const dislikes = row[BOARD_COL.DISLIKES] ? String(row[BOARD_COL.DISLIKES]).split(',').filter(Boolean) : [];

    let myReaction = null;
    const likeSet = new Set(likes);
    const dislikeSet = new Set(dislikes);
    if (likeSet.has(token)) myReaction = 'like';
    else if (dislikeSet.has(token)) myReaction = 'dislike';

    return {
      id: String(row[BOARD_COL.ID]),
      content: row[BOARD_COL.CONTENT],
      date: row[BOARD_COL.DATE] ? new Date(row[BOARD_COL.DATE]).toISOString() : '',
      likes: likes.length,
      dislikes: dislikes.length,
      myReaction: myReaction,
      reply: row[BOARD_COL.REPLY] ? String(row[BOARD_COL.REPLY]) : null,
      pinned: String(row[BOARD_COL.PINNED] || '').trim().toUpperCase() === 'Y'
    };
  });

  posts.sort((a, b) => Number(b.id) - Number(a.id));
  return createResponse({ status: 'success', posts: posts });
}

/**
 * 게시판 글 작성
 */
function handleBoardWrite(adminRow, e) {
  const content = _sanitizeBoardContent(e.parameter.content);
  if (!content) return createResponse({ status: 'error', message: '내용을 입력해줘. (1~200자)' });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME.BOARD);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME.BOARD);
    sheet.appendRow(['ID', '내용', '날짜', '좋아요', '싫어요', '관리자답변']);
  }
  sheet.appendRow([Date.now(), content, new Date().toISOString(), '', '', '']);
  return createResponse({ status: 'success' });
}

/**
 * 게시판 좋아요/싫어요 토글
 */
function handleBoardReact(adminRow, e) {
  const token = String(adminRow[ADMIN_COL.KNOX_ID]);
  const postId = e.parameter.postId;
  const type = e.parameter.type;
  if (!postId || !type || (type !== 'like' && type !== 'dislike')) {
    return createResponse({ status: 'error', message: '잘못된 요청이야.' });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const data = getCachedData(SHEET_NAME.BOARD);
  if (data.length < 2) return createResponse({ status: 'error', message: '게시물을 찾을 수 없어.' });

  const rowIndex = data.findIndex((row, i) => i > 0 && String(row[BOARD_COL.ID]) === String(postId));
  if (rowIndex === -1) return createResponse({ status: 'error', message: '게시물을 찾을 수 없어.' });

  const row = data[rowIndex];
  let likes = row[BOARD_COL.LIKES] ? String(row[BOARD_COL.LIKES]).split(',').filter(Boolean) : [];
  let dislikes = row[BOARD_COL.DISLIKES] ? String(row[BOARD_COL.DISLIKES]).split(',').filter(Boolean) : [];

  if (type === 'like') {
    if (likes.includes(token)) {
      likes = likes.filter(u => u !== token);
    } else {
      dislikes = dislikes.filter(u => u !== token);
      likes.push(token);
    }
  } else {
    if (dislikes.includes(token)) {
      dislikes = dislikes.filter(u => u !== token);
    } else {
      likes = likes.filter(u => u !== token);
      dislikes.push(token);
    }
  }

  const sheet = ss.getSheetByName(SHEET_NAME.BOARD);
  sheet.getRange(rowIndex + 1, BOARD_COL.LIKES + 1).setValue(likes.join(','));
  sheet.getRange(rowIndex + 1, BOARD_COL.DISLIKES + 1).setValue(dislikes.join(','));
  invalidateCache(SHEET_NAME.BOARD);

  let myReaction = null;
  if (likes.includes(token)) myReaction = 'like';
  else if (dislikes.includes(token)) myReaction = 'dislike';

  return createResponse({ status: 'success', likes: likes.length, dislikes: dislikes.length, myReaction: myReaction });
}

/**
 * 게시판 관리자 답변 작성/수정
 */
function handleBoardReply(adminRow, e, managerSet) {
  const currentKnoxId = adminRow[ADMIN_COL.KNOX_ID];
  if (!managerSet) {
    managerSet = new Set(getCachedData(SHEET_NAME.MANAGER).slice(1).map(r => String(r[0]).trim().toLowerCase()));
  }
  const isAdmin = managerSet.has(String(currentKnoxId).trim().toLowerCase());
  if (!isAdmin) return createResponse({ status: 'error', message: '관리자만 답변할 수 있어.' });

  const postId = e.parameter.postId;
  const reply = _sanitizeBoardContent(e.parameter.reply);
  if (!postId) return createResponse({ status: 'error', message: '잘못된 요청이야.' });
  if (!reply) return createResponse({ status: 'error', message: '답변을 입력해줘. (1~200자)' });

  const data = getCachedData(SHEET_NAME.BOARD);
  if (data.length < 2) return createResponse({ status: 'error', message: '게시물을 찾을 수 없어.' });

  const rowIndex = data.findIndex((row, i) => i > 0 && String(row[BOARD_COL.ID]) === String(postId));
  if (rowIndex === -1) return createResponse({ status: 'error', message: '게시물을 찾을 수 없어.' });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.getSheetByName(SHEET_NAME.BOARD).getRange(rowIndex + 1, BOARD_COL.REPLY + 1).setValue(reply);
  invalidateCache(SHEET_NAME.BOARD);
  return createResponse({ status: 'success', reply: reply });
}

/**
 * 게시판 관리자 답변 삭제
 */
function handleBoardReplyDelete(adminRow, e, managerSet) {
  const currentKnoxId = adminRow[ADMIN_COL.KNOX_ID];
  if (!managerSet) {
    managerSet = new Set(getCachedData(SHEET_NAME.MANAGER).slice(1).map(r => String(r[0]).trim().toLowerCase()));
  }
  const isAdmin = managerSet.has(String(currentKnoxId).trim().toLowerCase());
  if (!isAdmin) return createResponse({ status: 'error', message: '관리자만 삭제할 수 있어.' });

  const postId = e.parameter.postId;
  if (!postId) return createResponse({ status: 'error', message: '잘못된 요청이야.' });

  const data = getCachedData(SHEET_NAME.BOARD);
  if (data.length < 2) return createResponse({ status: 'error', message: '게시물을 찾을 수 없어.' });

  const rowIndex = data.findIndex((row, i) => i > 0 && String(row[BOARD_COL.ID]) === String(postId));
  if (rowIndex === -1) return createResponse({ status: 'error', message: '게시물을 찾을 수 없어.' });

  SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME.BOARD).getRange(rowIndex + 1, BOARD_COL.REPLY + 1).setValue('');
  invalidateCache(SHEET_NAME.BOARD);
  return createResponse({ status: 'success' });
}

/**
 * 게시판 상단고정 토글 (관리자 전용)
 */
function handleBoardPin(adminRow, e, managerSet) {
  const currentKnoxId = adminRow[ADMIN_COL.KNOX_ID];
  if (!managerSet) {
    managerSet = new Set(getCachedData(SHEET_NAME.MANAGER).slice(1).map(r => String(r[0]).trim().toLowerCase()));
  }
  const isAdmin = managerSet.has(String(currentKnoxId).trim().toLowerCase());
  if (!isAdmin) return createResponse({ status: 'error', message: '관리자만 고정할 수 있어.' });

  const postId = e.parameter.postId;
  const pin = e.parameter.pin; // 'Y' or 'N'
  if (!postId || (pin !== 'Y' && pin !== 'N')) return createResponse({ status: 'error', message: '잘못된 요청이야.' });

  const data = getCachedData(SHEET_NAME.BOARD);
  if (data.length < 2) return createResponse({ status: 'error', message: '게시물을 찾을 수 없어.' });

  const rowIndex = data.findIndex((row, i) => i > 0 && String(row[BOARD_COL.ID]) === String(postId));
  if (rowIndex === -1) return createResponse({ status: 'error', message: '게시물을 찾을 수 없어.' });

  SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME.BOARD).getRange(rowIndex + 1, BOARD_COL.PINNED + 1).setValue(pin === 'Y' ? 'Y' : '');
  invalidateCache(SHEET_NAME.BOARD);
  return createResponse({ status: 'success', pinned: pin === 'Y' });
}

/**
 * 게시판 콘텐츠 검증 및 sanitize
 */
function _sanitizeBoardContent(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  text = text.replace(/[<>"']/g, '');
  text = text.replace(/^[=+\-@]/, '');
  text = text.trim();
  if (text.length < 1 || text.length > 200) return null;
  return text;
}
