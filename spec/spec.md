# 사내 교육비 조회 대시보드 — 기술 명세서

## 1. 프로젝트 개요

- **목적:** 사내 직원별 연간 교육비(한도 50만원) 사용 내역 및 실시간 잔액 조회 + 관리자 통합 관제
- **환경:** GitHub Pages (Static Hosting)
- **인증:** 사내 메신저 'Flow' 연동 6자리 OTP (3분 제한)
- **백엔드:** Google Apps Script (GAS) + Google Sheets

## 2. 파일 구조

| 파일 | 설명 |
|------|------|
| `dev-edu-book-dashboard.html` | 사용자 대시보드 (개발용) |
| `edu-book-dashboard.html` | 사용자 대시보드 (배포용, 난독화) |
| `dev-admin-dashboard.html` | 관리자 대시보드 (개발용) |
| `admin-dashboard.html` | 관리자 대시보드 (배포용, 난독화) |
| `gas/code.gs` | GAS 백엔드 (API + 자동 알림 트리거) |
| `gas/generateUUID.gs` | GAS 유틸리티 (UUID 일괄 생성) |
| `img/` | 정적 에셋 (파비콘, 마스코트 이미지, GIF 애니메이션) |

## 3. 기술 스택

- **프론트엔드:** 단일 HTML 파일, Tailwind CSS (CDN), Chart.js (관리자), Noto Sans KR + IBM Plex Mono
- **백엔드:** Google Apps Script (`doGet` 핸들러)
- **데이터:** Google Sheets (4개 시트: 교육 신청서, 도서 신청서, 웹페이지관리, 관리자)
- **메신저 연동:** Flow API (`flow.emro.co.kr/MGateway`)
- **배포:** GitHub Pages, `@google/clasp` 으로 GAS 배포

## 4. API 인터페이스

**Base URL:** `https://script.google.com/macros/s/AKfycby8_T37FXsohyVrIKStEIaV2DYenigsBb8WQ4OPI1FTroQRPCFZKOo5g7cdG9BfGqCO/exec`

| 기능 | Endpoint (GET) | 응답 | 비고 |
|------|----------------|------|------|
| 인증번호 발송 | `?action=sendCode&knoxId={사번}` | `{status:"success"}` | Flow 메신저로 6자리 OTP 발송 |
| 인증번호 검증 | `?action=verify&knoxId={사번}&authCode={6자리}` | `{status:"success", token:UUID}` | 3분 이내 검증, 성공 시 UUID 토큰 반환 |
| 데이터 조회 | `?token={UUID}` | `{userInfo, myHistory, adminStats?}` | 관리자인 경우 adminStats 추가 포함 |
| 알람 설정 변경 | `?action=updateAlarm&token={UUID}&isAgreed={true/false}` | `{status:"success"}` | 웹페이지관리 시트 실시간 업데이트 |
| 잔액 정보 발송 | `?action=sendBalanceInfo&token={UUID}&targetKnoxId={사번}` | `{status:"success"}` | 관리자 전용, 대상 사용자에게 Flow 발송 |

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
| 교육 신청서 | 교육비 신청 데이터 | knoxId(J), 이름(K), 과정명(L), 금액(Q), 업체(R), 상태(T) |
| 도서 신청서 | 도서비 신청 데이터 | knoxId(J), 이름(K), 도서명(L), 금액(M), 상태(Q) |
| 웹페이지관리 | 사용자/인증 관리 | knoxId(A), 알람동의(B), UUID(C), 최종로그인(D), 인증코드(E), 인증시각(F), 부서(G), 이름(I) |
| 관리자 | 관리자 권한 목록 | knoxId(A) |
| Flow자동발송이력 | 알림 발송 이력 | 문서번호(A), 일시(B), knoxId(C) |

## 6. 사용자 대시보드 (`dev-edu-book-dashboard.html`)

### A. 인증 및 세션 관리

- **로그인 화면:** Flow ID 입력 + `@emro.co.kr` 접미사 표시
- **2단계 인증:** Step1(ID 입력 → 인증요청) → Step2(6자리 OTP 입력 → 검증)
- **3분 카운트다운 타이머:** 만료 시 재전송 버튼 노출
- **자동 로그인:** `localStorage.edu_token` 기반 토큰 자동 인증
- **세션 복원:** `localStorage.edu_auth_session` 으로 Flow 앱 재진입 시 Step2 자동 복원
- **URL 토큰:** `?token=` 파라미터로 진입 시 자동 저장 후 URL 정리
- **에러 안내:** "인재성장파트 김우정 프로에게!" 문의 안내 표시

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

### C. UX 디테일

- 스켈레톤 로딩 (시머 애니메이션)
- 마스코트 애니메이션 (인증 중 working.gif, 헤더 idle dance GIF)
- 5초 미조작 시 헤더 아이콘 → 댄스 애니메이션 전환
- 버튼 로딩 시 시머 효과 + 스피너
- 관리자인 경우 헤더에 '관리자' 링크 자동 표시

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

## 8. GAS 백엔드 (`gas/code.gs`)

### A. `doGet(e)` — 웹 요청 처리

1. `action=sendCode`: 6자리 OTP 생성 → 시트 저장 → Flow 발송
2. `action=verify`: 인증코드 + 3분 유효성 검증 → UUID 토큰 발급
3. `action=updateAlarm`: 알람 동의 Y/N 시트 업데이트
4. `action=sendBalanceInfo`: 관리자 → 사용자 잔액 정보 Flow 발송
5. `token` 기본 조회: 교육+도서 데이터 병합, 본인 내역 + 관리자 통계 반환

### B. `onSpreadsheetChange(e)` — 자동 알림 트리거

- 교육/도서 신청서 시트 변경 감지
- 상태가 "완료"로 변경된 건 자동 감지
- 알람 동의한 사용자에게 Flow 메신저 자동 발송
- `Flow자동발송이력` 시트로 중복 발송 방지

### C. Flow 메신저 연동

- **API:** `https://flow.emro.co.kr/MGateway`
- **봇 ID:** helpdesk
- **발송 내용:** OTP 인증번호, 결재 완료 알림(과정명/금액/잔액), 잔액 안내

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

## 13. 법인카드(중식대 결재) 
- 15일부터 다음달 14일까지를 한 그룹으로 보면되고 15일부터는 이전에 사용한 내역을 비즈플레이를 통해 결재를 올려야함. 
- 법인카드는 교통카드로도 쓸수 있으며 이건 결재내역에 포함되면 안된다. 교통비로 판단하는 기준은 사용처에 티머니 버스, 티머니 지하철, 수신단계가 실시간 이면 교통비로 판단.
- 지출용도가 빈값인것만 대상
- 교육비의 flow 알람 수신 동의처럼 매달 16일에 '매월 16일에 밥카결재요청 알림' 을 추가 웹페이지관리의 I 열에 밥카알람수신여부(Y/N) 추가함. 여기에 데이터를 저장
- 밥카알람수신여부가 Y인 사용자가 있으면 매달 16일에 알람발송함. 밥카 결재진행할까요? link도 함께 보냄.
- 밥카알람수신여부가 Y인 사용자중 18일에도 결재상신 내역이 없으면 한번 더 발송함
- 밥카내역을 보려면 weAuth를 통해 https://webank.appplay.co.kr/rcard_main.act 로 진입.
- 법인카드 탭의 UI는 교육비와 동일하게 하면된다. 사용금액, 알람수신여부, 사용내역, 간편신청 그대로. 
- 법인카드는 기간별 1일당 1만원이며 주말, 공휴일은 제외인 영업일로만 계산하여 잔액을 계산하고 실제 사용금액은 초과하여 사용가능함에 유의

## 99. 추후 구현 예정 아이디어 
- 나의 교육이력내역을 동료에게 공유해서 쉽게 교육신청가능
- **각종 마감일 알림**: 밥카상신, 경비 등 각종 품의를 마감일까지 올리지 않앗따면 flow 로 알림
- 매월 1일 타임시트정보를 불러와 휴일근무수당 자동 신청
- 로그인을 2원화해야함. bizplay로 바로 로그인가능해야함. 나중에 flow 로그인은 없애야 할듯. 
- 결재요청 시 실제 결제요청이라는 하나의 서비스를 더 실행해야함
- 

## 100. 오류 
