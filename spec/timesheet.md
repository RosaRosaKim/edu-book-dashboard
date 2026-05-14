# Timesheet (HRTong) 외부 연동 분석

## 상태: 진행 중 - 토큰 갱신 문제 미해결

## 배경
- 타임시트(HRTong)는 내부망 웹에서만 접속 가능, 모바일은 전용 앱(com.pb.mobile)으로만 가능
- APK 디컴파일 + mitmweb 트래픽 캡처로 앱의 API 구조를 역공학 분석

## 핵심 발견

### API 서버
```
Base URL: http://isu-hrtong-alb-344241565.ap-northeast-2.elb.amazonaws.com
API Path: /ifm/emro/vue/api/{endpoint}
```
- AWS ALB(Application Load Balancer) — 외부에서 접근 가능
- 내부망 웹과는 완전히 다른 URL/시스템

### 인증 헤더 (3종)
| 헤더 | 형태 | 설명 |
|------|------|------|
| `userToken` | UUID (`0599a7af-...`) | 서버 세션 토큰 |
| `Authorization` | Base64 (`AUtVjBugJQuQTfRKGWkIlw==`) | 암호화된 인증값 |
| `Cookie` | `JSESSIONID=...` | Java 서버 세션 |

추가 헤더:
- `X-Requested-With: com.pb.mobile`
- `Origin` / `Referer`: ALB base URL

### 확인된 API 목록
| 엔드포인트 | 용도 | Request Body |
|-----------|------|-------------|
| `getTimeSheetProgressBarMap` | 월간 근무시간 요약 | `{"ymd":"YYYYMMDD"}` (파라미터 미확정) |
| `getTimeSheetAppWorkList` | 일별 근무 기록 | `{"ymd":"YYYYMMDD"}` |
| `getTimeSheetAppWorkProjectList` | 프로젝트별 근무 기록 | 미확인 |
| `getTimeSheetBaseProjectList` | 프로젝트 마스터 목록 | 미확인 |
| `getTimeSheetGntList` | 초과근무 목록 | 미확인 |

### 응답 예시 (getTimeSheetAppWorkList)
```json
{
  "result": {
    "enterCd": "T170",
    "ymd": "20260303",
    "sabun": "7411715",
    "workSHm": "09:00",
    "workEHm": "18:00",
    "workTerm": 540,
    "restTime": 1,
    "workTime": 8,
    "baseWork": 8,
    "overTimeWork": 0,
    "nightWork": 0,
    "confirmTag": "N",
    "restPeriodTime": "11:30 ~ 12:30",
    "rest": [{ "restStartTime": "11:30", "restEndTime": "12:30", "workRestTime": 1 }]
  },
  "status": "OK"
}
```

## GAS 연동 검증 결과
- **GAS(UrlFetchApp)에서 외부 호출 성공 확인** (2026-03-06)
- `src/gas/timesheet.gs` 구현 완료
- `testHrtongConnection()` 함수로 ProgressBar, WorkList 정상 응답 확인
- 토큰은 PropertiesService에 저장

## 미해결 과제 (블로커)

### 1. 토큰 갱신 (최우선)
- 현재 토큰은 mitmweb에서 수동 캡처한 것 → 만료되면 사용 불가
- 앱 로그인 화면에서 mitmweb 프록시 감지로 앱이 강제 종료됨
- 로그인 플로우를 캡처하지 못함
- **해결 방안 후보:**
  - PCAPdroid (VPN 방식, 프록시 감지 우회 가능성)
  - Frida로 앱 보안 체크 우회 후 로그인 캡처
  - 앱 트래픽에서 token refresh 요청 찾기
  - 토큰 만료 시간 확인 (장기 유효할 수도 있음)

### 2. ProgressBar API 파라미터
- `{"ymd":"20260306"}`으로 호출 시 null 응답
- 앱에서 보내는 정확한 Request Body 확인 필요

### 3. 나머지 API Request Body
- WorkProjectList, BaseProjectList, GntList의 요청 형식 미확인

## APK 분석 정보

### 앱 구조
- 패키지: `com.pb.mobile` (PearBranch HRTong)
- 인증: OIDC/OAuth2 + 세션 기반 이중 인증
- HTTP: OkHttp3 + Retrofit2
- 암호화: AES/CBC/PKCS5 + RSA (EncryptUtil.java)
- 난독화: XShield (libdxbase.so) — 네이티브 라이브러리 기반, 정적 분석 불가

### XShield 난독화
- `dc.m301(hash)` 형태로 문자열 암호화
- XOR 키: `'n'`(0x6E) / `'Q'`(0x51) 교대
- 최종 복호화는 `libdxbase.so` 네이티브 라이브러리에서 수행
- .so 파일이 디컴파일 결과에 미포함 → 원본 APK에서 추출 필요

### 기타 알려진 URL
```
AWS Lambda:  https://8vxu0grpsd.execute-api.ap-northeast-2.amazonaws.com/ifm/api/
PearBranch:  https://m.pearbranch.com/ifm/api/v5/ext/
고정 경로:    POST /ifm/api/v5/tenant
             POST /ifm/api/v5/login/encryption
```

## 파일 위치
- GAS 모듈: `src/gas/timesheet.gs`
- APK 디컴파일: `C:\Users\skyc5\Downloads\apk_decompiled2`
- 주요 소스: `sources/com/pb/mobile/` (ESSessionRepository, ApiModule, RequestInterceptor 등)
