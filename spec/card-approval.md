# 밥카(법인카드) 결재 플로우

## 전체 흐름 (handleCardApproval)

```
1. Bizplay SSO → Webank 쿠키 획득
2. 카드 사용내역 조회 (card_list_0002_r001.jct)
3. 날짜 매칭 → 결재 대상 선별
4. eapr_1001_01.act 로드 → eaprForm 파싱 (PAPER_SEQ_NO=101 등)
5. rcptRec 생성 (영수증 데이터 매핑)
6. r010 검증 호출 → 결재라인 세팅
7. c004 저장/결재 호출
```

## 임시저장 vs 결재요청

| 구분 | 임시저장 (mode=temp) | 결재요청 (mode=approve) |
|------|---------------------|----------------------|
| TEMP_APPR_YN | 'Y' | 'N' |
| r010 REC | 없음 | 결재라인 REC 전달 |
| c004 APPRLINE_REC | 없음 | r010 응답에서 전달 |
| 사전 호출 | 없음 | bizplayApprLine (결재라인 팝업) |

## r010 결재라인 전달 형식 (핵심!)

r010의 `REC` 필드에 **브라우저와 동일한 7개 필드만** 전달:
```json
[
  {"APPR_ORD":"1","APPR_USER_GB":"1","APPRLINE_KIND":"2","RECENT_SAVE_YN":"Y","BOTTOM_FIXED_YN":"N","DEPT_CD":"19","DEPT_NM":"재무그룹"},
  {"APPR_ORD":"0","APPR_USER_GB":"1","APPRLINE_KIND":"4","RECENT_SAVE_YN":"Y","BOTTOM_FIXED_YN":"N","DEPT_CD":"157","DEPT_NM":"관리그룹"}
]
```

### 주의사항
- 원본 USER_REC의 필드를 전부 보내면 안 됨 → `APPR_USER_DEPT_CD` 등 불필요 필드가 validation 오류 유발
- `DEPT_CD` fallback: `r.DEPT_CD || r.APPR_DEPT_CD` (PAPER_APPRLINE_REC 항목은 DEPT_CD 없고 APPR_DEPT_CD 사용)
- `DEPT_NM` fallback: `r.DEPT_NM || r.APPR_DEPT_NM`
- APPRLINE_KIND: 2=결재, 4=부서수신

## c004 결재라인 전달

r010 응답의 `APPRLINE_REC`을 c004에 **그대로** 전달:
```javascript
if (r010Data.APPRLINE_REC && r010Data.APPRLINE_REC.length > 0) {
  c004Json.APPRLINE_REC = r010Data.APPRLINE_REC;
}
```

## 결재라인 조회 (handleBizplayApprLine)

`gas/edu-bizplay.gs`에서 approval 서버로 조회:
1. `appr_doc_0001_01_r001.jct` → USER_REC + PAPER_APPRLINE_REC
2. APPRLINE_SEQ_NO=84768443 (사용자의 저장된 결재선)
3. 원본 데이터를 `_cardApprLine` 별도 프로퍼티에 저장

### APPRLINE_SEQ_NO 조회
- `apprline_list_0007.act` → HTML 파싱
- `apprline_r005.jct` → fallback
- PAPER_SEQ_NO: 교육비=79697428, 카드=101

## rcptRec 핵심 필드
| 필드 | 값 | 비고 |
|------|-----|------|
| BIZ_UNIT_ERP_CD | 'EX049' | 필수! 브라우저와 동일 |
| TRAN_KIND_CD | 'C0093' | 중식대(공통) |
| TRAN_KIND_ERP_CD | '54901' | |
| BIZ_UNIT | '41999' | 중식대 |
| CNTS_ID | 'CRD_MAGR_NEW' | 카드관리 신규 |

## 결재 제목 형식
`{월}월중식대({카드뒤4자리})` — 예: "3월중식대(0725)"

## 프론트엔드 플로우 (card-babka.html)

```
1. 📨 결재요청 클릭
2. bizplayApprLine 호출 → 결재라인 데이터 수신
3. showApprLinePopup() → 결재라인 확인 팝업
4. 확인 → cardApproval(mode=approve) 호출 → 전체 플로우 실행
5. 성공 → showConfirm('결재요청했어! 확인해볼까?') → 기안문서 탭 이동
```

## 디버깅 히스토리 (해결된 이슈)

| 증상 | 원인 | 해결 |
|------|------|------|
| 결재선이 존재하지 않습니다 (r010) | APPRLINE_SEQ_NO 미전달 | r010에 APPRLINE_SEQ_NO 추가 |
| APPRLINE_SEQ_NO 비어있음 | apprline_list_0007.act 500 | payload 간소화 + r005 fallback |
| 재무그룹 안 나옴 | r001에 잘못된 APPRLINE_SEQ_NO | HTML 파싱으로 올바른 SEQ_NO 추출 |
| NO_CACHE | step1과 bizplayApprLine 세션 동시 쓰기 | 별도 프로퍼티 `_cardApprLine` 사용 |
| RSLT_CD 3000 (2-step) | step 간 webank 세션 만료 | 2-step 제거, 단일 호출로 변경 |
| RSLT_CD 3000 (APPRLINE_REC) | c004에 직접 전달한 형식이 잘못됨 | r010 REC로 세션 세팅 후 r010 응답 사용 |
| CMS9001 APPR_USER_DEPT_CD | raw 필드 전체 전달 시 validation 오류 | 브라우저 형식 7개 필드만 전달 |
| CMS9001 DEPT_CD 비어있음 | PAPER_APPRLINE_REC은 APPR_DEPT_CD 사용 | DEPT_CD fallback: APPR_DEPT_CD |
| 결재선이 존재하지 않습니다 (c004) | c004에 APPRLINE_REC 미전달 | r010 응답의 APPRLINE_REC을 c004에 전달 |
