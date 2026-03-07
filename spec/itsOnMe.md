# 이쏜미 (It's On Me) - 기능 설계

## 1. 기능 개요

엠로생활 탭에서 "이쏜미"를 선택하면 팀원들에게 커피/음료 주문을 받아 한번에 취합하는 기능.

### 가게 선택지
- **당산SKV1 바나프레소** — 메뉴 UI 제공 (바나프레소 API 직접 연동)
- **수동입력** — 커스텀 가게/메뉴 설정, 템플릿 저장/공유

### 기본 플로우
```
[생성자] 가게 선택 (바나프레소 or 수동입력)
  → 바나프레소: 바로 멤버 선택으로
  → 수동입력: 상호명 + 메뉴 설정 (템플릿 불러오기 가능)
  → 사용자 검색 & 선택 (로컬 캐시 기반 즉시 검색)
  → 마감시간 설정 (기본 20분)
  → Flow 알람 발송 + 템플릿 자동 저장

[수신자] Flow 메시지 내 "바로가기" 클릭
  → 메뉴 선택 화면 자동 진입
  → 바나프레소: 카테고리 필터 / 검색 / 즐겨찾기 / 이미지 썸네일
  → 수동입력: 등록된 메뉴 선택 or 직접 입력
  → 먹던대로(직전 주문) 원클릭 재선택 가능
  → 마감시간 전까지 변경 가능

[참여자] 주문 화면에서 +멤버 추가, +10분 시간 연장 가능

[마감 5분 전] 미선택자에게 리마인드 Flow 발송
[마감] 생성자에게 취합 결과 + 총금액 Flow 발송
```

---

## 2. 구현 상세

### 2-1. 사용자 검색 — 프리로드 방식

가게 선택 시 사용자 목록을 일괄 로드하여 로컬 캐시에 저장.
이후 검색은 네트워크 요청 없이 즉시 필터링.

- **인코딩 전송**: JSON → base64 → 문자열 반전 (Network 탭 평문 노출 방지)
- **디코딩**: 문자열 반전 → base64 → `TextDecoder`로 UTF-8 복원
- **API 폴백**: 캐시 실패 시 `searchBizFlowUsers` API로 개별 검색

### 2-2. 메뉴 데이터 — 바나프레소 API 직접 연동

`order.banapresso.com` API에서 메뉴/옵션 데이터를 직접 가져와 `ScriptProperties`에 캐싱.

**API 정보**:
- URL: `POST https://order.banapresso.com/query`
- 메뉴 쿼리 해시: `91D8843AB9D3C73B28F1043252C574AF`
- 옵션 쿼리 해시: 미확인 (영업시간에 확인 필요)
- `f_code: 200000`, `f_code_sub: 12600` (당산SK점)

**데이터 구조** (API 58개 컬럼 중 사용):
| 인덱스 | 필드 | 설명 |
|--------|------|------|
| 0 | nItem | 메뉴 ID |
| 1 | sItemDivision | 카테고리명 |
| 4 | sItem | 메뉴명 |
| 9 | sUserOption | 옵션 ID 문자열 |
| 10 | sImageUrl | 썸네일 이미지 URL |
| 18 | nCharge | 가격 |
| 27 | bSoldOut | 품절 여부 |
| 44 | bStopSell | 판매중지 여부 |

**음료 카테고리 필터**:
`커피`, `저당 & 제로슈가`, `디카페인 커피`, `논커피 라떼`, `주스 & 드링크`, `바나치노 & 스무디`, `티 & 에이드`

**캐싱**: `ScriptProperties` 9KB 제한 → 8000바이트 단위 분할 저장/읽기
**동기화 주기**: 주 1회 트리거 (월요일 오전 7시 권장)
**폴백**: GAS API 실패 시 `src/data/menu.json`, `src/data/refined_options.json` 정적 파일 사용

### 2-3. 메뉴 선택 UX (바나프레소)

**카테고리 필터**: 가로 스크롤 탭 (전체 / 즐겨찾기 / 커피 / 디카페인 / ...)
**메뉴 검색**: 상단 검색 입력창 (카테고리 필터와 동시 적용)
**즐겨찾기**: 하트 아이콘 토글, `localStorage`에 저장 (세션 간 유지)
- 즐겨찾기가 있으면 진입 시 즐겨찾기 탭 자동 선택
**이미지 썸네일**: 40x40 rounded, 없으면 자동 숨김
**먹던대로**: 직전 주문 이력 기반 원클릭 재선택 버튼

### 2-4. 수동입력

커스텀 가게/메뉴를 직접 설정하여 주문을 받는 기능.

**설정 화면**:
- 상호명 입력
- 메뉴 추가 (메뉴명 + 가격)
- 저장된 템플릿 불러오기 (전체 사용자 것 공유)

**템플릿 시스템**:
- "다음" 클릭 시 자동 저장 (구글시트 `이쏜미템플릿`)
- 모든 사용자의 템플릿이 목록에 표시 (다른 사람 것은 `by 이름` 표시)
- 즐겨찾기: ★ 아이콘 토글 (`localStorage` 저장)
- 정렬: 즐겨찾기 → 내 것 → 나머지
- 삭제: 본인 템플릿만 가능

**수신자 메뉴 선택**:
- 등록된 메뉴 목록에서 선택
- "메뉴판에 없으면 직접 입력" 자유 텍스트 옵션
- 카테고리 필터/검색 없음 (메뉴 수가 적으므로)

**데이터 저장**: 세션 마스터 I열(`CUSTOM_MENUS`)에 JSON 저장

### 2-5. 마감시간 트리거 + 리마인드
- **5분 폴링 트리거**: `everyMinutes(5)`로 상시 실행
- **마감 5분 전 리마인드**: 미선택자에게 Flow 알림 발송 (세션당 1회, `IOM_REMINDED` 프로퍼티로 중복 방지)
- **전원 선택 완료 시 즉시 마감**: 트리거 대기 없이 바로 마감

### 2-6. 데이터 저장소 — 구글시트 (3시트)

**`이쏜미` 시트 (세션 마스터)** — 1세션 1행:
| 열 | 인덱스 | 내용 |
|----|--------|------|
| A | 0 | 세션ID (UUID) |
| B | 1 | 생성자 knoxId |
| C | 2 | 생성자 이름 |
| D | 3 | 가게명 |
| E | 4 | 마감시간 (절대시각) |
| F | 5 | 상태 (open/closed) |
| G | 6 | 생성시각 |
| H | 7 | 총 인원수 |
| I | 8 | 커스텀 메뉴 JSON (수동입력 시) |

**`이쏜미응답` 시트 (수신자별 응답)** — 1수신자 1행:
| 열 | 인덱스 | 내용 |
|----|--------|------|
| A | 0 | 세션ID (FK) |
| B | 1 | 수신자 knoxId |
| C | 2 | 수신자 이름 |
| D | 3 | 선택 메뉴명 |
| E | 4 | 옵션 상세 |
| F | 5 | 가격 |
| G | 6 | 선택/수정 시각 |

**`이쏜미템플릿` 시트 (수동입력 템플릿)** — 1사용자+1가게 1행:
| 열 | 인덱스 | 내용 |
|----|--------|------|
| A | 0 | knoxId |
| B | 1 | 상호명 |
| C | 2 | 메뉴목록 JSON |
| D | 3 | 수정시각 |

### 2-7. Flow 딥링크

```
https://rosarosakim.github.io/edu-book-dashboard/edu-book-dashboard.html?tab=life&itsOnMe={sessionId}
```

라우팅: URL params → `sessionStorage` 임시 저장 → 로그인 확인 → `switchTab('life')` → `openItsOnMeOrder(sessionId)`

### 2-8. 취합 결과 메시지

같은 **메뉴+옵션** 조합 기준으로 그룹핑 + **총 금액** 표시:

```
1. 아이스 아메리카노 (샷 추가) 4,500원 x2
   - 김철수, 이영희

2. 바닐라 라떼 HOT (휘핑 추가) 5,000원 x1
   - 정수진

미선택 x1
   - 최동욱

총 금액: 14,000원
```

### 2-9. 시간 연장
- 참여자 누구나 +10분 연장 가능
- 이미 지난 마감시간이면 현재 시각 기준으로 +10분
- 연장 후 마감시간 즉시 UI 갱신
- `confirm()` 확인 다이얼로그 표시
- **발송자 본인이 아닌 참여자가 연장 시** → 발송자에게 Flow 알림 (`"{이름} 프로가 마감시간 {HH:mm}로 연장"`)

### 2-10. 멤버 추가
- 발송자뿐 아니라 **참여자 누구나** 추가 가능
- 주문 화면 상단 `+멤버` 버튼 → 이름 검색 → 추가
- 추가된 멤버에게 Flow 초대 메시지 자동 발송
- 기존 멤버와 중복 체크
- **발송자 본인이 아닌 참여자가 추가 시** → 발송자에게 Flow 알림 (`"{이름} 프로가 {추가된 이름} 추가"`)

### 2-11. 이전 발송내역
- 가게 선택 화면(Setup)에서 "이전 발송내역" 버튼
- 내가 발송한 최근 5개 세션 목록 (가게, 시간, 멤버 이름)
- 선택 시 해당 세션의 멤버를 자동으로 채움
- 데이터 소스: 이쏜미/이쏜미응답 시트 직접 조회

### 2-12. 선택 현황
- 주문 화면 상단에 `3/5명 선택완료` 현황 바 표시
- `+멤버`, `+10분` 액션 버튼 함께 배치

### 2-13. 데이터 정리
- 마감 후 1시간 뒤 세션 + 응답 데이터 삭제 (딥링크 접근용 유예)
- `_cleanupItsOnMe` 1회성 트리거로 자동 실행

---

## 3. GAS 액션

| 액션 | 핸들러 | 설명 |
|------|--------|------|
| `createItsOnMe` | `handleCreateItsOnMe` | 세션 생성 + Flow 발송 (customMenus 포함) |
| `getItsOnMe` | `handleGetItsOnMe` | 세션 정보 + 내 선택 + 먹던대로 + 현황 |
| `submitItsOnMeMenu` | `handleSubmitItsOnMeMenu` | 메뉴 선택/수정 (가격 포함) |
| `addItsOnMeMembers` | `handleAddItsOnMeMembers` | 멤버 추가 (참여자 누구나) |
| `extendItsOnMe` | `handleExtendItsOnMe` | 마감시간 연장 |
| `getBizFlowUserList` | `handleGetBizFlowUserList` | 사용자 목록 일괄 (인코딩) + 이전 세션 |
| `searchBizFlowUsers` | `handleSearchBizFlowUsers` | 사용자 개별 검색 (API 폴백) |
| `getBanapressoMenu` | `handleGetBanapressoMenu` | 캐시된 메뉴/옵션 반환 |
| `getItsOnMeTemplates` | `handleGetItsOnMeTemplates` | 전체 템플릿 목록 (ownerName, isMine 포함) |
| `saveItsOnMeTemplate` | `handleSaveItsOnMeTemplate` | 템플릿 저장/업데이트 (knoxId+상호명 upsert) |
| `deleteItsOnMeTemplate` | `handleDeleteItsOnMeTemplate` | 템플릿 삭제 (본인 것만) |
| `syncBanapressoMenu` | (트리거) | 바나프레소 API → 캐시 갱신 |
| `pollItsOnMeClose` | (5분 트리거) | open 세션 마감 + 5분전 리마인드 |

---

## 4. Flow 메시지

| 메시지 | 함수 | 제목 | 본문 |
|--------|------|------|------|
| 초대 | `itsOnMeInvite` | `☕ {이름} 프로가 메뉴 주문을 받고 있어` | `{가게} · {시간} 마감` + 링크 |
| 세션 변경 | `itsOnMeUpdate` | `☕ 이쏜미 {액션}` | `{이름} 프로가 {액션}` (멤버 추가, 시간 연장 시 발송자에게) |
| 마감 임박 | `itsOnMeReminder` | `⏰ {가게} 마감 5분 전!` | `아직 메뉴를 안 골랐어! {시간}에 마감이야.` |
| 취합 결과 | `itsOnMeSummary` | `☕ {가게} 주문 취합 ({N}명, {금액}원)` | 메뉴별 그룹핑 + 인원 + 총금액 |

---

## 5. 파일 구조

| 파일 | 역할 |
|------|------|
| `src/gas/its-on-me.gs` | 세션 CRUD, 멤버 추가, 시간 연장, 폴링, 템플릿 CRUD |
| `src/gas/banapresso-sync.gs` | 바나프레소 API 연동, 메뉴 캐싱 |
| `src/gas/flow-messages.gs` | 이쏜미 관련 Flow 메시지 정의 |
| `src/html/emro-life.html` | 프론트엔드 전체 (가게선택, 수동입력, 멤버선택, 메뉴선택, 옵션) |
| `src/data/menu.json` | 정적 메뉴 폴백 (8개) |
| `src/data/refined_options.json` | 정적 옵션 폴백 |

---

## 6. 테스트 모드 (운영 전 원복 필요)

`its-on-me.gs`에 4곳 주석처리됨 (본인 제외 로직):
1. **멤버 검색 본인 제외** (line ~38): `// if (knoxId.toLowerCase() === myKnox) continue;`
2. **사용자 목록 본인 제외** (line ~65): `// if (knoxId.toLowerCase() === myKnox) continue;`
3. **이전 멤버 본인 제외** (line ~99): `// if (rKnox.toLowerCase() === myKnox) continue;`
4. **Flow 발송 생성자 제외** (line ~167): `// if (allMembers[k].knoxId.toLowerCase() === creatorKnox.toLowerCase()) continue;`

---

## 7. 셋업 필요 항목

| 항목 | 상태 | 설명 |
|------|------|------|
| `pollItsOnMeClose` 트리거 | 수동 설정 필요 | GAS 편집기 → 트리거 → `everyMinutes(5)` |
| `syncBanapressoMenu` 트리거 | 수동 설정 필요 | 주 1회 월요일 오전 7시 |
| `syncBanapressoMenu` 최초 실행 | 수동 실행 필요 | img 필드 포함 캐시 워밍업 |
| 옵션 쿼리 해시 확인 | 미완 | 영업시간에 Network 탭에서 확인 필요 |
