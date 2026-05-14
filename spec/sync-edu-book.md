# 교육/도서 신청서 자동 동기화

## 개요
Bizplay 전자결재 API에서 교육 신청서, 도서 신청서 데이터를 가져와 Google Sheets에 자동 동기화.
영업일 오후 1시 트리거로 매일 실행.

## 파일
- `src/gas/sync-edu.gs` - 동기화 모듈 전체
- `src/gas/flow-messages.gs` - `FLOW_MSG.syncFail()` (동기화 실패 알림)

## 실행 흐름

### 1. 트리거 발동 (`syncAllRequests`)
- 매일 오후 1시 시간 기반 트리거
- 주말 + 공휴일(`_isHolidayServer`) 스킵

### 2. 로그인
- 관리자 시트에서 C열="교육" 행 찾기
- A열: Knox ID, B열: 암호화 비밀번호(`enc1:...`), D열: Bizplay ID
- `_decryptPw()`로 복호화 → `_bizplayLoginCore()`로 Bizplay SSO 로그인
- 로그인 실패 시 관리자 시트 전원에게 `FLOW_MSG.syncFail()` 발송

### 3. 데이터 조회
- Bizplay approval API (`appr_paper_item_r001.jct`) 호출
- 교육: `PAPER_SEQ_NO = '79697428'`
- 도서: `PAPER_SEQ_NO = '16206240'`
- 조회 기간: 오늘 기준 30일 전 ~ 오늘

### 4. 파싱 (`_parseEduRecords` / `_parseBookRecords`)
- API REC 배열 → 시트 컬럼 순서로 변환
- 동일 문서번호 중복 시 완료(APPR_STS=3) 건 우선

### 5. Upsert (`_writeEduRows` / `_writeBookRows`)
문서번호(G열) 기준:
| 시트 기존 상태 | 들어온 데이터 | 동작 |
|---|---|---|
| 없음 (신규) | any | 삽입 |
| 완료 | any | **스킵** (덮어쓰지 않음) |
| 완료 아님 | any | 기존 삭제 → 새 행 삽입 |

### 6. Flow 발송 (`_sendCompletionFlow`)
완료 전환된 문서에 대해:
1. **Flow자동발송이력** 시트에서 문서번호 조회
2. 이미 이력에 있으면 스킵
3. 웹페이지관리 시트에서 수신동의 확인 → "Y"면 `sendFlowMsg` 발송
4. 발송 여부 무관하게 **이력 항상 기록** (중복 발송 방지)

### 7. 이력 정리 (`_cleanupFlowHistory`)
- `syncAllRequests` 시작 시 실행
- B열(발송일시) 기준 90일(3개월) 이전 행 자동 삭제

## 시트 구조

### 교육 신청서 (26열, A-Z)
```
작성일시, 기안자, 사원번호, 부서, 직위(직급), 문서명, 문서번호,
제목, 부서명, 녹스ID, 성명, 교육과정명, 기간,
교육기관, 교육구분, 교육 목적 및 내용, 비용, 비용 청구 방식, 비고,
결재상태, 완료일시, 최근결재자, 다음결재자, 최종결재자, 첨부, 메모
```

### 도서신청서_test (23열, A-W)
```
작성일시, 기안자, 사원번호, 부서, 직위(직급), 문서명, 문서번호,
제목, 부서명, 녹스ID, 성명, 도서명, 비용, 구입목적, 도서목차, 비고,
결재상태, 완료일시, 최근결재자, 다음결재자, 최종결재자, 첨부, 메모
```

### Flow자동발송이력 (3열)
```
문서번호, 발송일시, 녹스ID
```

## doGet 액션
- `adminAutoLogin` → `handleAdminAutoLogin()` - 관리자 자동 로그인
- `adminSyncEdu` → `handleAdminSyncEdu()` - 교육신청서 동기화 (웹에서 호출)
- `adminSyncBook` → `handleAdminSyncBook()` - 도서신청서 동기화 (웹에서 호출)

## 결재상태 매핑
| APPR_STS | 상태 |
|---|---|
| 9 | 진행 |
| 2 | 진행 |
| 3 | 완료 |
| 4 | 반송 |
| 5 | 취소 |
