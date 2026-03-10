/**
 * 바나프레소 메뉴 자동 동기화
 * - order.banapresso.com API에서 메뉴/옵션 데이터를 가져와 캐싱
 * - 당산SK점(12600) 기준
 * - 트리거: 주 1회 (월요일 오전 7시 권장)
 */

var BANA_API_URL = 'https://order.banapresso.com/query';
var BANA_MENU_QUERY = '91D8843AB9D3C73B28F1043252C574AF';
var BANA_OPT_QUERY  = '7426BEAF86B272A76AEE27580B296CF3';
var BANA_F_CODE     = 200000;
var BANA_F_CODE_SUB = 12600; // 당산SK점
var BANA_PROP_MENU  = 'BANA_MENU';
var BANA_PROP_OPT   = 'BANA_OPT';

/* ── API 호출 ── */
function _fetchBanaAPI(queryHash) {
  var resp = UrlFetchApp.fetch(BANA_API_URL, {
    method: 'post',
    contentType: 'text/plain;charset=UTF-8',
    payload: JSON.stringify({
      query: queryHash,
      params: { f_code: BANA_F_CODE, f_code_sub: BANA_F_CODE_SUB }
    }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) throw new Error('바나프레소 API 오류: ' + resp.getResponseCode());
  return JSON.parse(resp.getContentText());
}

/* ── 메뉴 row → 객체 변환 ── */
// API 컬럼 (58개):
// [0]nItem [1]sItemDivision [2]sItemDivisionOrigin [3]sItemDivisionRecipe
// [4]sItem [5]sEItem [6]nIceItemType [7]filter_keyword
// [8]sDefaultOption [9]sUserOption [10]sImageUrl [11]sImageUrlSub
// [12]takeout_menu [13]sMenuExplanation [14]sSetItem [15]sKakaoGiftUrl
// [16]sCountryOfOrigin [17]bDelete [18]nCharge ...
// [27]bSoldOut [44]bStopSell [46]bNewMenu [47]nBest
function _parseMenuRow(r) {
  return {
    id: r[0],
    name: r[4],
    category: r[1],
    price: r[18] || 0,
    img: r[10] || '',
    optionIds: r[9] || '',
    soldOut: r[27] === 1 || r[27] === '1',
    stopSell: r[44] === 1 || r[44] === '1'
  };
}

/* ── 옵션 row → map 구축 ── */
function _buildOptionMap(rows) {
  var map = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    map[r[0]] = {
      id: r[0],
      categoryId: r[1],
      categoryName: r[2],
      name: r[3],
      price: r[4] || 0,
      required: r[11] === '1' || r[11] === 1
    };
  }
  return map;
}

/* ── 옵션 타입 추정 (radio/checkbox) ── */
function _guessOptionType(catName) {
  var multi = ['샷', '시럽', '추가', '토핑'];
  for (var i = 0; i < multi.length; i++) {
    if (catName.indexOf(multi[i]) !== -1) return 'checkbox';
  }
  return 'radio';
}

/* ── 메뉴별 refined options 생성 ── */
function _buildRefinedOptions(menus, optMap) {
  var result = {};
  for (var mi = 0; mi < menus.length; mi++) {
    var m = menus[mi];
    if (!m.optionIds) continue;

    // optionIds: "8,18,37,;18,36,41,;" (HOT옵션;ICE옵션;...)
    var groups = m.optionIds.split(';');
    var seen = {};
    var allIds = [];
    for (var gi = 0; gi < groups.length; gi++) {
      var ids = groups[gi].split(',');
      for (var ii = 0; ii < ids.length; ii++) {
        var n = parseInt(ids[ii], 10);
        if (!isNaN(n) && !seen[n]) { seen[n] = true; allIds.push(n); }
      }
    }

    // 카테고리별 그룹핑
    var catMap = {};
    for (var ai = 0; ai < allIds.length; ai++) {
      var opt = optMap[allIds[ai]];
      if (!opt) continue;
      var cid = opt.categoryId;
      if (!catMap[cid]) {
        catMap[cid] = {
          id: opt.categoryName,
          name: opt.categoryName,
          required: opt.required,
          type: _guessOptionType(opt.categoryName),
          options: []
        };
      }
      // 기본값 표시: 가격 0이고 이름에 '기본' 포함
      var entry = { name: opt.name, price: opt.price };
      if (opt.price === 0 && opt.name.indexOf('기본') !== -1) entry.isDefault = true;
      catMap[cid].options.push(entry);
    }

    var cats = [];
    var keys = Object.keys(catMap);
    for (var ki = 0; ki < keys.length; ki++) cats.push(catMap[keys[ki]]);

    // 온도 카테고리를 맨 앞으로
    cats.sort(function(a, b) {
      if (a.name === '온도') return -1;
      if (b.name === '온도') return 1;
      if (a.required && !b.required) return -1;
      if (!a.required && b.required) return 1;
      return 0;
    });

    if (cats.length) result[m.id] = cats;
  }
  return result;
}

/**
 * 바나프레소 메뉴 동기화 (트리거용)
 * - 메뉴/옵션 API 호출 → 변환 → ScriptProperties 저장
 */
// 이쏜미용 음료 카테고리 (디저트/세트/상품 제외)
var BANA_DRINK_CATS = ['커피','저당 & 제로슈가','디카페인 커피','논커피 라떼','주스 & 드링크','바나치노 & 스무디','티 & 에이드'];

function syncBanapressoMenu() {
  var menuRaw = _fetchBanaAPI(BANA_MENU_QUERY);

  var menus = [];
  for (var i = 0; i < menuRaw.rows.length; i++) {
    var item = _parseMenuRow(menuRaw.rows[i]);
    // 삭제/판매중지/품절 제외
    if (item.stopSell || item.soldOut || String(menuRaw.rows[i][17]) === '1') continue;
    // 음료 카테고리만
    if (BANA_DRINK_CATS.indexOf(item.category) === -1) continue;
    menus.push(item);
  }

  // 옵션: 별도 쿼리가 있으면 API에서, 없으면 기존 캐시 유지
  var refined = {};
  if (BANA_OPT_QUERY) {
    var optRaw = _fetchBanaAPI(BANA_OPT_QUERY);
    var optMap = _buildOptionMap(optRaw.rows);
    refined = _buildRefinedOptions(menus, optMap);
  } else {
    // 기존 옵션 캐시가 있으면 유지
    var props = PropertiesService.getScriptProperties();
    var existing = _getPropChunked(props, BANA_PROP_OPT);
    if (existing) refined = JSON.parse(existing);
  }

  // ScriptProperties 저장 (9KB 제한 → 분할)
  var menuJson = JSON.stringify(menus);
  var optJson  = JSON.stringify(refined);
  var props = PropertiesService.getScriptProperties();
  _setPropChunked(props, BANA_PROP_MENU, menuJson);
  _setPropChunked(props, BANA_PROP_OPT, optJson);
  props.setProperty('BANA_SYNC_AT', new Date().toISOString());

  Logger.log('바나프레소 동기화 완료: 메뉴 ' + menus.length + '개, 옵션 ' + Object.keys(refined).length + '개');
  return { menuCount: menus.length, optionCount: Object.keys(refined).length };
}

/* ── ScriptProperties 분할 저장/읽기 (9KB 제한 우회) ── */
function _setPropChunked(props, key, value) {
  // 기존 청크 삭제
  for (var i = 0; i < 20; i++) {
    var ck = key + '_' + i;
    if (props.getProperty(ck) === null) break;
    props.deleteProperty(ck);
  }
  var CHUNK = 8000;
  var chunks = Math.ceil(value.length / CHUNK);
  props.setProperty(key + '_N', String(chunks));
  for (var c = 0; c < chunks; c++) {
    props.setProperty(key + '_' + c, value.substr(c * CHUNK, CHUNK));
  }
}

function _getPropChunked(props, key) {
  var n = parseInt(props.getProperty(key + '_N'), 10);
  if (isNaN(n) || n <= 0) return null;
  var parts = [];
  for (var i = 0; i < n; i++) {
    var chunk = props.getProperty(key + '_' + i);
    if (chunk === null) return null;
    parts.push(chunk);
  }
  return parts.join('');
}

/**
 * GAS action: getBanapressoMenu
 * - 캐시된 데이터 반환, 없으면 동기화 후 반환
 */
function handleGetBanapressoMenu(adminRow, e) {
  var props = PropertiesService.getScriptProperties();
  var menuJson = _getPropChunked(props, BANA_PROP_MENU);
  var optJson  = _getPropChunked(props, BANA_PROP_OPT);

  if (!menuJson) {
    try {
      syncBanapressoMenu();
      menuJson = _getPropChunked(props, BANA_PROP_MENU);
      optJson  = _getPropChunked(props, BANA_PROP_OPT);
    } catch (ex) {
      // 동기화 실패 시 빈 데이터 → 프론트에서 정적 JSON 폴백
      return createResponse({ ok: false, error: '메뉴 동기화 실패: ' + ex.message });
    }
  }

  return createResponse({
    ok: true,
    menu: JSON.parse(menuJson),
    options: JSON.parse(optJson),
    syncedAt: props.getProperty('BANA_SYNC_AT') || ''
  });
}
