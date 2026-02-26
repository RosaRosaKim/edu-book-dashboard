# 🚀 [최종] 사내 교육비 조회 대시보드 구축 요청서

## 1. 프로젝트 개요

- **목적:** 사내 직원별 연간 교육비(한도 50만원) 사용 내역 및 실시간 잔액 조회.
- **파일:** dev-edu-book-dashboard.html (단일 파일로 구성 권장).
- **환경:** GitHub Pages (Static Hosting).
- **인증:** 사내 메신저 'Flow' 연동 6자리 OTP (3분 제한).

## 2. 기술 정보

- **Main API URL:** https://script.google.com/macros/s/AKfycbwm206oiHHGBPGHUw17ZvbQVgVES9tq6kwWFvTbQ7UjSJKtwHzf20DbFxiBXAhwQbmg/exec
- **디자인:** Tailwind CSS 기반의 깔끔하고 전문적인 기업용 UI.

## 3. 상세 기능 구현 가이드

### A. 인증 및 세션 관리 (Auth Flow)

- **초기 상태:** localStorage에 edu_token이 없으면 로그인 인터페이스 노출.
- **입력창 구성:** [ 사번 입력 ] @emro.co.kr (사번만 입력하도록 유도).
- **안내 텍스트:** "인증요청을 누르면 Flow로 인증번호가 발송돼요."
- **인증번호 요청:** action=sendCode 호출. 성공 시 6자리 입력창과 3분 카운트다운 타이머 활성화.
- **인증 완료:** action=verify 호출. 성공 시 서버에서 받은 token(UUID)을 localStorage에 저장 후 대시보드로 진입.
- **자동 로그인:** 이후 접속 시 저장된 토큰으로 action=getData (기본 호출) 수행.
- **예외 처리:** 사번 미등록 등 API 에러 발생 시 "인재성장파트 김우정 프로에게 문의해주세요" 메시지를 모달 또는 경고창으로 노출.

### B. 대시보드 (Main Dashboard)

**잔액 시각화:**
- [연간 한도 50만원 / 사용 금액 / 남은 잔액] 표시.
- Progress Bar 또는 Donut Chart를 활용하여 한도 대비 사용량 시각화.

**알람 토글 (Flow 알람 수신 동의):**
- 화면 상단에 스위치(Toggle) 배치.
- 페이지 로드 시 userInfo.isAgreed 값에 따라 초기 상태 결정.
- 토글 상태 변경 즉시 action=updateAlarm API 호출 및 결과 반영.

**상세 신청 내역:**
- 반려 건을 포함한 모든 리스트 출력.
- 상태 배지(Badge): '완료'(초록), '반려'(빨강), '결재중'(노랑) 등 상태별 색상 차별화.
- 모바일 대응: 테이블 가독성이 떨어질 경우 카드 형태(Card View)로 전환되는 반응형 레이아웃 적용.

## 4. API 인터페이스 (Request 가이드)

| 기능 | Endpoint (GET) | 비고 |
|------|----------------|------|
| 인증번호 발송 | `?action=sendCode&knoxId={사번}` | Flow 메신저로 OTP 발송 |
| 인증번호 검증 | `?action=verify&knoxId={사번}&authCode={6자리}` | 성공 시 token 반환 |
| 데이터 조회 | `?token={UUID}` | 사용자 정보 및 내역 반환 |
| 알람 설정 변경 | `?action=updateAlarm&token={UUID}&isAgreed={true/false}` | 시트 실시간 업데이트 |

## 5. 안티그래비티를 위한 개발 팁 (보안 매니저 전달사항)

- **보안:** URL 파라미터로 토큰이 노출되어 접속했을 경우, 로컬스토리지 저장 후 `window.history.replaceState`를 사용해 URL의 토큰을 즉시 제거해 주세요.
- **UX:** 인증번호 3분 만료 시 '재전송' 버튼을 활성화해 주세요.
- **API 호출:** 구글 앱스 스크립트 특성상 Redirect가 발생할 수 있으니 fetch 사용 시 이를 고려해 주세요.
