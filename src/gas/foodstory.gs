/**
 * 식단 이미지 OCR 모듈
 * - 카카오 채널 식단 이미지 URL → Google Drive OCR → 텍스트 추출 → 시트 기록
 * - doGet 액션: ocrMenu (imageUrl 파라미터)
 */

var MENU_SHEET_NAME = '당산푸드스토리';
var KAKAO_CHANNEL_URL = 'https://pf.kakao.com/_Gijes';

/**
 * 카카오 채널 페이지에서 og:image URL 추출
 * @return {string|null} 이미지 URL
 */
function _getKakaoMenuImageUrl() {
  var resp = UrlFetchApp.fetch(KAKAO_CHANNEL_URL, {
    headers: { 'User-Agent': BROWSER_UA },
    muteHttpExceptions: true
  });
  var html = resp.getContentText();
  var match = html.match(/og:image["'][^>]*content=["']([^"']+)["']/);
  if (!match) {
    match = html.match(/content=["']([^"']+)["'][^>]*og:image/);
  }
  if (!match) return null;
  // img_m → img_xl 로 고해상도 변환
  return match[1].replace(/img_m\./, 'img_xl.').replace(/^http:/, 'https:');
}

/**
 * 이미지 URL → Google Drive OCR → 텍스트 반환
 * Drive Advanced Service 필요 (appsscript.json에 "drive" 활성화)
 */
function _ocrImageToText(imageUrl) {
  var blob = UrlFetchApp.fetch(imageUrl, { muteHttpExceptions: true }).getBlob();
  blob.setName('menu_ocr_temp.jpg');

  // Drive API로 이미지를 Google Doc으로 변환 (OCR 자동 적용)
  var resource = { title: 'menu_ocr_temp' };
  var file = Drive.Files.insert(resource, blob, { ocr: true, ocrLanguage: 'ko', convert: true });

  // Doc에서 텍스트 추출
  var doc = DocumentApp.openById(file.id);
  var text = doc.getBody().getText();

  // 임시 파일 삭제
  Drive.Files.remove(file.id);

  return text.trim();
}

/**
 * OCR 텍스트에서 식단 정보 파싱
 * @return {{ date: string, day: string, meal: string, menus: string[], price: string }}
 */
function _parseMenuText(text) {
  var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

  var result = { date: '', day: '', meal: '', menus: [], price: '' };

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // "3월 9일 (월요일/중식)" 패턴
    var dateMatch = line.match(/(\d+월\s*\d+일)\s*\(([^\/]+)\/([^\)]+)\)/);
    if (dateMatch) {
      result.date = dateMatch[1].replace(/\s+/g, ' ');
      result.day = dateMatch[2];
      result.meal = dateMatch[3];
      continue;
    }

    // "식권:9000원" 패턴
    var priceMatch = line.match(/식권\s*[:：]\s*(\d[\d,]*원)/);
    if (priceMatch) {
      result.price = priceMatch[1];
      continue;
    }

    // "*상기 메뉴는..." 안내문 스킵
    if (line.indexOf('상기') >= 0 && line.indexOf('메뉴') >= 0) continue;
    if (line.indexOf('페이지') >= 0) continue;

    // 나머지는 메뉴 항목
    if (result.date) {
      result.menus.push(line);
    }
  }

  return result;
}

/**
 * 식단 시트에 기록
 * @param {Object} parsed - _parseMenuText 결과
 */
function _writeMenuToSheet(parsed) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MENU_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MENU_SHEET_NAME);
    sheet.getRange(1, 1, 1, 2).setValues([['날짜', '메뉴']]);
  }

  var menuText = parsed.menus.join('\n');
  var dateKey = parsed.date;

  // 같은 날짜 중복 체크 (A열, Date객체/문자열 모두 대응) → 이미 있으면 덮어쓰기
  var dateNormKey = _normDateKey(dateKey);
  if (sheet.getLastRow() > 1) {
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (_normDateKey(data[i][0]) === dateNormKey) {
        sheet.getRange(i + 1, 2).setValue(menuText);
        return { skipped: false, row: i + 1, updated: true };
      }
    }
  }

  sheet.appendRow([dateKey, menuText]);
  return { skipped: false, row: sheet.getLastRow() };
}

/**
 * [기능 19] 식단 OCR (doGet에서 호출)
 * ?action=ocrMenu&imageUrl=https://k.kakaocdn.net/...
 */
function handleOcrMenu(e) {
  var imageUrl = e.parameter.imageUrl || _getKakaoMenuImageUrl();
  if (!imageUrl) return createResponse({ error: 'NO_URL', message: '이미지 URL을 찾을 수 없어.' });

  try {
    var text = _ocrImageToText(imageUrl);
    if (!text) return createResponse({ status: 'fail', message: 'OCR 결과가 비어있어.' });

    var parsed = _parseMenuText(text);
    if (!parsed.date) return createResponse({ status: 'fail', message: '날짜를 파싱할 수 없어.', rawText: text });

    var result = _writeMenuToSheet(parsed);

    return createResponse({
      status: 'success',
      message: parsed.date + ' ' + parsed.meal + ' - ' + (result.skipped ? '이미 등록됨 (스킵)' : parsed.menus.length + '개 메뉴 등록'),
      parsed: parsed,
      rawText: text
    });
  } catch (err) {
    return createResponse({ status: 'fail', message: 'OCR 오류: ' + err.message });
  }
}

/**
 * 카카오 채널 → OCR → 시트 기록 (성공 여부 반환)
 * @return {boolean} 시트에 기록 성공 여부
 */
function _trySyncMenu() {
  var imageUrl = _getKakaoMenuImageUrl();
  if (!imageUrl) {
    Logger.log('[menu] 카카오 채널에서 이미지 URL을 찾을 수 없음');
    return false;
  }
  Logger.log('[menu] 이미지 URL: ' + imageUrl);

  var text = _ocrImageToText(imageUrl);
  if (!text) {
    Logger.log('[menu] OCR 결과가 비어있음');
    return false;
  }
  Logger.log('[menu] OCR 텍스트:\n' + text);

  var parsed = _parseMenuText(text);
  if (!parsed.date) {
    Logger.log('[menu] 날짜 파싱 실패. rawText: ' + text);
    return false;
  }
  Logger.log('[menu] 파싱: ' + parsed.date + ' ' + parsed.meal + ' - ' + parsed.menus.length + '개 메뉴');

  var result = _writeMenuToSheet(parsed);
  Logger.log('[menu] 시트 기록 완료: row ' + result.row + (result.updated ? ' (덮어쓰기)' : ' (신규)'));
  return true;
}

/**
 * 식단 자동 동기화 (트리거: 매일 오전 8~9시)
 * 카카오 채널 → 이미지 URL 추출 → OCR → 시트 기록
 */
function syncSKV1Menu() {
  var now = new Date();
  var dow = now.getDay();
  if (dow === 0 || dow === 6) { Logger.log('[menu] 주말 스킵'); return; }
  if (_isHolidayServer(now)) { Logger.log('[menu] 공휴일 스킵'); return; }
  _trySyncMenu();
}

/**
 * 시트 날짜 셀 → "M/D" 정규화 (Date 객체, "2026. 3. 9", "3월 9일" 모두 대응)
 */
function _normDateKey(cellVal) {
  if (cellVal instanceof Date) {
    return (cellVal.getMonth() + 1) + '/' + cellVal.getDate();
  }
  var s = String(cellVal).trim();
  // "2026. 3. 9" or "2026.3.9" 형식
  var dotMatch = s.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
  if (dotMatch) return parseInt(dotMatch[2], 10) + '/' + parseInt(dotMatch[3], 10);
  // "3월 9일" 형식
  var korMatch = s.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (korMatch) return parseInt(korMatch[1], 10) + '/' + parseInt(korMatch[2], 10);
  return s;
}

/**
 * 선호 키워드 매칭: 등록된 키워드 중 하나라도 식단에 포함되면 true
 * 키워드 미등록이면 항상 true (필터 없음)
 * @param {string} menuText - 오늘 식단 텍스트
 * @param {string} likeStr - 쉼표 구분 선호 키워드
 * @return {boolean} 알림 발송 여부
 */
function _shouldSendMenu(menuText, likeStr) {
  if (!likeStr) return true; // 키워드 미등록 → 항상 발송
  var menu = menuText.toLowerCase();
  var likes = likeStr.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  if (likes.length === 0) return true;
  return likes.some(function(k) { return menu.indexOf(k.toLowerCase()) >= 0; });
}

/**
 * 특정 사용자에게 오늘 식단 Flow 발송 (알람 수신 Y 전환 시 즉시 발송용)
 * @return {boolean} 발송 성공 여부
 */
function _sendMenuFlowToUser(knoxId) {
  var info = _getTodayMenu();
  if (!info) {
    Logger.log('[menu] 즉시발송 실패: 오늘 식단 없음');
    return false;
  }

  sendFlowMsg(knoxId, FLOW_MSG.todayMenu(info.todayStr, info.todayMenu));
  Logger.log('[menu] 즉시 발송 완료: ' + knoxId);
  return true;
}

/**
 * 오늘 식단 텍스트 조회 (없으면 null)
 * @return {{ todayStr: string, todayMenu: string }|null}
 */
function _getTodayMenu() {
  var now = new Date();
  var todayKey = (now.getMonth() + 1) + '/' + now.getDate();
  var todayStr = (now.getMonth() + 1) + '월 ' + now.getDate() + '일';

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var menuSheet = ss.getSheetByName(MENU_SHEET_NAME);
  if (!menuSheet || menuSheet.getLastRow() <= 1) return null;

  var menuData = menuSheet.getDataRange().getValues();
  for (var i = 1; i < menuData.length; i++) {
    if (_normDateKey(menuData[i][0]) === todayKey) {
      var menu = String(menuData[i][1] || '');
      if (menu) return { todayStr: todayStr, todayMenu: menu };
      break;
    }
  }
  return null;
}

