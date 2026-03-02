# Flow 메시지 관리

## 개요
Flow 메신저 알림 메시지를 `flow-messages.gs`에서 중앙 관리한다.

## 구조

### FLOW_LINK
| 키 | URL |
|---|---|
| DASHBOARD | `edu-book-dashboard.html` |
| CARD | `edu-book-dashboard.html?tab=card` |

### FLOW_MSG (6개)

| # | 키 | 용도 | 트리거 | 발송 대상 |
|---|---|---|---|---|
| 1 | `balanceInfo` | 교육비 잔액 안내 | 관리자가 수동 발송 (`sendBalanceInfo`) | 특정 사용자 |
| 2 | `approvalComplete` | 결재 완료 알림 | 시트 변경 트리거 (`onSpreadsheetChange`) | 신청자 |
| 3 | `approvalNotice` | 결재 완료 (레거시) | 레거시 프로세스 (`processAlarm`) | 신청자 |
| 4 | `cardDay15` | 밥카 결재 안내 | 15일 첫 영업일 (`sendCardAlarmDay15`) | 밥카 알람 동의자 전원 |
| 5 | `cardReminder` | 밥카 미결재 리마인더 | 15일부터 3번째 영업일 (`sendCardAlarmReminder`) | 미상신자 |
| 6 | `cardDailyBalance` | 밥카 잔액 알림 | 매 영업일 오전 (`sendCardDailyBalance`) | 밥카 알람 동의자 전원 |

### 메시지 내용

**#1 balanceInfo(used, remain, limit)**
```
[교육비 잔액 안내]
- 사용 금액: {used}원
- 잔여 금액: {remain}원
- 연간 한도: {limit}원
```

**#2 approvalComplete(reqType, docId, title, cost, totalUsed, remain)**
```
[{reqType} 결재 완료]
- 문서번호: {docId}
- 과정/도서명: {title}
- 금액: {cost}원
- 총 사용: {totalUsed}원
- 잔액: {remain}원
```

**#3 approvalNotice(title, cost, totalUsed, remain)**
```
과정: {title}
- 금액: {cost}원
- 총 사용: {totalUsed}원
- 잔액: {remain}원
```

**#4 cardDay15()**
```
밥값은 회사가, 결재는 내가! 🍚
```

**#5 cardReminder()**
```
아직 밥카 결재 안한 것 같아...
```

**#6 cardDailyBalance(remain, budget, used, count)**
```
밥카 잔액: {remain}원 / {budget}원 (사용 {used}원, {count}건)
```

## 발송 함수
- `sendFlowMsg(knoxId, msg)` — FLOW_MSG 객체를 받아 `sendFlowGAS()`로 발송
- `sendFlowGAS(userId, content, previewLink, previewTitle)` — Flow API 호출 (code.gs)

## 파일 의존 관계
```
flow-messages.gs  →  sendFlowGAS() (code.gs)
                  →  _fmtMoney()   (card-babka.gs)
code.gs           →  FLOW_MSG, sendFlowMsg()
card-babka.gs     →  FLOW_MSG, sendFlowMsg()
```
