/**
 * 스플래시 정보 (날씨 + 주식)
 * Phase 2 응답에 포함되어 로딩 토스트에 표시
 */

/**
 * 날씨 변화 감지 → 알림 메시지 반환 (변화 없으면 null)
 * Open-Meteo API (무료, 키 불필요) — 당산역 기준
 */
function _getWeatherAlert() {
  var resp = UrlFetchApp.fetch(
    'https://api.open-meteo.com/v1/forecast?latitude=37.5340&longitude=126.9027' +
    '&hourly=precipitation_probability,weathercode,temperature_2m' +
    '&timezone=Asia/Seoul&forecast_days=1',
    { muteHttpExceptions: true }
  );
  if (resp.getResponseCode() !== 200) return null;
  var data = JSON.parse(resp.getContentText());
  var h = data.hourly;
  if (!h || !h.time) return null;

  var now = new Date();
  var curHour = now.getHours();

  var codes = [], precips = [], temps = [];
  for (var i = 0; i < h.time.length; i++) {
    var hour = parseInt(h.time[i].split('T')[1].split(':')[0], 10);
    if (hour >= curHour && hour <= curHour + 6) {
      codes.push(h.weathercode[i]);
      precips.push(h.precipitation_probability[i] || 0);
      temps.push(h.temperature_2m[i]);
    }
  }
  if (codes.length < 2) return null;

  var isRainCode = function(c) { return c >= 51; };
  var nowRain = isRainCode(codes[0]);
  var laterRain = codes.slice(1, 4).some(isRainCode);
  var laterClear = !codes.slice(1, 4).some(isRainCode);

  if (!nowRain && laterRain) {
    var maxPrecip = Math.max.apply(null, precips.slice(1, 4));
    if (maxPrecip >= 50) return '🌧️ 곧 비 온대, 우산 챙겨!';
    if (maxPrecip >= 30) return '🌂 비 올 수도 있대, 우산 챙길까?';
  }
  if (nowRain && laterClear) return '☀️ 곧 비 그친대!';
  if (temps.length >= 3 && temps[0] - temps[temps.length - 1] >= 3) return '🥶 기온이 뚝 떨어져, 따뜻하게!';
  if (temps[0] >= 33) return '🔥 오늘 너무 덥대, 물 많이 마셔!';
  var snowCodes = codes.filter(function(c) { return c >= 71 && c <= 77; });
  if (snowCodes.length > 0 && !isRainCode(codes[0])) return '❄️ 눈 온대!';

  return null;
}

/**
 * 현재 날씨 정보 → 스플래시 메시지 (변화 없을 때 fallback용)
 * weatherAlert가 null일 때만 사용됨
 */
function _getWeatherNow() {
  var resp = UrlFetchApp.fetch(
    'https://api.open-meteo.com/v1/forecast?latitude=37.5340&longitude=126.9027' +
    '&current=temperature_2m,weathercode&timezone=Asia/Seoul',
    { muteHttpExceptions: true }
  );
  if (resp.getResponseCode() !== 200) return null;
  var data = JSON.parse(resp.getContentText());
  var cur = data.current;
  if (!cur) return null;

  var temp = Math.round(cur.temperature_2m);
  var code = cur.weathercode;

  var desc;
  if (code === 0) desc = '맑음 ☀️';
  else if (code <= 3) desc = '구름 조금 ⛅';
  else if (code <= 48) desc = '흐림 ☁️';
  else if (code <= 67) desc = '비 🌧️';
  else if (code <= 77) desc = '눈 ❄️';
  else if (code <= 82) desc = '소나기 🌦️';
  else if (code <= 86) desc = '눈보라 🌨️';
  else desc = '뇌우 ⛈️';

  return '지금 바깥 ' + temp + '°, ' + desc;
}

/**
 * D-day 정보 → 스플래시 메시지 배열 (월급날 + 다음 공휴일)
 * 월급날: 매월 3번째 금요일 (공휴일/주말이면 전날로)
 */
function _getDday() {
  // 공휴일 {날짜: 이름} — 매년 초 업데이트 필요 (음력 공휴일은 연도별 상이)
  var H = {
    '2026-05-05':'어린이날', '2026-05-25':'부처님오신날 대체공휴일',
    '2026-06-06':'현충일', '2026-06-08':'대체공휴일',
    '2026-08-15':'광복절', '2026-08-17':'대체공휴일',
    '2026-10-03':'개천절', '2026-10-04':'추석', '2026-10-05':'추석', '2026-10-06':'추석',
    '2026-10-07':'대체공휴일', '2026-10-09':'한글날',
    '2026-12-25':'크리스마스',
    '2027-01-01':'신정',
    '2027-02-06':'설날', '2027-02-07':'설날', '2027-02-08':'설날', '2027-02-09':'대체공휴일',
    '2027-03-01':'삼일절', '2027-05-05':'어린이날', '2027-05-13':'부처님오신날',
    '2027-06-06':'현충일', '2027-06-07':'대체공휴일',
    '2027-08-15':'광복절', '2027-08-16':'대체공휴일',
    '2027-09-24':'추석', '2027-09-25':'추석', '2027-09-26':'추석', '2027-09-27':'대체공휴일',
    '2027-10-03':'개천절', '2027-10-04':'대체공휴일', '2027-10-09':'한글날', '2027-10-11':'대체공휴일',
    '2027-12-25':'크리스마스'
  };

  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  function fmt(d) {
    return d.getFullYear() + '-' + ('0'+(d.getMonth()+1)).slice(-2) + '-' + ('0'+d.getDate()).slice(-2);
  }

  // 다음 공휴일 (대체공휴일 제외 이름)
  var nextH = null;
  var keys = Object.keys(H).sort();
  for (var i = 0; i < keys.length; i++) {
    var hd = new Date(keys[i].replace(/-/g, '/'));
    var diff = Math.round((hd - today) / 86400000);
    if (diff >= 1 && H[keys[i]].indexOf('대체') === -1) {
      nextH = { name: H[keys[i]], diff: diff };
      break;
    }
  }

  // 월급날: 3번째 금요일 → 공휴일/주말이면 전날로
  function getPayday(y, m) {
    var first = new Date(y, m, 1);
    var firstFri = 1 + (5 - first.getDay() + 7) % 7;
    var pd = new Date(y, m, firstFri + 14);
    while (pd.getDay() === 0 || pd.getDay() === 6 || H[fmt(pd)]) {
      pd.setDate(pd.getDate() - 1);
    }
    return pd;
  }

  var pd = getPayday(today.getFullYear(), today.getMonth());
  if (pd < today) {
    var nm = today.getMonth() + 1, ny = today.getFullYear();
    if (nm > 11) { nm = 0; ny++; }
    pd = getPayday(ny, nm);
  }
  var payDiff = Math.round((pd - today) / 86400000);

  var msgs = [];
  if (payDiff === 0) msgs.push('💰 오늘 월급날!');
  else if (payDiff === 1) msgs.push('💰 내일 월급날!');
  else msgs.push('💰 월급날까지 D-' + payDiff);

  if (nextH) {
    if (nextH.diff === 1) msgs.push('🎉 내일 ' + nextH.name + '!');
    else msgs.push('🗓️ ' + nextH.name + '까지 D-' + nextH.diff);
  }

  return msgs;
}

/**
 * 미세먼지 정보 → 스플래시 메시지
 * Open-Meteo Air Quality API — 당산역 기준
 */
function _getAirQuality() {
  var resp = UrlFetchApp.fetch(
    'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=37.5340&longitude=126.9027' +
    '&current=pm2_5,pm10',
    { muteHttpExceptions: true }
  );
  if (resp.getResponseCode() !== 200) return null;
  var data = JSON.parse(resp.getContentText());
  var cur = data.current;
  if (!cur || cur.pm2_5 == null) return null;

  var pm = cur.pm2_5;
  if (pm <= 15) return '😊 미세먼지 좋음';
  if (pm <= 35) return '🙂 미세먼지 보통';
  if (pm <= 75) return '😷 마스크 챙겨! 미세먼지 나쁨';
  return '🤢 미세먼지 매우나쁨, 외출 자제!';
}

/**
 * 주요 뉴스 헤드라인 → 스플래시 메시지 배열 (최대 10개)
 * Google News RSS — 한국 주요 뉴스
 */
function _getNewsHeadlines() {
  var resp = UrlFetchApp.fetch(
    'https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko',
    { muteHttpExceptions: true }
  );
  if (resp.getResponseCode() !== 200) return [];
  var xml = resp.getContentText();
  var doc = XmlService.parse(xml);
  var root = doc.getRootElement();
  var channel = root.getChild('channel');
  if (!channel) return [];

  var items = channel.getChildren('item');
  var headlines = [];
  for (var i = 0; i < Math.min(items.length, 10); i++) {
    var title = items[i].getChildText('title');
    if (title) {
      // 언론사 접미사 제거 (예: " - 조선일보")
      var clean = title.replace(/\s*-\s*[^\-]+$/, '').trim();
      if (clean.length > 30) clean = clean.substring(0, 28) + '..';
      headlines.push('📰 ' + clean);
    }
  }
  return headlines;
}

/**
 * 주식 정보 → 스플래시 메시지 반환
 * Yahoo Finance API — 엠로(058970.KQ, KOSDAQ)
 */
function _getStockInfo() {
  var resp = UrlFetchApp.fetch(
    'https://query1.finance.yahoo.com/v8/finance/chart/058970.KQ?range=1d&interval=1d',
    { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (resp.getResponseCode() !== 200) return null;
  var data = JSON.parse(resp.getContentText());
  var result = data.chart && data.chart.result && data.chart.result[0];
  if (!result || !result.meta) return null;

  var price = result.meta.regularMarketPrice;
  var prevClose = result.meta.chartPreviousClose || result.meta.previousClose;
  if (!price || !prevClose) return null;

  var diff = price - prevClose;
  var pct = ((diff / prevClose) * 100).toFixed(1);
  var fmt = Number(price).toLocaleString();

  var absPct = Math.abs(parseFloat(pct));
  if (diff > 0 && absPct >= 5) return '🚀 엠로 ' + fmt + '원 (+' + pct + '%) 오늘 치킨 사도 되겠는데?';
  if (diff < 0 && absPct >= 5) return '🫣 오늘 회사 주식은 확인하지 않는 게 좋을 것 같아..';
  if (diff > 0) return '📈 엠로 ' + fmt + '원 (+' + pct + '%)';
  if (diff < 0) return '📉 엠로 ' + fmt + '원 (' + pct + '%)';
  return '📊 엠로 ' + fmt + '원 (0.0%)';
}
