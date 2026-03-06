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
  var resource = { title: 'menu_ocr_temp', mimeType: 'application/vnd.google-apps.document' };
  var file = Drive.Files.insert(resource, blob, { ocr: true, ocrLanguage: 'ko' });

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

  // 같은 날짜 중복 체크 (A열)
  if (sheet.getLastRow() > 1) {
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === dateKey) {
        sheet.getRange(i + 1, 2).setValue(menuText);
        return { updated: true, row: i + 1 };
      }
    }
  }

  sheet.appendRow([dateKey, menuText]);
  return { updated: false, row: sheet.getLastRow() };
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
      message: parsed.date + ' ' + parsed.meal + ' - ' + parsed.menus.length + '개 메뉴 ' + (result.updated ? '업데이트' : '등록'),
      parsed: parsed,
      rawText: text
    });
  } catch (err) {
    return createResponse({ status: 'fail', message: 'OCR 오류: ' + err.message });
  }
}

/**
 * 식단 자동 동기화 (트리거 또는 GAS 에디터에서 실행)
 * 카카오 채널 → 이미지 URL 추출 → OCR → 시트 기록
 */
function syncMenu() {
  var imageUrl = _getKakaoMenuImageUrl();
  if (!imageUrl) {
    Logger.log('[menu] 카카오 채널에서 이미지 URL을 찾을 수 없음');
    return;
  }
  Logger.log('[menu] 이미지 URL: ' + imageUrl);

  var text = _ocrImageToText(imageUrl);
  if (!text) {
    Logger.log('[menu] OCR 결과가 비어있음');
    return;
  }
  Logger.log('[menu] OCR 텍스트:\n' + text);

  var parsed = _parseMenuText(text);
  if (!parsed.date) {
    Logger.log('[menu] 날짜 파싱 실패. rawText: ' + text);
    return;
  }
  Logger.log('[menu] 파싱: ' + parsed.date + ' ' + parsed.meal + ' - ' + parsed.menus.length + '개 메뉴');

  var result = _writeMenuToSheet(parsed);
  Logger.log('[menu] 시트 기록 완료: row ' + result.row + (result.updated ? ' (업데이트)' : ' (신규)'));
}
