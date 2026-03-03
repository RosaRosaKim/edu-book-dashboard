# 사내 교육비 조회 대시보드 — 기술 명세서

## 1. 프로젝트 개요

- **목적:** 사내 직원별 연간 교육비(한도 50만원) 사용 내역 및 실시간 잔액 조회 + 관리자 통합 관제 + 법인카드(밥카) 사용내역/결재
- **환경:** GitHub Pages (Static Hosting), PWA 지원 (Android 설치 / iOS 홈화면 추가)
- **인증:** Bizplay SSO 로그인 (사내 메신저 Flow OTP 인증은 제거됨)
- **백엔드:** Google Apps Script (GAS) + Google Sheets
- **다크모드:** CSS 변수 + `html.dark` 클래스 토글, localStorage 저장, FOUC 방지

## 2. 파일 구조

| 파일 | 설명 |
|------|------|
| `html/dev-edu-book-dashboard.html` | 사용자 대시보드 (개발용) |
| `html/dev-admin-dashboard.html` | 관리자 대시보드 (개발용) |
| `html/edu-bizplay.html` | Bizplay 교육 신청서 임시저장 모듈 |
| `html/card-babka.html` | 법인카드(밥카) 모듈 |
| `html/edu-board.html` | 익명 게시판 모듈 (정렬, 페이지네이션, 관리자 답변) |
| `html/edu-draft.html` | 기안문서 모듈 (목록, 상세, 결재의견) |
| `css/draft.css` | 기안문서 전용 스타일 (카드 상태색, 본문 파싱, 리스트/코드) |
| `html/manifest.json` | PWA 매니페스트 |
| `html/sw.js` | Service Worker (네트워크 우선 + 캐시 폴백) |
| `gas/code.gs` | GAS 백엔드 (라우터 + 자동 알림 트리거) |
| `gas/edu-bizplay.gs` | GAS — Bizplay SSO 로그인 + 교육 임시저장 |
| `gas/card-babka.gs` | GAS — 밥카 알람, 사용내역, 결재, 잔액알림 |
| `gas/board.gs` | GAS — 게시판 CRUD (목록, 작성, 반응, 관리자 답변) |
| `gas/generateUUID.gs` | GAS 유틸리티 (UUID 일괄 생성) |
| `build.js` | 빌드 스크립트 (난독화 + 압축 + 경로 치환) |
| `deploy.js` | 배포 스크립트 (빌드 → GitHub Pages push) |
| `img/` | 정적 에셋 (파비콘, 마스코트 이미지, GIF 애니메이션) |
| `dist/` | 빌드 출력 (배포용 파일) |

## 3. 기술 스택

- **프론트엔드:** 단일 HTML 파일, Tailwind CSS (CDN), Chart.js (관리자), Noto Sans KR + IBM Plex Mono
- **테마:** CSS 변수 RGB triplet + `html.dark` 클래스 기반 다크모드
- **PWA:** manifest.json + Service Worker, Android 설치 프롬프트, iOS 홈화면 추가 가이드
- **백엔드:** Google Apps Script (`doGet` 핸들러)
- **데이터:** Google Sheets (6개 시트: 교육 신청서, 도서 신청서, 웹페이지관리, 관리자, Flow자동발송이력, 게시판)
- **메신저 연동:** Flow API (`flow.emro.co.kr/MGateway`)
- **배포:** GitHub Pages (`deploy.js`), `@google/clasp` 으로 GAS 배포

## 4. API 인터페이스

**Base URL:** `https://script.google.com/macros/s/AKfycby8_T37FXsohyVrIKStEIaV2DYenigsBb8WQ4OPI1FTroQRPCFZKOo5g7cdG9BfGqCO/exec`

| 기능 | Endpoint (GET) | 응답 | 비고 |
|------|----------------|------|------|
| Bizplay 로그인 | `?action=bizplayAuth&bizUserId={ID}&bizPwd={PW}&savePw={bool}` | `{status,token,userName,session}` | SSO 로그인 + UUID 발급 |
| 데이터 조회 | `?token={UUID}` | `{userInfo, myHistory, adminStats?}` | 관리자인 경우 adminStats 추가 포함 |
| 교육 알람 설정 | `?action=updateAlarm&token={UUID}&isAgreed={true/false}` | `{status:"success"}` | 웹페이지관리 B열 |
| 밥카 알람 설정 | `?action=updateCardAlarm&token={UUID}&isAgreed={true/false}` | `{status:"success"}` | 웹페이지관리 G열 + I열 |
| 잔액 알림 설정 | `?action=saveCardDailyAlarm&token={UUID}&isAgreed={true/false}` | `{status:"success"}` | 웹페이지관리 G열 (Y/N), J열 PW 미터치 |
| 밥카 사용내역 | `?action=cardRecords&token={UUID}&fromDt=&toDt=` | `{status,records,totalCount}` | webank API 프록시 |
| 밥카 결재 | `?action=cardApproval&token={UUID}&mode={temp/approve}&selectedRecords={JSON}` | `{status,message}` | 임시저장 또는 결재요청 |
| Bizplay 세션 로그인 | `?action=bizplayLogin&token={UUID}&bizUserId=&bizPwd=` | `{status,session}` | 밥카 탭 내 재로그인 |
| 교육 임시저장 | `?action=bizplayDraft&token={UUID}&...` | `{status,message}` | Bizplay 교육 신청서 임시저장 |
| 잔액 정보 발송 | `?action=sendBalanceInfo&token={UUID}&targetKnoxId={사번}` | `{status:"success"}` | 관리자 전용, Flow 발송 |
| 게시판 목록 | `?action=boardList&token={UUID}` | `{status,posts[]}` | 전체 목록 + 본인 반응 상태 |
| 게시판 글쓰기 | `?action=boardWrite&token={UUID}&content={텍스트}` | `{status:"success"}` | 익명, 1~200자 |
| 게시판 반응 | `?action=boardReact&token={UUID}&postId={ID}&type={like/dislike}` | `{status,likes,dislikes,myReaction}` | 좋아요/싫어요 토글 |
| 게시판 답변 | `?action=boardReply&token={UUID}&postId={ID}&reply={텍스트}` | `{status,reply}` | 관리자 전용, 1~200자 |
| 기안문서 목록 | `?action=bizplayDraftList&token={UUID}` | `{status,draftList[]}` | 최근 3개월, Bizplay r007 프록시 |
| 기안문서 상세 | `?action=bizplayDraftDetail&token={UUID}&apprSeqNo={NO}&paperSeqNo={NO}` | `{status,detail}` | r011 + 결재의견(appr_opinion_r001) |

### 데이터 조회 응답 구조

```json
{
  "userInfo": {
    "name": "홍길동",
    "isAdmin": false,
    "totalBudget": 500000,
    "usedBudget": 150000,
    "remainingBudget": 350000,
    "isAgreed": true
  },
  "myHistory": [
    {
      "date": "2025-01-15",
      "courseName": "[교육] React 실무",
      "cost": 100000,
      "status": "완료",
      "period": "2025.01~02"
    }
  ],
  "adminStats": {
    "totalConfirmed": 12000000,
    "totalPending": 3000000,
    "totalMemberCount": 120,
    "vendors": { "패스트캠퍼스": 5000000, "도서": 2000000 },
    "allUserList": [
      { "knoxId": "hong", "name": "홍길동", "dept": "개발팀", "used": 150000, "pending": 50000, "eduUsed": 100000, "bookUsed": 50000, "isOverLimit": false, "isZeroUsage": false }
    ],
    "allRecords": [
      { "knoxId": "hong", "name": "홍길동", "courseName": "[교육] React 실무", "cost": 100000, "status": "완료", "period": "2025.01~02", "date": "2025-01-15T00:00:00Z", "reqType": "교육" }
    ]
  }
}
```

## 5. Google Sheets 구조

| 시트명 | 용도 | 주요 컬럼 |
|--------|------|-----------|
| 교육 신청서 | 교육비 신청 데이터 | knoxId(J=9), 이름(K=10), 과정명(L=11), 기간(M=12), 교육구분(N=13), 목적(O=14), 업체(P=15), 금액(Q=16), 비용청구(R=17), 비고(S=18), 상태(T=19) |
| 도서 신청서 | 도서비 신청 데이터 | knoxId(J=9), 이름(K=10), 도서명(L=11), 금액(M=12), 상태(Q=16) |
| 웹페이지관리 | 사용자 관리 | knoxId(A=0), 교육알람동의(B=1), UUID(C=2), 최종로그인(D=3), 부서(E=4), 이름(G=6), 밥카알람(G열=col7), BizplayPW(H열=col8), 16일결재알람(I열=col9) |
| 관리자 | 관리자 권한 목록 | knoxId(A) |
| Flow자동발송이력 | 알림 발송 이력 | 문서번호(A), 일시(B), knoxId(C) |
| 게시판 | 익명 게시판 | ID(A=0), 내용(B=1), 날짜(C=2), 좋아요(D=3), 싫어요(E=4), 관리자답변(F=5) |

### 웹페이지관리 컬럼 상세 (GAS 상수 매핑)

| 컬럼 | 1-based | 0-based | GAS 상수 | 용도 |
|------|---------|---------|----------|------|
| A | 1 | 0 | `ADMIN_COL.KNOX_ID` | 사번 |
| B | 2 | 1 | `ADMIN_COL.AGREE` | 교육비 알람 동의 (Y/N) |
| C | 3 | 2 | `ADMIN_COL.UUID` | 세션 토큰 |
| D | 4 | 3 | `ADMIN_COL.LAST_LOGIN` | 최종 로그인 시각 |
| E | 5 | 4 | `ADMIN_COL.DEPT` | 부서 |
| F | 6 | 5 | — | (예비) |
| G | 7 | 6 | `ADMIN_COL.NAME` / `CARD_ALARM_COL` | 이름 / 밥카 잔액알림 (Y/N) |
| H | 8 | 7 | `CARD_DAILY_COL` | Bizplay 암호화 PW (잔액알림 + 자동로그인) |
| I | 9 | 8 | `CARD_16_ALARM_COL` | 밥카 16일 결재알림 (Y/N) |

## 6. 사용자 대시보드 (`dev-edu-book-dashboard.html`)

### A. 인증 및 세션 관리

- **로그인 화면:** Bizplay ID/PW 입력, 비밀번호 저장(자동로그인) 체크박스
- **Bizplay SSO 인증:** GAS 프록시로 Bizplay 로그인 → UUID 토큰 발급
- **자동 로그인:** `localStorage.token` 기반 토큰 자동 인증, Bizplay PW 저장 시 세션 자동 복원
- **URL 파라미터:** `?token=` 자동 저장, `?tab=card` 등 탭 직접 진입 지원

### B. 대시보드 메인

**잔액 요약 카드:**
- 사용 금액 (확정) / 남은 잔액 / 연간 한도 500,000원
- 프로그레스 바: 확정 사용(그라데이션 초록) + 진행중(빗금 패턴) + 잔액 3단 표시
- 진행중 금액 포함 시 서브텍스트로 합계 표시

**Flow 알람 토글:**
- 스위치 UI로 알람 수신 동의/해제
- 낙관적 UI 업데이트 + 실패 시 롤백
- 로딩 중 스피너 표시
- 토스트 알림으로 결과 피드백

**신청 내역:**
- 데스크탑: 테이블 뷰 (No, 기간, 과정명, 금액, 상태)
- 모바일(640px 이하): 카드 뷰로 자동 전환
- 상태 배지: 완료/승인(초록), 반려(빨강), 결재중/대기/진행(노랑), 기타(베이지)
- 빈 상태: 마스코트 이미지 + "신청 내역이 없어요" 안내

**교육비 신청 바로가기:**
- Bizplay 결재 시스템 외부 링크 (`approval.appplay.co.kr`)

### C. 탭 구성

| 탭 | 내용 |
|-----|------|
| 교육비 | 잔액 요약 + 알람 토글 + 신청 내역 + Bizplay 임시저장 |
| 밥카 | 법인카드 잔액 요약 + 결재/잔액 알림 토글 + 사용내역 + TOP5 통계 + 결재(임시저장/상신) |
| 게시판 | 익명 글쓰기 + 좋아요/싫어요 + 최신순/인기순 정렬 + 페이지네이션 + 관리자 답변 |
| 기안문서 | 기안 목록(최근 3개월) + 상세 보기(HTML 파싱) + 결재의견 표시 |

### D. 다크모드

- 헤더 🌙/☀️ 아이콘 버튼으로 토글
- CSS 변수 RGB triplet: `--c-surface`, `--c-surface2`, `--c-border`, `--c-accent` 등
- `html.dark` 클래스 추가 → `:root` / `html.dark` 블록에서 변수 전환
- FOUC 방지: `<head>` 내 인라인 스크립트로 localStorage 읽어 즉시 클래스 적용
- 하드코딩 Tailwind 임의값(`text-[#47635f]` 등)은 `html.dark .text-\[\#47635f\]` CSS 셀렉터로 오버라이드

### E. PWA

- `manifest.json` + `sw.js` (html/ 폴더, 빌드 시 dist/로 경로 보정 복사)
- Service Worker: 네트워크 우선 + 캐시 폴백, HTTP/HTTPS만 캐시
- Android: `beforeinstallprompt` → 헤더 ⬇️ 버튼으로 설치
- iOS: Safari 감지 → 홈화면 추가 3단계 가이드 토스트
- standalone 모드(PWA로 열었을 때)에서는 설치 버튼 숨김

### F. UX 디테일

- 스켈레톤 로딩 (시머 애니메이션)
- 마스코트 애니메이션 (인증 중 working.gif, 헤더 idle dance GIF)
- 5초 미조작 시 헤더 아이콘 → 댄스 애니메이션 전환
- 버튼 로딩 시 시머 효과 + 스피너
- 관리자인 경우 헤더에 '관리자' 링크 자동 표시
- 추천 버튼(🤝): HTML 포맷 토스트 + 닫기 버튼

## 7. 관리자 대시보드 (`dev-admin-dashboard.html`)

### A. 접근 제어

- 동일한 `edu_token` 기반 인증
- API 응답의 `userInfo.isAdmin` 여부로 접근 차단/허용
- 비관리자 접근 시 "접근 권한 없음" 화면 표시

### B. KPI 카드 (3열 그리드)

- **확정 금액:** 전체 완료 건 합계
- **진행중 금액:** 대기/진행 건 합계 (클릭 시 필터링)
- **잔여 예산:** 전체 한도 - 확정 - 진행중

### C. 예산 소진 게이지

- 이중 바: 확정(초록) + 진행중(빗금) 시각화
- 퍼센트 표시 + 전체 예산 합계

### D. 월별 리포트 (탭 전환)

- **금액 탭:** 월별 확정 금액 + 건수 (Bar Chart, 이중 Y축)
  - 누적/개별 월 보기 모드 전환
- **부서 탭:** 부서별 사용 금액 + 소진율 (Bar Chart)
- **비율 탭:** 교육/도서 비율 분석

### E. 필터링 시스템

- **검색:** 사번/이름 실시간 검색 (300ms 디바운스)
- **잔여 금액 범위 슬라이더:** 듀얼 레인지 (0~50만원)
- **태그 시스템:** 사용자, 월, 부서, 유형(교육/도서), 상태별 복합 필터
  - 차트 클릭으로 태그 자동 추가
  - 개별/전체 태그 제거

### F. 데이터 테이블

- **사용자 목록:** 사번, 부서, 이름, 확정, 진행중, 잔여, 상태, Flow 발송 버튼
  - 상태 배지: 정상(초록), 한도 임박(빨강, 45만 이상), 미사용(베이지)
  - 행 클릭 → 상세 내역 펼침
- **상세 내역:** 해당 사용자의 개별 신청 건 목록

### G. Flow 잔액 알림 발송

- 관리자가 특정 사용자에게 잔액 정보를 Flow 메신저로 발송
- `action=sendBalanceInfo` API 호출
- 발송 중 스피너 + 완료/실패 토스트 알림

## 8. GAS 백엔드

### A. `gas/code.gs` — 라우터 + 공통

**`doGet(e)` 액션 라우팅:**
1. `bizplayAuth`: Bizplay SSO 로그인 → UUID 토큰 발급 + PW 저장
2. `updateAlarm`: 교육비 알람 동의 Y/N
3. `updateCardAlarm`: 밥카 결재 알림 + 16일 알람 동의 (G열 + I열)
4. `saveCardDailyAlarm`: 잔액 알림 동의 (G열 Y/N, PW 미터치)
5. `bizplayLogin` / `bizplayDraft`: Bizplay 세션 로그인 / 교육 임시저장
6. `cardRecords`: 밥카 사용내역 조회 (webank 프록시)
7. `cardApproval`: 밥카 결재 제출 (임시저장/결재요청)
8. `sendBalanceInfo`: 관리자 → 사용자 잔액 Flow 발송
9. `boardList` / `boardWrite` / `boardReact` / `boardReply`: 게시판 CRUD
10. `bizplayDraftList`: 기안문서 목록 조회 (r007 프록시)
11. `bizplayDraftDetail`: 기안문서 상세 조회 (r011 + 결재의견 r001)
12. `token` 기본 조회: 교육+도서 병합 + 본인 내역 + 관리자 통계 + Bizplay 자동 세션 복원

**`onSpreadsheetChange(e)` — 자동 알림 트리거:**
- 교육/도서 신청서 "완료" 변경 감지 → 알람 동의 사용자에게 Flow 발송
- `Flow자동발송이력` 시트로 중복 방지

### B. `gas/card-babka.gs` — 밥카 모듈

| 함수 | 트리거 | 설명 |
|------|--------|------|
| `sendCardAlarmDay16()` | 매월 16일 9시 | I열 'Y' 사용자에게 결재 요청 알림 Flow 발송 |
| `sendCardAlarmDay18()` | 매월 18일 9시 | 미상신자 리마인더 발송 |
| `sendCardDailyBalance()` | 매일 평일 11시 | G열 'Y' + H열 PW 존재 사용자에게 잔액 Flow 발송 (공휴일 제외) |
| `handleUpdateCardAlarm()` | API | 결재 알림 토글 (G열 + I열) |
| `handleSaveCardDailyAlarm()` | API | 잔액 알림 토글 (G열 Y/N, PW 미터치) |
| `handleCardRecords()` | API | webank 사용내역 조회 (자동 재로그인 포함) |
| `handleCardApproval()` | API | webank 결재 제출 (r010 검증 → c004 저장) |

**밥카 기간 계산:** 매월 15일~다음달 14일, 영업일 × 10,000원 예산, 공휴일+근로자의날 제외

### C. `gas/board.gs` — 게시판

| 함수 | 설명 |
|------|------|
| `handleBoardList(adminRow, e)` | 전체 글 목록 조회 (본인 반응 상태 + 관리자 답변 포함) |
| `handleBoardWrite(adminRow, e)` | 익명 글 작성 (1~200자, sanitize) |
| `handleBoardReact(adminRow, e)` | 좋아요/싫어요 토글 (UUID 기반 중복 방지) |
| `handleBoardReply(adminRow, e)` | 관리자 답변 작성/수정 (관리자 시트 체크, 1~200자) |

- **컬럼 상수:** `BOARD_COL = { ID: 0, CONTENT: 1, DATE: 2, LIKES: 3, DISLIKES: 4, REPLY: 5 }`
- **좋아요/싫어요:** D/E열에 UUID 쉼표 구분 리스트 저장, 토글 방식
- **관리자 답변:** F열에 덮어쓰기 (작성/수정 동일 엔드포인트)

### D. `gas/edu-bizplay.gs` — Bizplay SSO

- Bizplay 로그인 → weAuth SSO → approval/webank 쿠키 획득
- `fetchWithCookies` 헬퍼: 리다이렉트 + 쿠키 누적 수동 처리
- 세션 ScriptProperties 저장 (`bizplay_{knoxId}`)
- 상세 스펙: `spec/bizplay-spec.md` 참조

### E. Flow 메신저 연동

- **API:** `https://flow.emro.co.kr/MGateway`
- **봇 ID:** helpdesk
- **발송 내용:** 결재 완료 알림, 밥카 결재 요청, 잔액 안내, 교육비 잔액

## 9. 디자인 시스템

| 토큰 | 값 | 용도 |
|------|-----|------|
| surface | `#f1fbf7` | 카드 배경 |
| surface-2 | `#e2f5ef` | 입력/보조 배경 |
| border | `#ccebe2` | 테두리 |
| accent | `#2d8a7e` | 주요 버튼/강조 |
| edu | `#059669` | 완료/성공 |
| warn | `#d97706` | 대기/진행 |
| danger | `#dc2626` | 반려/에러 |
| pend | `#b98e72` | 진행중(잠정) |
| 배경 | `#fff7ee` | 페이지 배경 (연한 크림) |
| 텍스트 | `#47635f` | 기본 텍스트 |
| 보조텍스트 | `#6e7f7b` | 서브/라벨 텍스트 |

## 10. 로컬 개발 가이드

### A. 초기 설정

```bash
# 1. 저장소 클론
git clone https://github.com/duk9/emroEduDashboard.git
cd emroEduDashboard

# 2. develop 브랜치로 전환 (개발 브랜치)
git checkout develop

# 3. 의존성 설치
npm install

# 4. GAS 인증 (최초 1회, Google 계정 로그인 필요)
npm run gas:login
```

### B. 브랜치 전략

| 브랜치 | 용도 |
|--------|------|
| `develop` | 개발 작업 브랜치 (dev-*.html 파일 편집) |
| `main` | 안정 버전, PR 대상 브랜치 |

### C. 프론트엔드 개발

개발 시에는 `dev-` 접두사가 붙은 파일을 직접 편집한다.

| 편집 대상 | 설명 |
|-----------|------|
| `dev-edu-book-dashboard.html` | 사용자 대시보드 |
| `dev-admin-dashboard.html` | 관리자 대시보드 |

**로컬 실행 방법:**
- 단일 HTML 파일이므로 별도 서버 없이 브라우저에서 직접 열어 확인 가능
- 또는 VS Code의 Live Server, IntelliJ 내장 서버 등 사용
- dev 파일은 GAS **개발 배포 URL** (`devDeploymentId`)을 사용하므로 API가 정상 동작함

**개발 시 주의:**
- `dev-*.html` 파일의 `API_URL` 상수는 `.clasp.json`의 `devDeploymentId` 기반 URL을 사용
- 배포 파일(`edu-book-dashboard.html`, `admin-dashboard.html`)은 **직접 편집하지 않음** — 빌드 스크립트가 자동 생성
- `.gitignore`에 배포 파일(`edu-book-dashboard.html`)이 포함되어 있어 dev 저장소에는 커밋되지 않음

### D. GAS 백엔드 개발

```bash
# code.gs 수정 후 개발 환경에 푸시
npm run gas:push        # gas/code.gs → GAS 프로젝트에 업로드 + 개발 배포 갱신

# GAS 편집기 열기
npm run gas:open

# GAS 실행 로그 확인
npm run gas:logs
```

- `gas/code.gs`를 편집한 후 `npm run gas:push` 실행
- 개발 배포(`devDeploymentId`)가 자동 갱신되어 dev HTML에서 바로 테스트 가능

### E. `.clasp.json` 구조

```json
{
  "scriptId": "GAS 프로젝트의 스크립트 ID",
  "rootDir": "./gas",
  "devDeploymentId": "개발 배포 ID (dev HTML이 사용하는 API)",
  "deploymentId": "운영 배포 ID (빌드 시 prod HTML에 주입)"
}
```

> `.clasp.json`은 `.gitignore`에 포함되어 있으므로 각 개발자가 로컬에서 직접 설정해야 한다.

## 11. 운영 배포 가이드

### A. 전체 배포 흐름

```
dev-*.html 편집
    ↓
npm run build          ← JS 난독화 + CSS/HTML 압축 + API URL 운영 전환
    ↓
edu-book-dashboard.html / admin-dashboard.html 생성
    ↓
npm run deploy         ← 배포 전용 저장소에 push → GitHub Pages 자동 반영
```

### B. 프론트엔드 배포

```bash
# 빌드만 실행 (로컬 확인용)
npm run build

# 빌드 + 배포 저장소에 푸시 (한 번에 실행)
npm run deploy
```

**`npm run build` 수행 내용 (`build.js`):**

1. `dev-edu-book-dashboard.html` → `edu-book-dashboard.html`
2. `dev-admin-dashboard.html` → `admin-dashboard.html`
3. GAS API URL을 개발용(`devDeploymentId`) → 운영용(`deploymentId`)으로 치환
4. 인라인 JS: `console.*` 제거 → `javascript-obfuscator`로 난독화 (controlFlowFlattening, stringArray 등)
5. 인라인 CSS: `clean-css` Level 2 압축
6. 전체 HTML: `html-minifier-terser`로 압축
7. 파일 내 상호 링크를 `dev-*.html` → 배포 파일명으로 치환
8. 빌드 검증: 주요 함수/요소 존재 여부 자동 체크

**`npm run deploy` 수행 내용 (`deploy.js`):**

1. `npm run build` 실행
2. 배포 전용 저장소 (`https://github.com/RosaRosaKim/edu-book-dashboard.git`) 를 임시 디렉토리에 클론
3. 빌드된 `edu-book-dashboard.html`, `admin-dashboard.html`을 복사
4. 변경 사항이 있으면 커밋 + 푸시 → GitHub Pages 자동 반영
5. 임시 디렉토리 정리

> 배포 전용 저장소(`RosaRosaKim/edu-book-dashboard`)와 개발 저장소(`duk9/emroEduDashboard`)는 **별도 저장소**이다.

### C. GAS 백엔드 배포

```bash
# 개발 배포 (dev HTML이 바라보는 API 갱신)
npm run gas:push

# 운영 배포 (prod HTML이 바라보는 API 갱신)
npm run gas:deploy
```

**`npm run gas:deploy` 수행 내용 (`deployGAS.js --deploy`):**

1. `.clasp.json`의 `scriptId`, `deploymentId` 검증
2. `gas/code.gs`를 GAS 프로젝트에 푸시 (`clasp push`)
3. `deploymentId` 기반 운영 배포 갱신 (`clasp deploy -i {deploymentId}`)
4. 운영 URL 출력

### D. 배포 체크리스트

```
프론트엔드 배포:
  [ ] dev-*.html 에서 변경 사항 확인 (브라우저 테스트)
  [ ] npm run build — 빌드 성공 + 검증 통과 확인
  [ ] 빌드된 파일 브라우저 확인 (난독화 후에도 정상 동작하는지)
  [ ] npm run deploy — 배포 저장소 푸시 완료

GAS 백엔드 배포:
  [ ] gas/code.gs 변경 사항 확인
  [ ] npm run gas:push — 개발 환경 테스트
  [ ] dev HTML에서 API 정상 동작 확인
  [ ] npm run gas:deploy — 운영 배포
  [ ] 운영 HTML에서 API 정상 동작 확인
```

### E. 주요 npm 스크립트 요약

| 명령어 | 설명 |
|--------|------|
| `npm run build` | dev HTML → 운영 HTML 빌드 (난독화 + 압축 + URL 치환) |
| `npm run deploy` | 빌드 + 배포 저장소에 푸시 (GitHub Pages 반영) |
| `npm run gas:login` | Google 계정으로 clasp 인증 (최초 1회) |
| `npm run gas:push` | code.gs → GAS 개발 배포 갱신 |
| `npm run gas:deploy` | code.gs → GAS 운영 배포 갱신 |
| `npm run gas:open` | GAS 편집기 브라우저에서 열기 |
| `npm run gas:logs` | GAS 실행 로그 조회 |

## 12. 기타 참고

- **구글시트:** https://docs.google.com/spreadsheets/d/1DT_TIc-nHBiKxWE7kZHK-6XNqtgyTXiWu0R7LIE2aa0/edit?gid=0#gid=0
- **교육비 신청:** https://approval.appplay.co.kr/appr/gate/appr_doc_layout2.act (Bizplay)
- **개발 저장소:** https://github.com/duk9/emroEduDashboard.git
- **배포 저장소:** https://github.com/RosaRosaKim/edu-book-dashboard.git (GitHub Pages)
- **연간 한도:** 1인당 500,000원 (`LIMIT_BUDGET` 상수)
- **교육+도서 통합:** 교육 신청서와 도서 신청서를 병합하여 단일 예산으로 관리

## 13. 법인카드(밥카) 탭 — `html/card-babka.html`

### 기간 및 예산
- **기간:** 매월 15일 ~ 다음달 14일
- **예산:** 영업일 × 10,000원 (주말 + 공휴일 + 근로자의날 제외)
- **초과 사용 가능** (잔액이 음수가 될 수 있음)
- **교통비 제외:** 사용처에 '티머니 버스', '티머니 지하철' 포함 시 필터링

### UI 구성
- **잔액 요약 카드:** 사용 금액 / 남은 잔액 / 기간 / 영업일 / 프로그레스 바
- **알림 토글 2개:**
  - 결재 알림 — 매월 16일 결재 요청 알림 (I열 = `CARD_16_ALARM_COL`)
  - 잔액 알림 — 평일 10~11시 잔액 Flow 발송 (G열 = `CARD_ALARM_COL`, PW 필요)
- **사용내역:** 현재월 테이블/카드 뷰 + TOP5 사용처 통계 (6개월)
- **결재 버튼 2개:** 임시저장 / 결재요청

### 알림 정책
| 토글 | 시트 컬럼 | ON/OFF 방식 | 실제 발송 조건 |
|------|-----------|-------------|---------------|
| 결재 알림 | I열 (Y/N) | 토글 직접 변경 | I열 'Y' |
| 잔액 알림 | G열 (Y/N) | 토글 직접 변경 (PW 미터치) | G열 'Y' AND H열 PW 존재 |

- **H열 PW:** 로그인 시 "비밀번호 저장" 체크 여부로만 관리 (잔액 알림 OFF 시 삭제하지 않음)

### webank API 연동
- Bizplay SSO → weAuth → webank 쿠키 획득 → 카드 내역 API 호출
- 자동 재로그인: 세션 만료 시 저장된 PW로 재시도
- 결재 제출: r010 검증 → c004 저장 (임시저장/결재요청)
- 상세 스펙: `spec/bizplay-spec.md` 참조

## 14. 게시판 탭 — `html/edu-board.html`

### 기능 개요
- 익명 글쓰기 + 좋아요/싫어요 반응 + 관리자 답변

### UI 구성
- **안내 문구:** "익명이야! 그래서 수정,삭제도 못해"
- **글쓰기 폼:** textarea (200자 제한) + 글자수 카운터 + 올리기 버튼
- **정렬 토글:** 최신순(ID desc) / 인기순(likes-dislikes desc, 동점 시 최신 우선)
- **글 카드:** 내용 + 날짜(상대시간) + 좋아요/싫어요 버튼 + 관리자 답변 영역
- **관리자 답변:** 좌측 accent 보더 + 연한 배경, 관리자인 경우 답변 textarea + 작성/수정 버튼 표시
- **페이지네이션:** 10개씩 표시, "더보기" 버튼으로 추가 로드

### 프론트엔드 상태 관리
- `_allPosts[]`: 서버에서 받은 전체 목록 로컬 캐시
- `_sortMode`: 'latest' | 'popular'
- `_displayedCount`: 현재 화면에 표시된 개수
- `PAGE_SIZE`: 10
- `reactPost` 성공 시 `_allPosts` 로컬 업데이트 (전체 재조회 안 함)
- `replyPost` 성공 시 `_allPosts` 로컬 업데이트 후 재렌더
- `window._isAdmin`: 대시보드 로그인 시 설정되는 전역 플래그

## 15. 기안문서 탭 — `html/edu-draft.html`

### 기능 개요
- Bizplay 전자결재 기안문서 목록 조회 + 상세 보기 + 결재의견 표시
- 최근 3개월 기안문서를 카드 리스트로 표시, 클릭 시 상세 내용 렌더링

### UI 구성

**목록 뷰:**
- 상태별 카드 색상: 완료/승인(초록), 반송/반려(빨강), 진행중(파랑), 기본(회색)
- 좌측 상태 바(3px) + 배경색 + 문서번호/제목/기안일/최종결재자
- `_draftMap` 로컬 캐시로 목록 데이터를 상세 뷰에 전달

**상세 뷰:**
- 헤더: 문서번호, 제목, 기안일, 상태 배지, 금액
- 결재의견 (본문 상단): 반송/반려 시 빨간색, 일반 의견은 파란색 카드
  - 의견자 이름, 부서/직급 배지, 날짜, 의견 본문
- 본문 HTML: `parseDraftHtml()` 함수로 파싱

### HTML 파싱 (`parseDraftHtml`)

**결의서 문서 (cardbill/expreport):**
- 전용 카드 UI로 변환 (기존 로직 유지)

**일반 문서 (`_parseGenericDoc`):**
- 모든 HTML 속성 제거 (colspan/rowspan만 보존)
- base64 이미지 제거
- 테이블 → 카드 UI 변환 (`_tblToCards`)
  - 멀티-로우 헤더 감지 (rowspan/colspan 그리드 알고리즘)
  - 데이터 행 → 번호 배지 + key-value flex 카드
  - 합계 행 자동 감지 (하단 bold/합계 텍스트)
- 빈 요소 제거
- ★ 섹션 헤더 자동 감지 → `.draft-section-hdr` 클래스 적용

### Bizplay API

| API | 용도 | 주요 파라미터 |
|-----|------|--------------|
| `appr_r007.jct` | 기안문서 목록 | ST/EN_DRAFT_DATE, PG_NO, PG_PER_CNT |
| `appr_r011.jct` | 기안문서 상세 | APPR_SEQ_NO, PAPER_SEQ_NO |
| `appr_opinion_r001.jct` | 결재의견 조회 | APPR_SEQ_NO |

**결재의견 응답 (`APPR_OPINION_REC[]`):**
- `USER_NM`: 의견자 이름
- `DVSN_NM`: 부서명
- `RSPT_NM`: 직급명
- `OPINION`: 의견 본문
- `OPINION_DATE` + `OPINION_TIME`: 작성 일시 (yyyyMMdd + HHmm)

### CSS (`css/draft.css`)
- 상태별 카드 배경/바 색상 (light + dark)
- `.draft-content` 스코핑: 테이블, 리스트, 코드, 헤딩, ★ 섹션 헤더
- Bizplay 에디터 고정폭 컨테이너 무력화 (`width: auto !important`)
- 반응형 테이블 (border-collapse, auto table-layout)

## 16. 메시지 톤 & 스타일

- **전체 반말 모드**: 프로젝트 내 모든 사용자 대상 메시지(UI 텍스트, 에러 메시지, 알림, 토스트 등)는 반말로 작성
  - 예: "로그인이 필요합니다" → "로그인이 필요해", "재로그인 해주세요" → "재로그인 해줘", "완료되었습니다" → "완료됐어"
- 존댓말(~합니다, ~습니다, ~해주세요 등) 사용 금지
- 코드 주석, 스펙 문서 등 개발자 대상 텍스트는 해당 없음

## 17. 추후 구현 예정 아이디어

- 동료 교육 추천 기능 (🤝 버튼 → 동료 Bizplay 임시저장으로 전송) — UI만 구현, "곧 추가될 기능" 안내 표시 중
