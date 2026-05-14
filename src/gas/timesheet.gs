/**
 * HRTong Timesheet API 연동 모듈
 * - 모바일 앱이 사용하는 AWS ALB 엔드포인트로 직접 호출
 */

const HRTONG_BASE = 'http://isu-hrtong-alb-344241565.ap-northeast-2.elb.amazonaws.com';
const HRTONG_API  = HRTONG_BASE + '/ifm/emro/vue/api/';

/** HRTong API 공통 호출 */
function _hrtongFetch(endpoint, payload) {
  var props = PropertiesService.getScriptProperties();
  var userToken = props.getProperty('HRTONG_USER_TOKEN');
  var authorization = props.getProperty('HRTONG_AUTHORIZATION');
  var jsessionId = props.getProperty('HRTONG_JSESSIONID');

  if (!userToken || !authorization) {
    return { status: 'ERROR', message: 'HRTong 인증 정보가 설정되지 않았습니다.' };
  }

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'userToken': userToken,
      'Authorization': authorization,
      'Cookie': 'JSESSIONID=' + (jsessionId || ''),
      'X-Requested-With': 'com.pb.mobile',
      'Origin': HRTONG_BASE,
      'Referer': HRTONG_BASE + '/ifm/emro/vue/'
    },
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true
  };

  var res = UrlFetchApp.fetch(HRTONG_API + endpoint, options);
  var code = res.getResponseCode();
  var body = res.getContentText();

  if (code !== 200) {
    return { status: 'ERROR', message: 'HTTP ' + code, body: body };
  }

  try {
    return JSON.parse(body);
  } catch (e) {
    return { status: 'ERROR', message: 'JSON 파싱 실패', body: body.substring(0, 500) };
  }
}

/** 토큰 설정 (최초 1회 또는 갱신 시 호출) */
function setHrtongTokens(userToken, authorization, jsessionId) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('HRTONG_USER_TOKEN', userToken);
  props.setProperty('HRTONG_AUTHORIZATION', authorization);
  if (jsessionId) props.setProperty('HRTONG_JSESSIONID', jsessionId);
  return 'OK';
}

/** 월간 근무시간 요약 */
function getTimeSheetProgressBar(ymd) {
  return _hrtongFetch('getTimeSheetProgressBarMap', { ymd: ymd || _today() });
}

/** 일별 근무 기록 */
function getTimeSheetWorkList(ymd) {
  return _hrtongFetch('getTimeSheetAppWorkList', { ymd: ymd || _today() });
}

/** 프로젝트별 근무 기록 */
function getTimeSheetWorkProjectList(ymd) {
  return _hrtongFetch('getTimeSheetAppWorkProjectList', { ymd: ymd || _today() });
}

/** 프로젝트 마스터 목록 */
function getTimeSheetBaseProjectList(ymd) {
  return _hrtongFetch('getTimeSheetBaseProjectList', { ymd: ymd || _today() });
}

/** 초과근무 목록 */
function getTimeSheetGntList(ymd) {
  return _hrtongFetch('getTimeSheetGntList', { ymd: ymd || _today() });
}

/** 오늘 날짜 YYYYMMDD */
function _today() {
  var d = new Date();
  var mm = ('0' + (d.getMonth() + 1)).slice(-2);
  var dd = ('0' + d.getDate()).slice(-2);
  return '' + d.getFullYear() + mm + dd;
}

// ── 테스트 함수 ──

function testHrtongConnection() {
  // 1) 토큰 설정
  setHrtongTokens(
    '0599a7af-31d3-4ab0-9e9c-b05a032185f7',
    'AUtVjBugJQuQTfRKGWkIlw==',
    '0234E919E69E0BD5C554E045602CBAF1'
  );

  // 2) 월간 요약 테스트
  var progress = getTimeSheetProgressBar('20260306');
  Logger.log('Progress: ' + JSON.stringify(progress));

  // 3) 일별 근무 테스트
  var work = getTimeSheetWorkList('20260303');
  Logger.log('WorkList: ' + JSON.stringify(work));
}
