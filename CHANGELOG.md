# Changelog

## 2026-03-03 (v219)

### 밥카 식당평가 - 별점 → 추천/비추천 전환
- **별 5개 평가 시스템 제거**, 추천(⭐)/비추천(💩) 2버튼 시스템으로 단순화
- 추천 버튼: 연초록 배경, 선택 시 초록 채움 + 흰 글씨
- 비추천 버튼: 연빨강 배경, 선택 시 빨강 채움 + 흰 글씨
- 맛집 평가 랭킹: 평균 별점 → 추천율(%) 기반 정렬
  - 70% 이상 ♥ / 40~69% ― / 40% 미만 ✕ 표시
- **백엔드(GAS)**: `handleCardRatings`, `handleCardRate` 응답 구조 변경
  - 기존: `{ avg, count, myRating }` → 신규: `{ likes, dislikes, count, myRating }`
  - rating 값: 기존 1~5 → 신규 1(추천) 또는 0(비추천)
- **하위호환**: `normalizeRatings()` 함수로 구형 API 응답 자동 변환
- **데이터 마이그레이션**: `ensureRatingSheet()`에서 기존 별점(2~5) → 1(추천)로 자동 변환
- 시트 구조(사용처, knoxId, 평점, 날짜) 변경 없음, 평점 값만 변경

### 게시판 좋아요 아이콘 변경
- 좋아요 버튼 이모지: 💚(녹색하트) → 👍(엄지손가락)
- 렌더링 및 반응 업데이트 두 곳 모두 적용

### 토스트 메시지 - 마스코트 말풍선 개선
- 토스트 위치: 이벤트 요소 근처/화면 하단 → **헤더 마스코트 고양이 오른쪽 옆** 고정
- 말풍선 꼬리: 좌측 중앙(← 마스코트 방향)으로 배치
- 말풍선 내부 마스코트 이미지 제거 (텍스트만 표시)
- `transform-origin: left center`로 마스코트에서 펼쳐지는 스케일 효과
- **확인 다이얼로그(showConfirm)는 기존 이벤트 위치 유지** (변경 없음)

### 변경 파일
| 파일 | 변경 내용 |
|------|----------|
| `src/html/card-babka.html` | 별점→추천/비추 UI, CSS, 렌더링 로직 전면 개편 |
| `src/gas/card-babka.gs` | rating API 변경, 데이터 마이그레이션 추가 |
| `src/html/edu-board.html` | 좋아요 💚 → 👍 |
| `src/html/dev-edu-book-dashboard.html` | 토스트 HTML 구조 변경, showToast 위치 로직 변경 |
| `src/css/dashboard.css` | 말풍선 꼬리 방향 변경 (좌상단 → 좌측 중앙) |
