/**
 * 밥카 유틸리티 (card-babka.gs에서 분리)
 * - 날짜/공휴일 판별
 * - 영업일 기반 예산 계산
 * - 금액 포맷 / 날짜 파싱
 */

/* ═══════════════ 공휴일 캐시 ═══════════════ */
var _holidayCache = {}; // 스크립트 실행 단위 캐시 (연도별)

function _loadHolidays(year) {
  var y = String(year);
  if (_holidayCache[y]) return _holidayCache[y];
  try {
    var resp = UrlFetchApp.fetch('https://holidays.hyunbin.page/' + y + '.json', { muteHttpExceptions: true });
    _holidayCache[y] = (resp.getResponseCode() === 200) ? JSON.parse(resp.getContentText()) : {};
  } catch (e) { _holidayCache[y] = {}; }
  return _holidayCache[y];
}

/** 복수 연도의 공휴일을 flat Object로 병합 */
function _buildHolidaySet(years) {
  var set = {};
  var seen = {};
  for (var i = 0; i < years.length; i++) {
    var y = String(years[i]);
    if (seen[y]) continue;
    seen[y] = true;
    var h = _loadHolidays(Number(y));
    for (var k in h) set[k] = true;
    set[y + '-05-01'] = true; // 근로자의 날
  }
  return set;
}

/** 공휴일 목록에서 해당 날짜 체크 (근로자의 날 포함) */
function _isHolidayFromList(date, holidays) {
  var mm = ('0' + (date.getMonth() + 1)).slice(-2);
  var dd = ('0' + date.getDate()).slice(-2);
  var dateStr = date.getFullYear() + '-' + mm + '-' + dd;
  if (mm === '05' && dd === '01') return true;
  return dateStr in holidays;
}

/** 공휴일 여부 체크 (holidays API + 근로자의 날) */
function _isHolidayServer(date) {
  var holidays = _loadHolidays(date.getFullYear());
  return _isHolidayFromList(date, holidays);
}

/** 두 Date가 같은 날짜인지 비교 */
function _sameDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/* ═══════════════ 영업일 판별 ═══════════════ */

/** 오늘이 해당월 1일부터 첫 번째 영업일인지 판별 */
function _isFirstBizDayOfMonth(date) {
  var y = date.getFullYear(), m = date.getMonth();
  var holidays = _loadHolidays(y);
  for (var d = 1; d <= 10; d++) {
    var check = new Date(y, m, d);
    var dow = check.getDay();
    if (dow === 0 || dow === 6) continue;
    if (_isHolidayFromList(check, holidays)) continue;
    return _sameDate(check, date);
  }
  return false;
}

/** 오늘이 해당월 14일+1영업일인지 판별 */
function _isFirstBizDayFrom14(date) {
  var y = date.getFullYear(), m = date.getMonth();
  var holidays = _loadHolidays(y);
  for (var d = 14; d <= 31; d++) {
    var check = new Date(y, m, d);
    if (check.getMonth() !== m) break;
    var dow = check.getDay();
    if (dow === 0 || dow === 6) continue;
    if (_isHolidayFromList(check, holidays)) continue;
    return _sameDate(check, date);
  }
  return false;
}

/** 오늘이 해당월 14일부터 세어 3번째 영업일인지 판별 */
function _isCardAlarmDay(date) {
  var y = date.getFullYear(), m = date.getMonth();
  var holidays = _loadHolidays(y);
  var bizDayCount = 0;
  for (var d = 14; d <= 31; d++) {
    var check = new Date(y, m, d);
    if (check.getMonth() !== m) break;
    var dow = check.getDay();
    if (dow === 0 || dow === 6) continue;
    if (_isHolidayFromList(check, holidays)) continue;
    bizDayCount++;
    if (bizDayCount === 3) return _sameDate(check, date);
  }
  return false;
}

/* ═══════════════ 예산 계산 ═══════════════ */

/** 특정 기간의 영업일 기반 예산 계산 */
function _calcCardBudgetForPeriod(fromDt, toDt) {
  var start = _parseDateStr(fromDt);
  var end = _parseDateStr(toDt);
  var holidaySet = _buildHolidaySet([start.getFullYear(), end.getFullYear()]);
  var bizDays = 0;
  var d = new Date(start);
  while (d <= end) {
    var dow = d.getDay();
    var mm = ('0' + (d.getMonth() + 1)).slice(-2);
    var dd = ('0' + d.getDate()).slice(-2);
    var dateStr = d.getFullYear() + '-' + mm + '-' + dd;
    if (dow !== 0 && dow !== 6 && !holidaySet[dateStr]) bizDays++;
    d.setDate(d.getDate() + 1);
  }
  return bizDays * 10000;
}

/** 현재 기간 영업일 수 기반 예산 계산 */
function _calcCardBudget() {
  var period = _getCardQueryPeriod();
  var start = _parseDateStr(period.from);
  var end = _parseDateStr(period.to);
  var holidaySet = _buildHolidaySet([start.getFullYear(), end.getFullYear()]);
  var bizDays = 0;
  var d = new Date(start);
  while (d <= end) {
    var dow = d.getDay();
    var mm = ('0' + (d.getMonth() + 1)).slice(-2);
    var dd = ('0' + d.getDate()).slice(-2);
    var dateStr = d.getFullYear() + '-' + mm + '-' + dd;
    if (dow !== 0 && dow !== 6 && !holidaySet[dateStr]) bizDays++;
    d.setDate(d.getDate() + 1);
  }
  return bizDays * 10000;
}

/** 오늘부터 마감일(14일)까지 남은 출근일 수 */
function _calcRemainingBizDays() {
  var period = _getCardQueryPeriod();
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var end = _parseDateStr(period.to);
  var holidaySet = _buildHolidaySet([today.getFullYear(), end.getFullYear()]);
  var bizDays = 0;
  var d = new Date(today);
  while (d <= end) {
    var dow = d.getDay();
    var mm = ('0' + (d.getMonth() + 1)).slice(-2);
    var dd = ('0' + d.getDate()).slice(-2);
    var dateStr = d.getFullYear() + '-' + mm + '-' + dd;
    if (dow !== 0 && dow !== 6 && !holidaySet[dateStr]) bizDays++;
    d.setDate(d.getDate() + 1);
  }
  return bizDays;
}

/* ═══════════════ 포맷 / 파싱 ═══════════════ */

/** "20260215" → Date */
function _parseDateStr(s) {
  return new Date(Number(s.substring(0, 4)), Number(s.substring(4, 6)) - 1, Number(s.substring(6, 8)));
}

/** 금액 포맷 (천단위 콤마) */
function _fmtMoney(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 금액 문자열 정리: "37300.00" → "37300", null → "0" */
function _cleanAmt(val) {
  if (val == null || val === '') return '0';
  var n = Number(String(val).replace(/,/g, ''));
  if (isNaN(n)) return '0';
  return String(Math.round(n));
}

/** 카드 조회 기간 (매월 15일 ~ 다음달 14일) */
function _getCardQueryPeriod() {
  var now = new Date();
  var y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  var start, end;
  if (d >= 15) {
    start = new Date(y, m, 15);
    end = new Date(y, m + 1, 14);
  } else {
    start = new Date(y, m - 1, 15);
    end = new Date(y, m, 14);
  }
  var fmt = function(dt) {
    var mm = ('0' + (dt.getMonth() + 1)).slice(-2);
    var dd = ('0' + dt.getDate()).slice(-2);
    return '' + dt.getFullYear() + mm + dd;
  };
  return { from: fmt(start), to: fmt(end) };
}

/** 승인일시 포맷: 20260227 + 151510 → 02.27 15:15 */
function _fmtApvDt(apvDt, apvTm) {
  if (!apvDt) return '';
  var s = String(apvDt);
  var result = s.substring(4, 6) + '.' + s.substring(6, 8);
  if (apvTm) {
    var t = ('000000' + apvTm).slice(-6);
    result += ' ' + t.substring(0, 2) + ':' + t.substring(2, 4);
  }
  return result;
}

/** 비밀번호 마이그레이션 (레거시 XOR → HMAC-CTR 일괄 전환) */
function migratePasswords() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  if (!sheet) return;
  var data = sheet.getDataRange().getValues();
  var migrated = 0;
  for (var i = 1; i < data.length; i++) {
    var encPw = data[i][CARD_DAILY_COL - 1]; // H열
    if (!encPw || String(encPw).indexOf('enc1:') === 0) continue;
    try {
      var plain = _decryptPwLegacyXor(String(encPw));
      var newEnc = _encryptPw(plain);
      sheet.getRange(i + 1, CARD_DAILY_COL).setValue(newEnc);
      migrated++;
    } catch (e) {
      Logger.log('[마이그레이션] 실패 행 ' + (i + 1) + ': ' + e.message);
    }
  }
  Logger.log('[마이그레이션] 완료: ' + migrated + '건 변환');
  return migrated;
}
