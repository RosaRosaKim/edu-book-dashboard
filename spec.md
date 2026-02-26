# 🚀 [최종] 사내 교육비 조회 대시보드 구축 요청서

## 1. 프로젝트 개요

- **목적:** 사내 직원별 연간 교육비(한도 50만원) 사용 내역 및 실시간 잔액 조회.
- **파일:** dev-edu-book-dashboard.html (단일 파일로 구성 권장).
- **환경:** GitHub Pages (Static Hosting).
- **인증:** 사내 메신저 'Flow' 연동 6자리 OTP (3분 제한).

## 2. 기술 정보

- **Main API URL:** https://script.google.com/macros/s/AKfycbzI7GbZU2NybDeu-dzcl9jc1bUe5IWTXlHqStC9RVtFQMLhS5nKTBqXEfcnop5P2wMF/exec
- **디자인:** Tailwind CSS 기반의 깔끔하고 전문적인 기업용 UI.
- 필요시 code.gs참고

## 3. 상세 기능 구현 가이드

### A. 인증 및 세션 관리 (Auth Flow)

- **초기 상태:** localStorage에 edu_token이 없으면 로그인 인터페이스 노출.
- **입력창 구성:** [ Flow ID 입력 ] @emro.co.kr 
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

## 5. 기타 
- 구글시트 : https://docs.google.com/spreadsheets/d/1DT_TIc-nHBiKxWE7kZHK-6XNqtgyTXiWu0R7LIE2aa0/edit?gid=0#gid=0

### 6. 관리자 페이지 
🤖 클로드 전달용 개발 프롬프트
제목: 기업용 교육비 관리 시스템(에듀-돋보기) Admin 대시보드 개발 요청

1. 프로젝트 개요

서비스명: 에듀-돋보기 (Education Expense Monitoring System)

사용자: 기업 보안 매니저 및 교육 담당자

주요 목적: 사내 교육비 집행 현황 모니터링, 예산 소진율 관리, 개별 사용 내역 추적 및 필터링

2. 기술 스택 및 디자인 가이드

Frontend: HTML5, Tailwind CSS (CDN), Chart.js

Backend: Google Apps Script (GAS) 연동 (JSON API 방식)

디자인 테마: 전문적이고 세련된 다크 모드 (Dark Mode) 인터페이스

레이아웃: 데이터 가독성을 극대화한 1컬럼(Single Column) 세로 배치

3. 핵심 기능 요구사항 (필수 구현)

통합 예산 KPI 카드: 상단에 '확정 금액', '집행 예정 금액', '잔여 예산'을 시각적으로 강조하여 배치.

시각화 차트 (Interactive Charts):

전사 예산 소진 게이지: 전체 예산 대비 확정/예정 비중을 보여주는 수평 바(Bar).

분야별 지출 비중: IT, 어학, 직무 등 카테고리별 통계 (수평 막대 차트).

플랫폼 점유율: 인프런, 유데미 등 교육 기관별 선호도 (수평 막대 차트).

핵심 기능: 차트의 각 항목(막대)을 클릭하면 해당 조건이 '필터 태그'로 자동 추가되어야 함.

다중 태그 필터링 시스템 (AND 조건):

차트 클릭 또는 검색창 입력을 통해 필터 조건(태그) 생성.

생성된 태그는 개별 삭제(X 버튼)가 가능해야 함.

여러 태그가 활성화될 경우, **모든 조건을 만족(AND)**하는 데이터만 하단 리스트에 표시.

사용자 상세 조회 및 결과:

사번 또는 성명으로 검색 시 해당 인원의 **개인별 예산 현황(소진/진행/잔여)**을 게이지로 표시.

반려(Rejected) 내역 포함: 과거 반려된 내역은 취소선이나 붉은 톤으로 시각화하여 이력을 유지.

전략적 리스트 추출: '한도 임박자(45만 원 이상)', '미사용자(0원)'를 원클릭으로 필터링하는 버튼 배치.

4. 보안 및 로직 참고사항

관리자 판별: 로그인한 사용자의 UUID를 기반으로 서버에서 isAdmin 권한 여부를 확인하며, 관리자일 때만 전사 통계 데이터(adminStats)를 수신함.

중복 방지: 모든 데이터 처리는 '문서번호(G열)'를 기준으로 중복을 체크함.
