/**
 * 공통 유틸리티
 * - 시트 캐싱 (같은 요청 내 중복 읽기 제거)
 * - 암호화/복호화 (HMAC-CTR)
 * - 응답 헬퍼
 * - 공용 상수 (BROWSER_UA 등)
 */

/* ═══════════════ 시트 캐싱 ═══════════════ */
/*
 * GAS는 요청당 단일 스레드이므로 글로벌 변수가 요청 스코프 캐시 역할을 함.
 * getDataRange().getValues()는 비용이 큰 호출 → 같은 시트를 반복 읽지 않도록 캐싱.
 *
 * 사용법:
 *   var data = getCachedData('웹페이지관리');        // 캐시 히트 or 읽기
 *   var data = getCachedData('웹페이지관리', true);   // 강제 갱신
 *   invalidateCache('웹페이지관리');                  // 시트에 쓴 후 캐시 무효화
 */
var _sheetDataCache = {};

/**
 * 시트 데이터 캐시 조회/로드
 * @param {string} sheetName - 시트 이름
 * @param {boolean} [forceReload] - true면 캐시 무시하고 다시 읽기
 * @returns {Array[]} 2D 배열 (getValues 결과)
 */
function getCachedData(sheetName, forceReload) {
  if (!forceReload && _sheetDataCache[sheetName]) {
    return _sheetDataCache[sheetName];
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 1) {
    _sheetDataCache[sheetName] = [];
    return [];
  }
  var data = sheet.getDataRange().getValues();
  _sheetDataCache[sheetName] = data;
  return data;
}

/**
 * 캐시 무효화 (시트에 데이터를 쓴 후 호출)
 * @param {string} [sheetName] - 특정 시트만 무효화. 생략 시 전체 무효화
 */
function invalidateCache(sheetName) {
  if (sheetName) {
    delete _sheetDataCache[sheetName];
  } else {
    _sheetDataCache = {};
  }
}

/* ═══════════════ 공용 상수 ═══════════════ */

/** GAS 기본 UA가 앱 설치 페이지를 유발하므로 브라우저 UA 사용 */
var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 녹스ID에서 @emro.co.kr 제거 (이메일 전체 입력 대응) */
function _normalizeKnoxId(knoxId) {
  return String(knoxId || '').trim().replace(/@emro\.co\.kr$/i, '');
}

/* ═══════════════ JSON 응답 ═══════════════ */
function createResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 에러 응답 표준 형식 */
function createErrorResponse(code, message) {
  return createResponse({ error: code, message: message || code });
}

/* ═══════════════ 암호화/복호화 (HMAC-CTR) ═══════════════ */
/*
 * GAS V8에는 AES API가 없으므로 HMAC-SHA256 기반 CTR 스트림 암호 사용
 * - 매 암호화마다 랜덤 nonce(16바이트) 생성 → 같은 평문도 다른 암호문
 * - keystream = HMAC(key, nonce||counter) 블록을 이어붙여 생성
 * - 저장 형식: "enc1:" + base64(nonce + ciphertext)
 */
var ENCRYPT_SECRET = (function() {
  try { return PropertiesService.getScriptProperties().getProperty('ENCRYPT_SECRET') || 'edu-book-dashboard-card-v1'; }
  catch (_) { return 'edu-book-dashboard-card-v1'; }
})();

function _encryptPw(plain) {
  var key = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, ENCRYPT_SECRET);
  var nonce = _randomBytes(16);
  var plainBytes = Utilities.newBlob(plain, 'UTF-8').getBytes();
  var keystream = _hmacKeystream(key, nonce, plainBytes.length);

  var cipherBytes = [];
  for (var i = 0; i < plainBytes.length; i++) {
    cipherBytes.push(plainBytes[i] ^ keystream[i]);
  }

  return 'enc1:' + Utilities.base64Encode(nonce.concat(cipherBytes));
}

function _decryptPw(cipher) {
  if (!cipher) return '';

  // 레거시 XOR 형식 (접두어 없음)
  if (String(cipher).indexOf('enc1:') !== 0) {
    return _decryptPwLegacyXor(cipher);
  }

  var raw = Utilities.base64Decode(cipher.substring(5));
  var key = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, ENCRYPT_SECRET);
  var nonce = raw.slice(0, 16);
  var cipherBytes = raw.slice(16);
  var keystream = _hmacKeystream(key, nonce, cipherBytes.length);

  var plainBytes = [];
  for (var i = 0; i < cipherBytes.length; i++) {
    plainBytes.push(cipherBytes[i] ^ keystream[i]);
  }

  return Utilities.newBlob(plainBytes).getDataAsString();
}

/** HMAC-SHA256 카운터 모드 키스트림 생성 */
function _hmacKeystream(key, nonce, length) {
  var stream = [];
  var counter = 0;
  while (stream.length < length) {
    var input = nonce.concat([counter >> 24 & 0xff, counter >> 16 & 0xff, counter >> 8 & 0xff, counter & 0xff]);
    var block = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_256, input, key);
    for (var i = 0; i < block.length && stream.length < length; i++) {
      stream.push(block[i]);
    }
    counter++;
  }
  return stream;
}

/** 랜덤 바이트 배열 생성 */
function _randomBytes(n) {
  var bytes = [];
  for (var i = 0; i < n; i++) bytes.push(Math.floor(Math.random() * 256) - 128);
  return bytes;
}

/** 레거시 XOR 복호화 (하위 호환) */
function _decryptPwLegacyXor(cipher) {
  var key = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, ENCRYPT_SECRET);
  var enc = Utilities.base64Decode(cipher);
  var dec = enc.map(function(b, i) { return b ^ key[i % key.length]; });
  return Utilities.newBlob(dec).getDataAsString();
}
