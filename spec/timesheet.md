# 타임시트 모바일 앱 API 분석

## 개요
회사 내부 타임시트 모바일 앱(HrTong)의 API를 분석하여 GAS에서 호출 가능한지 조사.

## 앱 정보
| 항목 | 값 |
|---|---|
| 앱 이름 | HrTong (타임시트) |
| 패키지 | `com.pb.mobile` (PearBranch Mobile) |
| 내부 패키지 | `com.isu.hrtong` |
| 버전 | 2.6.79 (빌드 755, 2026-02-26) |
| 프레임워크 | Kotlin + Retrofit + OkHttp + Hilt + RxJava |
| 보안 | xshield (문자열 난독화 + 네이티브 키 보호) |
| SSL Pinning | 있음 (프록시 감지 시 앱 자동 종료) |

## 서버
| 서버 | URL | 용도 |
|---|---|---|
| AWS API Gateway | `https://8vxu0grpsd.execute-api.ap-northeast-2.amazonaws.com` | 메인 API |
| PearBranch | `https://m.pearbranch.com` | 메인 API (동일 역할) |

## 인증 구조

### Authorization 헤더 (모든 API 필요)
```
Authorization = AES/CBC/PKCS5Padding(고정문자열, Base64Decode(nativeKey))
```
- `nativeKey`: xshield JNI 네이티브 라이브러리에서 반환 (정적 추출 불가)
- 고정문자열: xshield 난독화 (`dc.m289(-1106373781)`)
- **결과**: GAS에서 직접 생성 불가

### 로그인 흐름
```
1. /ifm/api/v5/tenant          (POST, Authorization + s 헤더 + body{tenantKey})
   → 테넌트 정보 + 암호화된 URL 목록 반환

2. /ifm/api/v5/login/encryption (POST, Authorization 헤더)
   → RSA 공개키(modulus, exponent) 반환

3. 비밀번호 RSA 암호화 → 로그인 API 호출
   → accessToken + 세션 정보 반환

4. 이후 모든 API: accessToken 헤더로 인증
```

### 로그인 계정
- 형식: `knoxID@emro.co.kr` (Bizplay와 동일 형식, 비밀번호는 다름)
- tenantKey: `EMRO`

## API 엔드포인트

### 하드코딩된 엔드포인트 (DEX에서 추출)
| 엔드포인트 | 용도 |
|---|---|
| `/ifm/api/v5/tenant` | 테넌트 조회 |
| `/ifm/api/v5/login/encryption` | RSA 공개키 조회 |
| `/ifm/api/ext/ecopro/REQUEST_IN` | 출근 체크인 |
| `/ifm/api/ext/ecopro/REQUEST_OUT` | 퇴근 체크아웃 |
| `/ifm/api/v5/ext/EMP_DETAIL` | 직원 상세 정보 |
| `/ifm/api/v5/ext/SCHOOL_DOC_SEARCH` | 문서 검색 |
| `/ifm/api/edocument` | 전자문서 |
| `/ifm/api/edocument/list` | 전자문서 목록 |
| `/ifm/api/edocument/status` | 전자문서 상태 |
| `/ifm/api/offrequest/leave` | 휴가 신청 |
| `/ifm/api/salary` | 급여 |
| `/ifm/api/salary/list` | 급여 목록 |
| `/ifm/api/employee/image` | 직원 사진 |

### 동적 URL (로그인 후 서버에서 수신)
TenantInfo에 AES 암호화된 URL로 저장:
- `certificationUrl` - 인증 URL
- `ssoCertificationUrl` - SSO 인증 URL
- `userStatusUrl` - 사용자 상태 URL
- `tenantSettingUrl` - 테넌트 설정 URL
- `empImageUrl` - 직원 이미지 URL
- `menuUpdateUrl` - 메뉴 업데이트 URL
- `pushTokenUrl` - 푸시 토큰 URL
- `multiDeviceAccessUrl` - 멀티 디바이스 URL
- `contentPopupUrl` - 컨텐츠 팝업 URL
- `findPasswordUrl` - 비밀번호 찾기 URL
- `logoutUrl` - 로그아웃 URL
- `widgetQuickMenuUrl` - 위젯 퀵메뉴 URL
- `widgetTeamStatusUrl` - 위젯 팀 상태 URL
- `loadingImageUrl` - 로딩 이미지 URL

## 앱 내 화면 구조

### 네이티브 Fragment (view:// 스킴)
| view:// 경로 | Fragment | 설명 |
|---|---|---|
| `scheduleCalendar` | ESScheduleCalendarFragment | **근무 스케줄 캘린더** |
| `eventCalendar` | ESEventCalendarFragment | 이벤트 캘린더 |
| `myWorkStatus` | - | 근무 현황 |
| `myLeaveStatus` | - | 휴가 현황 |
| `myVacationStatus` | - | 연차 현황 |
| `payList` | ESPayListFragment | 급여 |
| `hrApprovalList` | ESApprovalTabFragment | 결재 문서 |
| `hrApprovalDetail` | ESApprovalDetailFragment | 결재 상세 |
| `employee` | - | 조직도 |
| `calendar` | - | 캘린더 |
| `workRequest` | - | 근태 신청 |
| `teamStatus` | ESTeamStatusFragment | 팀 근태 현황 |
| `wizardForm` | ESWizardFormFragment | 동적 폼 |
| `dynamic` | ESDynamicListFragment | 동적 목록 |

### WebView 화면
- `ExtWebViewActivity`: 인증 정보(tenantKey, userToken, locale, empKey)를 WebView에 전달
- `WebViewActivity`: `SYS.URL.EMP_EXT_VIEW` 등 서버에서 받은 URL 로드

## Retrofit 서비스 인터페이스

### ESRetrofitServices (Epsilon - 로그인용)
- `EncryptRetrofit` 사용 (RequestInterceptor 없음, 로깅만)
- Authorization + s 헤더로 인증

### ApiCommonService (Epsilon - 로그인 후)
- `HrTongRetrofit` 사용 (RequestInterceptor로 accessToken 헤더 자동 추가)
- 동적 URL (`@Url`) + JSON body

### RetrofitService (레거시)
- 쿼리 파라미터로 인증: `empKey`, `tenantKey`, `userToken`, `locale`
- 다양한 HTTP 메서드 (GET/POST/PUT/DELETE)

## RequestInterceptor
```kotlin
// OkHttp Interceptor - accessToken 헤더 추가
class RequestInterceptor(esSessionRepository: ESSessionRepository) : Interceptor {
    override fun intercept(chain: Chain): Response {
        val accessToken = esSessionRepository.fetchUserToken() // suspend
        val request = if (accessToken.isNotEmpty()) {
            chain.request().newBuilder()
                .addHeader("<obfuscated-header-name>", accessToken)
                .build()
        } else {
            chain.request()
        }
        return chain.proceed(request)
    }
}
```

## 분석 방법
1. APK 추출: APK Extractor (폰에서)
2. APK 디컴파일: jadx 1.5.5 + Corretto JDK 17
3. mitmproxy 시도: SSL pinning으로 실패 (프록시 감지 → 앱 자동 종료)
4. DEX 바이너리 문자열 추출: Python `re.findall()`

## GAS 연동 가능성

### 현재 차단 요소
- **Authorization 헤더**: xshield 네이티브 키 필요 → 정적 추출 불가
- **SSL Pinning**: mitmproxy로 런타임 캡처 불가

### 대안
1. **Frida**: 루팅 없이 앱 실행 중 Authorization 값 캡처 가능
2. **Android 에뮬레이터**: 루팅 에뮬레이터에서 SSL pinning 우회
3. **웹 버전 분석**: 앱이 WebView로 로드하는 내부 웹페이지를 PC 브라우저에서 열어 DevTools로 API 분석
4. **레거시 API**: 쿼리 파라미터 인증 방식이라 empKey/tenantKey/userToken만 확보하면 호출 가능

## 파일 위치
- APK: `C:\Users\skyc5\Downloads\Mobile.apk`
- APK 추출: `C:\Users\skyc5\Downloads\apk_extract/`
- jadx 디컴파일: `C:\Users\skyc5\Downloads\apk_decompiled2/`
- 주요 소스 경로: `sources/com/pb/mobile/`
