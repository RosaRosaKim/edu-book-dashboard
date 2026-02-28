
# Bizplay 연동 스펙

## 개요

대시보드(`dev-edu-book-dashboard.html`)에서 Bizplay 전자결재 시스템에 교육 신청서를 임시저장하는 기능.
GAS(Google Apps Script)를 프록시로 사용하여 Bizplay SSO 로그인 → approval 세션 획득 → 임시저장 API 호출.

## 파일 구조

| 파일 | 역할 |
|------|------|
| `gas/edu-bizplay.gs` | GAS 백엔드 — SSO 로그인 + 임시저장 API |
| `gas/code.gs` | GAS 라우터 — `bizplayLogin`, `bizplayDraft` 액션 라우팅 |
| `html/edu-bizplay.html` | 프론트엔드 — 로그인 폼 + 신청서 폼 + JS |
| `dev-edu-book-dashboard.html` | 메인 대시보드 — edu-bizplay.html 동적 로드 |

## SSO 로그인 흐름 (handleBizplayLogin)

GAS에서 브라우저 동작을 재현하여 Bizplay → approval 세션을 획득한다.

### Step 1: Bizplay 로그인

```
POST https://www.bizplay.co.kr/login_proc_01.jct
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
User-Agent: Chrome UA (필수 — GAS 기본 UA는 앱 설치 페이지 유발)

Payload: _JSON_={USER_ID, PWD, USER_BR:"Chrome", LNGG_DSNC:"DF", ...}
Response: {RSLT_CD:"0000", USER_NM, USE_INTT_ID, ...}
Cookie: SCOUTER=...; JSESSIONID=...
```

### Step 2: POST /weAuth (SSO 인증)

**핵심 발견**: `/weAuth`는 단순 GET이 아닌 **POST with auth_srno + auth_val** 이 필요.
GET으로 호출하면 에러 9001 "실행할 앱 정보가 존재하지 않습니다" 반환.

```
POST https://www.bizplay.co.kr/weAuth
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Cookie: (Step 1의 쿠키)

Payload:
  auth_srno=88
  auth_val={"SVC_PTRN":"M","APP_TARG":"Y","RSVD1":"","RSVD2":"","RSVD3":"","RSVD4":"","RSVD5":""}
  STND_PAGE=https://www.bizplay.co.kr/weAuth
  quick_menu=&quick_param=&stup=

Response HTML 끝에 sendRdmKey 호출 포함:
  weAuthClient.sendRdmKey('https://approval.appplay.co.kr/appr/gate/appr_gate.jsp', 'B-xxxxxxxx-...');
```

**auth_srno=88**: 전자결재 앱 번호 (CNTS_ID: CNTS_370)

### Step 3: POST approval gate (RDM_KEY 전달)

```
POST https://approval.appplay.co.kr/appr/gate/appr_gate.jsp
Content-Type: application/x-www-form-urlencoded
Payload: RDM_KEY=B-xxxxxxxx-...

→ 리다이렉트 체인 따라가며 approval 쿠키 누적
→ 상대경로 리다이렉트(appr_doc_layout2.act) 처리 필요
```

### Step 4: 부서정보 파싱

```
GET https://approval.appplay.co.kr/appr/gate/appr_doc_layout2.act
Cookie: (Step 3의 approval 쿠키)

HTML에서 파싱:
  DVSN_CD → 부서코드 (예: "163")
  DVSN_NM → 부서명 (예: "엠로 D2S그룹")
  deptShort → DVSN_NM의 마지막 단어 (예: "D2S그룹")
```

### Step 5: 세션 저장

ScriptProperties에 저장 (키: `bizplay_{KNOX_ID}`):
```json
{
  "bizplayCookies": "SCOUTER=...; JSESSIONID=...",
  "approvalCookies": "JSESSIONID=...",
  "userId": "user@emro.co.kr",
  "userName": "박창환",
  "deptCd": "163",
  "deptNm": "엠로 D2S그룹",
  "deptShort": "D2S그룹",
  "useInttId": "UTLZ_2108121502820",
  "loginTime": "2026-02-28T..."
}
```

## 임시저장 흐름 (handleBizplayDraft)

### API 호출

```
POST https://approval.appplay.co.kr/appr_c002.jct
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Cookie: (저장된 approvalCookies)
User-Agent: Chrome UA

Payload: _JSON_={...}
```

### ITEM_REC 매핑 (교육 신청서 양식)

| SEQ | 필드 | 소스 |
|-----|------|------|
| 0 | 부서 | 세션 deptShort |
| 1 | 사번 | userId @ 앞부분 |
| 2 | 이름 | 세션 userName |
| 3 | 교육과정명 | 사용자 입력 |
| 4 | 교육기간 | ITVL_1=시작일(YYYYMMDD), ITVL_2=종료일 |
| 5 | 교육기관 | 사용자 입력 |
| 6 | 교육구분 | 온라인 / 오프라인 / 구독 |
| 7 | 교육 목적 및 내용 | 사용자 입력 |
| 8 | 금액 | 사용자 입력 (콤마 제거) |
| 9 | 횟수 | 사용자 입력 (기본 "1회") |
| 10 | 비고 | 사용자 입력 (선택) |

### 고정값

```
PAPER_SEQ_NO: "79697428"    (교육 신청서 양식 ID)
PTL_ID:       "PTL_3"
CHNL_ID:      "CHNL_1"
USE_INTT_ID:  세션에서
PROC_GB:      "1"           (임시저장. "2"=결재요청)
APPR_SUBJ:    "교육 신청서"
API_YN:       "Y"
```

## GAS 쿠키/리다이렉트 처리

### fetchWithCookies 헬퍼

GAS `UrlFetchApp`는 쿠키 자동전달/리다이렉트 쿠키 누적을 지원하지 않으므로 수동 구현:

- `followRedirects: false`로 요청
- 3xx 응답 시 Location 헤더 파싱 → 리다이렉트 따라감
- 각 홉에서 `Set-Cookie` 추출 → 쿠키 누적 (`mergeCookies`)
- POST → 3xx 시 GET으로 전환
- **리다이렉트 URL 해석**: 절대URL / 절대경로(`/`시작) / 상대경로 모두 처리

### User-Agent 필수

GAS 기본 UA(`Google-Apps-Script`)로 `/weAuth` 호출 시 앱 설치 페이지 반환.
Chrome UA 헤더를 모든 요청에 포함해야 정상 동작.

## 프론트엔드 (html/edu-bizplay.html)

### 구조

부모(`dev-edu-book-dashboard.html`)에서 동적 로드. 부모가 제공하는 전역:
`$`, `API_URL`, `TOKEN_KEY`, `gasFetch`, `setBtnLoading`, `showToast`, `records`

### 주요 함수

| 함수 | 역할 |
|------|------|
| `bizplayLogin()` | GAS bizplayLogin 호출 → SSO 성공 시 신청 폼 표시 |
| `showDraftForm()` | 부서/사번/이름 자동채움, 복사 버튼 표시 |
| `copyToForm(idx)` | 기존 신청내역 → 폼 자동채움 (과정명, 금액, 기간) |
| `submitBizDraft()` | 폼 유효성 검사 → GAS bizplayDraft 호출 → 결과 표시 |

### 세션 관리

- `localStorage.bizplay_id`: 마지막 로그인 ID (자동입력)
- `localStorage.bizplay_session`: SSO 세션 정보 (폼 자동채움용)
- 페이지 로드 시 저장된 세션 복원 → 폼 자동 표시

## 디버깅 히스토리

| 시도 | 문제 | 해결 |
|------|------|------|
| GET /weAuth | ERR 9001 "앱 정보 없음" | POST with auth_srno=88, auth_val 필요 |
| GAS 기본 UA | 앱 설치 페이지 반환 | Chrome User-Agent 헤더 추가 |
| fetchWithCookies 상대경로 | DNS 오류 (`http://appr_doc_layout2.act`) | 상대경로 → 절대URL 변환 로직 추가 |
| Set-Cookie 파싱 | 헤더 키 대소문자 불일치 | case-insensitive 헤더 탐색 |
| sendRdmKey 정규식 | 작은따옴표/큰따옴표 혼용 | `['"]` 패턴으로 확장 |

---

# 비즈플레이 원본 소스 참조

## weAuth 소스정보
<!DOCTYPE html>
<html>
    <head>
        <title>bizplay</title>
        <meta http-equiv="content-type" content="text/html; charset=utf-8"/>
        <meta http-equiv="Cache-Control" content="No-Cache"/>
        <meta http-equiv="Pragma" content="No-Cache"/>
        <script type="text/javascript" src="https://platform.bizplay.co.kr/js/weAuth/jquery-1.12.4.min.js" integrity="sha384-Z3BLeAip2X9WwCEc3M/oaQqqsAXf4moVeTprZvfVwcOSGVm5EVG0BevOPJk4mJhG" crossorigin="anonymous"></script>
        <script type="text/javascript" src="https://platform.bizplay.co.kr/js/weAuth/json2.js" integrity="sha384-bZIlE5PRvoU4VxXjlYVt/WZfLnfNkjwrPBC1YRc9GXsZ3QH+KrS30m6JOCsQ/XxP" crossorigin="anonymous"></script>
        <script type="text/javascript" src="https://platform.bizplay.co.kr/js/weAuth/weAuthClient.js?v=2026022813" integrity="sha384-MdJ4zj2dBqJDNznKwGHvrQiEQnm697bfs3tceY14IR1nySf7DRln2Oa75C+I4yJf" crossorigin="anonymous"></script>
        <style>
            img {
                display: block;
                margin: 15% auto;
            }
        </style>
    </head>
    <body>
        <form id="weAuthFrm" name="weAuthFrm" method="post">
            <input type="hidden" id="CNTS_URL" name="CNTS_URL"/>
            <input type="hidden" id="RDM_KEY" name="RDM_KEY"/>
        </form>
        <form id="weAuthErrorFrm" name="weAuthErrorFrm" method="post">
            <input type="hidden" id="CODE" name="CODE"/>
            <input type="hidden" id="LANG" name="LANG"/>
            <input type="hidden" id="SVC_PTRN" name="SVC_PTRN"/>
            <input type="hidden" id="ERR_TRACE" name="ERR_TRACE"/>
            <input type="hidden" id="CNTS_ID" name="CNTS_ID"/>
        </form>
        <img src="/img/loading/loading_auth.gif" alt="loading"/>
    </body>
</html>
<script>
    weAuthClient.sendRdmKey('https://approval.appplay.co.kr/appr/gate/appr_gate.jsp', 'B-c59cab38-ca7d-4bb0-a32a-bc064f8bff6e');
</script>

## 비즈플레이 교육신청서 관련 소스
/**
* <pre>
* APPROVAL PROJECT
* @COPYRIGHT (c) 2009-2012 WebCash, Inc. All Right Reserved.
*
* @File Name      : appr_dtl_0005.js
* @File path      : APPROVAL_PT_STATIC/web/js/appr
* @author         : 이하림 ( yarim@webcash.co.kr )
* @Description    : 결재문서 조회(POPUP API)
* @History        : 20150730102508, 이하림
* </pre>
**/
/***********************
* 변수정의
* g_menu_type(메뉴타입정의) :  P(개인) D(부서) A(접수) W(대기) H(보류) C(완료) T(임시) R(기안작성)
  ***********************/
  var g_ptl_id                  = "";
  var g_chnl_id                 = "";
  var g_use_intt_id             = "";
  var g_paper_seq_no            = "";
  var g_appr_seq_no             = "";
  var g_appr_sts                = "";
  var g_apprline_kind           = "";
  var g_basis_appr_seq_no = "";
  var g_dvsn_cd                 = "";
  var g_atch                    = "";
  var g_proc_gb                 = ""; // g_proc_gb  R:조회, C:등록, U:수정, P:PDF
  var g_user_id                 = "";
  var g_user_nm                 = "";
  var g_dept_cd                 = "";
  var g_dept_nm                 = "";
  var g_pos_nm                  = "";
  var g_paper_kind        = "";
  var g_paper_path        = "";
  var g_appr_cont_use_yn  = "";
  var g_menu_type               = "";
  var g_appr_mode               = "";
  var g_paper_nm                = "";
  var g_seal_use_yn       = "";
  var g_dsp_time_line_yn  = "";
  var g_user_appr_subj    = "";
  var g_user_appr_cont    = "";
  var g_isFirst           = true;
  // 양식 결재선 위치
  var g_apprline_loc      = [];
  var g_apprline_pos_len = 0;
  var g_apprline_left_len = 0;
  var g_apprline_right_len = 0;
  var g_apprline_bottom_len = 0;
  var g_paper_item_len = 0;
  var g_paper_cont        = "";
  // 양식 항목 사용 수(사용하면 0보다 크다)
  var g_apprline_gb             = "";
  var is_apprline_modify  = false;
  var apprline_json = null;
  var apprline_list = [];
  var g_bottom_title = ""; // 아랫쪽 결재선 타이틀 명
  var g_editor_atch_srno = "";
  var jsonApprLine = null;
  var isDefaultTime = false; // 항목중 시간기간인 경우에 날짜를 기본 날짜세팅변수
  var g_rps_paper_cd = "";      // 대표양식코드
  var s_proc_gb                 = "";
  var jsonApprLine = null;
  var _PTL_ID = null;
  var _CHNL_ID = null;
  var _USE_INTT_ID = null;        
  var _CNTS_ID = null;            
  var _USER_ID = null;
  var _CCTN_CHNL_ID = null;
  var g_ifrm_height = 0;
  var curViewCardBill = "";     // 현재 펼쳐진 영수증의 순번
  var nonStopPrint = "";      // 즉시인쇄  "P" : 즉시인쇄
  var g_rcpt_rec = null;
  var g_appr_cancel_can_yn = null;
  $time = "<option value='00'>00</option><option value='01'>01</option><option value='02'>02</option><option value='03'>03</option><option value='04'>04</option><option value='05'>05</option><option value='06'>06</option><option value='07'>07</option><option value='08'>08</option><option value='09'>09</option><option value='10'>10</option><option value='11'>11</option><option value='12'>12</option><option value='13'>13</option><option value='14'>14</option><option value='15'>15</option><option value='16'>16</option><option value='17'>17</option><option value='18'>18</option><option value='19'>19</option><option value='20'>20</option><option value='21'>21</option><option value='22'>22</option><option value='23'>23</option>";
  $minite = "<option value='00'>00</option><option value='05'>05</option><option value='10'>10</option><option value='15'>15</option><option value='20'>20</option><option value='25'>25</option><option value='30'>30</option><option value='35'>35</option><option value='40'>40</option><option value='45'>45</option><option value='50'>50</option><option value='55'>55</option>";
  var g_sHtmlBottomLine ="";
  var g_sHtmlBRow="";

var g_draft_user_id =""; //  기안자아이디
var g_patial_reject_yn="N";// 부분반려 사용 여부
var g_receipt_modify_yn="N";// 영수증 수정 버튼 사용여부
var g_patial_taxbill_reject_yn="N";// 세금계산서 부분반려 사용여부
var g_taxbill_modify_yn="N";// 세금계산서 부분반려 사용여부
var g_underlineShowYn="N";

//2109.01.25배유연추가 : 서명란 표시여부 전역으로 빼기
var g_sign_appr_kind_use_yn="N";
var g_sign_dept_use_yn="N";
var g_sign_jbcl_use_yn="N";
var g_sign_idnum_use_yn="N";
//2023.02.10 진호용 추가 : 인감서명 결재자 정보
var g_seal_sign_appr_kind_use_yn="N";
var g_seal_sign_dept_use_yn="N";
var g_seal_sign_jbcl_use_yn="N";
var g_seal_sign_idnum_use_yn="N";
var g_pos_rec =null;// 2019.12.30 배유연 추가 :  결재란 값
//2020.02.20 배유연 추가 : 이미지 뷰잉 기능 작동안되는 현상 ( wecloud2->wecloud3)
var g_draft_date_time="";
var g_draft_user_id_number="";

//2021.05.24 진호용 추가 : 다음 에디터, crosseditor 구분
var editorGb = ""; //cross or daum
var editorLoadYn = "N";

//2021.12.17 진호용 추가 : 첨부파일 용량제한
var g_limited_vouch_size = "100";
var g_limited_vouch_size_use_yn = "N";

var g_trip_calcul_rcpt_item = ""; // 출장정산서 영수증 항목
var g_rcpt_img_load_cnt = 0;
var g_real_rcpt_img_cnt = 0;

var g_paper_apprline = null; //양식별결재선
var g_webank_sso_item_seq = "";
var isReadyForAppr = true;

var budgetExecData = null;

var g_lnkd_gb = ""; // 외부연결여부
var g_appr_cont = "";
//document.addEventListener('readystatechange', () => alert(document.readyState));

new (Jex.extend({
onload:function() {
_this = this;
g_ptl_id                = $("#frm_appr_dtl_0005").find("#PTL_ID").val();
g_chnl_id               = $("#frm_appr_dtl_0005").find("#CHNL_ID").val();
g_use_intt_id           = $("#frm_appr_dtl_0005").find("#USE_INTT_ID").val();
//언어설정
//2018.11.25 언어 설정값이 있으면 setting 하기
if(jex.null2Void($("#LNGG_DSNC").val()) !=""){
fn_setLngg($("#LNGG_DSNC").val(), $("#frm_appr_dtl_0005").find("#USER_ID").val(), g_ptl_id, g_chnl_id, g_use_intt_id);
}

    		fn_lngg_change("appr","appr_dtl_0005");
            //--- todo onload start ---//
    		
    		//2021.05.25 진호용 추가 : editor 설정
    		editorGb = jex.null2Str($("#EDITOR_ID").val(), "daum");
           
    		g_cnts_id               = "CNTS_309";//$("#frm_appr_dtl_0005").find("#CNTS_ID").val();//다른 앱에서 cnts_id 잘못 설정했을 때 error막기위해
            g_appr_seq_no           = $("#frm_appr_dtl_0005").find("#APPR_SEQ_NO").val();
            g_user_id               = $("#frm_appr_dtl_0005").find("#USER_ID").val();
            g_user_nm               = $("#frm_appr_dtl_0005").find("#USER_NM").val();
            g_dvsn_cd               = $("#frm_appr_dtl_0005").find("#DVSN_CD").val();
            g_paper_seq_no          = $("#frm_appr_dtl_0005").find("#PAPER_SEQ_NO").val();
            g_atch                        = $("#frm_appr_dtl_0005").find("#ATCH").val();
            g_paper_kind        = $("#frm_appr_dtl_0005").find("#PAPER_KIND").val();
            g_rps_paper_cd      = $("#frm_appr_dtl_0005").find("#RPS_PAPER_CD").val();
            g_paper_path        = $("#frm_appr_dtl_0005").find("#PAPER_PATH").val();
            g_user_appr_subj    = $("#frm_appr_dtl_0005").find("#USER_APPR_SUBJ").val();
            g_user_appr_cont    = $("#frm_appr_dtl_0005").find("#USER_APPR_CONT").val();
            g_proc_gb               = $("#frm_appr_dtl_0005").find("#PROC_GB").val();
            g_menu_type             = $("#frm_appr_dtl_0005").find("#MENU_TYPE").val();
            g_appr_mode             = $("#frm_appr_dtl_0005").find("#APPR_MODE").val();
            g_seal_use_yn           = $("#frm_appr_dtl_0005").find("#SEAL_USE_YN").val();
            g_dsp_time_line_yn      = $("#frm_appr_dtl_0005").find("#DSP_TIME_LINE_YN").val();
            g_basis_appr_seq_no     = $("#frm_appr_dtl_0005").find("#BASIS_DOC_APPR_SEQ_NO").val();          
            g_apprline_kind   = $("#frm_appr_dtl_0005").find("#APPRLINE_KIND").val();
            g_pos_nm            = $("#frm_appr_dtl_0005").find("#JBCL_NM").val();
            g_dept_cd               = $("#frm_appr_dtl_0005").find("#DVSN_CD").val();
            g_dept_nm               = $("#frm_appr_dtl_0005").find("#DVSN_NM").val();
            curViewCardBill     = $("#frm_appr_dtl_0005").find("#CUR_VIEW_CARD_BILL").val();
            nonStopPrint        = $("#frm_appr_dtl_0005").find("#NON_STOP_PRINT").val();
            g_appr_cancel_can_yn= $("#frm_appr_dtl_0005").find("#APPR_CANCEL_CAN_YN").val();
            
            g_sign_appr_kind_use_yn= $("#frm_appr_dtl_0005").find("#SIGN_APPR_KIND_USE_YN").val();
            g_sign_dept_use_yn= $("#frm_appr_dtl_0005").find("#SIGN_DEPT_USE_YN").val();
            g_sign_jbcl_use_yn= $("#frm_appr_dtl_0005").find("#SIGN_JBCL_USE_YN").val();
            g_sign_idnum_use_yn= $("#frm_appr_dtl_0005").find("#SIGN_IDNUM_USE_YN").val();
            g_seal_sign_appr_kind_use_yn= $("#frm_appr_dtl_0005").find("#SEAL_SIGN_APPR_KIND_USE_YN").val();
            g_seal_sign_dept_use_yn= $("#frm_appr_dtl_0005").find("#SEAL_SIGN_DEPT_USE_YN").val();
            g_seal_sign_jbcl_use_yn= $("#frm_appr_dtl_0005").find("#SEAL_SIGN_JBCL_USE_YN").val();
            g_seal_sign_idnum_use_yn= $("#frm_appr_dtl_0005").find("#SEAL_SIGN_IDNUM_USE_YN").val();

            g_lnkd_gb= $("#frm_appr_dtl_0005").find("#LNKD_GB").val();

			g_limited_vouch_size=$("#frm_appr_dtl_0005").find("#LIMITED_VOUCH_SIZE").val();
			g_limited_vouch_size_use_yn=$("#frm_appr_dtl_0005").find("#LIMITED_VOUCH_SIZE_USE_YN").val();
			if (g_limited_vouch_size_use_yn != "N" && cnts_Null2Void(g_limited_vouch_size,"") != "") 
				g_limited_vouch_size = parseInt(g_limited_vouch_size) * 1024 * 1024;
           
            
            _PTL_ID = g_ptl_id;
            _CHNL_ID = g_chnl_id;
            _USE_INTT_ID = g_use_intt_id;
            _CNTS_ID = g_cnts_id;
            _USER_ID = g_user_id;
            _CCTN_CHNL_ID = g_chnl_id;
            // 양식지 조회
            
            if(g_proc_gb != "U")  // 임시저장 또는 재기안인경우 나중에 조회한다.
                  fn_getPaperDtlSrc();
            
			//wgpp 예산관리 pro 팝업
//			if (g_paper_seq_no === "900947" && (g_proc_gb === "C" || g_proc_gb === "U")) {
//				var btnHtml = "<div class='f_right' id='bgtProPop' style='margin-top:-10px;'>";
//				btnHtml += "<a href='javascript:'onclick='openBgtProPop();' class='btn_style4'><span>예산집행상세작성</span></a>";
//				btnHtml += "</div>";
//				$("#tempdocinfo").append(btnHtml);
//			}

            // 양식지 결재선라인 조회
            fn_getPaperApprlineSrc();
            // 연계 내용부분 display:none
            $("#ifrm_rel").css("display", "none");
            // g_proc_gb  R:조회, C:등록, U:수정, P:인쇄
            
            //2018.01.21 배유연 추가 : 해당양식지에 등록된 결재선이있는지(직원결재선 관리 메뉴에서 추가한 결재선)
            fn_apprline_by_paper(g_paper_seq_no);
            
            //2018.10.21 배유연 추가 : 부분반려기능 사용여부
            if($("#frm_appr_dtl_0005").find("#PARTIAL_REJECT_YN").val()=="Y"){// 부분 반려기능 사용 업체이고
            	if(g_menu_type=="PW" || g_menu_type=="PH" || g_menu_type=="DW" || g_menu_type=="DH" || g_menu_type=="AW" || g_menu_type=="AH" ){ // 대기, 보류함이면서
            		if(g_apprline_kind !="4") // 참조가 아니면
            			g_patial_reject_yn="Y";// 부분반려기능을 사용할수 있음
            	}else{//부분반려기능을 사용하는 업체이지만, 조회만 가능(my 기안문서 조회이거나, 참조인경우, 결재자가 결재 끝난 경우)
            		g_patial_reject_yn="A"
            	}
            	
            }
            
            
            //2019.06.17 배유연 추가 : 세금계산서 부분반려기능 사용여부
            if($("#frm_appr_dtl_0005").find("#PARTIAL_TAXBILL_REJECT_YN").val()=="Y"){// 부분 반려기능 사용 업체이고
            	if(g_menu_type=="PW" || g_menu_type=="PH" || g_menu_type=="DW" || g_menu_type=="DH" || g_menu_type=="AW" || g_menu_type=="AH" ){ // 대기, 보류함이면서
            		if(g_apprline_kind !="4") // 참조가 아니면
            			g_patial_taxbill_reject_yn="Y";// 부분반려기능을 사용할수 있음
            	}else{//부분반려기능을 사용하는 업체이지만, 조회만 가능(my 기안문서 조회이거나, 참조인경우, 결재자가 결재 끝난 경우)
            		g_patial_taxbill_reject_yn="A"
            	}
            	
            }
           
           
            //2018.10.21 배유연 추가 : 영수증 수정버튼 사용가능
            if($("#frm_appr_dtl_0005").find("#RECEIPT_MODIFY_YN").val()=="Y"){
            	if(g_menu_type=="PW" || g_menu_type=="PH" || g_menu_type=="DW" || g_menu_type=="DH" || g_menu_type=="AW" || g_menu_type=="AH" ){ // 대기, 보류함이면서
            		if(g_apprline_kind !="4"){ // 참조가 아니면
            			g_receipt_modify_yn="Y";//영수증 수정버튼 사용가능
            			
            		}
            			
            	}else{//부분반려기능을 사용하는 업체이지만, 조회만 가능(my 기안문서 조회이거나, 참조인경우, 결재자가 결재 끝난 경우)
            		
            	}
            	
            }
          //2018.10.21 배유연 추가 : 계산서 수정버튼 사용가능
            //기존
            //if($("#frm_appr_dtl_0005").find("#TAXBILL_MODIFY_YN").val()=="Y" && $("#LAST_APPR_USER_YN").val()=="Y" && cnts_Null2Void(parent.g_popup_yn,"N")!="Y" ){
            //2020.04.08 수정 : 최종결재자만 수정->전결관리자이면서 결재자이면 계산서 수정가능
            
            if($("#frm_appr_dtl_0005").find("#TAXBILL_MODIFY_YN").val()=="Y" && cnts_Null2Void(parent.$("#MNGR_DSNC").val(),"")=="A" && cnts_Null2Void(parent.g_popup_yn,"N")!="Y" ){
            	if(g_menu_type=="PW" || g_menu_type=="PH" || g_menu_type=="DW" || g_menu_type=="DH" || g_menu_type=="AW" || g_menu_type=="AH" ){ // 대기, 보류함이면서
            		if(g_apprline_kind !="4" ){ // 참조가 아니면
            			g_taxbill_modify_yn="Y"//계산서 수정버튼 사용가능	
            		}
            	}            	
            }
            

         
            
            //기존
            if (g_proc_gb == "R" || g_proc_gb.indexOf("P") >-1 ) {
            	
                  //20170.09.27 배유연 추가 : 조회할 때 삭제 글씨 안보이게.
                  $("#VOUCH_THEAD").find("tr").find("th:eq(4)").find("div").hide();
                 
                  // 연계문서인 경우
                  $("#ifrm_rel").css("display", "none");
                 

                  if("1" == g_paper_kind){
                        $(".usr_cls_c").css("display", "none");
//                        $(".usr_cls_c").remove();
} else if("2" == g_paper_kind){
$("#ifrm_rel").css("display", "block");
$("div#APPR_CONT").css("display", "none");

                        /**
                         * 송신자지정 양식은 APPR_SUBJ 넣는다.
                         * 20160823 김상묵 이석우
                         */
                       
                        if(g_rps_paper_cd != "-1"){
                              $("#R_TBL").css("display", "none");
                        }                      
                        //if(g_paper_seq_no !="111")
                        	//$(".usr-not-ifrm").css("display", "none");
                                               
                       
                  } else if ("3" == g_paper_kind) {
                        $(".usr_cls_c").eq(0).css("display", "block");
                        $(".usr_cls_r").css("display", "none");
                  } 
                 
                  $(".stit").css("display", "block");
                 
                  fn_appr_opinion_r002();
                  if(g_proc_gb.indexOf("OPIN")  >-1  && $("#DIV_OPINION_PRINT").find("tbody").find("tr").length>0){
                	  $("#DIV_OPINION_PRINT").show();
                  }
                 
            } else {
                  g_menu_type = "R";
                  // 양식지조회
                  //fn_getPaperDtlSrc_R();
           
                  if ("1" == g_paper_kind ) {
                	  if (editorGb == "daum") {
                		  Editor.getCanvas().setCanvasSize({
                			  height: "300px"
                		  });
                		  Editor.modify( {
                			  inputmode : "original", //original , text
                			  content       : g_paper_cont
                		  });
                	  }
                  }
                  
                  /*if(g_proc_gb=="U")
                  {
                        if("1" == g_paper_kind){
                              $(".usr_cls_c").css("display", "none");
                        } else if("2" == g_paper_kind){
                              $("#ifrm_rel").css("display", "block");
                              $("div#APPR_CONT").css("display", "none");                       
                             
                              *//**
                               * 송신자지정 양식은 APPR_SUBJ 넣는다.
                               * 20160823 김상묵 이석우
                               *//*
                             
                              if(g_rps_paper_cd != "-1"){
                                    $("#R_TBL").css("display", "none");
                              }                      
                             
                              $(".usr-not-ifrm").css("display", "none");
                                                     
                             
                        } else if ("3" == g_paper_kind) {
                              $(".usr_cls_c").css("display", "block");
                              $(".usr_cls_r").css("display", "none");
                        }                
                        $(".mgb5").css("display", "none");
                        $(".stit").css("display", "block");
                  }*/
            //    else{
                  
                  
                  $(".usr_cls_r").css("display", "none");
                  $(".usr_cls_c").css("display", "block");
                  
                  // 2019.05.17_이현수 : 출장문서(600,601,602,603)
                  var tripArr = ['600','601','602','603','604','605'];
                  //if($("#PAPER_CATE").val()!="500" && tripArr.indexOf($("#PAPER_CATE").val())==-1){//2021.01.28 해당 조건 뺌, 박새롬 요청
            	  $("table#C_TBL").find("#APPR_SUBJ").val(""==g_user_appr_subj ? g_paper_nm : g_user_appr_subj);
                  $("table#C_TBL").find("#APPR_SUBJ").focus();
                  
                  //}
                  
                  //2020.09.21 예산관리 pro init 함수
                  if($("#PAPER_CATE").val()=="800"||$("#PAPER_CATE").val()=="801"){
                	  
                	  fn_openBudget();
                	
                	  if (editorGb == "daum") {
	                	  Editor.modify( {
	                          inputmode : "original", //original , text
	                          content       : g_paper_cont
	                	  });
                	  }
                	  
                	  
                  }
                  
                  //}
                  if ("" != g_atch) {
                        fn_callbackFnctAtch(jQuery.parseJSON(decodeURIComponent(g_atch)));     
                  }
                 
                  /**
                   * 송신자지정 양식은 첨부파일area를 가린다.
                   * 20160823 김상묵 이석우
                   */
                  if(g_rps_paper_cd == "-1"){
                        $(".usr-not-ifrm").css("display", "none");
                        //$(".usr_cls_c").css("display", "none");            
                        $(".icon_add").css("display", "none");
                        $(".icon_addfile").css("display", "none");
                  }
                 
                 
            }
            if(g_proc_gb == "U"){
                  fn_getPaperDtlSrc();
                  if($("#tempapprline").is(':visible'))$("#tempapprline").hide();
            }
            if (g_proc_gb != "C") {
                  fn_getApprStsSrc();
                  fn_getApprDtlSrc(g_appr_seq_no);
                 // height auto 로 하면됨..
                  //setTimeout(function(){ $(".editbox").css("height",$("#contDiv").height());  }, 500);
            } else {
				if (g_limited_vouch_size_use_yn != "N") {
					fn_setVouchSize();
				}
			}
                       
            //if (g_menu_type == "M")
                 // $(".mgb5").css("display", "block");
                //$("#btnAtchSave").css("display", "block");                       
           
     
           
           
           
            fn_btnSet();
            fn_setCalendar();
            fn_setCalendar2();
           
           
            //2017.09.20 배유연 추가 :매입세금계산서는 파일 첨부부분 안뜨게
            //if("111"==g_paper_seq_no )
                  //$("#fileAttchPrint").css("display", "none");
           
         
            //2017.12.01 배유연 추가 : 경리나라는 첨부파일 안보임
 
            if(g_paper_seq_no =="112" || g_paper_seq_no =="113"){

            	//$("#fileAttchPrint").css("display","none");
            	$("#taxDiv").css("display","none");
            }
            if(g_paper_seq_no =="121"){

            	$("#fileAttchPrint").css("display","none");
            	
            }
            
            //2018.03.27 배유연 추가 : 휴가신청서(인사문서)이면 휴가 잔여일수 구하기.
            if(g_paper_kind=="3" && $("#PAPER_PATH").val().indexOf('insa_01')>=0){
            	fn_comm_myinsa_r002();
            	
            	if(g_proc_gb !="C" && g_proc_gb !="U"){
            		$("#IMG_VC_DATE_LST").hide();// 달력버튼 hidden 처리
            		$("#VC_DATE_LST").css("width","100%");
            	}
            	//fn_comm_myinsa_r001(); // 결재할때 휴가올린 년도로 조회해오기.
            	if(g_proc_gb != "C"){ // 조회화면이면
            		fn_comm_myinsa_r001(); // 결재할때 휴가올린 년도로 조회해오기.
            	}
            
            }
            if (typeof post_callback === "function")
                post_callback();
            
            //2018.11.20 추가
            
            if($("#HEADER_HIDDEN").val()=="Y"){
            	$(".pop_header").css("display","none");
            }
            
            
            //파일 첨부 옵션 관리자 설정에 따라 controll
            if("3" == g_appr_sts || "4" == g_appr_sts){//결재완료건
            	try{
            		if($("#FILE_ATCH_USE_YN").val()=="Y" &&  ($("#MY_MNU_OPEN_YN").val()=="Y" || $("#MNGR_MNU_OPEN_YN").val()=="Y" ||parent.opener.document.location.href.indexOf("appr_list_0007")>-1 || 
            				parent.opener.document.location.href.indexOf("appr_list_0013")>-1)){// 파일 첨부 옵션 켜져있고 완료/반송문서이고 my기안문서 or 관리자 메뉴에서 조회한경우 or 연계 my기안문서 or 연계 관리자메뉴
                    	  $("#fileAttchPrint").find(".mgb5").css("display", ""); //파일첨부 버튼 
                      }else{
                    	  $("#fileAttchPrint").find(".mgb5").css("display", "none"); //파일첨부 버튼 숨김
                      }
            	}catch(e){
            	}
        	} else if ("2" == g_appr_sts && "N" === $("#PROG_APPR_VOUCH_USE_YN").val()) {
				$("#fileAttchPrint").find(".mgb5").css("display", "none"); //파일첨부 버튼 숨김
            } else { //그 외에는 보이게
            	$("#fileAttchPrint").find(".mgb5").css("display", ""); //파일첨부 버튼 
            }
            
            
            //2020.09.14 관리자 결재문서관리에서 열었고, 첨부파일 삭제옵션 사용하는 경우
            try{
            	
            	if($("#ATCH_DEL_USE_YN").val()=="Y" && ($("#MNGR_MNU_OPEN_YN").val()=="Y" ||  parent.opener.document.location.href.indexOf("appr_list_0013")>-1)){
	              	
        			$(".atchDel").show();   
                }
        	}catch(e){
        		
        	}
            
            
            //2019.03.05 배유연 추가 : 의견설정값받아오기, 기안시에만
            if(g_menu_type=="R"){
            	if($("#DRAFT_OPINION_USE_YN").val()=="Y"){
            		$(".DRAFT_OPINION_USE_YN").show();
            	}
				if($("#SECRET_OPINION_USE_YN").val()=="Y"){
					$(".SECRET_OPINION_USE_YN").show();		
				}
				if($("#INSTANT_OPINION_USE_YN").val()=="Y"){
					$(".INSTANT_OPINION_USE_YN").show();
				}
            }
            	
            
			if (g_proc_gb.indexOf("MAIN") > -1) {
				$("#APPR_CONT").siblings('div').hide();
				$("#R_TBL").hide();
			}

			//2020.09.08 연계문서가 아니거나 연계문서이지만 APPR_CONT를 사용안하는 경우 status를 세팅함-> pdf저장시 loading 이 끝났음을 알 수 있음
            if (("601" != $("#PAPER_CATE").val() && "2" != g_paper_kind) || ("2" == g_paper_kind && g_appr_cont_use_yn!="Y")) {
            	setTimeout(function () {
		            window.status = 'ready_to_print';
		        }, 500);    
			}
			if ("601" == $("#PAPER_CATE").val() && g_proc_gb.indexOf("A") == -1) {
            	setTimeout(function () {
		            window.status = 'ready_to_print';
		        }, 500);    
			}
            
           //2023.08.23 슈프리마의 경우 제목 공란
			if( g_proc_gb != "U" &&
				(($("#REAL_YN").val() =="N" && (g_use_intt_id == "UTLZ_2303100908457" ||g_use_intt_id == "UTLZ_2303101008458" ||g_use_intt_id == "UTLZ_2303101008459" ||g_use_intt_id == "UTLZ_2303101008460" ||g_use_intt_id == "UTLZ_2303101008461"  ) )
				|| ($("#REAL_YN").val() =="Y"  && (g_use_intt_id == "UTLZ_2201091231316" ||g_use_intt_id == "UTLZ_2304280908377" ||g_use_intt_id == "UTLZ_2304280908378" ||g_use_intt_id == "UTLZ_2308011023236" ||g_use_intt_id == "UTLZ_2308011023239" ) ))  
				//$("#REAL_YN").val() =="N"
			)
			{
				//alert("test");
				$("#C_TBL").find("#APPR_SUBJ").val("");
			}
			
			
			if(g_lnkd_gb == "00"){//외부링크
				//외부링크는 다 막는다. 나중에 위에 설정값에서 차례로 정리해야할듯
				$(".usr_cls_c").css("display", "none");//첨부파일버튼들
				$("#btnApprCancel").css("display", "none");//결재취소버튼
			}
			
			setObserverIframe("ifrm_0005");
      }, event:function() {
            //--- define event action ---//

    	  
            /**
             * 기안문서 재기안 클릭 함수
             * Rewrite Appr Document Click Event function
             */
            this.addEvent("#btnReAppr", "click", function(){
            	

            	if(confirm($.i18n.prop("msg26"))){ // 기존 작성한 원안문서가 근기문서로 첨부됩니다. 첨부하시겠습니까?
            		fn_goRewriteAppr("");
				} else {
				     fn_goRewriteAppr("X");
				}
				 
            });
           
            /**
             * 결재정보 버튼 클릭
             */
            this.addEvent("#btnStsInfo", "click", function(){
                  $("#frm_appr_dtl_0005").find("#TYPE").val("P");
                  $("#frm_appr_dtl_0005").find("#PAPERNM").val($("#PAPER_NM").text());
                 
                  var s_doc_gb_nm = "";
                  if("0" == $("input[name='raoDocType']:checked").val()) s_doc_gb_nm = $.i18n.prop("msg168");
                  else if("1" == $("input[name='raoDocType']:checked").val()) s_doc_gb_nm = $.i18n.prop("msg169");
                  $("#frm_appr_dtl_0005").find("#DOC_GB_NM").val(s_doc_gb_nm);
                  open_smartPop({href:"appr_sts_list_0003.act", width: 680, height: 500, target : "appr_sts_list_0003", frm:$("#frm_appr_dtl_0005")});
            });
           
            /**
             * 결재처리 클릭 함수
             * Appr Document Process Click Event function
             */
            this.addEvent("#btnStsProc", "click", function(){
            $("#DOCNO").val($("#DOC_NO").text());
                  open_smartPop({href:"appr_sts_reg_0002.act", width: 700, height: 500, target : "frm_appr_dtl_0005", frm:$("#frm_appr_dtl_0005")});
            });
           
            /**
             * 임시저장 버튼 클릭
             */
            this.addEvent("#btnTmpProc", "click", function(){
                  // Validation
                  if(!jex.plugin.get("FORM_CHECKER").check("#EditorForm"))
                        return false;
                 
                  if("" == $.trim($("table#C_TBL").find("#APPR_SUBJ").val()) && g_paper_path != "cust_99_UTLZ_1808301082871.jsp" && g_paper_path != "cust_99_UTLZ_1808301082871_2.jsp") {
                        //alert("제목" + jex.getMsg("9108"));
                	  	alert($.i18n.prop("msg50")+" " + $.i18n.prop("M9108"))
                        return;
                  }                                        
                  s_proc_gb = "1";
                  fn_saveAppr(jsonApprLine);
            });
            /**
             * 저장 버튼 클릭 (My기안문서)
             */
            /*this.addEvent("#btnUpdateAppr", "click", function(){
                 
                  fn_updateAttch();
                 
            });*/
            /**
             * 회람 버튼 클릭 (My기안문서)
             */
            this.addEvent("#btnShareAppr", "click", function(){
                 
                  fn_share();
                 
            });
           
            /**
             * 원안문서 팝업 클릭 함수
             * Basis Appr document Popup call click function
             */
            this.addEvent("#btnBasisApprAdd", "click", function(){
            	$("#CALLBACK_FNCT").val("fn_callbackFnctBasisAppr");
                  open_popup("frm_appr_dtl_0005",{sizeW:"1060" ,sizeH:"620", target:"appr_list_0012",action:"appr_list_0012.act"});
            });
                       
            /**
             * 첨부파일 팝업
             */
            this.addEvent("#btnAtchAdd", "click", function(){
				  var max_file_size = g_limited_vouch_size_use_yn == "N" ? 104857600 : g_limited_vouch_size;
				  if (max_file_size <= 0) {
					  alert($.i18n.prop("msg205"));
					  return false;
				  }
                  var opt = {
                              ptlId       :g_ptl_id
                          , chnlId        :g_chnl_id
                          , useInttId     :g_use_intt_id
                          , cctnChnlId  :g_chnl_id
                          , cntsId        :g_cnts_id
                          , userId        :g_user_id
                          , maxFileSize : max_file_size
                          , openType    :"P" // P:popup, L : layer
                          , callBackFn    :"fn_callbackFnctAtch"
                          , uploadFileProp      : {
                                    type              : "all"
                              }
                   };              
                  _WE_DRIVER.open(opt);
            });
           
            /**
             * 결재선 변경 팝업 Click function
             */
            this.addEvent("#btnStsChange", "click", function(){
                  $("#MODE").val("E");
                  $("#CALLBACK_FN").val("fn_getApprStsSrc");
                 // open_smartPop({href:"apprline_list_0005.act", width: 950, height: 500, target : window, frm:$("#frm_appr_dtl_0005")});
                  //2018.01.17 배유연 수정 : 새로운 ui 로 호출한다. 
                  open_smartPop({href:"apprline_list_0008.act", width: 500, height: 650, target : window, frm:$("#frm_appr_dtl_0005")});
                  /*if (location.href.indexOf("appplay") == -1){ //개발
                	  open_smartPop({href:"apprline_list_0008.act", width: 500, height: 650, target : window, frm:$("#frm_appr_dtl_0005")});
                	  //open_smartPop({href:"apprline_list_0005.act", width: 950, height: 500, target : window, frm:$("#frm_appr_dtl_0005")});                     

                  }else{ //운영
                	  open_smartPop({href:"apprline_list_0008.act", width: 500, height: 650, target : window, frm:$("#frm_appr_dtl_0005")});
                	 // open_smartPop({href:"apprline_list_0005.act", width: 950, height: 500, target : window, frm:$("#frm_appr_dtl_0005")});                     
                  }*/
                  
            });
           
            /**
             * 결재선 관리 팝업 Click function
             */
            this.addEvent("#btnStsMgr", "click", function(){
            	  // jex.formcheck.js : Form Validation Check 
                  if(!jex.plugin.get("FORM_CHECKER").check("#EditorForm"))
                	  return false;
                  
                  // 제목 Check
                  if("" == $.trim($("table#C_TBL").find("#APPR_SUBJ").val())&& g_paper_path != "cust_99_UTLZ_1808301082871.jsp" && g_paper_path != "cust_99_UTLZ_1808301082871_2.jsp" ) {
                        //alert("제목" + jex.getMsg("9108"));
                	  
                	  alert($.i18n.prop("msg50") +" "+$.i18n.prop("M9108"));
                      return;
                  }
                 
                  var name = "";		// Validation 되지 않은 항목명을 담을 변수
                  var validation = "Y"; // Validation Check 변수 (Y.정상/N.오류)
                  
                  // 항목 Validation Check                  
                  if ( g_paper_kind == "3" ) {
                        $('[usr_item_must="Y"]').each(function(i,e){                       
                              var attr = $(e).attr('usr_attr');
                              name = $(e).attr('usr_item_name');                                                       
                              if ("3" == attr) {                        // 기간
                                    if (cnts_Null2Void($(e).find("input[name='START_SELECT_DATE']").val(), "") == "" ||
                                          cnts_Null2Void($(e).find("input[name='END_SELECT_DATE']").val(), "") == "") {
                                          validation = "N";
                                          return false;
                                    };
                              } else if ("4" == attr) {           // 일자
                                    if (cnts_Null2Void($(e).find("input[name='SELECT_DATE']").val(), "") == "") {
                                          validation = "N";
                                          return false;
                                    };
                              } else if ("7" == attr) {           // 사용기간(시분)
                                    if (cnts_Null2Void($(e).find("#START_SELECT_TIME").val(), "") == "" ||
                                          cnts_Null2Void($(e).find("#START_SELECT_MIN").val(), "") == "" ||
                                          cnts_Null2Void($(e).find("#END_SELECT_TIME").val(), "") == "" ||
                                          cnts_Null2Void($(e).find("#END_SELECT_MIN").val(), "") == "") {
                                          validation = "N";
                                          return false;
                                    }                      
                              } else if ("8" == attr) {           // 사용자정의
                            	  if (cnts_Null2Void($(e).find("input[name^='USER_DEFINE_ATTR']:checked").val(), "") == "") {
                                          validation = "N";
                                          return false;
                                    };
                              }else if ("12" == attr) {           // 직원
                            	  //console.log($(e).find(".name_cmb_multi_box").find("p"));
                            	  if ($(e).find(".name_cmb_multi_box").find("p").length<1) {
                                      validation = "N";
                                      return false;
                                      
                            	  };
                              } else if ("13" == attr) {           // 2019.08.07 배유연추가 : 휴가기간
                            	  //console.log($(e).find(".name_cmb_multi_box").find("p"));
                            	  if ($(e).find("p[addnew]").length<1) {
                                      validation = "N";
                                      return false;
                                      
                            	  };
                              } else {
                                    if (cnts_Null2Void($(e).find("*[name='TEXT']").val(), "") == "") {
                                          validation = "N";
                                          return false;
                                    }
                              }
                        });        
                        
                        if(g_paper_kind=="3" && $("#PAPER_PATH").val().indexOf('insa_01')>=0){
                            
                      	  //2020.12.14 잔여일수통제여부 사용-> 잔여일수-휴가일수 <0 : 기안불가
                      	  if($("#VC_REMAIN_YN").val()=="Y"){
                      		  var check =fn_calRemainDay();
                      		  if(check=="N"){
                      			  alert("연차 잔여일수 부족으로 인해 휴가 신청이 불가합니다.");
                      			  return;
                      		  }
                      	  }
                      	  
                        }	 
                  } 
                  // 2018.09.13 신대홍 추가 : 1, 4 필수항목 검증추가
                  if( g_paper_kind == "1" || g_paper_kind == "4" ){
                	  $('[usr_item_must="Y"]').each(function(i,e){ 
                		  
                          var attr = $(e).attr('usr_attr');
                          name = $(e).attr('usr_item_name');        
                         
						if (attr === "3") {
							var td = $(e).closest("td");
							if ($(td).find(".START_SELECT_DATE").length > 0 && $(td).find(".START_SELECT_TIME").length > 0) {
								if ($(td).find(".START_SELECT_TIME").val() === "시간선택" || $(td).find(".END_SELECT_TIME").val() === "시간선택") {
									validation = "N";
                                	return false; 
								}
							} else {
								if (cnts_Null2Void($(e).val(), "") == "") {
                        			validation = "N";
                                	return false;    
                        		}
							}
						  } else if(attr=="8" || attr=="11"){//라디오버튼 또는 체크박스

                        	  if($(e).parent().find("input:checked").length<1){
                        		  validation = "N";
                                  return false;    
                        	  }
                          }
                          else if ("12" == attr || "14" == attr || "15" == attr 
								|| "20" == attr || "21" == attr || "23" == attr) {  // 직원, 거래처, 거래처담당자, 예산부서, 용도
                        	
                        	  if ($(e).find(".name_cmb_multi_box").find("p").length<1) {
                                  validation = "N";
                                  return false;
                        	  };
                          }else if("16" == attr || "17" == attr){// 영수증 총합계, 신청금액 총합계
                        	  if($(e).text()==""){
                        		  validation = "N";
                                  return false;
                        	  }
                          }else if ("18" == attr) {
                        	  if ($(e).html() == "") {
                        		  validation = "N";
                                  return false;
                        	  }
                          }else if ("19" == attr) { //hbiz 에약번호
                        	  if ($(e).find("span").length > 0 && $(e).find("p").text() == "") {
                        		  validation = "N";
                                  return false;
                        	  }
                          }else if ("22" == attr) { //bzp 스케줄 번호
                        	  if ($(e).find("span").length > 0 && $(e).find("p").text() == "") {
                        		  validation = "N";
                                  return false;
                        	  }
                          }else if (cnts_Null2Void($(e).val(), "") == "" || cnts_Null2Void($(e).val(), "") == "99999999") {
                        	  validation = "N";
                              return false;                         
                          } 
                          
                	  });
                  }
                  // Validation 오류 메시지
                  if (validation == "N") {
                        alert(name + $.i18n.prop("msg78")); //필수입니다.
                        return;
                  }
                  
                  // 출장정산서 경비 항목 검증 || 통합지출결의 지출 항목 검증, 지출결의 항목검증
                  /* 출장정산/명령/보고 */
                  var tripArr = ['601','602','603'];
                  if(tripArr.indexOf($("#PAPER_CATE").val())!=-1 || $("#PAPER_CATE").val()=="700" ||  $("#PAPER_CATE").val()=="901"){
                	  if(!fn_validation()){
                		  return false;
                	  }
            	  }
                 
                  $("#MODE").val("S");
                  $("#CALLBACK_FN").val("fn_setApprline");
                  
				//woomi
				if ("Y" === $("#GROUPWARE_BTN_USE_YN").val() && "601" === $("#PAPER_CATE").val()) {
					if (g_paper_apprline != null && g_paper_apprline.length > 0) {
						$.each(g_paper_apprline, function(i,v) {
							if ("1" === v.APPR_USER_GB) {
				                v["DEPT_CD"] = v.APPR_DEPT_CD;
				                v["DEPT_NM"] = v.APPR_DEPT_NM;
				                v["APPR_USER_DEPT_CD"] = v.APPR_DEPT_CD; //2017.06.08 배유연 추가
				                v["APPR_USER_DEPT_NM"] = v.APPR_DEPT_NM;//2017.06.08 배유연 추가
							} else if ("2" === v.APPR_USER_GB) {
				                v["APPR_USER_DEPT_CD"] = v.APPR_DEPT_CD;
				                v["APPR_USER_DEPT_NM"] = v.APPR_DEPT_NM;
							}
						});
						var tmpJson = {};
	    				tmpJson["JSONDATA"] = encodeURIComponent(JSON.stringify(sortJSON(g_paper_apprline, "APPR_ORD")));
						jsonApprLine = tmpJson;
					    is_apprline_modify = true;
					    fn_appReg();
						return false;
					} else {
						alert($.i18n.prop("msg263"));
						return false;
					}
				}
                  open_smartPop({href:"apprline_list_0007.act", width: 500, height: 630, target : window, frm:$("#frm_appr_dtl_0005")});
                                                                             
            });  
           
            /**
             * 기안작성 버튼 Click Function
             */
            this.addEvent("#btnAppr", "click", function(){
                  $("#frm_appr_dtl_0005").find("#PROC_GB").val("U");
                  $("#frm_appr_dtl_0005").find("#MENU_TYPE").val("R");
                  $("#frm_appr_dtl_0005").find("#APPR_MODE").val("RE");
                  $("#frm_appr_dtl_0005").find("#TMP_MENU_TYPE").val("T");
                  $("#frm_appr_dtl_0005").find("#BASIS_DOC_APPR_SEQ_NO").val($("#frm_appr_dtl_0005").find("#APPR_SEQ_NO").val());
                  $("#frm_appr_dtl_0005").find("#PRE_APPR_SEQ_NO").val($("#frm_appr_dtl_0005").find("#APPR_SEQ_NO").val());
                  open_popup("frm_appr_dtl_0005",{sizeW:"950" ,sizeH:"800", target:"_self",action:"appr_dtl_0005.act"});
            });
           
            // 인쇄
/*         
this.addEvent("#btnPrint", "click", function(){
var strUserAgent = (navigator.userAgent.toUpperCase());
if( "3" == g_paper_kind || "1" == g_paper_kind || strUserAgent.indexOf( "CHROME") > 0 || strUserAgent.indexOf("FIREFOX" ) > 0 || strUserAgent.indexOf( "SAFARI") > 0
|| strUserAgent.indexOf( "TRIDENT/4.0" ) > 0 || strUserAgent.indexOf("TRIDENT/5.0" ) > 0){
window.print();
} else if("2" == g_paper_kind){

                        // 연계문서인 경우
                        try{
                              var iframe_height = $("#ifrm_rel").attr("height");
                              iframe_height = (parseInt(iframe_height) + 50);
                             
                              var oIframe = document.getElementById('ifrm_rel_print');
                          $apprline = $("#tempapprline").html();
                          $title = $("#temptitle").html();
                          $docinfo = $("#tempdocinfo").html();
                          var oDoc = (oIframe.contentWindow || oIframe.contentDocument);
                          if (oDoc.document) oDoc = oDoc.document;
                              oDoc.write("<html><head><title>title</title>");
                          oDoc.write("<link rel='stylesheet' type='text/css' href='https://approval.appplay.co.kr/css/reset.css'");
                        oDoc.write("<link rel='stylesheet' type='text/css' href='https://approval.appplay.co.kr/css/content.css'");
                          oDoc.write("</head><body onload='this.focus(); this.print();'><div class='pop_wrap'><div class='pop_container'>");
                          oDoc.write("<div class='cboth mgb20'>" + $apprline  + "</div><div class='p_style2_wrap' style='margin-bottom:20px !important;'>"+ $title + "</div><div class='cboth mgb10'>" + $docinfo + "</div>");
                          oDoc.write("<div style='overflow-y:visible;' >" + $apprCont + "</div>");
                          oDoc.write("</div></div></body></html>");
                              oDoc.close();    
                      }
                      catch(e){
                            self.print();
                      }
                  }
            });
*/

            this.addEvent("#btnPrint", "click", function(){
                  var agent = navigator.userAgent.toLowerCase();
                  //2018.04.05 배유연 수정중...
                  if("111" == g_paper_seq_no){
                	  $("#intaxPrint").css("display","");   
                	 
            	  }else{
            		  //기존
            		  //window.print();
            		  //2019.08.16 배유연 수정 : 결재의견 포함여부에 따른 인쇄 탭 선택
            		  if(parent.document.location.href.indexOf("appr_dtl_0005") != -1){
            			  
            			  window.print();
            		  }else{
            			  $("#opinionPrint").toggle();  
            		  }
            		  
            	  }
                  
            });    
            
            //2019.08.19 배유연 추가
            
            //결재의견 미포함하여 인쇄
            $("#printNoIncludeOpin").on("click", function(e){
            	window.print();
            	$("#opinionPrint").hide();
            });
            $("#printIncludeOpin").on("click", function(e){
            	if($("#DIV_OPINION_PRINT").find("tbody").find("tr").length>0){
            		$("#DIV_OPINION_PRINT").show();
                	window.print();
                	$("#DIV_OPINION_PRINT").hide();
            	}else{
            		window.print();
            	}            
            	$("#opinionPrint").hide();
            
            });
			//에디터 영역만 다운로드
            $("#printMainArea").on("click", function(e){
        		$("#APPR_CONT").siblings('div').hide();
				$("#R_TBL").hide();
            	window.print();
				$("#btnLLayer, #tempapprline, #temptitle, #tempdocinfo, #R_TBL, #fileAttchPrint, #bottomDiv").show();
            	$("#opinionPrint").hide();
            });
            
            var clickFlag_print =true;
            this.addEvent("#printIncludeOpin, #printNoIncludeOpin, .pdfDown ", "mousedown", function(e) {
            	clickFlag_print =true;           
            });
           
            
            var clickFlag =true;
            this.addEvent("#intaxPrint_mode1", "mousedown", function(e) {
                  clickFlag =true;
                 
     
            });
            this.addEvent("#intaxPrint_mode2", "mousedown", function(e) {
                  clickFlag =true;
                 
                 
                 
           
            });
            this.addEvent("#intaxPrint_mode1", "click", function(e) { // 지출결의서 인쇄 버튼만 눌렀을 경우
            	 //$("#ifrm_rel").contents().find(".div_file").css("display","block");
            	 
                 // top.ifrm_rel.focus();
                  //window.print();

            	var agent = navigator.userAgent.toLowerCase();
            	if ( (navigator.appName == 'Netscape' && navigator.userAgent.search('Trident') != -1) || (agent.indexOf("msie") != -1) ) {//IE
          		  	$("#ifrm_rel").contents().find(".div_file").css("display","block");
          		  	if(document.referrer.indexOf("appr_dtl_0008.act")>0){
          		  		
          		  		top.ifrm_0005.ifrm_rel.focus();
          		  	}else{
          		  		top.ifrm_rel.focus();
          		  	}
          		  	
          		  	
          		  	window.print();
          		  	$("#ifrm_rel").contents().find(".div_file").css("display","none");

          	  	}else{ //
          	  		/*$("#ifrm_rel").contents().find(".div_file").css("display","block");
          	  		top.ifrm_rel.print(); 
          	  		$("#ifrm_rel").contents().find(".div_file").css("display","none");*/
          	  		//2018.05.03 배유연 수정
          	  		window.print();
          	  	}
          	
                 $("#intaxPrint").css("display","none");
                 // $("#ifrm_rel").contents().find(".div_file").css("display","none");
     
            });
            this.addEvent("#intaxPrint_mode2", "click", function(e) { //매입세금계산서 배유연 추가 (세금계산서 포함 인쇄)
                 
                 
            /*
                  var height2 =0;
                  //$("#ifrm_rel").contents().find("#taxDiv").css("display","block");
                  $.each($("#ifrm_rel").contents().find("#taxDiv").find("#printDiv"),function () {
                      height2 += $(this).height();
                  });
                 
                  */
                 
                  var returnVal = callbackTax();
/*
var iFrameID = document.getElementById('ifrm_rel');
if(iFrameID) {
iFrameID.height = "";
g_ifrm_height = iFrameID.contentWindow.document.body.scrollHeight;
iFrameID.style.height =  "0";
iFrameID.style.height =  "2000px";
}
*/               
if(returnVal==1){
//top.ifrm_rel.print();

                	  var agent = navigator.userAgent.toLowerCase();

                	  

                	  if ( (navigator.appName == 'Netscape' && navigator.userAgent.search('Trident') != -1) || (agent.indexOf("msie") != -1) ) {//IE
                		  $("#ifrm_rel").contents().find(".div_file").css("display","block");
                		  //top.ifrm_rel.focus();
                		  try{
                			  ifrm_rel.focus(); 
                		  }catch(e){
                			  top.ifrm_rel.focus();  
                		  }
                		  window.print();
                		  $("#ifrm_rel").contents().find(".div_file").css("display","none");

                	  }else{ //
                		  $("#ifrm_rel").contents().find(".div_file").css("display","block");
                		  
                		  try{
                			  ifrm_rel.print(); 
                		  }catch(e){
                			  top.ifrm_rel.print();   
                		  }
                		  
                		  $("#ifrm_rel").contents().find(".div_file").css("display","none");
                	  }
                	
                	  
                	 
                	 // parent.ifrm_rel.print();
                	  //document.ifrm_rel.printMe();
                	
                	  //document.getElementById("ifrm_rel").contentWindow.focus();
                	  	
                        //$("#ifrm_rel").focus();
                        //window.print();
                        //window.print();//일단 출력
                	   $("#fileAttchPrint", window.parent.document).removeClass("print");
                       
                        // 이제 끝났으니까 다시 프린트 관련 속성을 없애준다.
                        $.each($("#ifrm_rel").contents().find("#taxDiv"),function () {
                             
                              $(this).removeClass("print-display");
                             
                        });
                        $.each($("#ifrm_rel").contents().find("#taxDiv").find(".pop_wrap"),function (i) {
                              $(this).removeClass("print");
                       
                        });
                       
                  }
                  // 인쇄 버튼 눌렀을 때 나오는 탭화면 안보이게함.
                  $("#intaxPrint").css("display","none");
     
            });
     
            this.addEvent("#btnPrint, #btnPDF", "blur", function(){
                  if(clickFlag){
                        clickFlag=false;
                  }
                  else{
                        $("#intaxPrint").css("display","none");
                  }
                  
                  if(clickFlag_print){
                	  clickFlag_print=false;
                  }
                  else{
                	  $("#opinionPrint").css("display","none");
                	  $("#opinionPDF").css("display","none");
                  }
           
            });
            // PDF 다운로드
            this.addEvent("#btnPDF", "click", function() {
            	try{
	            	if(parent.document.location.href.indexOf("appr_dtl_0005") != -1){
	            		fn_pdfDown();
	            	}else{
	            		$("#opinionPDF").toggle();	
	            	}
            	}catch(e){
            		fn_pdfDown();
            	}
            	
            });        
           
            this.addEvent("#btnApprCancel", "click", function() {
                  var jsonRECS = []; 
                  var jsonREC = null;
                  jsonREC = {};
                  jsonREC["APPR_SEQ_NO"] = g_appr_seq_no;
                  jsonRECS[0] = jsonREC;
                  if(confirm($.i18n.prop("msg147")) == true){ //"정말 취소하시겠습니까?"
                        var jexAjax = jex.createAjaxUtil("appr_u004");
                        jexAjax.set("PTL_ID"        , g_ptl_id);
                        jexAjax.set("CHNL_ID"        , g_chnl_id);
                        jexAjax.set("USE_INTT_ID"    , g_use_intt_id);
                        jexAjax.set("EDTR_ID"        , g_user_id);
                        jexAjax.set("APPR_SEQ_REC"    , jsonRECS);     
                        jexAjax.setAsync(false);
                        jexAjax.execute(function(dat){
                        	
                        	if(dat.RSLT_CD=="취소된 항목이 없습니다."?  $.i18n.prop("msg81")  : (dat.RSLT_CD=="반려하였습니다."?  $.i18n.prop("msg82") : (dat.RSLT_CD=="취소하였습니다."?  $.i18n.prop("msg83") : dat.RSLT_CD))) 
                              if("0000" !== dat.RSLT_CD){ //임시 코드
                                    alert(dat.RSLT_MSG);        
                              }else{
                                    alert(dat.RSLT_MSG);
                                    parent.close();                                  
									parent.opener.g_sync_yn="Y";
									parent.reloadList();
                              }
                        });
                  }
                  else{
                        return;
                  }
                 
            });
           
            //$("#ifrm_rel").contents().find(".cardbill_box .right strong")
           
            // 세금계산서 상세보기 버튼
            $(document).on("click", "a[name='btn_cardbill']", function(e){
                                   
              if($(this).attr("class") == "btn_cardbill_open"){
                  $(this).attr("class", "btn_cardbill_close");
                  $(this).closest("td").find(".view_cardbill").css("display","block");
              }else{
                  $(this).attr("class", "btn_cardbill_open");
                  $(this).closest("td").find(".view_cardbill").css("display","none");
              }
            });
           
            // 영수증 전체 펼치기
            this.addEvent("#printDetail", "click", function(){
                  if($(this).is(':checked')){
                    
                        //$("#ifrm_rel_print").contents().find(".cardbill_box").css("display","none");
                        $("#ifrm_rel_print").contents().find(".view_cardbill").css("display","block");
                        $("#ifrm_rel_print").contents().find(".view_cardbill").css("position","static");
                       
                        fn_ifrmReSize();
                  } else {
                        //$("#ifrm_rel_print").contents().find(".cardbill_box").css("display","block");
                        $("#ifrm_rel_print").contents().find(".view_cardbill").css("display","none");
                        $("#ifrm_rel_print").contents().find(".view_cardbill").css("position","absolute");
/*
var iFrameID = document.getElementById('ifrm_rel');
if(iFrameID) {
iFrameID.height = g_ifrm_height + "px";
}
*/                                       
}
});

            $.fn.digits = function(){
                return this.each(function(){
                    $(this).text( $(this).text().replace(/(\d)(?=(\d\d\d)+(?!\d))/g, "$1,") );
                });
            };
           
        $(".item_type1").digits();
                 
         
        
        //2018.08.25 배유연 추가 : 사전승인서 내용 더 보기 버튼
        $(".print_ss_tbl_view").on({
        	click : function(){
        		if($(this).parent().find(".layertype1").css("display") =="none"){
        			$(this).parent().find(".layertype1").css("display","");
        		}else{
        			$(this).parent().find(".layertype1").css("display","none");
        		}
        	},
        	blur : function(){
        		
        		$(".print_ss_tbl_view").find(".layertype1").css("display","none")
        		
        	}
        	
        },".more");
        
        //2018.08.26 배유연 추가 : 사전승인 추가 내역 수정버튼
        $(".print_ss_tbl_view").on({
        	click : function(){
        		var seq_no = $(this).parent().parent().parent().find(".pre_seq").attr("data");
        		fn_apprPriorItemAdd("U",seq_no);
        	}
        	
        },".prior_update");
        //2018.08.26 배유연 추가 : 사전승인 추가 내역 삭제버튼
        $(".print_ss_tbl_view").on({
        	click : function(){
        		var r = confirm( $.i18n.prop("msg84")); // 삭제하시겠습니까?
        		if(!r){
        			return false;
        		}
        		var seq_no = $(this).parent().parent().parent().find(".pre_seq").attr("data");
        		fn_apprPriorItemAdd("D",seq_no);
        	}
        	
        },".prior_delete");
        
        
        //2019.08.26 배유연 추가 : 사전승인 추가 내역 삭제버튼
        $(".print_ss_tbl_view").on({
        	click : function(){
        		var r = confirm( $.i18n.prop("msg84")); // 삭제하시겠습니까?
        		if(!r){
        			return false;
        		}
        		var seq_no = $(this).parent().parent().parent().find(".pre_seq").attr("data");
        		fn_apprPriorItemAdd("D",seq_no);
        	}
        	
        },".prior_delete");
        
        //2019.4.23 배유연추가 : 첨부이력 마우스 오버
        $("#fileAttchPrint").on({
        	mouseover : function(){
        		 $(this).parent().parent().find(".ly_addfile_history").css("display","inline-block");
        	}
        	
        },".addfile_history_more");
        $("#fileAttchPrint").on({
        	mouseleave : function(){
        		$(this).hide();
        	}
        	
        },".ly_addfile_history");

		//2022.07.07 진호용추가 : 원안문서 제목 마우스 오버
        $("#fileAttchPrint").on({
        	mouseover : function(){
				var e = $(this).closest(".elipsis");
				if (e[0].offsetWidth < e[0].scrollWidth)
        			$(this).parent().parent().find(".origin_box").css("display","block");
        	}
        	
        },".show_origin_box");
        $("#fileAttchPrint").on({
        	mouseleave : function(){
        		$(this).parent().parent().find(".origin_box").css("display","none");
        	}
        	
        },".show_origin_box");
        
		//2022.07.12 진호용추가 : 첨부자료 마우스 오버
        $("#fileAttchPrint").on({
        	mouseover : function(){
				var e = $(this).closest(".elipsis");
				if (e[0].offsetWidth < e[0].scrollWidth)
        			$(this).parent().parent().find(".vouch_box").css("display","block");
        	}
        	
        },".show_vouch_box");
        $("#fileAttchPrint").on({
        	mouseleave : function(){
        		$(this).parent().parent().find(".vouch_box").css("display","none");
        	}
        	
        },".show_vouch_box");

       /* this.addEvent(".addfile_history_more , ly_addfile_history", "mouseleave", function(){
            $(this).parent().parent().find(".ly_addfile_history").hide();
        });
        */
        
        // 2019.11.18_이현수 : 서울반도체 직원 항목팝업 예외 처리를 위한 직원팝업 호출 공통 함수화
        this.addEvent(".empl_add", "click", function(){
        	addEmpl($(this));
        });
       
        
        //2019.05.20 직원 삭제 이벤트
        $("#C_TBODY").on({
        	click : function(){
        		$(this).parent().parent().remove();
        	}
        	
        },".delete_empl");
        
        
        //2019.09.17 배유연 추가 : pdf 뷰잉 기능 추가
        this.addEvent(".pdfViewing", "click", function(){
          
        	if($(this).attr("down")){
        		$(this).gdocsViewer();
        		$(this).text("▲");
            	$(this).removeAttr("down");
            	$(this).attr("up",true);
				$(this).parent().parent().parent().next().find("iframe").on("load", function() {
					resizeIframe0005();
				});
    		}else{
    			$(this).parent().parent().parent().next().remove();
    			$(this).text("▼");
            	$(this).removeAttr("up");
            	$(this).attr("down",true);
    		}
        	
        });
        //2019.09.17 배유연 추가 : img 뷰잉 기능 추가
        this.addEvent(".imgViewing", "click", function(){
          
        	if($(this).attr("down")){
        		var sHtml="<tr class='nohover fileviewing' style='display:table-row;cursor:default'><td colspan='4'><img src='"+$(this).attr("url")+"' style='max-width: 100%;height: auto;'></td></tr>";            	
            	$(this).parent().parent().parent().after(sHtml);
            	$(this).text("▲");
            	$(this).removeAttr("down");
            	$(this).attr("up",true);
				$(this).parent().parent().parent().next().find("img").on("load", function() {
					resizeIframe0005();	
				});
        	}else{
        		$(this).parent().parent().parent().next().remove();
        		$(this).text("▼");
            	$(this).removeAttr("up");
            	$(this).attr("down",true);
        	}
        	
        });
        //첨부파일 펼치기 버튼 기능
        this.addEvent("#AttchViewing", "click", function(){
            
        	if($(this).attr("fileView")=="true"){ //  다 열려있음
        		
        		$(".imgViewing").text("▼");
            	$(".imgViewing").removeAttr("up");
            	$(".imgViewing").attr("down",true);
            	
            	$(".pdfViewing").text("▼");
            	$(".pdfViewing").removeAttr("up");
            	$(".pdfViewing").attr("down",true);
            	
            	$(".fileviewing").remove();
            	
        		$(this).text($.i18n.prop("msg186"));// 첨부파일 펼치기
        		$(this).attr("fileView","false");
        	}else{ //현재 다 안보임.
        		$(".fileviewing").remove();
        		$.each($(".imgViewing"), function(i,e){
            		var sHtml="<tr class='nohover fileviewing' style='display:table-row;cursor:default'><td colspan='4'><img src='"+$(e).attr("url")+"' style='max-width: 100%;height: auto;'></td></tr>";            	
                	$(e).parent().parent().parent().after(sHtml);
                	$(e).text("▲");
                	$(e).removeAttr("down");
                	$(e).attr("up",true);
        		});

				$(".fileviewing img").on("load", function() {
					if ($(this).is($(".fileviewing img").last())) {
						resizeIframe0005();
					}
				})
        	
        		$(".pdfViewing").gdocsViewer(); // pdf문서 모두 펼치기
        		
        		$(".pdfViewing").text("▲");
            	$(".pdfViewing").removeAttr("down");
            	$(".pdfViewing").attr("up",true);

				$(".fileviewing iframe").on("load", function() {
					if ($(this).is($(".fileviewing iframe").last())) {
						resizeIframe0005();
					}
				})
        		
        		$(this).text($.i18n.prop("msg187"));// 첨부파일 접기
        		$(this).attr("fileView","true");
        		
        	}
        	
        });
        
        //2019.09.25 추가 : 안내튤팁
        $(".ico_noti").mouseover(function(){
        	$(this).parent().find(".ly_reply").show();
        });
        $(".ico_noti").mouseout(function(){
        	$(this).parent().find(".ly_reply").hide();
        });
        
        //2021.07.29 진호용 추가 : 에디터 타입 입력항목 에디터 오픈 이벤트
        $("a[id^=OPEN_EDIT_]").on("click", function() {
        	//var element = $(this).parent().find("div[id^=ITNM_18_]");
			var elementNum = $(this).attr("id").split("OPEN_EDIT_")[1];
			var element = $("#ITNM_18_"+elementNum);
        	var encoded_cont = encodeURIComponent(element.html());
        	$("#EDITOR_CALLBACK_FN").val("fn_editor_callback");
        	$("#EDITOR_TYPE_ELEMENT_ID").val("ITNM_18_"+elementNum);
        	$("#EDITOR_CONT").val(encoded_cont);
			open_popup("frm_appr_dtl_0005",{sizeW:"923" ,sizeH:"630", target:"frm_appr_dtl_0005_editor",action:"appr_editor.act"});
        	//open_smartPop({href:"appr_editor.act", width: 900, height: 670, target : window, frm:$("#frm_appr_dtl_0005")});
        });

		//외부문서
		$("#btnExtVouchAdd").on("click", function() {
			var extVouchPopUrl = $("#WEBANK_URL").val()+"/bizplay-custom-popup/g001.jsp?_callback_url="+$("#SERVICE_URL").val()+"/appr_callback_ext_vouch.act";
		    open_popup("frm_tmp", {sizeW:"480" ,sizeH:"635", target:"extVouchPop",action:""});

			var form = document.createElement("form");
		    form.appendChild(getHiddenField("BIZ_NO", $("#BIZ_REG_NO").val()));
		    form.appendChild(getHiddenField("ITEM_CD", "90"));
		    form.appendChild(getHiddenField("ERP_DEPT_CD", $("#DVSN_CD").val()));
		    form.appendChild(getHiddenField("ERP_EMPL_CD", $("#EMPL_NO").val()));
		    form.appendChild(getHiddenField("POS_SS_USER_ID", $("#USER_ID").val()));
		    form.appendChild(getHiddenField("_site", "03"));
		    form.appendChild(getHiddenField("_platform", "web"));
		    form.appendChild(getHiddenField("_selection", "multi"));
		    form.setAttribute("method", "post");
		    form.setAttribute("action", extVouchPopUrl);
		    form.setAttribute("id", "frm_tmp");
		    form.setAttribute("name", "frm_tmp");
		    form.setAttribute("target", "extVouchPop");
		    document.body.appendChild(form);
			$("#frm_tmp").submit();
		    document.body.removeChild(form);
		});
		
		window.addEventListener('message', function(event) {
			if (event.origin === $("#WEBANK_URL").val()) {
				try {
					var jsonData = event.data;
					var callbackTranNo = jsonData.TRAN_NO;
					var itemType = "";
					if ("0000" == jsonData.RSLT_CD) {
						if ("CRD_MAGR_L026" == callbackTranNo) {
							itemType = "20";
						} else if ("CRD_MAGR_L025" == callbackTranNo) {
							itemType = "21";
						} else if ("CRD_MAGR_L028" == callbackTranNo) {
							itemType = "23"
						}
						fn_callbackSsoPop(itemType, jsonData.RESP_DATA);
					}
				} catch (e) {
					console.log(e);
				}
			} else if (event.origin === "https://budget-dev.appplay.co.kr") {
				if ("" !== event.data) {
					budgetExecData = encodeURIComponent(JSON.stringify(event.data));
					bgtProCallback(budgetExecData);
				}
			}
		});

      } 

}))();
//매입세금계산서 : 세금계산서 포함한 인쇄 시 사용하는 함수
function callbackTax(){
$.each($("#ifrm_rel").contents().find("#taxDiv"),function () {

            $(this).addClass("print-display"); // @media 안에 이해당 div가 display:bloack 되어있어야 출력됨,
            //$(this).css("page-break-before","always");
            //$(this).css("display","block !imoportant");
            //$(this).addClass("print");
      });
      $.each($("#ifrm_rel").contents().find("#taxDiv").find(".pop_wrap"),function (i) { // 세금계산서 하나씩 for 루프 돌림.
           
           
           /* if($(this).attr("data") =="type3"){ //위수탁 세금계산서일 때는 무조건 페이지에 세금계산서 한장씩 자른다.
                  $(this).addClass("print");
            }
            else{ // 위수탁 그 외에는
                  if( i %2 ==0){ // 위수탁 제외 세금계산서 일때는 2개씩 프린트가 되도록 함.
                        $(this).addClass("print");
                  }
            }*/
    	  $(this).addClass("print");
    	  
            //$(this).css("page-break-before","always");
            //$(this).css("display","block !imoportant");
            //$(this).addClass("print");
      });
      $("#fileAttchPrint", window.parent.document).addClass("print");
      return 1;
}


function fn_appReg(){
if(cnts_Null2Void($("#C_TBL").find("#APPR_SUBJ").val(),"") == ""&& g_paper_path != "cust_99_UTLZ_1808301082871.jsp"&& g_paper_path != "cust_99_UTLZ_1808301082871_2.jsp") {
alert($.i18n.prop("msg50") +" "+ $.i18n.prop("M9108"));
$("#C_TBL").find("#APPR_SUBJ").focus();
return;
}

      // 아이템 항목 체크 Item check validation
      var o_item_table = $("#C_TBL #C_TBODY tr");
//    var o_th = 1;
//var i_error = 0;
var j=0;
for(var i=1; i<=g_paper_item_len; i++){
//var item_key;
var item_nm;
var item_lnkd1 = "";
var item_lnkd2 = "";

            item_key = $(o_item_table).find("th").eq(i).attr("usr-attr");  // th=item_seq_ td=input_type
            item_nm = $(o_item_table).find("th").eq(i).find("div").text();
            o_item_value = $(o_item_table).find("td").eq(i);
            var s_input_type = $(o_item_value).attr("usr-attr");
     
            var diff_start_sect_date = 0;
            var diff_end_sect_date = 0;
            if("3" == s_input_type){
                  item_lnkd1 = $(o_item_value).find(".START_SELECT_DATE").val();
                  item_lnkd2 = $(o_item_value).find(".END_SELECT_DATE").val();
                  if(item_lnkd1 ==""){//인사연동 부분은 id 로 되어있어서
                        if($(o_item_value).find("#START_SELECT_DATE").val() !=null)
                              item_lnkd1 = cnts_Null2Void($(o_item_value).find("#START_SELECT_DATE").val(),"");
                  }
                 
                  if(item_lnkd2 ==""){
                        if($(o_item_value).find("#END_SELECT_DATE").val() !=null)
                              item_lnkd2 = cnts_Null2Void($(o_item_value).find("#END_SELECT_DATE").val(),"");
                  }
                  diff_start_sect_date = cnts_Null2Void(parseInt(item_lnkd1.replace(/-/g, '')),"");
                  diff_end_sect_date = cnts_Null2Void(parseInt(item_lnkd2.replace(/-/g, '')),"");
            } else if("4" == s_input_type){
                  //item_lnkd1 = $(o_item_value).find("#SELECT_DATE").val();
                  item_lnkd1 = $(o_item_value).find("[class^='SELECT_DATE']").val();
                  if(item_lnkd1 ==""){
                        item_lnkd1 = cnts_Null2Void($(o_item_value).find("[id^='SELECT_DATE']").val(),"");
                  }
            } else if("7" == s_input_type){
                  // 시간기간 추가
                  item_lnkd1_t = $(o_item_value).find("#START_SELECT_TIME option:selected").val();
                  item_lnkd1_m = $(o_item_value).find("#START_SELECT_MIN option:selected").val();
                  item_lnkd2_t = $(o_item_value).find("#END_SELECT_TIME  option:selected").val();
                  item_lnkd2_m = $(o_item_value).find("#END_SELECT_MIN option:selected").val();
                 
                  item_lnkd1 = item_lnkd1_t + item_lnkd1_m;
                  item_lnkd2 = item_lnkd2_t + item_lnkd2_m;
                 
                  diff_start_sect_date = parseInt(item_lnkd1);
                  diff_end_sect_date = parseInt(item_lnkd2);
            } else if("8" == s_input_type){
                  //item_lnkd1 = $(o_item_value).find("#SELECT_DATE").val();
                  item_lnkd1 = $(o_item_value).find("#USER_DEFINES").val();                           
            } else {
                  item_lnkd1 = $(o_item_value).find("input[name^='TXT_ITNM']").val();
            }
            if("" == item_lnkd1 || ( "" == item_lnkd2 && "3" == s_input_type)){
                //  alert(item_nm + jex.getMsg("9108"));
                //  return;
            }
           
            if("3" == s_input_type && diff_start_sect_date > diff_end_sect_date){
                  alert(item_nm + $.i18n.prop("M9115"));
                  return;
            }
           
      }  
     
      if(is_apprline_modify){
            s_proc_gb = "2";
            
            //~~~~~~~~~ 2018.10.05 배유연 추가 : 출장신청/정산 문서는 지출결의 문서이기 때문에 요건별 결재선 호출해야함.
            // 2018.12.16 원안문서/첨부파일 필수여부도 호출해야함.
           /* if($("#PAPER_CATE").val() =="601"){
            	//fn_docuAddYn(); //2020.08.19 appr_c002 action 에서 처리할거임.
            }else{
            	fn_saveAppr(jsonApprLine);
            }*/
            
            fn_saveAppr(jsonApprLine);
            
      } else {
            s_proc_gb = "2";
            open_smartPop({href:"appr_sts_list_0004.act", width: 600, height: 505, target : window, frm:$("#frm_appr_dtl_0005")});
      }    
}
/**
* 달력 초기화 함수
* @return
  */
  function fn_setCalendar(){
  //여기에 키보드 입력 되도록 하기.
  $(".START_SELECT_DATE").next("a").click(function(){
  if($("#ui-datepicker-div").css("display") != "none"){
  //	  $("#ui-datepicker-div").css("display","none");
  return;
  }
  $(this).prev().focus();
  });


      $(".START_SELECT_DATE").datepicker({
	        changeMonth: true,
	        dateFormat: 'yy-mm-dd'
	      
	    });//.attr('readonly','readonly');  
      
      
      $(".END_SELECT_DATE").next("a").click(function(e){
    	  if($("#ui-datepicker-div").css("display") != "none"){
    	//	  $("#ui-datepicker-div").css("display","none");
    		  return;
    	  }
    	  $(this).prev().focus();
  	     
      });
      $(".END_SELECT_DATE").datepicker({
	        changeMonth: true,
	        dateFormat: 'yy-mm-dd',
	        
	        beforeShow: function(input, inst)
	        {
	        	setTimeout(function () {
			        if(inst.dpDiv){
			        	
			        	var datepickerUIRight = inst.dpDiv[0].offsetWidth + inst.dpDiv[0].offsetLeft;
			        	if(datepickerUIRight>window.innerWidth)
			        		inst.dpDiv.css({ left: window.innerWidth-15 - inst.dpDiv[0].offsetWidth });
			        }
		        },0);
	        }
	      
	    });//.attr('readonly','readonly');  
     
      $("[class^='SELECT_DATE']").datepicker({
	        changeMonth: true,
	        dateFormat: 'yy-mm-dd'
	      
	    });//.attr('readonly','readonly');  
      $("[class^='SELECT_DATE']").next("a").click(function(){
            $(this).prev().focus();
      });  
      
      
      //2019.10.04 추가
      $("[class^='START_SELECT_DATE']").blur(function(){
    	  
    	  if($(this).val() !=""){
    		  var date = $(this).val().replaceAll("-","");
	  	      if(date.length != 8){
	  	    	  alert($.i18n.prop("msg189"));
	  	    	  $(this).val("");
	  	    	  return false;
	  	      }else{
	  	    	 
	  	    	  $(this).val(skyComm.formatterDate(date));
	  	      }
    	  }
	        
	      
	  });
      $("[class^='END_SELECT_DATE']").blur(function(){
    	  if($(this).val() !=""){
    		  var date = $(this).val().replaceAll("-","");
	  	      if(date.length != 8){
	  	    	  alert($.i18n.prop("msg189"));
	  	    	  $(this).val("");
	  	    	  return false;
	  	      }else{
	  	    	 
	  	    	  $(this).val(skyComm.formatterDate(date));
	  	      }
    	  }
	      
	  });
      
      $("[class^='SELECT_DATE']").blur(function(){
    	  if($(this).val() !=""){
    		  var date = $(this).val().replaceAll("-","");
	  	      if(date.length != 8){
	  	    	  alert($.i18n.prop("msg189"));
	  	    	  $(this).val("");
	  	    	  return false;
	  	      }else{
	  	    	 
	  	    	  $(this).val(skyComm.formatterDate(date));
	  	      }
    	  }
    });  
}
function fn_setCalendar2(){
$("#START_SELECT_DATE").datepicker({
changeMonth: true,
dateFormat: 'yy-mm-dd'

	    }).attr('readonly','readonly');  
      $("#START_SELECT_DATE").next("a").click(function(){
            $(this).prev().focus();
      });
      $("#END_SELECT_DATE").datepicker({
	        changeMonth: true,
	        dateFormat: 'yy-mm-dd'
	      
	    }).attr('readonly','readonly');  
      $("#END_SELECT_DATE").next("a").click(function(){
            $(this).prev().focus();
      });
      $("[id^='SELECT_DATE']").datepicker({
	        changeMonth: true,
	        dateFormat: 'yy-mm-dd'
	      
	    }).attr('readonly','readonly');  
      $("[id^='SELECT_DATE']").next("a").click(function(){
            $(this).prev().focus();
      });  
}
/**
* 경우에 따른 버튼 조건 처리
* Conditions on the Button Processing Function
  */
  function fn_btnSet(){
  // 왼쪽 : 결재정보
  // 왼쪽 : 임시저장, 미리보기 (쓰기)
  // 오른쪽  : 결재선 관리,  결재처리 , 재기안, 결재요청 (쓰기)
  var sHtmlL = "";
  var sHtmlR = "";

  if("R" == g_menu_type && g_rps_paper_cd != "-1"){
  sHtmlL += "<a href='javascript:' id='btnTmpProc' class='btn_style4'><span>"+$.i18n.prop("msg94")+"</span></a>&nbsp;";//임시저장
  }


      if("4" != g_apprline_kind && ("PW" == g_menu_type || "DW" == g_menu_type  || "AW" == g_menu_type )){
    	  //2018.01.21 배유연 추가 : 관리자가 못바꾸게 한경우는 결재선 변경 안되게
    	  
    	  if(g_use_intt_id=="UTLZ_160713154539258"){
    		  sHtmlR += "<a href='javascript:' id='btnStsChange' class='btn_style4'><span>"+$.i18n.prop("msg13")+"</span></a>&nbsp;";//결재선변경
    	  }else{
    		  if($("#APPRLINE_SEQ_NO_FIX_YN").val() != "Y" && parent.g_appr_yn=="Y" ){
        		  
        		  sHtmlR += "<a href='javascript:' id='btnStsChange' class='btn_style4'><span>"+$.i18n.prop("msg13")+"</span></a>&nbsp;";//결재선변경  
        	  }  
    	  }
      }
     
      if("R" == g_menu_type || "U" == g_proc_gb){
			if ("Y" === $("#GROUPWARE_BTN_USE_YN").val() && "601"===$("#PAPER_CATE").val()) {
				if ("UTLZ_2309181430965" == g_use_intt_id) {
					sHtmlR += "<a href='javascript:' id='btnStsMgr' class='btn_style4'><span>ERP 전송</span></a>&nbsp;";//ERP 전송
				} else {
		            sHtmlR += "<a href='javascript:' id='btnStsMgr' class='btn_style4'><span>"+$.i18n.prop("msg262")+"</span></a>&nbsp;";//그룹웨어 전송
				}
			} else {
	            sHtmlR += "<a href='javascript:' id='btnStsMgr' class='btn_style4'><span>"+$.i18n.prop("msg95")+"</span></a>&nbsp;";//결재요청
			}
      }
      if(("1" == g_paper_kind || "3" == g_paper_kind) && ("PW" == g_menu_type || "PH" == g_menu_type || "PC" == g_menu_type || "DW" == g_menu_type || "DH" == g_menu_type || "DC" == g_menu_type ||
                  "AW" == g_menu_type ||  "AH" == g_menu_type || "AC" == g_menu_type ||
                  (("2" == g_appr_sts || "3" == g_appr_sts || "4" == g_appr_sts) && "M" == g_menu_type )) ){
            sHtmlR += "<a href='javascript:' id='btnReAppr' class='btn_style4'><span>"+$.i18n.prop("msg148")+"</span></a>&nbsp;";//재기안
      }
      //2017.09.22 배유연추가: 회람버튼 추가 / 완료건인것만 나와야함.
      //2021.09.02 진호용 추가 : 회람 기능 확장
      try { // 카드지출결의에서  opener 는 다른 주소이기 때문에 접근할 수 없음 따라서 try-catch 구문으로 묶어 주어야함. 
    	  if ("Y"==$("#APPR_SHARE_USE_YN").val() & "H"!=g_menu_type && "N" == $(parent.document).find("#EMAIL_YN").val()) {//회람함에서 띄운게 아니면

    		  if ( ("1" == $("#APPR_SHARE_RANGE").val() && "3" == g_appr_sts) || 
    				  ("2" == $("#APPR_SHARE_RANGE").val() && ("2" == g_appr_sts || "3" == g_appr_sts || "4" == g_appr_sts)) ) {
    			  sHtmlR += "<a href='javascript:' id='btnShareAppr' class='btn_style4'><span>"+$.i18n.prop("msg96")+"</span></a>&nbsp;"; //회람
    		  }

			if(
				($("#APPR_SHARE_RANGE").val()[0] == "1" &&  "3" == g_appr_sts) ||
				($("#APPR_SHARE_RANGE").val()[1] == "1" && ("2" == g_appr_sts || "8" == g_appr_sts || "9" == g_appr_sts) ) ||
				($("#APPR_SHARE_RANGE").val()[2] == "1" &&  "4" == g_appr_sts) 
			){
				sHtmlR += "<a href='javascript:' id='btnShareAppr' class='btn_style4'><span>"+$.i18n.prop("msg96")+"</span></a>&nbsp;"; //회람
			}

    	  }
      } catch (exception) {
    	  
      }
      
     
      if("4" != g_apprline_kind && ("PW" == g_menu_type || "PH" == g_menu_type || "DW" == g_menu_type || "DH" == g_menu_type || "AW" == g_menu_type || "AH" == g_menu_type)){
          //2018.07.13 배유연 수정 : 새  결재처리화면에서는  버튼 안보이도록 숨김.
    	  
    	  if(document.referrer.indexOf("appr_dtl_0008.act")<1){
    		  sHtmlR += "<a href='javascript:' id='btnStsProc' class='btn_style4'><span>"+$.i18n.prop("msg43")+"</span></a>&nbsp;";//결재처리  
    	  }
    	   
      }
      if("T" != g_menu_type && "R" != g_menu_type){
            sHtmlL += "<a href='javascript:' id='btnStsInfo' class='btn_style4'><span>"+$.i18n.prop("msg1")+"</span></a>&nbsp;";//결재정보
      }
     
      if(("1" == g_paper_kind || "3" == g_paper_kind ||  "4" == g_paper_kind) && "T" == g_menu_type){
            sHtmlR += "<a href='javascript:' id='btnAppr' class='btn_style4'><span>"+$.i18n.prop("msg97")+"</span></a>&nbsp;";//기안작성
      }
     
      if("R" != g_menu_type){
            sHtmlL += "<a href='javascript:' id='btnPrint' class='btn_style4'><span>"+$.i18n.prop("msg98")+"</span></a>&nbsp;";// 인쇄
            sHtmlL += "<a href='javascript:' id='btnPDF' class='btn_style4'><span>"+$.i18n.prop("msg99")+"</span></a>&nbsp;";//pdf다운로드
      }    
     
      if (g_appr_cancel_can_yn == 'Y') {
            sHtmlR += "<a href='javascript:' id='btnApprCancel' class='btn_style4'><span>"+$.i18n.prop("msg100")+"</span></a>&nbsp;";// 결재취소
      }
     
      if ($("#TMP_MENU_TYPE").val() == "SHARE" || parent.g_read_only_yn === "Y") {//배유연 추가 :회람 문서는 안보이게
            sHtmlR="";
      }
     
     
      $("#btnLLayer").append(sHtmlL);
      $("#btnRLayer").append(sHtmlR);
}
/**
* 기안문서 재기안 함수
* Rewrite Appr Document function
  */
  function fn_goRewriteAppr(aNotApprVouch){
  var s_appr_vouch = aNotApprVouch;
  if("X" != s_appr_vouch){
  $("#frm_appr_dtl_0005").find("#BASIS_DOC_APPR_SEQ_NO").val($("#frm_appr_dtl_0005").find("#APPR_SEQ_NO").val());
  }
  else if("X" == s_appr_vouch){// 2017.10.18 추가 :  원안문서 첨부하겠냐는 alert 에서 취소 누를 경우
  $("#frm_appr_dtl_0005").find("#BASIS_DOC_APPR_SEQ_NO").val("X");
  }
  $("#frm_appr_dtl_0005").find("#APPR_MODE").val("RE");
  $("#frm_appr_dtl_0005").find("#MENU_TYPE").val("R");
  $("#frm_appr_dtl_0005").find("#PROC_GB").val("U");
  //open_popup("frm_appr_dtl_0005",{sizeW:"950" ,sizeH:"800", target:"_self",action:"appr_dtl_0005.act"});

  $("#frm_appr_dtl_0005").find("#PROC_GB").val("U");
  try{
  $("#frm_appr_dtl_0005").find("#PARENT_URL").val(window.opener.document.location.href);  
  }catch(Exception){

  }

  $("#frm_appr_dtl_0005").action="appr_dtl_0005.act";
  $("#frm_appr_dtl_0005").target = "_self";

  //기존
  // $("#frm_appr_dtl_0005").submit();
  //2018.07.12 배유연 수정 :

  if($("#PARENT_URL").val().indexOf("appr_list_0007")>-1){

   	  $("#frm_appr_dtl_0005").submit();

  }
  else{
  open_popup("frm_appr_dtl_0005",{sizeW:"950" ,sizeH:"800", target:"window",action:"appr_dtl_0005.act"});

   	  parent.close();  
  }




}
/**
* 결재양식 상세조회 함수
* Appr Document Detail Search Function
* @return
  */
  function fn_getPaperDtlSrc(){
  var jexAjax = jex.createAjaxUtil("appr_paper_r003");
  jexAjax.set("PTL_ID"          , g_ptl_id);     
  jexAjax.set("CHNL_ID"         , g_chnl_id);    
  jexAjax.set("USE_INTT_ID"     , g_use_intt_id);      
  jexAjax.set("PAPER_SEQ_NO"    , g_paper_seq_no);
  jexAjax.set("GB"              , "APPR");
  jexAjax.set("_LODING_BAR_YN_" ,"N");
  jexAjax.setAsync(false);
  jexAjax.execute(function(dat){
  if(!jex.isError(dat)){
  g_paper_apprline 		  = dat.REC2; //양식별결재선
  g_paper_kind            = dat.PAPER_KIND;                   // 연계여부
  g_paper_nm              = dat.PAPER_NM;                     // 문서명
  g_paper_cont            = dat.PAPER_CONT;             // 내용
  g_trip_calcul_rcpt_item = dat.TRIP_CALCUL_RCPT_ITEM;	// 출장정산서 영수증 항목
  $("#PAPER_NM").text(g_paper_nm);                      // 문서명
  $("#PAPERKIND").val(g_paper_kind);                    // 연계여부
  if (editorGb == "cross" && editorLoadYn == "Y") {
  CrossEditor.SetBodyValue(g_paper_cont);
  }
  //2021.05.31 진호용 추가 : 크로스에디터 사용 시 placeholder 제어
  if (g_paper_kind == "1" && (g_proc_gb =="C" || g_proc_gb =="U")) {
  if (editorGb == "cross" && g_paper_cont != '<p><br></p>' && g_paper_cont != '<p style="text-align: left;"><br></p>') {
  CrossEditor.params.Placeholder = "";
  }
  }

                 var date = new Date();
                 var year = date.getFullYear();
                 var month = date.getMonth() + 1;
                 var dayOfMonth = date.getDate();
                 if(month < 10 ) month = "0" + month;
                 if(dayOfMonth < 10) dayOfMonth = "0" + dayOfMonth;
                
                 var s_doc_no_pref = dat.DOC_NO_PREF;      // 문서접두어
                 var s_doc_no_suff = dat.DOC_NO_SUFF;      // 문서접미어
                 var s_doc_no_1 = "";
                 var s_doc_no_2 = "";
                 var s_doc_no = "";
                 if("1" == s_doc_no_pref){                 // 분서분류
                       s_doc_no_1 = dat.PAPER_CATE_NM;
                 } else if("2" == s_doc_no_pref){    // 문서명
                       s_doc_no_1 = dat.PAPER_NM;
                 } else if("3" == s_doc_no_pref){    // 문서약칭
                       s_doc_no_1 = dat.PAPER_ABBR_NM;
                 }
                 if("1" == s_doc_no_suff){
                       s_doc_no_2 = year + "-OOOO";
                 } else if("2" == s_doc_no_suff){
                       s_doc_no_2 = year +  ""  + month + "-OOOO";
                 } else if("3" == s_doc_no_suff){
                       s_doc_no_2 = year + "" + month + "" + dayOfMonth + "-OOOO";
                 }
                
                 s_doc_no = s_doc_no_1 + "-" + s_doc_no_2;
                
                 $("#DOC_NO").text(s_doc_no);

  			  //양식별보안결재
  			  parent.g_paper_secu_appr_yn = dat.SECU_APPR_YN; 
                
                 // 결재 양식지 항목 사용 -> tr 추가함
                 g_paper_item_len = dat.REC.length;
                
                 //alert(g_paper_item_len);
                 if(g_paper_item_len > 0) {
                       var sHtmlItem = "";
                       var previous_tr_chk = true;
  					var tdCnt = 0;
                      
                       $.each(dat.REC, function(i, v){
                       	  var s_input_type  = cnts_Null2Void(v.INPUT_TYPE, "");
                             var s_item_seq_no = v.ITEM_SEQ_NO;
                             var s_user_defines = cnts_Null2Void(v.USER_DEFINES, "").replace(/\"/g, "&quot;");
                             var s_previous_one_val;
                             var s_previous_two_val;
                             var s_next_one_val = "";
                             var tdAttr = "";
                             var s_input_type_value= cnts_Null2Void(v.INPUT_TYPE_VALUE, "");  // 2018.11.11 배유연 추가 : 항목 값 리스트
                             var s_input_secu_kind= cnts_Null2Void(v.INPUT_SECU_KIND, "");  // 2019.05.17 배유연 추가 : 항목보안 리스트
                             if(s_input_secu_kind != ""){// 항목보안 값이 있으면 항목보안 적용문서라고 표시해야함.
                           	  
                           	  //기안 작성시와 결재올린 화면 구분해서 appr_subj에 넣어 줘야함 --낼부터
                           	  
                           	  if(g_proc_gb =="C" || g_proc_gb =="U"){//기안작성 혹은 재기안일경우
                           		  if( $("#APPR_SUBJ").parent().find("span[secu]").length < 1)
                               		  $("#APPR_SUBJ").parent().append("<span secu class='txt_r fwn'>&nbsp;("+$.i18n.prop("msg173")+")</span>");
                           	  }else{//결재올린후 
                               	  if( $("#R_TBODY").find("#APPR_SUBJ").parent().find("span[secu]").length < 1)
                               		  $("#R_TBODY").find("#APPR_SUBJ").parent().append("<span secu class='txt_r fwn'>&nbsp;("+$.i18n.prop("msg173")+")</span>");
                           	  }
                             }
                             if(i>=1){ s_previous_one_val = dat.REC[i-1]["INPUT_TYPE"]; }
                             if(i>=2){ s_previous_two_val = dat.REC[i-2]["INPUT_TYPE"]; }
                             if(i+1 < g_paper_item_len){ s_next_one_val = dat.REC[i+1]["INPUT_TYPE"]; }
                             
                             //colspan 주기
                             if (s_input_type == '9' || s_input_type == '8' || s_input_type == '11') {//9: 긴텍스트, 8: 라디오, 11:체크박스, 18:텍스트편집기   (8, 11유연 추가 ) (18 진호용 추가)                             	
                           	  tdAttr = " colspan='3' ";
                             }
                             else if (i >= 1) {
                           	  if(i+1 == g_paper_item_len && previous_tr_chk){
                               	  tdAttr = " colspan='3' ";
                                 }
                           	  else if((s_next_one_val == '9' && previous_tr_chk) || (s_next_one_val == '8' && previous_tr_chk) || (s_next_one_val == '11' && previous_tr_chk)){
                           		  tdAttr = " colspan='3' ";
                           	  }
                       	  }
                             if(i+1 == g_paper_item_len && g_paper_item_len=='1'){//2020.10.14 추가 , item 개수가 1일 경우는 무조건들어감.
                           	  tdAttr = " colspan='3' ";
                             }
                             //colspan 주기
                             
                             //tr열기
                             if (previous_tr_chk) {                            	  
                       		  sHtmlItem += "<tr>";
  							  previous_tr_chk = false;
                       	  }
                       	  //tr열기

  						  //td 카운트
  						  if (s_input_type !== '9' && s_input_type !== '8' && s_input_type !== '11') {
  							  tdCnt++;
  						  }
                       	  
                             sHtmlItem += "<th scope='row' usr-attr='"+ s_item_seq_no +"'><div style='word-break:break-all;'>" + v.ITNM + (v.ESSENTIAL_YN == 'Y' ? "<span class='point'>" : "<span class=''>") + "</span>"
                             //2019.05.17 항목보안 옵션값 추가 
                             if(s_input_secu_kind !=""){
                           	  sHtmlItem += "<span class='txt_r fwn' style='font-size: 10px;' secu_kind='"+s_input_secu_kind+"'></span></div></th>";//보안이라는 글씨 그냥 표시안하기로함.
                           	  //sHtmlItem += "</div></th>";  
                             }else{
                           	  sHtmlItem += "</div></th>";  
                             }
                             
                             sHtmlItem += "<td " + tdAttr + " usr-attr='"+ s_input_type +"'><div>";
                             if("R" == g_menu_type){
                                   sHtmlItem += fn_getInputTypeVal(s_input_type, s_item_seq_no, v.ESSENTIAL_YN, v.ITNM,s_input_type_value, s_user_defines);
                                  
                                   if("7" == s_input_type){
                                         isDefaultTime = true;
                                   }
                             } else {
                                 if(s_input_type=="8"){//2018.11.12 라디오버튼일 경우
                               	  
                               	  if(s_input_type_value !=""){
                               		  if(s_input_type_value.split("^").length >0){
                                   		  $.each(s_input_type_value.split("^"), function(j, k){
                                   			  if(s_input_type_value.split("^").length-1 == j)
                                   				  return false;
                                   			 
                                   			  sHtmlItem += "<input type='radio' disabled value='"+k+"'" + (v.ESSENTIAL_YN == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='8' style='width: 25px;' name='ITNM_"+i+"_"+k+"'>"+k;
                                   		  });
                                   	  }
                               	  }
                               	 
                                 }else if(s_input_type=="11"){//2018.11.12 체크박스일 경우
                               	  if(s_input_type_value !=""){
                                  	  if(s_input_type_value.split("^").length >0){
                                  		  $.each(s_input_type_value.split("^"), function(j, k){
                                  			  if(s_input_type_value.split("^").length-1 == j)
                                  				  return false;
                                  			  sHtmlItem += "<input type='checkbox' disabled value='"+k+"'" + (v.ESSENTIAL_YN == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='11' style='width: 25px;' name='ITNM_"+i+"_"+k+"'>"+k;
                                  		  });
                                  	  }     
                               	  }
                                 } else{
                               	  sHtmlItem += "<span id='ITNM_" + i + "' usr-attr='" + s_input_type+ "'></span>"; 
                                 } 
                           	  
                             }
                             sHtmlItem += "</div></td>";

                             //tr닫기
                             if(i+1 == g_paper_item_len){
                           	  sHtmlItem += "</tr>"; 
                           	  previous_tr_chk = true;
  							  tdCnt = 0;
                             }                          
                             else if(s_input_type == '9' || s_input_type == '8' || s_input_type == '11'){ 
                           	  sHtmlItem += "</tr>"; 
                           	  previous_tr_chk = true;
  							  tdCnt = 0; 
                             }
                             else if(s_next_one_val == '9' || s_next_one_val == '8' || s_next_one_val == '11'){ 
                           	  sHtmlItem += "</tr>"; 
                           	  previous_tr_chk = true;
  							  tdCnt = 0; 
                             }
                             else if(tdCnt === 2) {
                           	  sHtmlItem += "</tr>"; 
                       		  previous_tr_chk = true;
  							  tdCnt = 0;
                             }                         
                             else{
                          	  previous_tr_chk = false;
                            }                         
                             //tr닫기
                       });

                       if("R" == g_menu_type){
                             $("#C_TBODY tr:first").after(sHtmlItem);
                       } else {
                             //$("#C_TBODY tr:last").after(sHtmlItem);
                            
                             $("#R_TBODY tr:last").after(sHtmlItem);
                       }
                       //fn_setCalendar();
                       //fn_setCalendar2();
                       fn_setDefaultTime();
                 }

  			  //2021.11.02 진호용 : 에디터 항목 분리
  			  if(dat.EDITOR_REC.length > 0) {
  					var sHtmlItemEditor = "";

  					$.each(dat.EDITOR_REC, function(i, v){
                       	  var s_input_type  = cnts_Null2Void(v.INPUT_TYPE, "");
                             var s_item_seq_no = v.ITEM_SEQ_NO;
                             var s_user_defines = cnts_Null2Void(v.USER_DEFINES, "");
                             var s_input_type_value= cnts_Null2Void(v.INPUT_TYPE_VALUE, "");  // 2018.11.11 배유연 추가 : 항목 값 리스트
                             var s_input_secu_kind= cnts_Null2Void(v.INPUT_SECU_KIND, "");  // 2019.05.17 배유연 추가 : 항목보안 리스트
                             if(s_input_secu_kind != ""){// 항목보안 값이 있으면 항목보안 적용문서라고 표시해야함.
                           	  
                           	  //기안 작성시와 결재올린 화면 구분해서 appr_subj에 넣어 줘야함 --낼부터
                           	  
                           	  if(g_proc_gb =="C" || g_proc_gb =="U"){//기안작성 혹은 재기안일경우
                           		  if( $("#APPR_SUBJ").parent().find("span[secu]").length < 1)
                               		  $("#APPR_SUBJ").parent().append("<span secu class='txt_r fwn'>&nbsp;("+$.i18n.prop("msg173")+")</span>");
                           	  }else{//결재올린후 
                               	  if( $("#R_TBODY").find("#APPR_SUBJ").parent().find("span[secu]").length < 1)
                               		  $("#R_TBODY").find("#APPR_SUBJ").parent().append("<span secu class='txt_r fwn'>&nbsp;("+$.i18n.prop("msg173")+")</span>");

                           	  }
                           	  
                             }
  				    	  sHtmlItemEditor += "<div class='stitle5_wrap' style='margin-top:5px;z-index:0; user-select:none;'>";
  				    	  sHtmlItemEditor += "	<div class='left'><p class='fwb'>"+v.ITNM+"</p>";
  				    	  sHtmlItemEditor += "		"+(v.ESSENTIAL_YN == 'Y' ? "<span style='vertical-align:top; margin:10px 0 0 4px; display:inline-block; width:4px; height:4px; background: url(../img/bul/bul_point.gif) no-repeat;'></span>" : "");
  				    	  sHtmlItemEditor += "	</div>";
  						  if(s_input_secu_kind !=""){
                           	  sHtmlItemEditor += "<span class='txt_r fwn' style='font-size: 10px;' secu_kind='"+s_input_secu_kind+"'></span>";//보안이라는 글씨 그냥 표시안하기로함.
                             } 
  						  if("R" == g_menu_type)
  						  	  sHtmlItemEditor += fn_getInputTypeVal(s_input_type, s_item_seq_no, v.ESSENTIAL_YN, v.ITNM,s_input_type_value);
  						  else {
                           	  sHtmlItemEditor += "</div>"; 
                           	  sHtmlItemEditor += "<div id='ITNM_" + s_input_type +"_"+ s_item_seq_no + "' usr-attr='" + s_input_type+ "' style='margin-bottom:5px; border-bottom:1px solid #cbcbcb;'></div>";
  						  }
                       });

                       if("R" == g_menu_type){
  						  $("#EDITOR_TYPE_BOX_C").append(sHtmlItemEditor);
                            
                       } else {
  						  $("#EDITOR_TYPE_BOX_R").append(sHtmlItemEditor);
                       }
                 }
           }          
  });
  }
  function getNumber(obj){     
  var num01;
  var num02;
  var rgx1 = /\D/g;  // /[^0-9]/g 와 같은 표현
  var rgx2 = /(\d+)(\d{3})/;   
  num01 = obj.value;
  num02 = num01.replace(rgx1,"");     
  var outNum;
  outNum = num02;
  while (rgx2.test(outNum)) {
  outNum = outNum.replace(rgx2, '$1' + ',' + '$2');
  }  
  obj.value =  outNum;  
  }
  /**
* 양식지 항목값에 따른 값 조회함수
* @param aInput : INPUT_TYPE
* @return
  */
  function fn_getInputTypeVal(aInput, aItemSeqNo, aEssential_yn, aItnm, input_type_value, user_defines){
  var returnHtml = "";

  switch (aInput) {
  case "1":// 금액(원)
  returnHtml += "<input class='item_type1' usr_item_name= '" + aItnm + "'" +  (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='1' onchange='getNumber(this);' onkeyup='getNumber(this);' type='text' style='text-align:right;width:100px;' name='TXT_ITNM_"+aInput+"_" + aItemSeqNo + "' /> "+$.i18n.prop("msg52");// 원
  break;
  case "2":// 일수(일)  
  returnHtml += "<input type='text' usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='2' style='width: 100px;' name='TXT_ITNM_"+aInput+"_" + aItemSeqNo + "' onkeyup=\"this.value=this.value.replace(/[^0-9(\.)]/g,'')\" usr_item_must='N'/> "+$.i18n.prop("msg101");//일
  break;
  case "3": // 기간
  if ("601" === $("#PAPER_CATE").val() && input_type_value === "TRIP_TIME") {
  returnHtml += "<div style='padding:0;'><input type='text' usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='3' style='width:80px;' value='' class='START_SELECT_DATE'  name='START_SELECT_DATE_"+aInput+"_" + aItemSeqNo + "'/>&nbsp;<a href='javascript:'><img src='/img/ico/ico_calendar.png' alt='달력' /></a>";
  returnHtml += "&nbsp;<select class='START_SELECT_TIME' name='START_SELECT_TIME_"+aInput+"_" + aItemSeqNo + "'><option>시간선택</option>"+$time+"</select>"+$.i18n.prop("msg161")+" ~ </div>";
  returnHtml += "<div style='margin-top:4px;'><input type='text' usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='3' style='width:80px;' value='' class='END_SELECT_DATE' name='END_SELECT_DATE_"+aInput+"_" + aItemSeqNo + "'/>&nbsp;<a href='javascript:'><img src='/img/ico/ico_calendar.png' alt='달력' /></a>";
  returnHtml += "&nbsp;<select class='END_SELECT_TIME' name='END_SELECT_TIME_"+aInput+"_" + aItemSeqNo + "'><option>시간선택</option>"+$time+"</select>"+$.i18n.prop("msg161")+"</div>";
  } else {
  returnHtml += "<input type='text' usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='3' style='width:100px;' value='' class='START_SELECT_DATE'  name='START_SELECT_DATE_"+aInput+"_" + aItemSeqNo + "'/>&nbsp;<a href='javascript:'><img src='/img/ico/ico_calendar.png' alt='달력' /></a> ~";
  returnHtml += "&nbsp;<input type='text' usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='3' style='width:100px;' value='' class='END_SELECT_DATE' name='END_SELECT_DATE_"+aInput+"_" + aItemSeqNo + "'/>&nbsp;<a href='javascript:'><img src='/img/ico/ico_calendar.png' alt='달력' /></a>";
  }
  break;
  case "4":// 일자
  returnHtml += "<input type='text' style='width:100px;' usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='4' value='' class='SELECT_DATE_"+aInput+"_" + aItemSeqNo + "' name='SELECT_DATE_"+aInput+"_" + aItemSeqNo + "' />&nbsp;";
  returnHtml += "<a href='javascript:'><img src='../img/ico/ico_calendar.png' alt='달력'></a>";
  break;
  case "5":// 기타숫자
  returnHtml += "<input type='text' usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='5' style='width: 100px;' name='TXT_ITNM_"+aInput+"_" + aItemSeqNo + "' />";
  break;
  case "6":// 텍스트
  returnHtml += "<input type='text' usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='5' style='width: 100px;' name='TXT_ITNM_"+aInput+"_" + aItemSeqNo + "' placeholder=\""+user_defines+"\" />";
  break;
  case "7"://사용기간(시분)
  returnHtml += "<select style='width:50px;' usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='7' id='START_SELECT_TIME' name='START_SELECT_TIME_"+aInput+"_" + aItemSeqNo + "'>"+$time+"</select>"+$.i18n.prop("msg161")+"&nbsp;<select style='width:50px;' usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='7' id='START_SELECT_MIN' name='START_SELECT_MIN_"+aInput+"_" + aItemSeqNo + "'>"+$minite+"</select>"+$.i18n.prop("msg102")+" ~";//분
  returnHtml += "<select style='width:50px;' usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='7' id='END_SELECT_TIME' name='END_SELECT_TIME_"+aInput+"_" + aItemSeqNo + "'>"+$time+"</select>"+$.i18n.prop("msg161")+"&nbsp;<select style='width:50px;' usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='7' id='END_SELECT_MIN' name='END_SELECT_MIN_"+aInput+"_" + aItemSeqNo + "'>"+$minite+"</select>"+$.i18n.prop("msg102");
  break;
  case "8"://라디오버튼
  if(jex.null2Void(input_type_value,"") !=""){
  if(input_type_value.split("^").length >0){
  $.each(input_type_value.split("^"), function(j, k){
  if(input_type_value.split("^").length-1 == j)
  return false;
  returnHtml += "<input type='radio' value=\""+cnts_Null2Void(k).replace('"','&quot;')+"\" usr_item_name= '" + aItnm + "' radio_name= 'RADIO_ITNM_"+aItemSeqNo+"_" + k + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='8' style='width: 25px;' name='RADIO_ITNM_"+aItemSeqNo+ "' >"+k;
  });
  }
  }
  break;
  case "9":// 긴텍스트
  returnHtml += "<textarea style='width:100%; padding: 3px 0 2px 8px;' usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='9' name='TXT_ITNM_"+aInput+"_" + aItemSeqNo + "' placeholder=\""+user_defines+"\"></textarea>";
  break;
  case "10":// 선택박스
  var tmpHtml ="";   
  if(jex.null2Void(input_type_value,"") !=""){
  if(input_type_value.split("^").length >0){
  tmpHtml+="<option value='99999999'>"+$.i18n.prop("msg149")+"</option>";
  $.each(input_type_value.split("^"), function(j, k){
  if(input_type_value.split("^").length-1 == j)
  return false;
  tmpHtml+="<option  value=\""+cnts_Null2Void(k).replace('"','&quot;')+"\">"+k+"</option>";
  });
  }
  }
  returnHtml += "<select style='width:200px;' usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='10'  name='SELECT_ITNM_"+aItemSeqNo+ "' >"+tmpHtml+"</select>";
  break;
  case "11"://체크박스
  if(jex.null2Void(input_type_value,"") !=""){
  if(input_type_value.split("^").length >0){
  $.each(input_type_value.split("^"), function(j, k){
  if(input_type_value.split("^").length-1 == j)
  return false;
  returnHtml += "<input type='checkbox' value=\""+cnts_Null2Void(k).replace('"','&quot;')+"\" usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='11' style='width: 25px;' name='CHECK_ITNM_"+aItemSeqNo+"_" + k + "' >"+k;
  });
  }      
  }
  break;
  case "12"://2019.04.29 추가 : 직원항목 추가
  returnHtml += "<div usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='"+aInput+"' style='position:relative;padding-left:0px'><div style='padding:6px 0;'><div class='tbl_cmb' style='width:294px;padding:0;display:block;' name='EMPL_ITNM_" + aItemSeqNo + "'>";
  returnHtml += "<div class='tbl_cmb1_inner t2'><div class='name_cmb_multi_box' style='display:block;'>";
  returnHtml += "</div><a href='javascript:;' class='arrow_cmd empl_add' style='display:block;'><span class='blind'>출장자 선택</span></a></div></div></div></div>";
  break;
  case "14"://2020.11.13 거래처팝업 추가
  returnHtml += "<div usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='"+aInput+"' style='position:relative;padding-left:0px'><div style='padding:6px 0;'><div class='tbl_cmb' style='width:294px;padding:0;display:block;' name='CUST_ITNM_" + aItemSeqNo + "'>";
  returnHtml += "<div class='tbl_cmb1_inner t2'><div class='name_cmb_multi_box cust_add' style='display:block;'>";
  returnHtml += "</div><a href='javascript:;' onclick='fn_addCustPop(\"1\","+aItemSeqNo+")' class='cmd_srch' style='display:block;'><span class='blind'></span></a></div></div></div></div>";
  break;
  case "15"://2020.11.13 거래처담당자팝업 추가
  returnHtml += "<div usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='"+aInput+"' style='position:relative;padding-left:0px'><div style='padding:6px 0;'><div class='tbl_cmb' style='width:294px;padding:0;display:block;' name='CUST_MANAGER_ITNM_" + aItemSeqNo + "'>";
  returnHtml += "<div class='tbl_cmb1_inner t2'><div class='name_cmb_multi_box cust_empl_add' style='display:block;'>";
  returnHtml += "</div><a href='javascript:;' onclick='fn_addCustPop(\"2\","+aItemSeqNo+")' class='cmd_srch' style='display:block;'><span class='blind'></span></a></div></div></div></div>";
  break;
  case "16":// 영수증 총합계 필드
  returnHtml += "<span usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='"+aInput+"' style='width: 90%' name='BUY_AMT_SUM_ITNM_"+aInput+"_" + aItemSeqNo + "' > "+" 0</span>"+ $.i18n.prop("msg52");
  break;
  case "17":// 신청금액 총합계 필드
  returnHtml += "<span usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='"+aInput+"' style='width: 90%' name='REQ_AMT_SUM_ITNM_"+aInput+"_" + aItemSeqNo + "' > "+" 0</span>"+ $.i18n.prop("msg52");
  break;
  case "18":
  //2021.10.27 진호용 추가 : 텍스트에디터 입력타입
  returnHtml += "	<div class='right'><p><a href='#none' class='btn_style3' id='OPEN_EDIT_"+aItemSeqNo+"'><span>"+$.i18n.prop("msg272")+"</span></a></p></div>";
  returnHtml += "</div>";
  returnHtml += "<div id='ITNM_"+ aInput +"_"+ aItemSeqNo +"' usr_attr='18' usr_item_name= '"+ aItnm +"'"+ (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") +" name='ITNM_"+ aInput +"_"+ aItemSeqNo +"' style='margin-bottom:5px; border-bottom:1px solid #cbcbcb;'></div>";
  break;
  case "19"://hbiz 통합예약번호
  returnHtml += "<div usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='19' style='width:285px; padding-left:0;' name='ITNM_"+aInput+"_" + aItemSeqNo + "' >"
  + "<a href='javascript:' id='btnTmpProc' class='btn_style4_b' onclick='openHbizRsvt(\"biz_trip_used_0012_01\", \"1280\", \"730\");'><span>선택하기</span></a></div>";
  break;
  case "20"://사업예산부서
  returnHtml += "<div usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='"+aInput+"' style='position:relative;padding-left:0px'><div style='padding:6px 0;'><div class='tbl_cmb' style='width:294px;padding:0;display:block;' name='CUST_ITNM_" + aItemSeqNo + "'>";
  returnHtml += "<div class='tbl_cmb1_inner t2'><div class='name_cmb_multi_box cust_add' style='display:block;'>";
  returnHtml += "</div><a href='javascript:;' onclick='fn_cardSsoPop(\"CRD_MAGR_L026\", this)' class='cmd_srch' style='display:block;'><span class='blind'></span></a></div></div></div></div>";
  break;
  case "21"://예산과목
  returnHtml += "<div usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='"+aInput+"' style='position:relative;padding-left:0px'><div style='padding:6px 0;'><div class='tbl_cmb' style='width:294px;padding:0;display:block;' name='CUST_ITNM_" + aItemSeqNo + "'>";
  returnHtml += "<div class='tbl_cmb1_inner t2'><div class='name_cmb_multi_box cust_add' style='display:block;'>";
  returnHtml += "</div><a href='javascript:;' onclick='fn_cardSsoPop(\"CRD_MAGR_L025\", this)' class='cmd_srch' style='display:block;'><span class='blind'></span></a></div></div></div></div>";
  break;
  case "22"://bzp 스케줄 번호
  returnHtml += "<div usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='22' style='width:285px; padding-left:0;' name='ITNM_"+aInput+"_" + aItemSeqNo + "' >"
  + "<a href='javascript:' id='btnTmpProc' class='btn_style4_b' onclick='openHbizRsvt(\"biz_trip_used_0015_01\", \"1280\", \"730\");'><span>선택하기</span></a></div>";
  break;
  case "23"://구분1
  returnHtml += "<div usr_item_name= '" + aItnm + "'" + (aEssential_yn == 'Y' ? "usr_item_must='Y'" : "usr_item_must='N'") + " usr_attr='"+aInput+"' style='position:relative;padding-left:0px'><div style='padding:6px 0;'><div class='tbl_cmb' style='width:294px;padding:0;display:block;' name='CUST_ITNM_" + aItemSeqNo + "'>";
  returnHtml += "<div class='tbl_cmb1_inner t2'><div class='name_cmb_multi_box cust_add' style='display:block;'>";
  returnHtml += "</div><a href='javascript:;' onclick='fn_cardSsoPop(\"CRD_MAGR_L028\", this)' class='cmd_srch' style='display:block;'><span class='blind'></span></a></div></div></div></div>";
  break;
  }

  return returnHtml;
  }
  /**
* 결재양식지 결재선 조회 함수
* Appr Document Detail Search Function
* @return
  */
  function fn_getPaperApprlineSrc(){
  var jexAjax = jex.createAjaxUtil("appr_paper_apprline_r001");
  jexAjax.set("PTL_ID"          , g_ptl_id);     
  jexAjax.set("CHNL_ID"         , g_chnl_id);    
  jexAjax.set("USE_INTT_ID"     , g_use_intt_id);
  jexAjax.set("PAPER_SEQ_NO"          , g_paper_seq_no);
  jexAjax.set("POS_SEQ_NO"          , $("#POS_SEQ_NO").val());
  jexAjax.set("_LODING_BAR_YN_" ,"N");
  jexAjax.setAsync(false);
  jexAjax.execute(function(dat){
  if(!jex.isError(dat)){
  g_apprline_gb = dat.APPRLINE_GB;
  count = 0;

                 if(dat.APPRLINE_REC.length >0){
               	  g_pos_rec = dat.APPRLINE_REC;
                 }
                 
                 $.each(dat.APPRLINE_REC, function(i, v){
               	  
                       apprline_json = {};
                      
                       if("9" != v.APPRLINE_KIND){
                             var s_appr_user_info = "";
                             var s_appr_user_gb = cnts_Null2Void(v.APPR_USER_GB, "");
                             if("1" == s_appr_user_gb){
                                   s_appr_user_info = v.APPR_DEPT_CD;
                                   apprline_json["APPR_ORD"]                  = v.APPR_ORD;
                                   apprline_json["APPR_USER_GB"]             = v.APPR_USER_GB;
                                   apprline_json["APPR_DEPT_CD"]             = v.APPR_DEPT_CD;
                                   apprline_json["APPR_DEPT_NM"]       = v.APPR_DEPT_NM;
                                   apprline_json["APPRLINE_KIND"]             = v.APPRLINE_KIND;
                                   apprline_list[count] = apprline_json;
                                   count++;
                             } else if("2" == s_appr_user_gb){
                                   s_appr_user_info = v.APPR_USER_ID;
                                   apprline_json["APPR_ORD"]                 = v.APPR_ORD;
                                   apprline_json["APPR_USER_GB"]             = v.APPR_USER_GB;
                                   apprline_json["APPR_USER_ID"]             = v.APPR_USER_ID;
                                   apprline_json["APPR_USER_NM"]             = v.APPR_USER_NM;
                                   apprline_json["APPR_USER_POS_NM"]       = v.APPR_USER_POS_NM;
                                   apprline_json["APPRLINE_KIND"]             = v.APPRLINE_KIND;
                                   apprline_json["RSPT_NM"]       = v.RSPT_NM;
                                  
                                   apprline_list[count] = apprline_json;
                                   count++;
                             }                            
                             g_apprline_loc[i] = jex.null2Void(v.APPRLINE_KIND,"") + ":" 
                             					+ jex.null2Void(v.POS,"") + ":" + jex.null2Void(v.APPR_SECT_TITLE_GB,"")
                             					+ ":" + jex.null2Void(v.APPR_SECT_TITLE_INPUT,"")  + ":" + jex.null2Void(s_appr_user_info,"") + ":" + jex.null2Void(v.APPR_USER_GB,"");
                             g_apprline_pos_len++;
                                                          
                             if("1" == v.POS){                   // 왼쪽
                                   g_apprline_left_len++;
                             } else if("2" == v.POS){      // 오른쪽
                                   g_apprline_right_len++;
                             } else if("3" == v.POS){      // 아래쪽
                                   g_apprline_bottom_len++;
                                  
                                   if(g_bottom_title.indexOf(cnts_Null2Void(v.APPRLINE_KIND_NM, "")) == -1){
                                   	
                                   	var kind=(v.APPRLINE_KIND_NM=="기안" ? $.i18n.prop("msg158") : (v.APPRLINE_KIND_NM=="결재" ? $.i18n.prop("msg21") : (v.APPRLINE_KIND_NM=="합의" ? $.i18n.prop("msg22") : (v.APPRLINE_KIND_NM=="접수" ? $.i18n.prop("msg23")
                                     		  : (v.APPRLINE_KIND_NM=="감사" ? $.i18n.prop("msg24") :  $.i18n.prop("msg159"))))));
                                   	
                                         g_bottom_title += kind ;
                                         if(i<dat.APPRLINE_REC.length-1)
                                       	  g_bottom_title +="/";
                                   }
                             }
                       }                      
                 });
           }
  });
  }
  /**
* 전자결재 상세조회
* Appr document Detail Search Function
  */
  function fn_getApprDtlSrc(aApprSeqNo){
  var jexAjax = jex.createAjaxUtil("appr_r011");
  jexAjax.set("PTL_ID"        , g_ptl_id);
  jexAjax.set("CHNL_ID"       , g_chnl_id);
  jexAjax.set("USE_INTT_ID"   , g_use_intt_id);
  jexAjax.set("APPR_SEQ_NO"           , aApprSeqNo);
  jexAjax.set("PAPER_SEQ_NO"          , g_paper_seq_no);
  jexAjax.set("_LODING_BAR_YN_" ,"N");
  jexAjax.setAsync(false);
  jexAjax.execute(function(dat){


            if(!jex.isError(dat)){
                  g_appr_cont_use_yn      = dat.APPR_CONT_USE_YN;       // 결재내용HTML 여부
                 
                  //2020.02.20 배유연 추가 : 
                  g_draft_date_time= cnts_Null2Void(dat.DRAFT_DATE,"")+cnts_Null2Void(dat.DRAFT_TIME,"");
                  
                  if(cnts_Null2Void(dat.MARK_DOC_NM, "") != "") {
                        g_paper_nm = dat.MARK_DOC_NM;
                        $("#PAPER_NM").text(g_paper_nm);
                  }
                  // 연계여부상관없이 데이터 Set
                  if("R" != g_menu_type)
                        $("#DOC_NO").text(dat.DOC_NO);
                 
                  // 연계여부에 따라서 데이터 Set - paper_kind : 1(일반), 2(연계)
                 
                  if("1" == g_paper_kind){
                        var s_doc_gb_cd = dat.DOC_GB_CD;
                        $("input[name='raoDocType'][value='" + s_doc_gb_cd+ "']").attr("checked", "checked");
                       
                        var s_appr_subj = "";
                        if("" == cnts_Null2Void(dat.APPR_SUBJ, "")) s_appr_subj = g_paper_nm;
                        else s_appr_subj = cnts_Null2Void(dat.APPR_SUBJ, "");
                       
                        if("R" == g_menu_type){
                              $("#C_TBL").find("#APPR_SUBJ").val(s_appr_subj);
                              if (editorGb == "daum") {
	                              Editor.modify( {
	                                    inputmode : "original", //original , text
	                                    content       : dat.APPR_CONT
	                              });
                              }
                              //2021.05.24 진호용 추가 : crosseditor
                              g_paper_cont = dat.APPR_CONT;
                              if (editorGb == "cross" && editorLoadYn == "Y") {
                            	  CrossEditor.SetBodyValue(g_paper_cont);
                              }
                             
                        } else {
                              $("#R_TBL").find("#APPR_SUBJ").text(s_appr_subj);
                              $("#APPR_CONT").html("<div id='contDiv'>"+dat.APPR_CONT+"</div>");
         
                              /* if($("#contDiv").height() > 300){
                              $(".editbox").css("height",$("#contDiv").height());
                              $("#APPR_CONT").css("height",$("#contDiv").height());
		                       }
		                       */
		                     

                              $("#contDiv").find("[style*='letter-spacing']").each(function(i,e){
                            	  //var _this = $(e).css("letter-spacing");
                            	  $(e).css("letter-spacing","0px");
                              });
                              
		                       if($("#contDiv").find("table").length>0){
		                     	  /*console.log($("#contDiv").find("table").width());
		                     	  console.log($("#APPR_CONT").width());*/
		                     	  if($("#contDiv").find("table").width() > $("#APPR_CONT").width()){
		                     		  /*$("#contDiv").find("table").width($("#APPR_CONT").width());
		                     		  $("#contDiv").find("table").css("table-layout","auto");
		                     		  console.log($("#contDiv").find("table").width());*/
		                     	  }
		                     	  //$("#APPR_CONT").css("height",$("#contDiv").height());
					
                                  //2025.06.17 주석 처리
                                  //에디터에서 경우에 따라 margin-left와 text-indent 로  +- 하여 좌측 여백을 0으로 만드는 경우가 있는데
                                  //text-indent를 0 으로 하면 margin-left 만 남아서 작성화면과 조회화면이 틀어짐. 
                                  //$("#contDiv").find("p").css("text-indent","0px");
                            	  $("#contDiv").find("p").each(function(i,e){
                            		 
                            		  var margin_num = cnts_Null2Void($(e).css("margin-left").replace("px",""),"");
                            		  if(margin_num !="" && margin_num<0){
                            			  $(e).css("margin-left","0px");
                            		  } 
                            	  });
                              }
                        }
                       
                        var item_len = 0;
                        item_len = dat.ITEM_REC.length;
                       
                        if(item_len > 0){
                        	
                              $.each(dat.ITEM_REC, function(i, v){
                                    var s_item_seq_no       = cnts_Null2Void(v.ITEM_SEQ_NO, "");
                                    var s_input_type  = cnts_Null2Void(v.INPUT_TYPE, "");
                                   
                                    // 임시보관함에서 기안작성 or 결재함에서 재기안
                                    //if(g_menu_type == "R" || g_appr_mode == "RE"){
                                    if(g_menu_type == "R"  && g_appr_mode == "RE") {//기존
                                          if("1" == s_input_type){
                                                $("input[name='TXT_ITNM_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_1);
                                          } else if("2" == s_input_type){
                                                $("input[name='TXT_ITNM_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_1);
                                          } else if("5" == s_input_type || "6" == s_input_type){
                                                $("input[name='TXT_ITNM_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_1);
                                          } else if("3" == s_input_type){
                                                $("input[name='START_SELECT_DATE_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_1);
                                                $("input[name='END_SELECT_DATE_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_2);
                                          } else if("4" == s_input_type){
                                                $("input[name='SELECT_DATE_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_1);
                                          } else if("7" == s_input_type){
                                                var time1 = v.ITVL_1.substring(0, 2);
                                                var minite1 = v.ITVL_1.substring(2, 4);
                                                var time2 = v.ITVL_2.substring(0, 2);
                                                var minite2 = v.ITVL_2.substring(2, 4);
                                               
                                                $("select[name='START_SELECT_TIME_"+s_input_type+"_"+s_item_seq_no+"'] option[value='"+time1+"']").attr("selected", "selected");
                                                $("select[name='START_SELECT_MIN_"+s_input_type+"_"+s_item_seq_no+"'] option[value='"+minite1+"']").attr("selected", "selected");
                                                $("select[name='END_SELECT_TIME_"+s_input_type+"_"+s_item_seq_no+"'] option[value='"+time2+"']").attr("selected", "selected");
                                                $("select[name='END_SELECT_MIN_"+s_input_type+"_"+s_item_seq_no+"'] option[value='"+minite2+"']").attr("selected", "selected");
                                          } else if ("8" == s_input_type) {//라디오버튼
                                        	  if(cnts_Null2Void(v.ITVL_1,"")!=""){
                                        		  /*if(v.ITVL_1.split(",").length>0){
                                            		  $.each(v.ITVL_1.split(","), function(j, k){
                                            			
                                            			  $("input[radio_name='RADIO_ITNM_"+s_item_seq_no+"_"+k+"']").prop("checked", true);
                                            			  
                                            		  });
                                            	  }*/
                                        		 
                                        		  $("input[radio_name='RADIO_ITNM_"+s_item_seq_no+"_"+v.ITVL_1+"']").prop("checked", true);
                                        	  }
                                        	  
                                          }else if("10" == s_input_type){//선택박스
                                        	
                                        	 
                                        	  
                                                $("select[name='SELECT_ITNM_"+s_item_seq_no+"']").val(v.ITVL_1);
                                                
                                                	
                                          }else if("11" == s_input_type){//체크박스
                                                //$("input[name='SELECT_DATE_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_1);
                                        	  
                                        	  if(cnts_Null2Void(v.ITVL_1,"")!=""){
	                                                if(v.ITVL_1.split("^").length>0){
	                                                	
	                                                	$.each(v.ITVL_1.split("^"), function(j, k){
	                                                		
	                                          			  $("input[name='CHECK_ITNM_"+s_item_seq_no+"_"+k+"']").prop("checked", true);
	                                          			  
	                                          		  });
	                                          	  }	
                                        	  }
                                                
                                          }else if("9" == s_input_type){// 긴텍스트
                                        	  
                                        	  $("textarea[name='TXT_ITNM_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_1);
                                          }else if("12" == s_input_type){// 직원
                                        	 
                                        	  var jsonRec= jQuery.parseJSON(decodeURIComponent(v.ITVL_1));
                                        	  var empl_rec ={};
                                        	  var empl_list=[];
                                        	  $.each(jsonRec, function(j,k){
                                        		  var empl = jQuery.parseJSON(decodeURIComponent(k.VALUE));
                                        		  empl_list.push(empl);
                                        		  
                                        	  });
                                        	  
                                        	  empl_rec=empl_list;
                                        	  empl_rec["seq"]= s_item_seq_no;
                                        	  apprEmplCallback(empl_rec);
                                        	  
                                        	
                                          }else if("14" == s_input_type || "15" == s_input_type){//거래처, 거래처담당자 
                                        	 
                                        	  var jsonRec= jQuery.parseJSON(decodeURIComponent(v.ITVL_1));
                                        	  var cust_rec ={};
                                        	  var cust_list=[];
                                        	  $.each(jsonRec, function(j,k){
                                        		  var cust = jQuery.parseJSON(decodeURIComponent(k.VALUE));
                                        		  cust_list.push(cust);
                                        		  
                                        	  });
                                        	  
                                        	  cust_rec["BP_CUST_REC"]=cust_list;
                                        	  cust_rec["seq"]= s_item_seq_no;
                                        	  fn_custPop_callback(cust_rec);
                                        	  
                                          } else if (["20","21","23"].indexOf(s_input_type) > -1) {//예산부서, 용도 
                                        	 
                                        	  var jsonRec= jQuery.parseJSON(decodeURIComponent(v.ITVL_1));
                                        	  
                                        	  g_webank_sso_item_seq = s_item_seq_no;
                                        	  fn_callbackSsoPop(s_input_type, jsonRec);
                                          }
                                          
                                    }else{
                                          var separator = ""; // 구분값
                                          if("3" == $("#ITNM_" + i).attr("usr-attr") || "7" == $("#ITNM_" + i).attr("usr-attr")) separator = " ~ ";
                                         
                                          var itvl_1 = cnts_Null2Void(v.ITVL_1, "");
                                          var itvl_2 = cnts_Null2Void(v.ITVL_2, "");
                                          var itvl_3 = cnts_Null2Void(v.ITVL_3, "");
                                          var itvl_4 = cnts_Null2Void(v.ITVL_4, "");
                                         
                                         
                                          var str_input_string = "";
                                          if("1" == s_input_type){
                                                str_input_string = $.i18n.prop("msg52");// 원
                                               
                                                var num = Number(itvl_1);
                                                if (!isNaN(num)) itvl_1 = num.toLocaleString();
                                               
                                          } else if("2" == s_input_type){
                                                str_input_string = $.i18n.prop("msg101");
                                          }/*else if ("8" == s_input_type) {//라디오버튼
                                              $("[usr_item_ord="+(i+1)+"]").find("input[value="+itvl_1+"]").attr("checked",true);
                                              
                                              if (g_proc_gb == "R" || g_proc_gb == "P")
                                                    $("[usr_item_ord="+(i+1)+"]").find("input").attr("disabled",true);
                                              else
                                                    $("[usr_item_ord="+(i+1)+"]").find("input").attr("disabled",false);
                                              
                                         }else if ("11" == s_input_type) {//2018.09.17 배유연 추가: 체크박스 선택
                                     
	                                      	  $.each(itvl_1.split(","), function(j,g){
	                                      		  $("[usr_item_ord="+(i+1)+"]").find("input[value="+g+"]").attr("checked",true);
	                                      	  });
	                                           
	                                            
	                                            if (g_proc_gb == "R" || g_proc_gb == "P")
	                                                  $("[usr_item_ord="+(i+1)+"]").find("input").attr("disabled",true);
	                                            else
	                                                  $("[usr_item_ord="+(i+1)+"]").find("input").attr("disabled",false);
                                            
                                          } */
                                          
                                          
                                          if("7" == s_input_type){
                                                itvl_1 = itvl_1.substring(0, 2)+ ":" + itvl_1.substring(2, 4);
                                                itvl_2 = itvl_2.substring(0, 2)+ ":" + itvl_2.substring(2, 4);
                                          }
                                           
                                          if("8" == s_input_type ){// 라디오
                                        	  if(cnts_Null2Void(itvl_1,"") !=""){
                                        		  /*if(itvl_1.split(",").length>0){
                                            		  $.each(itvl_1.split(","), function(j, k){
                                            			 
                                            			  $("input[name='ITNM_"+i+"_"+k+"']").prop("checked", true);
                                            			  
                                            		  });
                                            	  }*/
                                        		 
                                        		  $("input[name='ITNM_"+i+"_"+itvl_1+"']").prop("checked", true);
                                        	  }
                                        	  
                                        	  
                                        	  var s_itvl_val = itvl_1 + str_input_string + " " + separator + itvl_2 + " " + itvl_3 + " " + itvl_4;
                                              $("#ITNM_" + i).html("<pre>"+s_itvl_val+"</pre>"); 
                                          }else if ("11" == s_input_type){
                                        	  if(cnts_Null2Void(itvl_1,"") !=""){
                                        		  if(itvl_1.split("^").length>0){
                                        			
                                            		  $.each(itvl_1.split("^"), function(j, k){
                                            		
                                            			  $("input[name='ITNM_"+i+"_"+k+"']").prop("checked", true);
                                            			  
                                            		  });
                                            	  }
                                        		  
                                        	  }
                                        	  
                                        	  
                                        	  var s_itvl_val = itvl_1 + str_input_string + " " + separator + itvl_2 + " " + itvl_3 + " " + itvl_4;
                                              $("#ITNM_" + i).html("<pre>"+s_itvl_val+"</pre>"); 
                                          }else if("12" == s_input_type){ // 직원 타입 추가
                                        	  var json = jQuery.parseJSON(decodeURIComponent(itvl_1));
                                        	
                                        		var sHtml="";
                                        		if(json !=null){
                                        			$.each(json, function (i,e){
                                        				
                                        				var empl = jQuery.parseJSON(decodeURIComponent(e.VALUE));
                                        				
                                        				sHtml +=cnts_Null2Void(empl.FLNM,"")+"("+cnts_Null2Void(empl.DVSN_NM,"")+","+cnts_Null2Void(empl.JBCL_NM,"")+"),";
                                        				
                                        			});
                                        	
                                        			sHtml =  sHtml.substr(0, sHtml.length -1);
                                        		
                                        		}
                                        	  
                                        	  
                                        	  $("#ITNM_" + i).html("<pre>"+sHtml+"</pre>"); 
                                          }else if("14" == s_input_type || "15" == s_input_type){ // 거래처, 거래처담당자 
                                        	  var json = jQuery.parseJSON(decodeURIComponent(itvl_1));
                                          	
                                      		
                                        	  var sHtml="";
	                                      	  if(json !=null){
	                                      	  	 $.each(json, function (i,e){
	                                      	  	 	
	                                      	  	 	var cust = jQuery.parseJSON(decodeURIComponent(e.VALUE));
	                                      	  	 	if(cnts_Null2Void(cust.BP_MAGR_NO,"")!=""){//거래처담당자일 경우
	                                      	  	 		sHtml +=cnts_Null2Void(cust.BP_MAGR_NM,"")+"("+cnts_Null2Void(cust.BP_CUST_NM,"")+"),";
	                                          	 		
	                                      	  	 	}else{//거래처일 경우
	                                      	  	 		sHtml +=cnts_Null2Void(cust.BP_CUST_NM,"")+",";	
	                                      	  	 	}
	                                      	  	 	
	                                      	  	 });
	                                      	     
	                                      	  	 sHtml =  sHtml.substr(0, sHtml.length -1);
	                                      	  
	                                      	  }
	                                      	  $("#ITNM_" + i).html("<pre>"+sHtml+"</pre>"); 
                                         }else if("16" == s_input_type || "17" == s_input_type){ //사용금액, 신청금액 필드
                                        	 var s_itvl_val = formatter.number(itvl_1);
                                        	 $("#ITNM_" + i).html("<pre>"+s_itvl_val+"</pre>"); 
                                         }else if("10" == s_input_type){ // 선택박스
                                        	  
                                        	  if(itvl_1.replace(/(\s*)/g,"") == "99999999"){
                                        		
                                        		  $("#ITNM_" + i).html("<pre></pre>");
                                        	  }                                        		  
                                        	  else{
                                        		  var s_itvl_val = itvl_1 + str_input_string + " " + separator + itvl_2 + " " + itvl_3 + " " + itvl_4;
                                                  $("#ITNM_" + i).html("<pre>"+s_itvl_val+"</pre>"); 
                                        	  }
                                         } else if (["20","21","23"].indexOf(s_input_type) > -1) {
											  var json = jQuery.parseJSON(decodeURIComponent(itvl_1));
                                      		
                                        	  var sHtml="";
	                                      	  if(json !=null){
                                      	  	 	if (cnts_Null2Void(json.TRAN_KIND_CD,"")!="") {
													//용도
                                      	  	 		sHtml += cnts_Null2Void(json.TRAN_KIND_NM,"");
                                      	  	 	} else {
													//예산부서
                                      	  	 		sHtml += cnts_Null2Void(json.NAME,"");	
                                      	  	 	}
	                                      	  }
	                                      	  $("#ITNM_" + i).html("<pre>"+sHtml+"</pre>"); 
                                         } else {
                                        	
                                        	  var s_itvl_val = itvl_1 + str_input_string + " " + separator + itvl_2 + " " + itvl_3 + " " + itvl_4;
                                              $("#ITNM_" + i).html("<pre>"+s_itvl_val+"</pre>"); 
                                        	  
                                          }
                                          
                                    }
                              });
                        }
						//2021.11.01 진호용 추가 : 택스트편집기(에디터)항목 추가 (조회 시)
						if (dat.EDITOR_REC.length > 0) {
							$.each(dat.EDITOR_REC, function(i, v){
                                var s_item_seq_no = cnts_Null2Void(v.ITEM_SEQ_NO, "");
                                var s_input_type  = cnts_Null2Void(v.INPUT_TYPE, "");
								var itvl_1  	  = cnts_Null2Void(v.ITVL_1, "");
                               
                                // 임시보관함에서 기안작성 or 결재함에서 재기안
                                //if(g_menu_type == "R" || g_appr_mode == "RE"){
                                if(g_menu_type == "R"  && g_appr_mode == "RE") {//기존
									if("18" == s_input_type) { //2021.08.04 진호용 추가 : 기안,재기안 시 에디터 타입 입력항목
                                    	$("#ITNM_"+s_input_type+"_"+s_item_seq_no).html(itvl_1);
									}
								} else {
									if("18" == s_input_type) {
										$("#ITNM_"+s_input_type+"_"+s_item_seq_no).html(itvl_1);
									}
								}
							});
						}
	
                        // 2019.07.30_이현수 : 출장계획 기안자 정보 추가
                        if("600" == $("#PAPER_CATE").val()) fn_getDraftUserInfo_trip(dat);
                        
                  } else if("2" == g_paper_kind ){
                        //alert("g_paper_kind : " + g_paper_kind);
                       
                        if("Y" == cnts_Null2Void(g_appr_cont_use_yn, "")){
                       
                              if(g_rps_paper_cd == "-1"){
                                    $("#R_TBL").find("#APPR_SUBJ").text(dat.APPR_SUBJ);
                              }

							  g_appr_cont = dat.APPR_CONT;
                             
                              $("#ifrm_rel").attr("src", "/appr/inc/ifrm_rel.jsp");
                              
                              //2021.08.17 진호용 추가 : 매입지출결의서 요약보기 클릭 함수 변경
                              if ("R" == g_proc_gb && "111" == g_paper_seq_no) {
                            	  dat.APPR_CONT = dat.APPR_CONT.replace("resolInfoPopUp", "parent.fn_intax_summary");
                              }
                              
							  if (g_proc_gb.indexOf("P") >-1) {
							  	  ifrm_rel.document.open();
		                          ifrm_rel.document.write(dat.APPR_CONT);
		                          ifrm_rel.document.close();

								  ifrm_rel.addEventListener('load', function() {
									  autoResize('', 'Y');
								  });
							  } else {
								  setTimeout(function() {
		                              ifrm_rel.document.open();
		                              ifrm_rel.document.write(dat.APPR_CONT);
		                              ifrm_rel.document.close();
	
									  ifrm_rel.addEventListener('load', function() {
										  var tmpScript = ifrm_rel.document.createElement("script");
										  tmpScript.textContent = "window.parent.postMessage('DOMContentLoaded', '*');";
										  ifrm_rel.document.body.appendChild(tmpScript);
									  });
								  }, 500);
								
								  window.addEventListener('message', function(event) {
									if (event.data === "DOMContentLoaded") {
										autoResize('', 'Y');
									}
								  });
							  }
                              
                              
                              setTimeout(function(){
                                  //  var ifrmHeight ;
                                   
                                    // 카드건 지출결의서 상세조회시에 Layer 영역 사이즈
                                    $("#PAPERKIND").val("2C");
                                   
                                    // 영수증펼침상태
                                    if ($("#CUR_VIEW_CARD_BILL").val() == "A") {
                                          //$("#ifrm_rel").contents().find(".cardbill_box").css("display","none");
                                          $("#ifrm_rel").contents().find(".view_cardbill").css("display","block");
                                          $("#ifrm_rel").contents().find(".view_cardbill").css("position","static");
                                                            
                                         
                                          
                                          //fn_ifrmReSize();
                                          
                                         
                                    } else if ($("#CUR_VIEW_CARD_BILL").val() != "") {
                                           // PDF변환시 화면이 깨지므로 일단 생략
                                           //cardBillDown($("#CUR_VIEW_CARD_BILL").val());
                                    }
                                   // ifrmHeight = $("#ifrm_rel").contents().find("body")[0].offsetHeight;
                                    //console.log("setTimeout 호출");
                                   
                              }, 0);
                        } else {
                              var sUrl = "";
                              sUrl += dat.APPR_CONT + "?PTL_ID=" + g_ptl_id + "&CHNL_ID=" + g_chnl_id + "&USE_INTT_ID=" + g_use_intt_id + "&APPR_SEQ_NO=" + g_appr_seq_no;
                             
                              $("#ifrm_rel").attr("src", sUrl);
                              $("#ifrm_rel").css("height", $("#ifrm_rel").contents().find("body")[0].offsetHeight);
                        }
                  } else if ("3" == g_paper_kind) {
                	 
                	  var vc_date_gbn="1";
                	  var start_dt="";
                	  var end_dt="";
                  	
                	  var vaction_date ="";// 휴가기간은 별도로 처리한다.
                  		
                	  
                	  $.each(dat.ITEM_REC, function(i, v){
							var attr = $("[usr_item_ord="+v.ITEM_SEQ_NO+"]").attr('usr_attr');
                           
                            var itvl_1 = cnts_Null2Void(v.ITVL_1, "");
                            var itvl_2 = cnts_Null2Void(v.ITVL_2, "");
                            var itvl_3 = cnts_Null2Void(v.ITVL_3, "");
                            var itvl_4 = cnts_Null2Void(v.ITVL_4, "");    

                			if($("#PAPER_PATH").val().indexOf('insa_01')>=0){//휴가신청서이면
	                   			if(v.ITEM_SEQ_NO == "9"  && itvl_1=="2"){//기간별
	                   				vc_date_gbn="2";
	                   			}
	                   	  
		                   		if(v.ITEM_SEQ_NO=="1" ){// 휴가시작, 끝 날짜 저장
									start_dt =  itvl_1.substring(0,4)+"-"+itvl_1.substring(4,6)+"-"+itvl_1.substring(6,8);
									end_dt =   itvl_2.substring(0,4)+"-"+itvl_2.substring(4,6)+"-"+itvl_2.substring(6,8);
								}
								//휴가 취소 키
								if (v.ITEM_SEQ_NO == "8") {
									$("#CAN_IS_SEQ").val(itvl_3);
								}
							}
                		  
                            var s_appr_subj = "";
                            if("" == cnts_Null2Void(dat.APPR_SUBJ, "")) s_appr_subj = g_paper_nm;
                            else s_appr_subj = cnts_Null2Void(dat.APPR_SUBJ, "");             
                           
                            if (g_proc_gb == "R" || g_proc_gb.indexOf("P") >-1)
                                  $("#APPR_SUBJ").parent().html(s_appr_subj);
                            else
                                  $("#APPR_SUBJ").val(s_appr_subj);
                           
                            var attr = $("[usr_item_ord="+v.ITEM_SEQ_NO+"]").attr('usr_attr');
                           
                            var separator = ""; // 구분값
                            var str_input_string = "";
                           
                            if("1" == attr){
                            	  if (itvl_1.indexOf("원") >= 0) {
                            		  str_input_string = "";
                            	  } else {
                            		  str_input_string = $.i18n.prop("msg52");
                            	  }
	                             
	                              var num = Number(itvl_1);
	                              
	                              //2021.05.06 진호용 추가 : 경조사 양식 신청금액 10000.00 소수점 제거
	                              if(!isNaN(num) && ($("#PAPER_PATH").val().indexOf('insa_03')>=0 || $("#PAPER_PATH").val().indexOf('insa_04')>=0)){
	                            	   itvl_1=numberFormat(num);
	                              }else if (!isNaN(num)) {
	                            	  itvl_1 = num.toLocaleString();
	                              }
                                  
                                  
                            } else if("2" == attr){
                                  str_input_string = $.i18n.prop("msg101");//일
                            } else if ("3" == attr) {
                                  if (itvl_1.length == 8)
                                        itvl_1 = itvl_1.substring(0,4)+"-"+itvl_1.substring(4,6)+"-"+itvl_1.substring(6,8);                                       
                                  if (itvl_2.length == 8)
                                        itvl_2 = itvl_2.substring(0,4)+"-"+itvl_2.substring(4,6)+"-"+itvl_2.substring(6,8);                                       
                                 
                                  separator = " ~ ";
                            } else if ("7" == attr){
                                  separator = " ~ ";
                                  itvl_1 = itvl_1.substring(0, 2)+ ":" + itvl_1.substring(2, 4);
                                  itvl_2 = itvl_2.substring(0, 2)+ ":" + itvl_2.substring(2, 4);
                                  
                                 //2018.04.06 배유연  추가 : 아무것도 입력아됐으면 아무것도안나오게 수정
                                 if(itvl_1 =="00:00" && itvl_2 =="00:00"){
                              	   itvl_1="";
                              	   itvl_2="";
                                 }
                            }                            
                            var s_itvl_val = itvl_1 + str_input_string + " " + separator + itvl_2 + " " + itvl_3 + " " + itvl_4;   
                            //2018.04.06 배유연 추가 : 아무것도 입력아됐으면 아무것도안나오게 수정
                            if(itvl_1 =="" && itvl_2 ==""){
                          	  s_itvl_val="";
                            }
                      
                            if ("3" == attr) {
                                  if (g_proc_gb == "R" || g_proc_gb.indexOf("P") >-1)
                                        $("[usr_item_ord="+(i+1)+"]").html(s_itvl_val);
                                  else {
                                        $("[usr_item_ord="+(i+1)+"]").find("*[name='START_SELECT_DATE']").val(itvl_1);
                                        $("[usr_item_ord="+(i+1)+"]").find("*[name='END_SELECT_DATE']").val(itvl_2);
                                  }
                                 
                            } else if ("4" == attr) {
                                  if (g_proc_gb == "R" || g_proc_gb.indexOf("P") >-1) {
                                        if (itvl_1.length == 8)
                                              itvl_1 = itvl_1.substring(0,4)+"-"+itvl_1.substring(4,6)+"-"+itvl_1.substring(6,8);
                                        $("[usr_item_ord="+(i+1)+"]").html(itvl_1);
                                  } else {
                                        $("[usr_item_ord="+(i+1)+"]").find("*[name='SELECT_DATE']").val(itvl_1);
                                  }
                                 
                            } else if ("7" == attr) {
                                  if (g_proc_gb == "R" || g_proc_gb.indexOf("P") >-1)
                                        $("[usr_item_ord="+(i+1)+"]").html(s_itvl_val);
                                  else {
                                        var time1 = v.ITVL_1.substring(0, 2);
                                        var minite1 = v.ITVL_1.substring(2, 4);
                                        var time2 = v.ITVL_2.substring(0, 2);
                                        var minite2 = v.ITVL_2.substring(2, 4);
                                       
                                        $("[usr_item_ord="+(i+1)+"]").find("#START_SELECT_TIME").val(time1);
                                        $("[usr_item_ord="+(i+1)+"]").find("#START_SELECT_MIN").val(minite1);
                                        $("[usr_item_ord="+(i+1)+"]").find("#END_SELECT_TIME").val(time2);
                                        $("[usr_item_ord="+(i+1)+"]").find("#END_SELECT_MIN").val(minite2);
                                  }
                                 
                            } else  if ("8" == attr) {
                                  $("[usr_item_ord="+(i+1)+"]").find("input[value="+itvl_1+"]").attr("checked",true);
                                 
                                  if (g_proc_gb == "R" ||g_proc_gb.indexOf("P") >-1)
                                        $("[usr_item_ord="+(i+1)+"]").find("input").attr("disabled",true);
                                  else
                                        $("[usr_item_ord="+(i+1)+"]").find("input").attr("disabled",false);
                                  
                            } else if ("11" == attr) {//2018.09.17 배유연 추가: 체크박스 선택
                         
                          	  if(cnts_Null2Void(itvl_1,"") !=""){
                          		  $.each(itvl_1.split("^"), function(j,g){
                              		  $("[usr_item_ord="+(i+1)+"]").find("input[value="+g+"]").attr("checked",true);
                              	  });
                                   
                          	  }
                          	  
                                
                                if (g_proc_gb == "R" || g_proc_gb.indexOf("P") >-1)
                                      $("[usr_item_ord="+(i+1)+"]").find("input").attr("disabled",true);
                                else
                                      $("[usr_item_ord="+(i+1)+"]").find("input").attr("disabled",false);
                                
                          }else if ("13" == attr) {//휴가신청서-휴가기간
                        	  
                    		  vaction_date = cnts_Null2Void(itvl_1,"");
                          	  
                          }else {
                          
                                 if (g_proc_gb == "R" || g_proc_gb.indexOf("P") >-1)
                                 	$("[usr_item_ord="+(i+1)+"]").html("<pre style='word-break:break-all;'>"+s_itvl_val+"</pre>");
                                 else
                                 	$("[usr_item_ord="+(i+1)+"]").find("*[name='TEXT']").val(itvl_1);                                   
                            
                          }
                      });    
                	
                	if($("#PAPER_PATH").val().indexOf('insa_01')>=0){//휴가신청서이면 휴가기간은 별도로 처리한다.
					// 임시보관함에서 기안작성 or 결재함에서 재기안   
                		  if (g_menu_type == "R" && g_appr_mode == "RE") {//기존
	                        
                			  if (vc_date_gbn =="2") {//일자별
                				  
                				  var itvl1 =vaction_date;
                              	  var dateList ="";
                              	
                              	  $.each(itvl1.split(","), function(j, k){
                              		  var sHtml ="";
                              		  var date = k.substring(0,4)+"-"+k.substring(4,6)+"-"+k.substring(6,8);
                              		  sHtml +="<p class='name_cmb multi pdr15' btnOpt ='multiple' addNew='"+j+"' style='margin-right:3px;'><span>"+date+"</span><a class='remove' idxRe='"+j+"' href='javascript:;' onclick='fn_remove("+j+")'><img src='/img/ico/x_span.png' alt=''></a></span>";
                              		  $("[usr_item_ord='8']").append(sHtml);
                              	  });
                			  } else { //기간별
                				  var date =start_dt+" ~ "+end_dt;
                				  var sHtml ="";
                				  
                          		  sHtml +="<p class='name_cmb multi pdr15' btnOpt ='range' addNew='0' style='margin-right:3px;'><span>"+date+"</span><a class='remove' idxRe='0' href='javascript:;' onclick='fn_remove(0)'><img src='/img/ico/x_span.png' alt=''></a></span>";
                          		
                          		  $("[usr_item_ord='8']").append(sHtml);
                			  }

						      //마지막 item
							  //재기안
							  if ($("input[name=USER_DEFINE_ATTR_3]:checked").val() === "N") {
								  if ($("#INSA_POP").attr("hr_user_yn")=="Y") {
									  $("#IMG_VC_DATE_LST").hide();
									  $("#INSA_POP").show();
								  }
									
								  $(".holiCount").hide();
								  if (!isCustomIntt()) {
									  $("#holiRsnTitle").text("취소사유");
								  }
								  if ($("p[addnew]").length > 0) {
									  $("input[name=USER_DEFINE_ATTR_3]").attr("disabled", true);
									  $("input[name=USER_DEFINE_ATTR]").attr("disabled", true);
								  }
						  	  }
	                      
                		  } else{
                			  
                			  if(vc_date_gbn =="2"){//일자별
                                	var itvl1 =vaction_date;
                                	var dateList ="";
                                	$.each(itvl1.split(","), function(j, k){
                                		dateList+=k.substring(0,4)+"-"+k.substring(4,6)+"-"+k.substring(6,8);
                                		if(j== itvl1.split(",").length-1){
                                			return false;
                                		}
                                		dateList+=", "
                                	});
                                	$("#VC_DATE_LST").val(dateList);
                              }else{//기간별
                                	$("#VC_DATE_LST").val(start_dt+" ~ "+end_dt);
                              }
							  
							  if ($("input[name=USER_DEFINE_ATTR_3]:checked").val() === "N" && !isCustomIntt()) {
								  $("#holiRsnTitle").text("취소사유");
							  }
                		  }
                		  
                	  }
                	  
                  }else if(
                		  ("4" == g_paper_kind )
                		  || "600" == $("#PAPER_CATE").val()
                		  || "601" == $("#PAPER_CATE").val()
                		  || "602" == $("#PAPER_CATE").val()
                		  || "603" == $("#PAPER_CATE").val()
                		  || "604" == $("#PAPER_CATE").val() //hbiz
                		  || "605" == $("#PAPER_CATE").val() //bzp
                		  || "700" == $("#PAPER_CATE").val() 
                		  || "800" == $("#PAPER_CATE").val() //예산추경
                		  || "801" == $("#PAPER_CATE").val() //예산전용
                		  || "901" == $("#PAPER_CATE").val() //지출결의
                  ){ // 2018.08.26 배유연 추가 : 사전승인서조회, 출장명세서 조회
                    
                	  /***** 제목 *****/
                      var s_appr_subj = "";
                      if("" == cnts_Null2Void(dat.APPR_SUBJ, "")) s_appr_subj = g_paper_nm;
                      else s_appr_subj = cnts_Null2Void(dat.APPR_SUBJ, "");
                     
                      
                      if($("#PAPER_CATE").val() == "500"){ // 사전조회승인서
                    	  if("R" == g_menu_type){ //임시보관함에서 다시 결재올리는 화면
                              //$("#C_TBL").find("#APPR_SUBJ").val(s_appr_subj)//사전승인, 
                              /*Editor.modify( {
                                    inputmode : "original", //original , text
                                    content       : dat.APPR_CONT
                              });*/
                              
                              $("#prior_div").empty();
                              $("#prior_div").append(dat.APPR_CONT);
                          }
                    	  else {
                    		  $("#R_TBL").find("#APPR_SUBJ").text(s_appr_subj);
                    		  $("#APPR_CONT").html("<div id='contDiv'>"+dat.APPR_CONT+"</div>");
                    		  /*if($("#contDiv").height() > 300){
                                     $(".editbox").css("height",$("#contDiv").height());
                              }*/
                              $("#APPR_CONT").css("border","none");
                              $("#contDiv").find(".stitle5_wrap").find(".right").remove();// 항목추가 버튼 삭제
                              $(".prior_update").remove();
                              $(".prior_delete").remove();
                         }
                      }
                      // 2019.05.17_이현수 : 출장관리 상세보기
                      else if(
                    		  "600" == $("#PAPER_CATE").val() 
                    		  || "601" == $("#PAPER_CATE").val()
                    		  || "602" == $("#PAPER_CATE").val()
                    		  || "603" == $("#PAPER_CATE").val()
                    		  || "604" == $("#PAPER_CATE").val()
                    		  || "605" == $("#PAPER_CATE").val()
                      ){
                    	  fn_getApprDtlSrc_trip(s_appr_subj, dat.APPR_CONT);
                    	  fn_getDraftUserInfo_trip(dat);
                      }
                      // 2019.01.23_이현수 : 통합지출결의 상세보기, 지출결의 상세보기
                      else if(("700" == $("#PAPER_CATE").val() ||"901" == $("#PAPER_CATE").val()  ) && "4" == $("#PAPER_KIND").val()){
                    	  fn_getApprDtlSrc_expense(s_appr_subj, dat.APPR_CONT);
                      }
                      // 2020.09.18 예산pro 연동
                      else if("800" == $("#PAPER_CATE").val() || "801" == $("#PAPER_CATE").val() ){
                    	  $("#APPR_CONT").remove();                       
                    	  
                    	  //임시저장건 기안작성 or 재기안 시
                    	  if(g_menu_type == "R"  && g_appr_mode == "RE") {//기존
                    		  $("#C_TBL").find("#APPR_SUBJ").val(s_appr_subj);  
                    		  if("" != cnts_Null2Void(dat.APPR_CONT, "")){
                    			  if (editorGb == "daum") {
	                    			  Editor.modify({
	                                      inputmode : "original", //original , text
	                                      content       : dat.APPR_CONT
	                                  });
                    			  }
                    			  //2021.05.24 진호용 추가 : crosseditor
                    			  g_paper_cont = dat.APPR_CONT;
                    			  if (editorGb == "cross" && editorLoadYn == "Y") {
                                	  CrossEditor.SetBodyValue(g_paper_cont);
                                  }
                    		  }
                    		  
                               
                            
                    	  }else{
                    		  $("#R_TBL").find("#APPR_SUBJ").text(s_appr_subj);  
                    	  }
                    	  
                    	  
                    	  fn_openBudget();
                      }
                      var item_len = 0;
                      item_len = dat.ITEM_REC.length;
                     
                      if(item_len > 0){
                            $.each(dat.ITEM_REC, function(i, v){
                                  var s_item_seq_no       = cnts_Null2Void(v.ITEM_SEQ_NO, "");
                                  var s_input_type  = cnts_Null2Void(v.INPUT_TYPE, "");
                                 
                                  // 임시보관함에서 기안작성 or 결재함에서 재기안
                                  //if(g_menu_type == "R" || g_appr_mode == "RE"){
                                  if(g_menu_type == "R"  && g_appr_mode == "RE") {//기존
                                        if("1" == s_input_type){
                                              $("input[name='TXT_ITNM_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_1);
                                        } else if("2" == s_input_type){
                                              $("input[name='TXT_ITNM_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_1);
                                        } else if("5" == s_input_type || "6" == s_input_type){
                                              $("input[name='TXT_ITNM_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_1);
                                        } else if("3" == s_input_type){
                                              $("input[name='START_SELECT_DATE_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_1);
                                              $("input[name='END_SELECT_DATE_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_2);
											  $("select[name='START_SELECT_TIME_"+s_input_type+"_"+s_item_seq_no+"'] option[value="+v.ITVL_3+"]").attr("selected", true);
                                              $("select[name='END_SELECT_TIME_"+s_input_type+"_"+s_item_seq_no+"'] option[value="+v.ITVL_4+"]").attr("selected", true);
                                        } else if("4" == s_input_type){
                                              $("input[name='SELECT_DATE_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_1);
                                        } else if("7" == s_input_type){
                                              var time1 = v.ITVL_1.substring(0, 2);
                                              var minite1 = v.ITVL_1.substring(2, 4);
                                              var time2 = v.ITVL_2.substring(0, 2);
                                              var minite2 = v.ITVL_2.substring(2, 4);
                                             
                                              $("select[name='START_SELECT_TIME_"+s_input_type+"_"+s_item_seq_no+"'] option[value='"+time1+"']").attr("selected", "selected");
                                              $("select[name='START_SELECT_MIN_"+s_input_type+"_"+s_item_seq_no+"'] option[value='"+minite1+"']").attr("selected", "selected");
                                              $("select[name='END_SELECT_TIME_"+s_input_type+"_"+s_item_seq_no+"'] option[value='"+time2+"']").attr("selected", "selected");
                                              $("select[name='END_SELECT_MIN_"+s_input_type+"_"+s_item_seq_no+"'] option[value='"+minite2+"']").attr("selected", "selected");
                                        } else if ("8" == s_input_type) {//라디오버튼
                                            
                                        	if(cnts_Null2Void(v.ITVL_1,"") !=""){
                                        		/*if(v.ITVL_1.split(",").length>0){
                                            		  $.each(v.ITVL_1.split(","), function(j, k){
                                            			
                                            			  $("input[radio_name='RADIO_ITNM_"+s_item_seq_no+"_"+k+"']").prop("checked", true);
                                            			  
                                            		  });
                                            	  }*/
                                        	
                                        		$("input[radio_name='RADIO_ITNM_"+s_item_seq_no+"_"+v.ITVL_1+"']").prop("checked", true);
                                        	}
                                      	  
                                        }else if("10" == s_input_type){//선택박스
                                      	 
                                              $("select[name='SELECT_ITNM_"+s_item_seq_no+"']").val(v.ITVL_1);
                                        }else if("11" == s_input_type){//체크박스
                                              //$("input[name='SELECT_DATE_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_1);
                                           
                                        	if(cnts_Null2Void(v.ITVL_1,"") !=""){
                                        		
                                        		
                                        		if(v.ITVL_1.split("^").length>0){
                                          		  $.each(v.ITVL_1.split("^"), function(j, k){
                                          			
                                          			  $("input[name='CHECK_ITNM_"+s_item_seq_no+"_"+k+"']").prop("checked", true);
                                          			  
                                          		  });
                                          	  	}
                                        		
                                        	}
                                              
                                              
                                        }else if("12" == s_input_type){// 직원
                                            
                                            var jsonRec= jQuery.parseJSON(decodeURIComponent(v.ITVL_1));
                                            var empl_rec ={};
                                            var empl_list=[];
                                            $.each(jsonRec, function(j,k){
                                                   var empl = jQuery.parseJSON(decodeURIComponent(k.VALUE));
                                                   empl_list.push(empl);
                                                  
                                            });
                                           
                                            empl_rec=empl_list;
                                            empl_rec["seq"]= s_item_seq_no;
                                            apprEmplCallback(empl_rec);
                                           
                                        }else if("14" == s_input_type || "15" == s_input_type){//거래처, 거래처담당자
                                        
                                        	var jsonRec= jQuery.parseJSON(decodeURIComponent(v.ITVL_1));
		                                  	var cust_rec ={};
		                                  	var cust_list=[];
		                                  	$.each(jsonRec, function(j,k){
		                                  	  var cust = jQuery.parseJSON(decodeURIComponent(k.VALUE));
		                                  	  cust_list.push(cust);
		                                  	  
		                                  	});
		                                  	
		                                  	cust_rec["BP_CUST_REC"]=cust_list;
		                                  	cust_rec["seq"]= s_item_seq_no;
		                                  	fn_custPop_callback(cust_rec);
		                                  	 
                                        }else if("9" == s_input_type){// 긴텍스트
                                       	 
                                      	 
                                      	  $("textarea[name='TXT_ITNM_"+s_input_type+"_"+s_item_seq_no+"']").val(v.ITVL_1);
                                        
										} else if (["20","21","23"].indexOf(s_input_type) > -1) {//예산부서, 용도 
                                        	 
                                        	  var jsonRec= jQuery.parseJSON(decodeURIComponent(v.ITVL_1));
                                        	  
                                        	  g_webank_sso_item_seq = s_item_seq_no;
                                        	  fn_callbackSsoPop(s_input_type, jsonRec);
                                        }
                                        
                                       
                                  }else{
                                        var separator = ""; // 구분값
                                        if("3" == $("#ITNM_" + i).attr("usr-attr") 
												|| "7" == $("#ITNM_" + i).attr("usr-attr")) separator = " ~ ";
                                       
                                        var itvl_1 = cnts_Null2Void(v.ITVL_1, "");
                                        var itvl_2 = cnts_Null2Void(v.ITVL_2, "");
                                        var itvl_3 = cnts_Null2Void(v.ITVL_3, "");
                                        var itvl_4 = cnts_Null2Void(v.ITVL_4, "");
                                       
                                       
                                        var str_input_string = "";
                                        if("1" == s_input_type){
                                              str_input_string = $.i18n.prop("msg52");//원
                                             
                                              var num = Number(itvl_1);
                                              if (!isNaN(num)) itvl_1 = num.toLocaleString();
                                             
                                        } else if("2" == s_input_type){
                                              str_input_string = $.i18n.prop("msg124");//일
                                        }
                                       
                                        if("7" == s_input_type){
                                              itvl_1 = itvl_1.substring(0, 2)+ ":" + itvl_1.substring(2, 4);
                                              itvl_2 = itvl_2.substring(0, 2)+ ":" + itvl_2.substring(2, 4);
                                        }
                                             
                                        if("8" == s_input_type){// 라디오, 체크박스는 따로 처리함.
                                      	  
                                        	if(cnts_Null2Void(itvl_1,"") !=""){
                                      		  /*if(itvl_1.split(",").length>0){
                                          		  $.each(itvl_1.split(","), function(j, k){
                                          			 
                                          			  $("input[name='ITNM_"+i+"_"+k+"']").prop("checked", true);
                                          			  
                                          		  });
                                          	  }*/
                                        	
                                        		$("input[name='ITNM_"+i+"_"+itvl_1+"']").prop("checked", true);
                                        	}
                                      	  
                                        	var s_itvl_val = itvl_1 + str_input_string + " " + separator + itvl_2 + " " + itvl_3 + " " + itvl_4;
                                            $("#ITNM_" + i).html("<pre>"+s_itvl_val+"</pre>");
                                        } else if ("10" == s_input_type) { //선택박스
											if(itvl_1.replace(/(\s*)/g,"") == "99999999"){
                                        		$("#ITNM_" + i).html("<pre></pre>");
                                        	}                                        		  
                                        	else{
                                        		var s_itvl_val = itvl_1 + str_input_string + " " + separator + itvl_2 + " " + itvl_3 + " " + itvl_4;
                                                $("#ITNM_" + i).html("<pre>"+s_itvl_val+"</pre>"); 
                                        	}
                                        }else if("11" == s_input_type){// 라디오, 체크박스는 따로 처리함.
                                      	  
                                        	if(cnts_Null2Void(itvl_1,"") !=""){
                                      		  if(itvl_1.split("^").length>0){
                                      		
                                      			  $.each(itvl_1.split("^"), function(j, k){                     
                                      			
                                          			  $("input[name='ITNM_"+i+"_"+k+"']").prop("checked", true);
                                          			  
                                          		  });
                                          	  }
                                        	}
                                      	  
                                        	var s_itvl_val = itvl_1 + str_input_string + " " + separator + itvl_2 + " " + itvl_3 + " " + itvl_4;
                                            $("#ITNM_" + i).html("<pre>"+s_itvl_val+"</pre>"); 
                                        }else if("12" == s_input_type){ // 직원 타입 추가
                                      	  
                                        	var json = jQuery.parseJSON(decodeURIComponent(itvl_1));
                                      	
                                      		var sHtml="";
                                      		if(json !=null){
                                      			$.each(json, function (i,e){
                                      				
                                      				var empl = jQuery.parseJSON(decodeURIComponent(e.VALUE));
                                      				
                                      				sHtml +=cnts_Null2Void(empl.FLNM,"")+"("+cnts_Null2Void(empl.DVSN_NM,"")+","+cnts_Null2Void(empl.JBCL_NM,"")+"),";
                                      				

                                      				
                                      			});
                                      	
                                      			sHtml =  sHtml.substr(0, sHtml.length -1);
                                      		
                                      		}
                  
                                      		$("#ITNM_" + i).html("<pre>"+sHtml+"</pre>"); 
                                        
                                        }else if("14" == s_input_type || "15" == s_input_type){ // 거래처, 거래처담당자 
                                      	  var json = jQuery.parseJSON(decodeURIComponent(itvl_1));
                                        	
                                    		var sHtml="";
                                    		if(json !=null){
                                    			$.each(json, function (i,e){
                                    				
                                    				var cust = jQuery.parseJSON(decodeURIComponent(e.VALUE));
                                    				if(cnts_Null2Void(cust.BP_MAGR_NO,"")!=""){//거래처담당자일 경우
                                    					sHtml +=cnts_Null2Void(cust.BP_MAGR_NM,"")+"("+cnts_Null2Void(cust.BP_CUST_NM,"")+"),";
                                        				
                                    				}else{//거래처일 경우
                                    					sHtml +=cnts_Null2Void(cust.BP_CUST_NM,"")+",";	
                                    				}
                                    				
                                    			});
                                    	
                                    			sHtml =  sHtml.substr(0, sHtml.length -1);
                                    		
                                    		}
                                    	  
                                    	  
                                    	  $("#ITNM_" + i).html("<pre>"+sHtml+"</pre>"); 
										}else if("16" == s_input_type || "17" == s_input_type){ //사용금액, 신청금액 필드
                                    		var s_itvl_val = formatter.number(itvl_1);
	                                   		$("#ITNM_" + i).html("<pre>"+s_itvl_val+$.i18n.prop("msg52")+"</pre>");
										} else if ("3" == s_input_type) {
											str_input_string = $.i18n.prop("msg161");
                                        	var s_itvl_val = itvl_1 + " " + (itvl_3 !== "" ? itvl_3+str_input_string : "");
											s_itvl_val += separator + itvl_2 + " " + (itvl_4 !== "" ? itvl_4+str_input_string : "");
                                            $("#ITNM_" + i).html("<pre>"+s_itvl_val+"</pre>"); 
										} else if (["20","21","23"].indexOf(s_input_type) > -1) {
											  var json = jQuery.parseJSON(decodeURIComponent(itvl_1));
                                        	  var sHtml="";
	                                      	  if(json !=null){
                                      	  	 	if (cnts_Null2Void(json.TRAN_KIND_CD,"")!="") {
													//용도
                                      	  	 		sHtml += cnts_Null2Void(json.TRAN_KIND_NM,"");
                                      	  	 	} else {
													//예산부서,구분1
                                      	  	 		sHtml += cnts_Null2Void(json.NAME,"");	
                                      	  	 	}
	                                      	  }
	                                      	  $("#ITNM_" + i).html("<pre>"+sHtml+"</pre>"); 
										} else {
                                        	var s_itvl_val = itvl_1 + str_input_string + " " + separator + itvl_2 + " " + itvl_3 + " " + itvl_4;
                                            $("#ITNM_" + i).html("<pre>"+s_itvl_val+"</pre>"); 
										}
                                  }
                            });
                      }

					  	//2021.11.01 진호용 추가 : 택스트편집기(에디터)항목 추가 (조회 시)
						if (dat.EDITOR_REC.length > 0) {
							$.each(dat.EDITOR_REC, function(i, v){
                                var s_item_seq_no = cnts_Null2Void(v.ITEM_SEQ_NO, "");
                                var s_input_type  = cnts_Null2Void(v.INPUT_TYPE, "");
								var itvl_1  	  = cnts_Null2Void(v.ITVL_1, "");
                               
                                // 임시보관함에서 기안작성 or 결재함에서 재기안
                                //if(g_menu_type == "R" || g_appr_mode == "RE"){
                                if(g_menu_type == "R"  && g_appr_mode == "RE") {//기존
									if("18" == s_input_type) { //2021.08.04 진호용 추가 : 기안,재기안 시 에디터 타입 입력항목
                                    	$("#ITNM_"+s_input_type+"_"+s_item_seq_no).html(itvl_1);
									}
								} else {
									if("18" == s_input_type) {
										$("#ITNM_"+s_input_type+"_"+s_item_seq_no).html(itvl_1);
									}
								}
							});
						}
                     
                }
                  if(g_appr_mode =="RE"){ // 2018.01.25 재기안일때는 무시하고 그냥 상태값 빈값으로준다.
                	  g_appr_sts="";
                  }else{
                	  g_appr_sts = dat.APPR_STS;
                  }
                 
            }          
      });  
      
      
      
      
      
      
      fn_getVouchSrc(aApprSeqNo);
      if(g_rps_paper_cd == "-1"){
            if($("#VOUCH_THEAD tr").length == 1){
                  $(".usr-not-ifrm").css("display", "none");                 
                 
                  /**
                   * 송신자지정 양식은 첨부파일area를 가린다.
                   * 20160823 김상묵 이석우
                   */        
                  //$(".usr_cls_c").css("display", "none");
                  $(".icon_add").css("display", "none");
                  $(".icon_addfile").css("display", "none");
            }
      }
      
      //보안필드
      if(g_menu_type != "R"  &&  g_appr_mode != "RE" && g_user_id != g_draft_user_id) {// 기안작성화면도 아니고 재기안 화면도 아니고 관리자>결재문서관리 화면도 아니면
		  try{
			  if( parent.opener.document.location.href.indexOf("appr_list_0013")>-1){
			
				  return;
				
			  }
			  
			  
		  }catch(e){
	    	  
	      }
		  if($("#R_TBODY").find("span[secu]").length>0){
			  
			  $("#R_TBODY").find("th").each(function(i,e){
				  
				  if($(e).find("span[secu_kind]").length>0){
	    			 
	    			 var secu_kind = $(e).find("span[secu_kind]").attr("secu_kind");
	    			 var secu_kind_flag=false;//항목보안설정에서 보이게 설정해놓은 결재방법지정자이면
	    		
	    			 $.each(secu_kind.split(';') ,function(j,k){
	    				 if(g_apprline_kind == k || g_apprline_kind=='1') {//보안결재 지정한 결재방법 혹은 기안자이면 보이게
	    					 secu_kind_flag = true;
	    					 return false;
	    				 }
	    			 });
	    			 
	    			 if(!secu_kind_flag){
	    				 $(e).next().find("span[id^='ITNM']").find("pre").html("******");
	    			
	    				$(e).next().find("div").html("******");
	    			 }
	    		 
				  }else if($(e).find("span").length>0){// 아예 항목보안에 결재방법 지정안할 때도 보안 설정으로 
					  if(g_apprline_kind=='1')
						  return;
					  $(e).next().find("span[id^='ITNM']").find("pre").html("******");
		    			
					  $(e).next().find("div").html("******");
				  } 
	    	  
			  });
	
			  //2021.11.02 진호용 추가 : 텍스트편집기(에디터) 보안항목 적용
			  $("#EDITOR_TYPE_BOX_R").find("div[class=stitle5_wrap]").each(function(i,e){
				  
				  if($(e).find("span[secu_kind]").length>0){
	    			 
	    			 var secu_kind = $(e).find("span[secu_kind]").attr("secu_kind");
	    			 var secu_kind_flag=false;//항목보안설정에서 보이게 설정해놓은 결재방법지정자이면
	    		
	    			 $.each(secu_kind.split(';') ,function(j,k){
	    				 if(g_apprline_kind == k || g_apprline_kind=='1') {//보안결재 지정한 결재방법 혹은 기안자이면 보이게
	    					 secu_kind_flag = true;
	    					 return false;
	    				 }
	    			 });
	    			 
	    			 if(!secu_kind_flag){
	    				 $(e).next().html("******");
	    			 }
	    		 
				  }else if($(e).find("span").length>0){// 아예 항목보안에 결재방법 지정안할 때도 보안 설정으로 
					  if(g_apprline_kind=='1')
						  return;
					  $(e).next().html("******");
				  } 
	    	  
			  });
		  }
 
      }

}
/**
* 결재증빙 조회 함수
* Evidence Search Function
  */
  function fn_getVouchSrc(aApprSeqNo){

  var jexAjax = jex.createAjaxUtil("appr_vouch_r001");
  jexAjax.set("PTL_ID"     , g_ptl_id);
  jexAjax.set("CHNL_ID"    , g_chnl_id);
  jexAjax.set("USE_INTT_ID", g_use_intt_id);
  jexAjax.set("USER_ID"      , g_user_id);
  jexAjax.set("APPR_SEQ_NO", aApprSeqNo);
  jexAjax.set("PROC_GB", g_proc_gb);
  if("" != g_basis_appr_seq_no || "T" == $("#TMP_MENU_TYPE").val()){ // 재기안 또는 임시저장에서 재기안일때

           jexAjax.set("TEMP_SAVE_DOC"     , "Y");
  }
  jexAjax.set("_LODING_BAR_YN_" ,"N");
  jexAjax.setAsync(false);
  jexAjax.execute(function(dat){
  if(!jex.isError(dat)){
  var sHtmlVouch = "";
  var sHtml = "";
  var sHtmlAppr = "";
  if(dat.REC.length > 0 ){
  $(".usr-not-ifrm").css("display", "block");
  sHtmlVouch = fn_returnStrVouch(dat);
  }

                 if(dat.REC.length ==0 ){
  					if (g_limited_vouch_size_use_yn != "N") {
                   		fn_setVouchSize();
  					}
                       $("#fileAttchPrint").addClass("no-print"); //2017.09.19 배유연 추가 : 파일첨부 없을 때는 프린트 안되게함.0
                       $("#fileAttchPrint").find(".f_right").hide();
                       
                       if (g_proc_gb.indexOf("P") > -1) {
  						$("#fileAttchPrint").hide();
  					}
                 }
                 g_rcpt_rec = dat.REC_IMG;
                
                 // 원안문서결재일련번호가 존재하고 임시보관함에서 기안작성이 아닌경우에만 원안문서로 문서첨부함
                 //if("" != jex.null2Void(g_basis_appr_seq_no) && "T" != $("#frm_appr_dtl_0005").find("#TMP_MENU_TYPE").val()){
                 //2017.10.18 배유연 추가 : 취소 버튼 눌렀을 경우는 이거 안타게
                 if(("X" != jex.null2Void(g_basis_appr_seq_no) && "" != jex.null2Void(g_basis_appr_seq_no)) && "T" != $("#frm_appr_dtl_0005").find("#TMP_MENU_TYPE").val()){
                       // 원안문서 조회
                       var ajax = jex.createAjaxUtil("appr_r011");
                       ajax.set("PTL_ID"       , g_ptl_id);     
                       ajax.set("CHNL_ID"            , g_chnl_id);    
                       ajax.set("USE_INTT_ID"  , g_use_intt_id);      
                       ajax.set("APPR_SEQ_NO"        , g_basis_appr_seq_no);
                       ajax.set("_LODING_BAR_YN_"    ,"N");
                       ajax.setAsync(false);
                       ajax.execute(function(data){
                             sHtmlAppr += "<tr id='TR_KIND1_"+ data.APPR_SEQ_NO +"'>";
                             sHtmlAppr += "<td><div>"+$.i18n.prop("msg104")+"</div></td>";
  						  sHtmlAppr += "<td><div style='position:relative;'><div class='elipsis' doc_no='"+data.DOC_NO+"'>";
                             if(parseInt(data.CNT)>0 && data.APPR_REC !=null){
                           	  sHtmlAppr +="<div class='ly_addfile_history' style='display:none;position:absolute;bottom:25px;left:inherit;'><p class='h_title'>첨부이력</p><ul>";
                                 $.each(data.APPR_REC, function(j,k){
                               
                               	  sHtmlAppr +="<li><a href=\"javascript:fn_openVouch('"+k.APPR_SEQ_NO+"')\">"+k.DOC_NO+ "/"+k.APPR_SUBJ +"</a></li>";
                                      
                                 });
                                 sHtmlAppr +="</ul></div> ";
                            }
                             if(data.CNT !=null && parseInt(data.CNT)>0){
                           	  sHtmlAppr += "<span class='addfile_history_more'>("+data.CNT+")</span><a title='"+data.DOC_NO+"' href='#'>"+ data.DOC_NO + "</a></div></div></td>";
                             }else{
                           	  sHtmlAppr += "<a title='"+data.DOC_NO+"' href='#'>" + data.DOC_NO + "</a></div></div></td>";
                             }
                             //2022.07.11 진호용 추가 : 원안문서 제목 추가
                             var subOriginSubj = cnts_Null2Void(data.APPR_SUBJ);
                       	  sHtmlAppr += '<td><div style="position:relative;"><div class="elipsis" style="padding-left:0;padding-right:0;">' +
  										'<a href="#none" class="show_origin_box">'+subOriginSubj+'</a></div>' + 
  										'<!-- 레이어 --><div class="ly_reply origin_box" style="display:none;position:absolute;top:31px;left:10px;width:300px;">' +
  										'<div class="inner"><span class="bg_arr" style="left:26px;"></span>'+subOriginSubj+'</div></div><!-- //레이어 -->' +
  										'</div></td>';
                             
                             
                             
                             sHtmlAppr += "<td><div><input type='text' style='border: 0 0 0 0 ; width:97%' name='VOUCH_RMK' value='"+$.i18n.prop("msg105")+"' readonly disabled /></div></td>";
                             sHtmlAppr += "<td><div><a href='javascript:' onclick=\"fn_vouchDel(this);\"><img src='../../img/ico/ico_delete.gif' alt='"+$.i18n.prop("msg77")+"'></a></div></td>";
                             sHtmlAppr += "</tr>";
                       });
                 }
                 sHtml = sHtmlAppr  + sHtmlVouch;
                 $("#VOUCH_THEAD tr:first").after(sHtml);
           }
  });
  }
  /*
  function fn_setDataApprDtl(dat){
  // 연계여부상관없이 데이터 Set
  $("#DOC_NO").text(dat.DOC_NO);
  // 연계여부에 따라서 데이터 Set - paper_kind : 1(일반), 2(연계)
  if("1" == g_paper_kind){
  var s_doc_gb_cd = dat.DOC_GB_CD;
  $("input[name='raoDocType'][value='" + s_doc_gb_cd+ "']").attr("checked", "checked");

           var s_appr_subj = "";
           if("" == cnts_Null2Void(dat.APPR_SUBJ, "")) s_appr_subj = g_paper_nm;
           else s_appr_subj = cnts_Null2Void(dat.APPR_SUBJ, "");      
          
           $("#R_TBL").find("#APPR_SUBJ").text(s_appr_subj);
           $("#APPR_CONT").html("<div id='contDiv'>"+dat.APPR_CONT+"</div>");
          
           if($("#contDiv").height() > 300)      $(".editbox").css("height", $("#contDiv").height());
          
           var item_len = 0;
           item_len = dat.ITEM_REC.length;
           if(item_len > 0){
                 $.each(dat.ITEM_REC, function(i, v){                 
                       var separator = ""; // 구분값
                       if("3" == $("#ITNM_" + i).attr("usr-attr") || "7" == $("#ITNM_" + i).attr("usr-attr")) separator = " ~ ";
                      
                       var itvl_1 = cnts_Null2Void(v.ITVL_1, "");
                       var itvl_2 = cnts_Null2Void(v.ITVL_2, "");
                       var itvl_3 = cnts_Null2Void(v.ITVL_3, "");
                       var itvl_4 = cnts_Null2Void(v.ITVL_4, "");                 
                
                       var str_input_string = "";
                       if("1" == v.INPUT_TYPE){
                             str_input_string = "원";
                       } else if("2" == v.INPUT_TYPE){
                             str_input_string = "일";
                       }
                            
                       if("7" == v.INPUT_TYPE){
                             itvl_1 = itvl_1.substring(0, 2)+ ":" + itvl_1.substring(2, 4);
                             itvl_2 = itvl_2.substring(0, 2)+ ":" + itvl_2.substring(2, 4);
                       }
                            
                       var s_itvl_val = itvl_1 + str_input_string + " " + separator + itvl_2 + " " + itvl_3 + " " + itvl_4;
                       $("#ITNM_" + i).text(s_itvl_val);
                 });
           }

  } else if("2" == g_paper_kind){
  if("Y" == cnts_Null2Void(g_appr_cont_use_yn, "N")){
  alert("연계문서 셋팅");
  $("#ifrm_rel").attr("src", "/appr/inc/ifrm_rel.jsp");
  ifrm_rel.document.open();
  ifrm_rel.document.write(dat.APPR_CONT);
  ifrm_rel.document.close();

                 // 카드건 지출결의서 상세조회시에 Layer 영역 사이즈
                 if(document.body.scrollHeight < 670)
                       $("#ifrm_rel").attr("height", "670");
                 else
                       $("#ifrm_rel").attr("height", document.body.scrollHeight);             
           } else {               
                 var sUrl = "";
                 sUrl += dat.APPR_CONT + "?PTL_ID=" + g_ptl_id + "&CHNL_ID=" + g_chnl_id + "&USE_INTT_ID=" + g_use_intt_id + "&APPR_SEQ_NO=" + g_appr_seq_no;
                
                 $("#ifrm_rel").attr("src", sUrl);
                 $("#ifrm_rel").css("height", document.body.scrollHeight);
           }
  } else if ("3" == g_paper_kind) {
  $.each(dat.ITEM_REC, function(i, v){                 
  var s_appr_subj = "";
  if("" == cnts_Null2Void(dat.APPR_SUBJ, "")) s_appr_subj = g_paper_nm;
  else s_appr_subj = cnts_Null2Void(dat.APPR_SUBJ, "");

                 if (g_proc_gb == "R")
                       $("#APPR_SUBJ").parent().html(s_appr_subj);
                 else
                       $("#APPR_SUBJ").val(s_appr_subj);
                
                 var attr = $("[usr_item_ord="+v.ITEM_SEQ_NO+"]").attr('usr_attr');
                
                 var itvl_1 = cnts_Null2Void(v.ITVL_1, "");
                 var itvl_2 = cnts_Null2Void(v.ITVL_2, "");
                 var itvl_3 = cnts_Null2Void(v.ITVL_3, "");
                 var itvl_4 = cnts_Null2Void(v.ITVL_4, "");           
                 var separator = ""; // 구분값
                 var str_input_string = "";
                
                 if("1" == attr){
                       str_input_string = "원";
                 } else if("2" == attr){
                       str_input_string = "일";
                 } else if ("3" == attr) {
                       separator = " ~ ";
                 } else if ("7" == attr){
                       separator = " ~ ";
                       itvl_1 = itvl_1.substring(0, 2)+ ":" + itvl_1.substring(2, 4);
                       itvl_2 = itvl_2.substring(0, 2)+ ":" + itvl_2.substring(2, 4);
                 }
                      
                 var s_itvl_val = itvl_1 + str_input_string + " " + separator + itvl_2 + " " + itvl_3 + " " + itvl_4;
                
                 if ("3" == attr) {
                       if (g_proc_gb == "R" || g_proc_gb == "P")
                             $("[usr_item_ord="+(i+1)+"]").html(s_itvl_val);
                       else {
                             $("[usr_item_ord="+(i+1)+"]").find("*[name='START_SELECT_DATE']").val(itvl_1);
                             $("[usr_item_ord="+(i+1)+"]").find("*[name='END_SELECT_DATE']").val(itvl_2);
                       }
                      
                 } else      if ("8" == attr) {
                       $("[usr_item_ord="+(i+1)+"]").find("input[value="+itvl_1+"]").attr("checked",true);
                      
                       if (g_proc_gb == "R" || g_proc_gb == "P")
                             $("[usr_item_ord="+(i+1)+"]").find("input").attr("disabled",true);
                       else
                             $("[usr_item_ord="+(i+1)+"]").find("input").attr("disabled",false);
                 } else {
                       if (g_proc_gb == "R" || g_proc_gb == "P")
                             $("[usr_item_ord="+(i+1)+"]").html(s_itvl_val);
                       else
                             $("[usr_item_ord="+(i+1)+"]").find("*[name='TEXT']").val(itvl_1);                       
                 }
           });
  }    
  g_appr_sts = dat.APPR_STS;
  }
  */
  function fn_returnStrVouch(dat){

  var returnStr = "";    
  $.each(dat.REC, function(i, v){
  var s_vouch_kind_nm = "";
  var s_vouch_nm          = "";
  var s_img_str           = "";
  var s_tr_id             = "";
  var s_viewing_pdf ="";
  var n_vouch_size = 0;
  if("1" == v.VOUCH_KIND) {                 // 원안문서
  s_vouch_kind_nm = $.i18n.prop("msg104");
  if(parseInt(v.CNT)>0 && v.APPR_REC !=null){
  s_vouch_nm +="<div class='ly_addfile_history' style='display:none;position:absolute;bottom:25px;left:inherit;'><p class='h_title'>첨부이력</p><ul>";
  $.each(v.APPR_REC, function(j,k){

               		  s_vouch_nm +="<li><a href=\"javascript:fn_openVouch('"+k.APPR_SEQ_NO+"')\">"+k.DOC_NO+ "/"+k.APPR_SUBJ +"</a></li>";
               		  
               	  });
               	  s_vouch_nm +="</ul></div> ";
                 }
                 if(parseInt(v.CNT)>0){
               	  s_vouch_nm += "<span class='addfile_history_more'>("+v.CNT+")</span><a title='"+v.VOUCH_NM+"' href=\"javascript:fn_openVouch('"+v.LNKD_KEY1+"')\" data = '"+v.LNKD_KEY1+"'>"+v.VOUCH_NM+"</a>"; 
                 }else{
               	  s_vouch_nm += "<a title='"+v.VOUCH_NM+"' href=\"javascript:fn_openVouch('"+v.LNKD_KEY1+"')\" data = '"+v.LNKD_KEY1+"'>"+v.VOUCH_NM+"</a>";
                 }
                 
                 //s_vouch_nm = "<a href=\"javascript:fn_openVouch('"+v.LNKD_KEY1+"')\" data = '"+v.LNKD_KEY1+"'>"+v.VOUCH_NM+"</a>";
                 s_tr_id = "TR_KIND1_" + v.LNKD_KEY1;
           } else if("2" == v.VOUCH_KIND){           // 일반첨부
                 s_vouch_kind_nm = $.i18n.prop("msg106");// 첨부파일
                 s_img_str = fileExtImgString(v.VOUCH_NM);

  			  n_vouch_size += parseInt(cnts_Null2Void(v.FILE_SIZE,"0"));

                 if("Y" == cnts_Null2Void(v.CLOUD_YN, "N")){
                       s_vouch_nm = "<a class='show_vouch_box' href='javascript:' class='show_vouch_box' onclick='_WE_DRIVER.download(\""+v.RAND_KEY+"\");'><img src='" + s_img_str + "' class='icon'/>" + v.VOUCH_NM + "</a>";
                       s_tr_id = "TR_KIND2_" + v.RAND_KEY;
                       
                      
                       
                       if(v.VOUCH_NM.indexOf(".png")>0 || v.VOUCH_NM.indexOf(".jpg")>0 || v.VOUCH_NM.indexOf(".jpeg")>0 || v.VOUCH_NM.indexOf(".gif")>0 
                       		|| v.VOUCH_NM.indexOf(".PNG")>0 || v.VOUCH_NM.indexOf(".JPG")>0  || v.VOUCH_NM.indexOf(".JPEG")>0 || v.VOUCH_NM.indexOf(".GIF")>0){
                       	var url="";
                       	if($("#REAL_YN").val() =="Y"){
                       		
                       		if (parseInt(g_draft_date_time) >= 20240731000000) {
                       			url = $("#FILE_UPLOAD_URL").val()+"/wecloud4/"+v.RAND_KEY+"."+v.VOUCH_NM.split(".")[v.VOUCH_NM.split(".").length-1];
  							} else if (parseInt(g_draft_date_time) >= 20200203180000) {
                       			url = $("#FILE_UPLOAD_URL").val()+"/wecloud3/"+v.RAND_KEY+"."+v.VOUCH_NM.split(".")[v.VOUCH_NM.split(".").length-1];
                       		} else {
                       			url = $("#FILE_UPLOAD_URL").val()+"/wecloud2/"+v.RAND_KEY+"."+v.VOUCH_NM.split(".")[v.VOUCH_NM.split(".").length-1];	
                       		}
                       	}else{
                       		url = $("#FILE_UPLOAD_URL").val()+"/wecloud/"+v.RAND_KEY+"."+v.VOUCH_NM.split(".")[v.VOUCH_NM.split(".").length-1];
                       	}
                       	
                       	
                       	s_viewing_pdf ="<span class='imgViewing' style='float:right' url='"+url+"' down=true>▼</span>";
                       }else if( v.VOUCH_NM.indexOf(".pdf")>0 || v.VOUCH_NM.indexOf(".PDF")>0){
                       	
                       	var url = $("#FILE_UPLOAD_URL").val()+"/preview/"+v.RAND_KEY+"."+v.VOUCH_NM.split(".")[v.VOUCH_NM.split(".").length-1];
                       	
                       	s_viewing_pdf ="<span class='pdfViewing' style='float:right'  rand_key='"+url+"' down=true>▼</span>";
                       	
                       }
                       
                 } else if("REL" == v.LNKD_KEY2){
                       s_vouch_nm = "<a class='show_vouch_box' onclick=\"fn_relAttFileDown('"+encodeURIComponent(v.LNKD_KEY1)+"');\" ><img src='" + s_img_str + "' class='icon'/>" + v.VOUCH_NM + "</a>";
                       s_tr_id = "TR_KIND2_" + v.LNKD_KEY1;
                 } else if("REL_CLOUD" == v.LNKD_KEY2){
                       var rand_key = v.LNKD_KEY1.split('=');

                       if(v.VOUCH_NM.indexOf(".png")>0 || v.VOUCH_NM.indexOf(".jpg")>0 || v.VOUCH_NM.indexOf(".jpeg")>0 || v.VOUCH_NM.indexOf(".gif")>0 
                       		|| v.VOUCH_NM.indexOf(".PNG")>0 || v.VOUCH_NM.indexOf(".JPG")>0  || v.VOUCH_NM.indexOf(".JPEG")>0 || v.VOUCH_NM.indexOf(".GIF")>0){
                       	var url="";
                       	if($("#REAL_YN").val() =="Y"){
                       		
                       		if(parseInt(g_draft_date_time) >= 20200203180000){
                       			url = $("#FILE_UPLOAD_URL").val()+"/wecloud3/"+rand_key[1]+"."+v.VOUCH_NM.split(".")[v.VOUCH_NM.split(".").length-1];
                       		}else{
                       			url = $("#FILE_UPLOAD_URL").val()+"/wecloud2/"+rand_key[1]+"."+v.VOUCH_NM.split(".")[v.VOUCH_NM.split(".").length-1];	
                       		}
                       		
                       		
                       	}else{
                       		url = $("#FILE_UPLOAD_URL").val()+"/wecloud/"+rand_key[1]+"."+v.VOUCH_NM.split(".")[v.VOUCH_NM.split(".").length-1];
                       	}
                       	
                       	
                       	s_viewing_pdf ="<span class='imgViewing' style='float:right' url='"+url+"' down=true>▼</span>";
                       } else if (v.VOUCH_NM.indexOf(".pdf")>0 || v.VOUCH_NM.indexOf(".PDF")>0) {
                       	
                       	//var url = $("#FILE_UPLOAD_URL").val()+"/preview/"+rand_key[1];
                       	
                       	var url = $("#FILE_UPLOAD_URL").val()+"/preview/"+rand_key[1]+"."+v.VOUCH_NM.split(".")[v.VOUCH_NM.split(".").length-1];
                       	
                       	
                       	s_viewing_pdf ="<span class='pdfViewing' style='float:right'  rand_key='"+url+"' down=true>▼</span>";
                       	
                       }
                       
                       
                       s_vouch_nm = "<a class='show_vouch_box' href='javascript:' onclick='_WE_DRIVER.download(\""+rand_key[1]+"\");'><img src='" + s_img_str + "' class='icon'/>" + v.VOUCH_NM + "</a>";
                       s_tr_id = "TR_KIND2_" + v.LNKD_KEY1;
                 } else {
                       s_vouch_nm = "<a class='show_vouch_box' href='/fileDownload_0001.act?PTL_ID="+ v.PTL_ID + "&CHNL_ID=" + v.CHNL_ID +"&USE_INTT_ID="+v.USE_INTT_ID+"&USER_ID="+v.RGSR_ID+"&ATCH_SRNO="+v.ATCH_SRNO+"&RAND_KEY="+v.RAND_KEY+"'><img src='" + s_img_str + "' class='icon'/>" + v.VOUCH_NM + "</a>";
                       s_tr_id = "TR_KIND2_" + v.LNKD_KEY1;
                 }                
           }else if("3" == v.VOUCH_KIND){           // 일반첨부
             s_vouch_kind_nm = "외부";// 첨부파일
               
             s_vouch_nm = "<a class='show_vouch_box' href='"+v.LNKD_KEY1+"' target='_blank'>"+v.VOUCH_NM+"</a>";
             s_tr_id = "TR_KIND3_" + v.LNKD_KEY1;
                               
         }
           
          
           //returnStr += "<tr id='" + s_tr_id + "'>";
           	
  		if (g_limited_vouch_size_use_yn != "N") {
  			g_limited_vouch_size -= n_vouch_size;
  		    fn_setVouchSize();
  	    }

           returnStr += "<tr vouch_seq_no='"+v.VOUCH_SEQ_NO+"' id='" + s_tr_id + "'>";
           returnStr += "<input type='hidden' id='TR_PATH"+ (i+1) + "' value='" + v.FILE_STRG_PATH + "' />" +
           "<input type='hidden' id='TR_FILE_SIZE"+(i+1) + "' value='"+v.FILE_SIZE + "' />" +
           "<input type='hidden' id='CLOUD_YN"+(i+1) + "' value='"+cnts_Null2Void(v.CLOUD_YN, "Y")+"'/>" +
           "<input type='hidden' id='ATCH_SRNO"+(i+1) + "' value='"+cnts_Null2Void(v.ATCH_SRNO, "0")+"'/>";
  		if ("3" == v.VOUCH_KIND) {
  			returnStr += '<input type="hidden" id="VOUCH_NM'+(i+1)+'" value="'+v.VOUCH_NM+'" />';
  			returnStr += '<input type="hidden" id="TR_PATH'+(i+1)+'" value="'+v.LNKD_KEY1+'" />';
  		}
           returnStr += "<td><div>" + s_vouch_kind_nm + "</div></td>";
           if("1" == v.VOUCH_KIND) {
  			var subOriginSubj = cnts_Null2Void(v.ORIGIN_VOUCH_SUBJ);  
           	returnStr += "<td><div style='position:relative;'><div class='elipsis' doc_no='"+v.VOUCH_NM+"'>" + s_vouch_nm + "</div></div></td>";
  			//2022.07.11 진호용 추가 : 원안문서 제목 추가
           	returnStr += '<td><div style="position:relative;"><div class="elipsis" style="padding-left:0;padding-right:0;">' +
  					'<a href="#none" class="show_origin_box">'+subOriginSubj+'</a></div>' + 
  					'<!-- 레이어 --><div class="ly_reply origin_box" style="display:none;position:absolute;top:31px;left:10px;width:300px;">' +
  					'<div class="inner"><span class="bg_arr" style="left:26px;"></span>'+subOriginSubj+'</div></div><!-- //레이어 -->' +
  					'</div></td>';
           }else{
           	returnStr += "<td><div style='position:relative;'><div class='elipsis' style='osition:relative;' doc_no='"+v.VOUCH_NM+"'>" + s_vouch_nm + "</div>";
  			returnStr += '<!-- 레이어 --><div class="ly_reply vouch_box" style="display:none;position:absolute;top:31px;left:10px;width:300px;">' +
  					'<div class="inner"><span class="bg_arr" style="left:26px;"></span>'+v.VOUCH_NM+'</div></div><!-- //레이어 -->' +
  					'</div></td>';
  			returnStr += "<td></td>";
           	//returnStr += "<td><div class='elipsis' style='overflow:visible;position:relative;' doc_no='"+v.VOUCH_NM+"'>" + s_vouch_nm + "</div></td><td></td>";
           }
           
                
           if("" != jex.null2Void(g_basis_appr_seq_no)){ //임시저장하고 다시 작성하기 버튼 눌렀을 경우.
          
                 if("1" == v.VOUCH_KIND) { //원안문서
                       returnStr += "<td><div><input type='text' style='border: 0 0 0 0 ; width:97%' name='VOUCH_RMK' value='"+jex.null2Void(v.RMRK)+"' readonly disabled /></div></td>";
                       returnStr += "<td><div><a href='javascript:' onclick=\"fn_vouchDel(this);\"><img src='../../img/ico/ico_delete.gif' alt='"+$.i18n.prop("msg77")+"'></a></div></td>";
                 } else if("2" == v.VOUCH_KIND){ //일반첨부
                       returnStr += "<td><div><input type='text' style='border: 0 0 0 0 ; width:97%' name='VOUCH_RMK' value='"+jex.null2Void(v.RMRK)+"' readonly disabled /></div></td>";
                       returnStr += "<td><div><a href='javascript:' onclick=\"fn_vouchDel(this);\"><img src='../../img/ico/ico_delete.gif' alt='"+$.i18n.prop("msg77")+"'></a></div></td>";
                 } else if ("3" == v.VOUCH_KIND) { //외부문서
                     returnStr += "<td><div><input type='text' style='border: 0 0 0 0 ; width:97%' name='VOUCH_RMK' value='"+jex.null2Void(v.RMRK)+"' readonly disabled /></div></td>";
                       returnStr += "<td><div><a href='javascript:' onclick=\"fn_vouchDel(this);\"><img src='../../img/ico/ico_delete.gif' alt='"+$.i18n.prop("msg77")+"'></a></div></td>"; 
                 }
           }else{
                
           	var deleteHtml ="<a href='javascript:' onclick=\"fn_realVouchDel(this);\" class='atchDel' style='display:none;' ><img src='/img/ico/ico_delete.gif' alt='"+$.i18n.prop("msg77")+"'></a>"
                 if("2" == v.VOUCH_KIND &&  jex.null2Void(v.LNKD_KEY2).startsWith("REL")){  //2017.04.14 배유연 수정, REL이나 REL_CLOUD 다 이 if문 타도록
               	  
                       returnStr += "<td><div>"+jex.null2Void(v.VOUCH_CONT)+"</div></td>";
                       if(s_viewing_pdf !=""){
                       	returnStr += "<td><div>"+deleteHtml+s_viewing_pdf+"</div></td>";
                       }else{
                       	returnStr += "<td><div>"+deleteHtml+"</div></td>";
                       }
                 } else {
               	
                       if(jex.null2Void(v.VOUCH_CONT) !=""){
                             returnStr += "<td><div>"+jex.null2Void(v.VOUCH_CONT)+"</div></td>";
                             //returnStr += "<td><div></div></td>";
                       }
                       else{
                             returnStr += "<td><div>"+jex.null2Void(v.RMRK)+"</div></td>";
                            // returnStr += "<td><div></div></td>";
                       }
                       if(s_viewing_pdf !=""){
                       	returnStr += "<td><div>"+deleteHtml+s_viewing_pdf+"</div></td>";
                       }else{
                       	returnStr += "<td><div>"+deleteHtml+"</div></td>";
                       }
                      
                 }
                
                
           }
           returnStr += "</tr>";
  });  
  return returnStr;


}
function fn_relAttFileDown(aUrl){
window.open(decodeURIComponent(aUrl), "_self");
}
/**
* 원안문서 open
  */
  function fn_openVouch(apprSeqNo){

  var urlData = $("#REG_VIEW_URL").val(); //"http://approval.webcashcorp.com:82/appr_dtl_0005.act";   // 전자결재 등록 팝업 API
  var form = document.createElement("form");
  form.appendChild(getHiddenField("PTL_ID", g_ptl_id));
  form.appendChild(getHiddenField("CHNL_ID", g_chnl_id));
  form.appendChild(getHiddenField("USE_INTT_ID", g_use_intt_id));
  form.appendChild(getHiddenField("CNTS_ID", g_cnts_id));
  form.appendChild(getHiddenField("USER_ID", g_user_id));
  form.appendChild(getHiddenField("APPR_SEQ_NO", apprSeqNo));
  form.appendChild(getHiddenField("CNTS_CRTC_KEY", $("#CNTS_CRTC_KEY").val()));
  form.appendChild(getHiddenField("PROC_GB", "R"));       // 전자결재 양식 일련변호.
  form.appendChild(getHiddenField("POPUP_YN", "Y"));       // 전자결재 양식 일련변호.

  if(g_lnkd_gb == "00"){//외부링크서 원안문서 호출시 -> fn_openVouch안에 들어올 값을 바꾸는게 맞을듯하다.
  form.appendChild(getHiddenField("LNKD_GB", g_lnkd_gb));       // 링크연결여부
  form.appendChild(getHiddenField("APPR_YN", "N"));       
  form.appendChild(getHiddenField("MENU_TYPE", g_menu_type));       
  }

  if ("H" == g_menu_type) {
  form.appendChild(getHiddenField("MENU_TYPE", g_menu_type));       
  }

  form.setAttribute("method", "post");
  form.setAttribute("action", urlData);
  form.setAttribute("id", "frm_tmp");
  form.setAttribute("name", "frm_tmp");
  document.body.appendChild(form);
  open_popup("frm_tmp",{sizeW:"1322" ,sizeH:"785", target:"newfrm",action:"appr_dtl_0008.act"});
  document.body.removeChild(form);
  }
  /**
* 기안문서 결재 정보 조회 함수
* Appr document state Search Funtion
  */
  function fn_getApprStsSrc(){




      var jexAjax = jex.createAjaxUtil("appr_sts_r002");
      jexAjax.set(jex.getAll("#frm_appr_dtl_0005"));
      jexAjax.set("APPR_SEQ_NO"           , g_appr_seq_no);
      jexAjax.set("_LODING_BAR_YN_" ,"N");
      jexAjax.setAsync(false);
      jexAjax.execute(function(dat){
            if(!jex.isError(dat)){
                  $("#ltbl").remove();
                  $("#rtbl").remove();
                 
                  // 오른쪽 왼쪽 순서대로 가지고 있어 나중에 그려준다.
                  var sHtmlLeftLine = "";
                  var sHtmlRightLine = "";
                  var sHtmlBottomLine = "";
     
                  if(g_apprline_left_len > 0 ){
                        sHtmlLeftLine += "<table class='list_table' summary='' style='width:auto;' id='ltbl'>";
                        sHtmlLeftLine += "<caption></caption>";
                        sHtmlLeftLine += "<colgroup id='lcolgrp'></colgroup>";
                        sHtmlLeftLine += "<thead>";
                        sHtmlLeftLine += "<tr id='lTrHeader'></tr><tr id='lTr' class='name'></tr><tr id='lTr2'></tr>";
                        sHtmlLeftLine += "</thead>";
                        sHtmlLeftLine += "</table>";                   
                  }
                  if(g_apprline_right_len > 0 ){
                        sHtmlRightLine += "<table class='list_table' summary='' style='width:auto;' id='rtbl'>";
                        sHtmlRightLine += "<caption></caption>";
                        sHtmlRightLine += "<colgroup id='rcolgrp'></colgroup>";
                        sHtmlRightLine += "<thead>";
                        sHtmlRightLine += "<tr id='rTrHeader'></tr><tr id='rTr' class='name'></tr><tr id='rTr2'></tr>";
                        sHtmlRightLine += "</thead>";
                        sHtmlRightLine += "</table>";
                  }
                  if(g_apprline_bottom_len > 0 ){
                        sHtmlBottomLine += "<tr id='bTr'>";
                        sHtmlBottomLine += "<th scope='row'><div id='bThHeader'></div></th>";
                        if(g_paper_kind == "2"){ //연계일때는 colspan 안넣음
                              sHtmlBottomLine += "<td><div id='bDiv'></div></td>"; 
                        }else{
                              sHtmlBottomLine += "<td colspan='3'><div id='bDiv'></div></td>";
                        }
                       
                       
                        sHtmlBottomLine += "</tr>";                    
                  }
                  $("#apprlineLeft").append(sHtmlLeftLine);
                  $("#apprlineRight").append(sHtmlRightLine);
                  $("#P_TBODY tr:first").after(sHtmlBottomLine);
                  $("#R_TBODY tr:first").after(sHtmlBottomLine);
                  g_sHtmlBottomLine = sHtmlBottomLine;
           
                  // 결재 상태 세팅 함수로 구현
                  setApprStsDataSet(dat);
            }
      });
}
/**
*
* @param dat
* @return
  */
  function setApprStsDataSet(dat){
  $("#lcolgrp > * ").remove();
  $("#rcolgrp > * ").remove();
  $("#lTrHeader > * ").remove();
  $("#rTrHeader > * ").remove();
  $("#lTr > * ").remove();
  $("#rTr > * ").remove();
  $("#bDiv > * ").remove();

  var sHtmlLHeader = "";
  var sHtmlRHeader = "";
  var sHtmlLCol = "";
  var sHtmlRCol = "";
  var sHtmlBRow = "";
  var sHtmlL = "";
  var sHtmlR = "";
  var sHtmlL2 = "";
  var sHtmlR2 = "";
  var locPos = "";
  var dispType = "";

  var locPos3 = 0;

  var sGaroHtml ="<table class='list_table horiz' summary='' style='width:auto;'>";

  sGaroHtml+="	<caption></caption>                  ";
  sGaroHtml+="	<colgroup>               ";
  sGaroHtml+="		<col>                ";
  sGaroHtml+="		<col>                ";
  sGaroHtml+="		<col>                ";
  sGaroHtml+="		<col>                ";
  sGaroHtml+="		<col>                ";
  sGaroHtml+="		<col>                ";
  sGaroHtml+="		<col>                ";
  sGaroHtml+="		<col>                ";
  sGaroHtml+="	</colgroup>             ";

  $.each(dat.STS_REC, function(i, v){

           // 결재 타입에 따라 위치 고려
           var s_appr_user_gb            = v.APPR_USER_GB; // APPR_USER_GB - 1:부서, 2:사용자
           var s_apprline_kind     = v.APPRLINE_KIND;
           var s_apprline_kind_nm  = v.APPRLINE_KIND_NM;
           var s_appr_dept_cd            = v.APPR_DEPT_CD;
           var s_appr_user_id            = v.APPR_USER_ID;
           var s_appr_user_nm            = v.APPR_USER_NM;
           var s_appr_dept_nm            = cnts_Null2Void(v.APPR_DEPT_NM, "");
           var s_apprline_sts            = v.APPRLINE_STS;
           var s_apprline_sts_nm   = v.APPRLINE_STS_NM;
           var s_appr_date         = cnts_Null2Void(v.APPR_DATE, "");
           var s_appr_time         = cnts_Null2Void(v.APPR_TIME, "");
           var s_appr_user_or_dept = "";
           var s_real_appr_user_or_dept = "";
           var s_real_appr_user_nm = cnts_Null2Void(v.REAL_APPR_USER_NM, "");
           var s_real_appr_user_id = v.REAL_APPR_USER_ID;
           var s_appr_title_input = cnts_Null2Void(v.APPR_TITLE_INPUT, "");
           var s_appr_img_path = cnts_Null2Void(v.IMG_PATH, "");
          
           
           // 2019.01.25 서명란 옵션 값 추가: 직위, 직책 추가 
           var s_appr_user_pos_nm = cnts_Null2Void(v.APPR_USER_POS_NM, ""); 
           var s_real_appr_user_pos_nm = cnts_Null2Void(v.REAL_APPR_USER_POS_NM, "");
           var s_appr_user_rspt_nm = cnts_Null2Void(v.APPR_USER_RSPT_NM, ""); 
           var s_real_appr_user_rspt_nm = cnts_Null2Void(v.REAL_APPR_USER_RSPT_NM, "");
           var s_appr_user_dept_nm = cnts_Null2Void(v.APPR_USER_DEPT_NM, "");
           
           var s_appr_ord = cnts_Null2Void(v.APPR_ORD, "");
           var s_id_number =  cnts_Null2Void(v.REAL_ID_NUMBER,"")!=""? cnts_Null2Void(v.REAL_ID_NUMBER,"") : cnts_Null2Void(v.ID_NUMBER);

  		var b_sign_idnum = g_sign_idnum_use_yn=="Y";
  		var b_sign_dept = g_sign_dept_use_yn=="Y";
  		var b_sign_jbcl = g_sign_jbcl_use_yn=="Y";
  		var b_sign_appr_kind = g_sign_appr_kind_use_yn=="Y";

           if(b_sign_idnum){
           	
     		    s_id_number = s_id_number !="" ? "("+s_id_number+")" : "";  
          }else{
        	    s_id_number = "";
          }
           //var s_real_id_number = cnts_Null2Void(v.REAL_ID_NUMBER);
           //2018.03.28 배유연 추가 : 기안자 아이디 저장(휴가일수 조회할때쓰려고.)
           if(s_apprline_kind == "1"){
           	g_draft_user_id = s_appr_user_id;
           	g_draft_user_id_number=s_id_number;
           	
           }
           if("undefined" == typeof(s_appr_user_nm)  || "undefined" == s_appr_user_nm){
                 s_appr_user_nm = "";
           }
           if("undefined" == typeof(s_appr_dept_nm)  || "undefined" == s_appr_dept_nm){
                 s_appr_dept_nm = "";
           }
           if("" != jex.null2Void(s_appr_date)) {
                 if(g_dsp_time_line_yn == "Y"){
                       s_appr_date = s_appr_date.substring(4, 6) + "/" + s_appr_date.substring(6,8)+" "+ s_appr_time.substring(0,2) +":"+ s_appr_time.substring(2,4);
                 }else{
                       s_appr_date = s_appr_date.substring(4, 6) + "/" + s_appr_date.substring(6,8);
                 }
           }
          
           if("1" == s_appr_user_gb) {
                 locPos = fn_getPos(s_apprline_kind, s_appr_dept_cd);
                 s_appr_user_or_dept = s_appr_dept_nm;
                
                 if("" != s_real_appr_user_nm && "3" != locPos ){ 
               	  
               	  //if("3" != locPos){
               		  s_appr_user_or_dept += " <br>(" + s_real_appr_user_nm + ")";
               	  //}
               		  
               	    
               		  
               	  if(b_sign_jbcl){
               		
               		  if(s_real_appr_user_pos_nm !="" && s_real_appr_user_rspt_nm !="")
                   		  s_appr_user_or_dept += " <br>(" + s_real_appr_user_pos_nm +"/"+s_real_appr_user_rspt_nm+ ")";
     	        		  if(s_real_appr_user_pos_nm !="" && s_real_appr_user_rspt_nm =="")
     	        			  s_appr_user_or_dept += " <br>(" + s_real_appr_user_pos_nm + ")";
     	        		  if(s_real_appr_user_pos_nm =="" && s_real_appr_user_rspt_nm !="")
     	        			  s_appr_user_or_dept += " <br>(" + s_real_appr_user_rspt_nm + ")";
               	  }
               	  
                 }
                 s_real_appr_user_or_dept = s_real_appr_user_nm;
                 dispType = fn_getTitleGb(s_apprline_kind, s_appr_dept_cd);
           } else if("2" == s_appr_user_gb) {
                 locPos = fn_getPos(s_apprline_kind, s_appr_user_id);
                 s_appr_user_or_dept = s_appr_user_nm;
                 s_real_appr_user_or_dept = s_real_appr_user_nm;
                 dispType = fn_getTitleGb(s_apprline_kind, s_appr_user_id);
          
           }
           
           s_apprline_kind_nm=(s_apprline_kind=="1" ? $.i18n.prop("msg158") : (s_apprline_kind=="2" ? $.i18n.prop("msg21") : (s_apprline_kind=="3" ? $.i18n.prop("msg22") : (s_apprline_kind=="5" ? $.i18n.prop("msg23")
           		  : (s_apprline_kind=="6" ? $.i18n.prop("msg24") :  $.i18n.prop("msg159"))))));
            
           
           var titleNm = "";
           // 결재란 구분값에 따른 입력값 세팅
           if ("1" == dispType) {              // 직급
                 if ("2" == s_appr_user_gb) {
                       titleNm = cnts_Null2Void(v.APPR_USER_POS_NM, "");
                 }
           } else if ("2" == dispType) {       // 부서명
                 if ("2" == s_appr_user_gb) {
                       titleNm = cnts_Null2Void(v.APPR_USER_DEPT_NM, "");
                 }
           } else if (dispType == "3") {       // 직접입력
                 titleNm = fn_getTitleValue(s_apprline_kind, s_appr_dept_cd);
           }else if(dispType == "4") {       // 결재유형(2019.12.31)
           	titleNm=s_apprline_kind_nm;
           }else if(dispType == "5") {       // 직책추가(202306)
           	titleNm=s_appr_user_rspt_nm;
           }




           if("" == $.trim(titleNm)){
                 titleNm = "&nbsp;";
           }
          
           if("" != s_appr_title_input){
                 titleNm = s_appr_title_input;
           }
           // 결재 대기상태일경우
           var dateColorCss  = "";
           var colorCss            = "";
           var apprReturnMsg = "";
           if("1" == s_apprline_sts){
                 dateColorCss      = "style='color:#0100FF;'";
                 colorCss          = "style='color:#0100FF;'";
           }
           // 결재 보류상태일경우
           else if("3" == s_apprline_sts){
                 dateColorCss      = "style='color:#FF0100;'";
                 apprReturnMsg     = "&nbsp;-보류";
           }
           // 결재 반송상태일경우
           else if("4" == s_apprline_sts){
                 dateColorCss      = "style='color:#FF0100;'";
                 apprReturnMsg     = "&nbsp;-"+$.i18n.prop("msg36");
           }
           // 대결인 경우
           if(("2" == s_apprline_sts || "3" == s_apprline_sts || "4" == s_apprline_sts) && "2" == s_appr_user_gb && s_real_appr_user_id != s_appr_user_id){
                 //apprReturnMsg   = "&nbsp;-대결";
                 s_appr_user_or_dept = s_appr_user_or_dept.concat("&nbsp;("+$.i18n.prop("msg107")+"-" + s_real_appr_user_or_dept + ")"); // 대결
           }
           if("" != cnts_Null2Void(v.OPINION, "")) {
                 isExistOpinion = true;
           //    s_appr_user_or_dept = s_appr_user_or_dept + "<img style='cursor:pointer !important;' src='../../img/ico/ico_letter01.gif' onclick=\"fn_apprStsList();\"/>";
                 //매입세금, 경리나라는 따로 처리, 카드재신고까지..
                 /*if("111" == g_paper_seq_no || "112" == g_paper_seq_no || "121" == g_paper_seq_no){ 
                       s_appr_user_or_dept = s_appr_user_or_dept + "<img style='cursor:pointer !important;' src='/img/ico/ico_letter01.gif' onclick=\"parent.fn_apprStsList();\"/>";
                 }
                 else{
                       s_appr_user_or_dept = s_appr_user_or_dept + "<img style='cursor:pointer !important;' src='/img/ico/ico_letter01.gif' onclick=\"fn_apprStsList();\"/>";
                 }*/
                
           }
           // 결재 서명란 표시 어떻게 할지
           var s_apprline_html="";
          
           if(g_seal_use_yn =="Y"){
           	if(s_appr_img_path != "" && s_apprline_sts =="2")
           		s_apprline_html += "<span class='img_sign'><img src='"+s_appr_img_path+"' alt='사인 이미지'></span>";
           	s_apprline_html += "<p "+colorCss+">" + s_appr_user_or_dept + "</p>";
  			if(b_sign_idnum){// 사원번호 표시
          		s_apprline_html += "<p "+colorCss+">" +s_id_number + "</p>";
          	}
          	if(b_sign_dept && s_appr_user_dept_nm !="" && "2" == s_appr_user_gb){// 부서정보 표시
          		s_apprline_html += "<p "+colorCss+">" +"("+ s_appr_user_dept_nm + ")"+"</p>";
          	}
          	if(b_sign_jbcl){// 직위/직책 표시
          		 //console.log(s_apprline_html);
          		//s_apprline_html += "<p "+colorCss+">" + s_appr_user_pos_nm+"/"+s_appr_user_rspt_nm + "</p>";
          		if("2" == s_appr_user_gb){// 사용자
  	        		if(s_appr_user_pos_nm !="" && s_appr_user_rspt_nm !="")
  	  	        		s_apprline_html += "<p "+colorCss+">" +"("+ s_appr_user_pos_nm+"/"+s_appr_user_rspt_nm+ ")"+ "</p>";
  	  	        	if(s_appr_user_pos_nm !="" && s_appr_user_rspt_nm =="")
  	  	        		s_apprline_html += "<p "+colorCss+">" +"("+ s_appr_user_pos_nm+ ")"+ "</p>";
  	  	        	if(s_appr_user_pos_nm =="" && s_appr_user_rspt_nm !="")
  		        		s_apprline_html += "<p "+colorCss+">" +"("+ s_appr_user_rspt_nm+ ")"+ "</p>";
          		}
          	}
          	if(b_sign_appr_kind){// 결재정보 표시
          		s_apprline_html += "<p "+colorCss+">" +"("+ s_apprline_kind_nm + ")"+ "</p>";
          	}
           }else if(g_seal_use_yn !="Y"){
           	//2019.01.25 서명란 옵션 추가
           	 s_apprline_html += "<p "+colorCss+">" + s_appr_user_or_dept + "</p>";
           	 if(b_sign_idnum){// 사원번호 표시
          		  s_apprline_html += "<p "+colorCss+">" +s_id_number + "</p>";
          	 }
          	  if(b_sign_dept && s_appr_user_dept_nm !="" && "2" == s_appr_user_gb){// 부서정보 표시
          		  s_apprline_html += "<p "+colorCss+">" +"("+ s_appr_user_dept_nm + ")"+"</p>";
          	  }
          	  if(b_sign_jbcl){// 직위/직책 표시
          		  //console.log(s_apprline_html);
          		  //s_apprline_html += "<p "+colorCss+">" + s_appr_user_pos_nm+"/"+s_appr_user_rspt_nm + "</p>";
          		  if("2" == s_appr_user_gb){// 사용자
          			
          			  if(s_appr_user_pos_nm !="" && s_appr_user_rspt_nm !="")
    	        			  s_apprline_html += "<p "+colorCss+">" +"("+ s_appr_user_pos_nm+"/"+s_appr_user_rspt_nm+ ")"+ "</p>";
    	        		  if(s_appr_user_pos_nm !="" && s_appr_user_rspt_nm =="")
    	        			  s_apprline_html += "<p "+colorCss+">" +"("+ s_appr_user_pos_nm+ ")"+ "</p>";
    	        		  if(s_appr_user_pos_nm =="" && s_appr_user_rspt_nm !="")
  	        			  s_apprline_html += "<p "+colorCss+">" +"("+ s_appr_user_rspt_nm+ ")"+ "</p>";
          		  }
          	  }
          	  if(b_sign_appr_kind){// 결재정보 표시
          		  s_apprline_html += "<p "+colorCss+">" +"("+ s_apprline_kind_nm + ")"+ "</p>";
          	  }
          	  
       	  
           }
           
           //2019.12.30 배유연 추가 : 가로형결재란사용하면서 위치를 본문 설정한거 제외한 경우만.(본문일 경우는 세로형이랑 동일.)
           if(g_pos_rec !=null && g_pos_rec.length>0 && g_pos_rec[0].SHAPE=="2" && g_pos_rec[0].POS!="3"){
           	
           	var ak= $.grep(g_pos_rec, function(n, i){
           		return n.APPRLINE_KIND == s_apprline_kind;
           	});
           
           	if(ak !=null && ak.length>0 && cnts_Null2Void(ak[0].APPRLINE_KIND,"")!=""){
           		sGaroHtml+="		<tr>                                                                                           ";
          		sGaroHtml+="			<th><div>"+s_appr_ord+"</div></th>                                                                  ";
          		sGaroHtml+="			<th><div >"+s_apprline_kind_nm+"</div></th>                                                                   ";
          		sGaroHtml+="			<td><div "+dateColorCss+">"+s_appr_user_or_dept+s_id_number;
          		if(s_real_appr_user_nm !="" &&  "1" == s_appr_user_gb ){
          			sGaroHtml +="<br>"+s_real_appr_user_nm+s_id_number+"</div></td>                                                                 ";
          		}else{
          			sGaroHtml+="</div></td>                                                         ";
          		}		
          		
          		if(b_sign_dept && "2" == s_appr_user_gb){//사용자결재 일때 부서정보 표기하기로함
          			sGaroHtml+="			<td><div>"+s_appr_user_dept_nm+"</div></td>                                                         ";	
          		}else if(b_sign_dept &&"1" == s_appr_user_gb){
          			sGaroHtml+="			<td><div style='min-width:40px;'></div></td>                                                         ";
          		}
          		if(b_sign_jbcl){//직위/직책 표시
          			sGaroHtml+="			<td><div style='min-width:40px;'>";
          			
          			if(s_appr_user_pos_nm !="" && s_appr_user_rspt_nm !="")
          				sGaroHtml += s_appr_user_pos_nm+"/"+s_appr_user_rspt_nm;
    	        		  if(s_appr_user_pos_nm !="" && s_appr_user_rspt_nm =="")
    	        			sGaroHtml +=s_appr_user_pos_nm;
    	        		  if(s_appr_user_pos_nm =="" && s_appr_user_rspt_nm !="")
    	        			sGaroHtml += s_appr_user_rspt_nm;
          			
          			sGaroHtml+="</div></td>                                                                   ";
          		}/*else{
          			sGaroHtml+="			<td><div style='min-width:40px;'></div></td>                                                        ";
          		}*/
          	
          		var sts_nm = (s_apprline_sts=="1" ? $.i18n.prop("msg190") : (s_apprline_sts=="2" ? $.i18n.prop("msg35") : (s_apprline_sts=="3" ? $.i18n.prop("msg37") : $.i18n.prop("msg36"))));
          		sGaroHtml+="			<td><div style='min-width:40px;'>"+sts_nm+"</div></td>                                                                   ";
          		
          		sGaroHtml+="			<td><div style='min-width:40px;'>"+s_appr_date+"</div></td>                                                             ";
          		
          	
       		    if(g_seal_use_yn =="Y" && s_appr_img_path != "" && s_apprline_sts =="2"){
       		    	sGaroHtml += "<td class='sign'><div><img class='sign' src='"+s_appr_img_path+"' alt='사인 이미지'></div></td>    ";
       		    }else if(g_seal_use_yn =="Y"){
       		    	sGaroHtml+="<td class='sign'><div></div></td>  ";
       		    } 
                   	
          		sGaroHtml+="		</tr>                                                                                          ";
           	}
           	
           	
           }else{
           	
           	if("1" == locPos){
                   sHtmlLCol += "<col style='width:100px;' />";
                   sHtmlLHeader += "<th scop='col' >" + titleNm + "</th>";
                  
                   sHtmlL += "<td>";
                  
                   sHtmlL +=s_apprline_html;
                   
                   sHtmlL += "</td>";
                   sHtmlL2 += "<td style='height:17px;'>";
                   sHtmlL2 += "<p "+dateColorCss+">" + s_appr_date + apprReturnMsg + "</p>";
                   sHtmlL2 += "</td>";          
             }else if("2" == locPos){
                 sHtmlRCol += "<col style='width:100px;' />";
                 sHtmlRHeader += "<th scop='col' >" + titleNm + "<input type='hidden' id='' /></th>";
                
                 sHtmlR += "<td>";
                 //if(g_seal_use_yn =="Y" && s_appr_img_path != ""){
                 /*if(g_seal_use_yn =="Y" && s_appr_img_path != ""  && s_apprline_sts =="2"){
                       sHtmlR += "<span class='img_sign'><img src='"+s_appr_img_path+"' alt='사인 이미지'></span>";
                 }                
                 sHtmlR += "<p "+colorCss+">" + s_appr_user_or_dept + "</p>";*/
                 sHtmlR +=s_apprline_html;
                 sHtmlR += "</td>";
                 sHtmlR2 += "<td style='height:17px;'>";
                 sHtmlR2 += "<p "+dateColorCss+">" + s_appr_date + apprReturnMsg + "</p>";
                 sHtmlR2 += "</td>";
                
             }else if("3" == locPos){
           	  
           	  	
                   locPos3++; //APPRLINE_STS_NM
                   s_apprline_html ="";
                   if(b_sign_dept === false && b_sign_jbcl === false  &&"1" == s_appr_user_gb && s_real_appr_user_nm!="" )// 아무것도 사용안함.
             		  s_appr_user_or_dept += " (" + s_real_appr_user_nm+")";
                   if(g_seal_use_yn !="Y"){
                   	//2019.01.25 서명란 옵션 추가
                 	  
                   	  if(b_sign_dept && b_sign_jbcl === false && "2" == s_appr_user_gb && s_appr_user_dept_nm!="" ){// 부서정보 표시, 사용자일때
       	        		  s_apprline_html +="("+ s_appr_user_dept_nm + ")";
       	        		
       	        	  }
       	        	  if(b_sign_dept && b_sign_jbcl === false && "1" == s_appr_user_gb && s_appr_user_dept_nm!="" ){// 부서정보 표시, 부서일때
       	        		  s_apprline_html +="("+ s_real_appr_user_nm+ ")";
       	        	  }
       	        	  if(b_sign_jbcl && b_sign_dept === false ){// 직위/직책 표시
       	        		  
       	        		
       	        		  if("2" == s_appr_user_gb){//사용자
       	        			
       	        			  if(s_appr_user_pos_nm !="" && s_appr_user_rspt_nm !="")
       	        				  s_apprline_html += "("+s_appr_user_pos_nm+"/"+s_appr_user_rspt_nm+")";
            	        		  if(s_appr_user_pos_nm !="" && s_appr_user_rspt_nm =="")
            	        			  s_apprline_html += "("+s_appr_user_pos_nm+")";
            	        		  if(s_appr_user_pos_nm =="" && s_appr_user_rspt_nm !="")
            	        			  s_apprline_html += "("+s_appr_user_rspt_nm+")";  
       	        		  }else{//부서
       	        			  
       	        			
       	        			
       	        			  if(""!=s_real_appr_user_nm)
       	        				  s_appr_user_or_dept += " (" + s_real_appr_user_nm;
       	        			  if(""!=s_real_appr_user_nm && s_real_appr_user_pos_nm !="" && s_real_appr_user_rspt_nm !="")
    	      	        			  s_apprline_html += s_real_appr_user_pos_nm+"/"+s_real_appr_user_rspt_nm+")";
    	      	        		  if(""!=s_real_appr_user_nm && s_real_appr_user_pos_nm !="" && s_real_appr_user_rspt_nm =="")
    	      	        			  s_apprline_html += s_real_appr_user_pos_nm+")";
    	      	        		  if(""!=s_real_appr_user_nm && s_real_appr_user_pos_nm =="" && s_real_appr_user_rspt_nm !="")
    	      	        			  s_apprline_html += s_real_appr_user_rspt_nm+")";  
       	        		  }
       	        		  
       	        		  
       	        		  
       	        	  }
       	        	  if(b_sign_jbcl && b_sign_dept ){//부서정보 표시,  직위/직책 표시
       	        		
       	        		 //s_apprline_html +="(";
       	        		 if( "2" == s_appr_user_gb  && s_appr_user_dept_nm != "")
       	        			s_apprline_html += "(" + s_appr_user_dept_nm+"&nbsp;";
       	        		 
       	        		 

       	        		 if("1" == s_appr_user_gb){
       	        			s_apprline_html =""; // 괄호때매  초가화
       	        			 if(s_real_appr_user_nm !="" ){
       	        				s_appr_user_or_dept += " (" + s_real_appr_user_nm;
       	        				if(s_real_appr_user_pos_nm !="" && s_real_appr_user_rspt_nm !="")
       	        					s_apprline_html += s_real_appr_user_pos_nm+"/"+s_real_appr_user_rspt_nm+")";
       	        				if(s_real_appr_user_pos_nm !="" && s_real_appr_user_rspt_nm =="")
       	        					s_apprline_html += s_real_appr_user_pos_nm+")";
       	        				if(s_real_appr_user_pos_nm =="" && s_real_appr_user_rspt_nm !="")
       	        					s_apprline_html += s_real_appr_user_rspt_nm+")";
       	        				if(s_real_appr_user_pos_nm =="" && s_real_appr_user_rspt_nm =="")
       	        					s_apprline_html += ")";

       	        				
       	        			 }
       	        	
       	        			
       	        		 }else{//사용자
       	        			var vol="";
          	        		 if(s_appr_user_dept_nm == ""){
          	        			vol="("
          	        		 }
          	        		 if(s_appr_user_pos_nm !="" && s_appr_user_rspt_nm !="")
          	        			 s_apprline_html += vol+s_appr_user_pos_nm+"/"+s_appr_user_rspt_nm+")";
         	        		 if(s_appr_user_pos_nm !="" && s_appr_user_rspt_nm =="")
         	        			 s_apprline_html += vol+s_appr_user_pos_nm+")";
         	        		 if(s_appr_user_pos_nm =="" && s_appr_user_rspt_nm !="")
         	        			 s_apprline_html += vol+s_appr_user_rspt_nm+")";
         	        		 if(s_appr_user_pos_nm =="" && s_appr_user_rspt_nm =="")
         	        			 s_apprline_html = (s_appr_user_dept_nm=="" ?  "" :  "(" + s_appr_user_dept_nm+")" );
       	        		 }
       	        		
       	        		 
     	        		 
     	        		 
     	        		 
     	        	  }
   	        	  if(b_sign_appr_kind){// 결재정보 표시
   	        		      	        		  
   	        	  }
   	        	  
               	  
                   
                  }
                   
                   
                   
                   s_apprline_sts_nm=(s_apprline_sts_nm=="대기" ? $.i18n.prop("msg190") : (s_apprline_sts_nm=="완료" ? $.i18n.prop("msg35") : (s_apprline_sts_nm=="보류" ? $.i18n.prop("msg37") : $.i18n.prop("msg36"))));
             
                   //기존
                   //sHtmlBRow += "<p>"+ s_apprline_kind_nm + "&nbsp;&nbsp;<font "+ colorCss + ">" + s_appr_user_or_dept+"&nbsp;"+s_apprline_html +"</font>&nbsp;&nbsp;"+ s_apprline_sts_nm + "&nbsp;" + s_appr_date + "</p>";
                   
                   //2019.12.31 배유연 수정
                   sHtmlBRow +="<table class='tbl_approval mgt5' style='margin-bottom: 5px !important;' summary=''>   ";
  				sHtmlBRow +="<caption></caption>                                 ";
  				sHtmlBRow +="<colgroup>                                          ";
  				sHtmlBRow +="	<col>                                            ";
  				sHtmlBRow +="	<col>                                            ";
  				sHtmlBRow +="	<col>                                            ";
  				sHtmlBRow +="	<col>                                            ";
  				sHtmlBRow +="	<col>                                            ";
  				sHtmlBRow +="	<col>                                            ";
  				sHtmlBRow +="</colgroup>                                         ";
  				sHtmlBRow +="<tbody>                                             ";
                   sHtmlBRow +="<tr>                              ";
  				sHtmlBRow +="	<th><div>&lt;"+s_appr_ord+"&gt;</div></th>  ";
  				//sHtmlBRow +="	<th><div>"+s_apprline_kind_nm+"</div></th>       ";
  				sHtmlBRow +="	<th><div>"+titleNm+"</div></th>       ";
  				sHtmlBRow +="	<td><div "+ colorCss+">"+s_appr_user_or_dept+s_id_number+"</div></td>       ";
  				sHtmlBRow +="	<td><div "+ colorCss+">"+s_apprline_html+"</div></td>";
  				sHtmlBRow +="	<td><div>"+s_apprline_sts_nm+"</div></td>       ";
  				sHtmlBRow +="	<td><div>"+s_appr_date+"</div></td>           ";
  				sHtmlBRow +="</tr>                             ";
  				sHtmlBRow +="</tbody>                          ";
  				sHtmlBRow +="</table>                          ";
                   
             }
           }


      });
     
      //가로형 결재란 setting
      if(g_pos_rec !=null && g_pos_rec.length>0 && g_pos_rec[0].SHAPE=="2"){
    	  sGaroHtml +="</tbody>";
    	  sGaroHtml +="</table>";
    	  
    	  if(g_pos_rec[0].POS =="1"){//왼쪽
    		  $("#apprlineLeft").append(sGaroHtml);
    	  }else if(g_pos_rec[0].POS =="2"){//오른쪽
    		  $("#apprlineRight").append(sGaroHtml);
    	  }else if(g_pos_rec[0].POS =="3"){//본문
    		  $("#bDiv").append(sHtmlBRow);
    	  }else if(g_pos_rec[0].POS =="4"){//표시안함
    		  
    	  }else if(g_pos_rec[0].POS =="5"){//하단
    		  $("#apprlineBottom").append(sGaroHtml);
    	  }
      }else{//세로형 결재란 setting
    	     //2017.11.07 배유연 추가 : 연계문서일 경우 결재선 아래쪽에 했을 때 값 따로 저장되게
    	  g_sHtmlBRow = sHtmlBRow;
    	
    	  $("#lcolgrp").append(sHtmlLCol);
          $("#rcolgrp").append(sHtmlRCol);
          $("#lTrHeader").append(sHtmlLHeader);
          $("#rTrHeader").append(sHtmlRHeader);
          $("#lTr").append(sHtmlL);
          $("#rTr").append(sHtmlR);
          $("#lTr2").append(sHtmlL2);
          $("#rTr2").append(sHtmlR2);
          
          if("" != g_bottom_title) {
                //g_bottom_title = g_bottom_title.substring(0, g_bottom_title.length-1);
                //$("#bThHeader").append($("<p>"+ g_bottom_title +"</p>"));
        	  $("#bThHeader").append( $.i18n.prop("msg191"));
          }
          $("#bDiv").append(sHtmlBRow);
          //2019.12.17 결재선 변경시 연계문서는 결재선 아래쪽으로 설정 할 경우 다시 setting 해줘야함.
          
          if( g_sHtmlBRow !=""){

        	  
        	  
              if("101" == g_paper_seq_no){// 카드지출결의서
            
            	  if($(".tbl_input2").eq(0).find("#bTr").length==0){

                	  var sHtmlBottomLine="";
                	  sHtmlBottomLine += "<tr id='bTr'>";
                      sHtmlBottomLine += "<th scope='row'><div id='bThHeader'>"+$.i18n.prop("msg191")+"</div></th>";
                      sHtmlBottomLine += "<td><div id='bDiv'></div></td>"; 
                      sHtmlBottomLine += "</tr>";     
                      $(".tbl_input2").eq(0).find("#APPR_SUBJ").parent().parent().after(sHtmlBottomLine);
            	  }
            	  
                  
            	  
        			
        			$(".tbl_input2").eq(0).find("#bDiv").html(g_sHtmlBRow);
        			

        			
        		}
        		if("111" ==g_paper_seq_no){ //매입세금계산 지출결의서
        			var _this = $('#ifrm_rel').get(0).contentWindow.div_web;

        			if("" != g_bottom_title) {
        		          //  g_bottom_title = g_bottom_title.substring(0, g_bottom_title.length-1);
        					$(_this).find(".tbl_input2:eq(0)").find("#bThHeader").html($("<p>"+ $.i18n.prop("msg191") +"</p>"));
        				}
        			//$(_this).find(".tbl_input2").find("#APPR_SUBJ").parent().parent().after(g_sHtmlBottomLine);
        			$(_this).find(".tbl_input2:eq(0)").find("#bDiv").html(g_sHtmlBRow);
        			
        		}
      
          }
          	

          
          if(locPos3 == 0)        $("#bTr").remove();  // 삭제
    	  
      }



}
/**
* 결재선 위치 함수
* @param aLineKd : 결재선종류
* @param apprUserInfo
* @return
*
*
*/
function fn_getPos(aLineKd, apprUserInfo) {
var result = "";
for (var i = 0 ; i < g_apprline_pos_len ; i++) {
var apprlineItem = g_apprline_loc[i].split(":");
//g_apprline_loc --> v.APPRLINE_KIND + ":" + v.POS + ":" + v.APPR_SECT_TITLE_GB + ":" + v.APPR_SECT_TITLE_INPUT  + ":" + s_appr_user_info + ":" + v.APPR_USER_GB;

            if(apprlineItem[0]== aLineKd) {
            	
                  //기존
                  //if( ("2" == apprlineItem[5] && apprUserInfo == apprlineItem[4]) || ("1" == apprlineItem[5] && apprUserInfo == apprlineItem[4])) {
                  //2017.07.13 배유연 수정
                  if( ("2" == apprlineItem[5] && apprUserInfo == apprlineItem[4]) || ("1" == apprlineItem[5] && apprUserInfo == apprlineItem[4])
                              || ("2" == apprlineItem[5]  &&  apprUserInfo != apprlineItem[4]) || ("1" == apprlineItem[5] && apprUserInfo != apprlineItem[4])) {
                        // 지정된 사용자의 포지션
                        result = apprlineItem[1];
                        return result;
                  } else if( "" == jex.null2Void(apprlineItem[5]) ) {
                        // 지정되지 않은 사용자의 포지션
                        result = apprlineItem[1];
                        return result;
                  } else {
                 
                        continue;
                  }
            }
      }
      return result;
}
/**
* 양식지 결재란 타이틀 구분값 조회 함수
* @param aLineKd
* @param apprUserInfo
* @return
  */
  function fn_getTitleGb(aLineKd, apprUserInfo) {
  var result = "";
  for(var i = 0 ; i < g_apprline_pos_len ; i++) {
  var apprlineItem = g_apprline_loc[i].split(":");
  // 지정결재선일 경우
  if( "2" == apprlineItem[5] || "1" == apprlineItem[5] ) {

                 //if (aLineKd == apprlineItem[0] && apprUserInfo == apprlineItem[4]) {
                 if( (aLineKd == apprlineItem[0] && apprUserInfo == apprlineItem[4]) || (aLineKd == apprlineItem[0] && apprUserInfo != apprlineItem[4])) {
                       result = apprlineItem[2];
                       return result;
                 }
           } else {
                 if (aLineKd == apprlineItem[0]) {
                       result = apprlineItem[2];
                       return result;
                 }
           }
  }
  return result;
  }
  /**
* 양식지 결재란 타이틀 값 조회 함수
* @param aLineKd
* @param apprUserInfo
* @return
  */
  function fn_getTitleValue(aLineKd, apprUserId) {
  var result = "";
  for (var i = 0 ; i < g_apprline_pos_len ; i++) {
  var apprlineItem = g_apprline_loc[i].split(":");
  // 지정결재선일 경우
  if( "2" == apprlineItem[5]  || "1" == apprlineItem[5] ) {
  //if ("21" == g_apprline_gb && aLineKd == apprlineItem[0] && apprUserId == apprlineItem[4]) {
  if(("21" == g_apprline_gb && aLineKd == apprlineItem[0] && apprUserId == apprlineItem[4])||("21" == g_apprline_gb && aLineKd == apprlineItem[0] && apprUserId != apprlineItem[4])){
  result = apprlineItem[3];
  return result;
  } else {
  if (aLineKd == apprlineItem[0]) {
  result = apprlineItem[3];
  return result;
  }
  }
  } else {
  if (aLineKd == apprlineItem[0]) {
  result = apprlineItem[3];
  return result;
  }
  }
  }
  return result;
  }
  /**
* 결재양식 상세조회 함수
  */
  function fn_getPaperDtlSrc_R(){
  var jexAjax = jex.createAjaxUtil("appr_paper_r003");
  jexAjax.set("PTL_ID"        , g_ptl_id);
  jexAjax.set("CHNL_ID"       , g_chnl_id);
  jexAjax.set("USE_INTT_ID"   , g_use_intt_id);
  jexAjax.set("PAPER_SEQ_NO"    , g_paper_seq_no);
  jexAjax.set("GB"              , "APPR");
  jexAjax.set("_LODING_BAR_YN_" ,"N");
  jexAjax.setAsync(false);
  jexAjax.execute(function(dat){
  if(!jex.isError(dat)){
  g_paper_kind            = dat.PAPER_KIND;                   // 연계여부
  g_paper_nm              = dat.PAPER_NM;                     // 문서명
  g_paper_cont            = dat.PAPER_CONT;             // 내용
  $("#PAPER_NM").text(g_paper_nm);                      // 문서명
  $("#PAPERKIND").val(g_paper_kind);                    // 연계여부

                 var date = new Date();
                 var year = date.getFullYear();
                 var month = date.getMonth() + 1;
                 var dayOfMonth = date.getDate();
                 if(month < 10 ) month = "0" + month;
                 if(dayOfMonth < 10) dayOfMonth = "0" + dayOfMonth;
                
                 var s_doc_no_pref = dat.DOC_NO_PREF;      // 문서접두어
                 var s_doc_no_suff = dat.DOC_NO_SUFF;      // 문서접미어
                 var s_doc_no_1 = "";
                 var s_doc_no_2 = "";
                 var s_doc_no = "";
                 if("1" == s_doc_no_pref){                 // 분서분류
                       s_doc_no_1 = dat.PAPER_CATE_NM;
                 } else if("2" == s_doc_no_pref){    // 문서명
                       s_doc_no_1 = dat.PAPER_NM;
                 } else if("3" == s_doc_no_pref){    // 문서약칭
                       s_doc_no_1 = dat.PAPER_ABBR_NM;
                 }
                 if("1" == s_doc_no_suff){
                       s_doc_no_2 = year + "-OOOO";
                 } else if("2" == s_doc_no_suff){
                       s_doc_no_2 = year +  ""  + month + "-OOOO";
                 } else if("3" == s_doc_no_suff){
                       s_doc_no_2 = year + "" + month + "" + dayOfMonth + "-OOOO";
                 }

                 s_doc_no = s_doc_no_1 + "-" + s_doc_no_2;            
                 $("#DOC_NO").text(s_doc_no);
                 // 결재 양식지 항목 사용 -> tr 추가함
                 g_paper_item_len = dat.REC.length;
                 var tdAttr = "";             
                 if(g_paper_kind == "1" && g_paper_item_len > 0) {                        
                       var sHtmlItem = "";
                       $.each(dat.REC, function(i, v){
               
                             var s_input_type  = cnts_Null2Void(v.INPUT_TYPE, "");
                             var s_item_seq_no = v.ITEM_SEQ_NO;
                             
                             if ((g_paper_item_len % 2 != 0) && (i+1 == g_paper_item_len))
                                   tdAttr = " colspan='3' ";                            
                             if(i % 2 == 0) sHtmlItem += "<tr>";
                             sHtmlItem += "<th scope='row' usr-attr='"+ s_item_seq_no +"'><div style='word-break:break-all;'>" + v.ITNM + "</div></th>";
                             sHtmlItem += "<td " + tdAttr + " usr-attr='"+ s_input_type +"'><div>";
                             if("R" == g_menu_type){
                                   sHtmlItem += fn_getInputTypeVal(s_input_type, s_item_seq_no);
                                  
                                   if("7" == s_input_type){
                                         isDefaultTime = true;                                      
                                   }
                             } else {
                                   sHtmlItem += "<span id='ITNM_" + i + "' usr-attr='" + s_input_type+ "'></span>";
                             }
                             sHtmlItem += "</div></td>";
                            
                             if(i % 2 != 0) sHtmlItem += "</tr>";
                       });
                      
                       if("R" == g_menu_type){
                             $("#C_TBODY tr:first").after(sHtmlItem);
                       } else {
                             $("#R_TBODY tr:last").after(sHtmlItem);
                       }
                 }                
                 fn_setDefaultTime();
           }          
  });
  }
  /**
* 항목이 기간선택일 경우에 디폴트 시간을 설정
* 09:00~ 10:00
  */
  function fn_setDefaultTime(){
  if(isDefaultTime){
  $("select[name^='START_SELECT_TIME_7'] option[value='09']").attr("selected", "selected");
  $("select[name^='START_SELECT_MIN_7'] option[value='00']").attr("selected", "selected");
  $("select[name^='END_SELECT_TIME_7'] option[value='10']").attr("selected", "selected");
  $("select[name^='END_SELECT_MIN_7'] option[value='00']").attr("selected", "selected");
  }
  }
  /**
* 원안문서 첨부파일 콜백함수
*
* @param dat
* @return
  */
  function fn_callbackFnctBasisAppr(dat){



	//2021-01-14
	/*var tempApprSeqNo = "";
	$.each(dat, function(i, v){
	    var len = dat.length -1;
	    if(i == len){
	        tempApprSeqNo += v.APPR_SEQ_NO;
	    }else{
	        tempApprSeqNo += v.APPR_SEQ_NO+",";
	    }
	});*/
	//2021-01-14
    var sHtml = "";
    
    $.each(dat, function(i, v){ //2021-01-14
        var s_att_html="";
        var s_att_count="";
        var s_paper_cate= "";
    	var jexAjax = jex.createAjaxUtil("appr_vouch_r002"); 
    	jexAjax.set("PTL_ID"                ,     g_ptl_id          );	 
    	jexAjax.set("CHNL_ID"               ,     g_chnl_id         );
    	jexAjax.set("USE_INTT_ID"           ,     g_use_intt_id     );
    	jexAjax.set("APPR_SEQ_NO"           ,     v.APPR_SEQ_NO);//2021-01-14
    	//jexAjax.set("APPR_SEQ_NO"           ,     tempApprSeqNo);//2021-01-14
    	s_paper_cate=jex.null2Void(v.PAPER_CATE); //2021.05.26 다라웃 추가 
        
    	jexAjax.setAsync(false);
    	jexAjax.execute(function(dat){
    		if(!jex.isError(dat)){
    			if(parseInt(dat.CNT)>0 && dat.APPR_REC !=null){
    			
    				s_att_html +="<div class='ly_addfile_history' style='display:none;position:absolute;bottom:25px;left:inherit;'><p class='h_title'>첨부이력</p><ul>";
    			   	$.each(dat.APPR_REC, function(j,k){
    			   		s_att_html +="<li><a href=\"javascript:fn_openVouch('"+k.APPR_SEQ_NO+"')\">"+k.DOC_NO+ "/"+k.APPR_SUBJ +"</a></li>";
    			   	});
    			   	s_att_html +="</ul></div> ";
    			    }
    				s_att_count=dat.CNT;
    		
    			}
    	});
	
	
	
	 
   
      /*
       sHtml += "<tr id='TR_KIND1_" + dat.APPR_SEQ_NO + "'  usr-attr='N'>";
       sHtml += "<td class='t_left'>원안문서</td>";
       sHtml += "<td class='t_left'>"+ dat.DOC_NO +"</td>";
       sHtml += "<td class='t_left'><input type='text' style='width:90%;' name='VOUCH_RMK'/>&nbsp;<a href='javascript:' onclick=\"fn_vouchDel('1', '"+ dat.APPR_SEQ_NO +"');\"><img src='../../img/ico/ico_delete.gif' alt='삭제'></a></td>";
       sHtml += "</tr>";
       */
      
          sHtml += "<tr id='TR_KIND1_" + v.APPR_SEQ_NO + "'  usr-attr='N'>";
          sHtml += "<td><div>"+$.i18n.prop("msg104")+"</div></td>";// 원안문서
          //sHtml += "<td><div class='elipsis'>"+ dat.DOC_NO +"</div></td>";
          if(parseInt(s_att_count)>0){
              sHtml += "<td><div style='position:relative;'><div class='elipsis' doc_no ='"+v.DOC_NO+"'>"+s_att_html+"<a href='javascript:;' class='addfile_history_more'>("+s_att_count+")</a><a title='"+v.DOC_NO+"' href='#'>"+ v.DOC_NO +"</a></div></div></td>";  
          }else{
              sHtml += "<td><div style='position:relative;'><div class='elipsis' doc_no ='"+v.DOC_NO+"'><a title='"+v.DOC_NO+"' href='#'>"+ v.DOC_NO +"</a></div></div></td>";
          }
          //2022.07.11 진호용 추가 : 원안문서 문서 제목 표시
          var subOriginSubj = cnts_Null2Void(v.APPR_SUBJ);
          sHtml += '<td><div style="position:relative;"><div class="elipsis" style="padding-left:0;padding-right:0;">' +
					'<a href="#none" class="show_origin_box">'+subOriginSubj+'</a></div>' + 
					'<!-- 레이어 --><div class="ly_reply origin_box" style="display:none;position:absolute;top:31px;left:10px;width:300px;">' +
					'<div class="inner"><span class="bg_arr" style="left:26px;"></span>'+subOriginSubj+'</div></div><!-- //레이어 -->' +
					'</div></td>';
          sHtml += "<td><div><input type='text' style='width:97%;' name='VOUCH_RMK'/></div></td>";
          
          
          //2017.10.23 배유연 수정 : 기안 문서 작성화면만 삭제 버큰 진행/완료문서만 저장취소 버튼 나오게..
          if(g_appr_sts =="" || "RE" == g_appr_mode){ // 처음 기안 문서 작성화면
            if(s_paper_cate == ""){ //2021.05.26 다라웃 수정 : if it is paper_cate cannot delete
              sHtml += "<td><div ><a href='javascript:' onclick=\"fn_vouchDel(this);\" data ='"+v.APPR_SEQ_NO+"'><img src='../../img/ico/ico_delete.gif' alt='"+$.i18n.prop("msg77")+"'></a></div></td>";
            }else{
                sHtml += "<td><div ></div></td>";
            }     
          }
          else{ // 그외에 진행, 완료 문서
              sHtml += "<td><div><a href='javascript:;' class='fileClass btn_style3' onclick=\"fn_updateAttch_save(this);\"  data ='"+v.APPR_SEQ_NO+"'><span>"+$.i18n.prop("msg150")+"</span></a><a href='javascript:;' class='fileClass btn_style3' onclick=\"fn_vouchDel(this);\"><span>"+$.i18n.prop("msg108")+"</span></a></div></td>";// 저장, 취소
          }
          
          
          sHtml += "</tr>";
      });
      
      
      $("#VOUCH_THEAD tr:last").after(sHtml);
}
/**
* 첨부파일 추가 팝업
* @return
  */
  function fn_callbackFnctAtch(dat){
  var trlength = parseInt($("#VOUCH_THEAD tr").length);
  var sHtml = "";
  var n_vouch_size = 0;
  $.each(dat, function(i, v){
  var s_img_str = "";
  s_img_str = fileExtImgString(cnts_Null2Void(v.FILE_NM, ""));

           sHtml += "<tr id='TR_KIND2_"+ v.FILE_IDNT_ID +"' usr-attr='N'>";
           sHtml += "<input type='hidden' id='TR_PATH"+ (trlength) + "' value='" + v.IMG_PATH + "' />";
           sHtml += "<input type='hidden' id='TR_FILE_SIZE"+(trlength) + "' value='"+v.FILE_SIZE + "' />" +
           "<input type='hidden' id='CLOUD_YN"+(trlength) + "' value='"+cnts_Null2Void(v.CLOUD_YN, "Y")+"'/>" +
           "<input type='hidden' id='ATCH_SRNO"+(trlength) + "' value='"+cnts_Null2Void(v.ATCH_SRNO, "0")+"'/>";
           sHtml += "<td><div>"+$.i18n.prop("msg106")+"</div></td>";// 첨부파일
           sHtml += "<td><div style='position:relative;'><div class='elipsis'><a class='show_vouch_box' href='#'><img src='" + s_img_str + "' class='icon'/>"+ v.FILE_NM+"</a></div>";
  		sHtml += '<!-- 레이어 --><div class="ly_reply vouch_box" style="display:none;position:absolute;top:31px;left:10px;width:300px;">' +
  					'<div class="inner"><span class="bg_arr" style="left:26px;"></span>'+v.FILE_NM+'</div></div><!-- //레이어 -->' +
  					'</div></td>';
           sHtml += "<td></td>";
           sHtml += "<td><div><input type='text' style='width:97%;' name='VOUCH_RMK'/></div></td>";
           //2017.10.23 배유연 수정 : 처음 기안 작성화면만 삭제 버튼, 결재/완료 문서는 저장/취소버튼
           if(g_appr_sts =="" || "RE" == g_appr_mode){ // 처음 기안 문서 작성화면
                 sHtml += "<td><div><a href='javascript:' onclick=\"fn_vouchDel(this);\"><img src='../../img/ico/ico_delete.gif' alt='"+$.i18n.prop("msg77")+"'></a></div></td>";
           }
           else{ // 그외에 진행, 완료 문서
                
                 sHtml += "<td><div><a href='javascript:;' class='fileClass btn_style3' onclick=\"fn_updateAttch_save(this);\"><span>저장</span></a><a href='javascript:;' class='fileClass btn_style3'  onclick=\"fn_vouchDel(this);\"><span>취소</span></a></div></td>";
           }
           sHtml += "</tr>";
           trlength++;

  		n_vouch_size += parseInt(cnts_Null2Void(v.FILE_SIZE,"0"));
  });
  $("#VOUCH_THEAD tr:last").after(sHtml);

  if ("N" != g_limited_vouch_size_use_yn) {
  g_limited_vouch_size -= n_vouch_size;
  fn_setVouchSize();
  }
  }
  /**
* 첨부파일 삭제 함수
* @param aAtchSrno : 첨부파일 시퀀스
* @return
  */
  function fn_vouchDel(_this){
  if ("N" != g_limited_vouch_size_use_yn) {
  var del_vouch = $(_this).parents("tr[id^=TR_KIND2]");
  if(del_vouch.length != 0) {
  var n_del_vouch_size = parseInt(cnts_Null2Void(del_vouch.find("input[id^=TR_FILE_SIZE]").val(),"0"));
  g_limited_vouch_size += n_del_vouch_size;
  fn_setVouchSize();
  }		
  }
  $(_this).parent().parent().parent().remove();
  }
  /**
* 에디터내 첨부파일 콜백함수 - 다음에디터
* @param dat
* @return
  */
  function fn_callbackFnctEditAtch(dat){
  $.each(dat, function(i, v){
  var s_rand_key = v.FILE_IDNT_ID;
  Editor.getCanvas().pasteContent('<p><img src=' + v.IMG_PATH + ' editor="0" rankey='+ s_rand_key + ' style="clear: none; float: none; align: center;"/></p>');
  });
  }
  /**
* 에디터내 첨부파일 콜백함수 - 크로스에디터 (2021.05.25 진호용 추가)
* @param dat
* @return
  */
  function fn_callbackFnctEditAtchCE(dat){
  if (dat.length > 1) {
  $.each(dat, function(i, v){
  var s_rand_key = v.FILE_IDNT_ID;
  CrossEditor.InsertValue(-1, '<p><img src=' + v.IMG_PATH + ' editor="0" rankey='+ s_rand_key + ' style="clear: none; float: none; align: center;"/></p>');
  });
  } else {
  $.each(dat, function(i, v){
  var s_rand_key = v.FILE_IDNT_ID;
  CrossEditor.InsertValue(1, '<p><img src=' + v.IMG_PATH + ' editor="0" rankey='+ s_rand_key + ' style="clear: none; float: none; align: center;"/></p>');
  });
  }
  }
  /**
* 결재선 변경 적용
* @param dat
* @return
  */
  function fn_setApprline(dat){
  var jsonValue = {};
  jsonValue = jQuery.parseJSON(decodeURIComponent(dat.JSONDATA));

  var jsonLineValue = null;
  var jsonLineList = [];
  $.each(jsonValue, function(i, v){
  jsonLineValue = {};

         //alert(v.APPR_USER_GB + " : " + v.APPR_USER_NM);
        
         var s_appr_user_gb = v.APPR_USER_GB;
         jsonLineValue["APPR_ORD"] = v.APPR_ORD;
         if("1" == s_appr_user_gb){
               jsonLineValue["APPR_DEPT_CD"] = v.APPR_DEPT_CD;
               jsonLineValue["APPR_DEPT_NM"] = v.APPR_DEPT_NM;
               jsonLineValue["DEPT_CD"] = v.APPR_DEPT_CD;
               jsonLineValue["DEPT_NM"] = v.APPR_DEPT_NM;
               jsonLineValue["APPR_USER_DEPT_CD"] = v.APPR_USER_DEPT_CD; //2017.06.08 배유연 추가
               jsonLineValue["APPR_USER_DEPT_NM"] = v.APPR_USER_DEPT_NM;//2017.06.08 배유연 추가
         } else if("2" == s_appr_user_gb){
               jsonLineValue["APPR_USER_ID"] = v.APPR_USER_ID;
               jsonLineValue["APPR_USER_NM"] = v.APPR_USER_NM;
               jsonLineValue["APPR_USER_DEPT_CD"] = v.APPR_USER_DEPT_CD;
               jsonLineValue["APPR_USER_DEPT_NM"] = v.APPR_USER_DEPT_NM;
               jsonLineValue["APPR_USER_POS_NM"] = v.APPR_USER_POS_NM;
              
         }
         jsonLineValue["APPRLINE_KIND"] = v.APPRLINE_KIND;
         jsonLineValue["APPR_USER_GB"] = s_appr_user_gb;
         //jsonLineValue["APPOINT_YN"] = cnts_Null2Void(v.APPOINT_YN, ""); // 지정결재여부 - 저장안함여부 Y이면 저장안함
         jsonLineValue["RECENT_SAVE_YN"] = cnts_Null2Void(v.RECENT_SAVE_YN, ""); // 최근결재선여부(경비관리 요건별결재선 호출 요청값으로 추가함)
         jsonLineValue["BOTTOM_FIXED_YN"] = cnts_Null2Void(v.BOTTOM_FIXED_YN, "N"); // 최하단고정여부
         jsonLineList[i] = jsonLineValue;
  });


    var tmpJson = {};
    tmpJson["JSONDATA"] = encodeURIComponent(JSON.stringify(sortJSON(jsonLineList, "APPR_ORD")));
    //alert("callback mid1");
    
    jsonApprLine =  tmpJson;
    //alert("callback mid2");
    is_apprline_modify = true; // 콜백됨
    //alert("callback mid3");
    fn_appReg();
}
//라타
/*function fn_updateAttch() {
var vouchRec = null;
vouchList = [];
var o_vouch_table = $("#R_TABLE #VOUCH_THEAD tr[usr-attr='N']");
var vouch_len = o_vouch_table.length; // 헤더제외
var i_vouch = 0;
for(var i=0; i<vouch_len; i++){
vouchRec = {};
$o_vouch_tr = $(o_vouch_table).eq(i);
var vouch_tr_id = $o_vouch_tr.attr("id");

            var vouch_kind = vouch_tr_id.substring(7, 8);
            var vouch_key = vouch_tr_id.substring(9);
            var img_path = $o_vouch_tr.find("input[id^='TR_PATH']").val();
            var file_size = $o_vouch_tr.find("input[id^='TR_FILE_SIZE']").val();
            var cloud_yn = $o_vouch_tr.find("input[id^='CLOUD_YN']").val();
            var vouch_nm = $o_vouch_tr.find("td").eq(1).text();
            var vouch_new = $o_vouch_tr.find("td").eq(2).find("input[name='VOUCH_RMK']").val();
            var vouch_rmk = "";
            vouch_rmk = vouch_new; 
            vouchRec["VOUCH_NM"] = vouch_nm;
            vouchRec["VOUCH_KIND"] = vouch_kind;
            vouchRec["CLOUD_YN"] = cloud_yn;
            if("Y" == cloud_yn){
                  vouchRec["LNKD_KEY1"] = "0";
                  vouchRec["RAND_KEY"] = vouch_key;
                  vouchRec["IMG_PATH"] = img_path;
                  vouchRec["FILE_SIZE"] = file_size;
            } else {
                  vouchRec["LNKD_KEY1"] = vouch_key;
            }
            vouchRec["RMRK"] = vouch_rmk;
            vouchList[i_vouch] = vouchRec;
            i_vouch++;
      }
      var jexAjax = jex.createAjaxUtil("appr_c003"); 
      jexAjax.set("PTL_ID"                ,     g_ptl_id          );
      jexAjax.set("CHNL_ID"               ,     g_chnl_id         );
      jexAjax.set("USE_INTT_ID"           ,     g_use_intt_id     );
      jexAjax.set("VOUCH_REC"             ,     vouchList         );
      jexAjax.set("USER_ID"               ,     g_user_id         );
      jexAjax.set("USER_NM"               ,     g_user_nm         );
    
      
      jexAjax.set("APPR_SEQ_NO"           , g_appr_seq_no);
      jexAjax.execute(function(dat){
            if(!jex.isError(dat)){
                  alert($.i18n.prop("M0000"));
                  self.close();
            }
      });  
}*/
//2017.10.23 배유연 추가 :  파일 첨부 저장 버튼  하나씩만 되게 하기
function fn_updateAttch_save(element) {


      /*var o_vouch_table = $("#R_TABLE #VOUCH_THEAD tr[usr-attr='N']");
      var vouch_len = o_vouch_table.length; // 헤더제외
      var i_vouch = 0;*/
      //var _this=$(this);
      var _this= $(element).parent().parent().parent();//$("#VOUCH_THEAD").find("tr[id=TR_KIND"+kind+"_"+s_tr_id+"]");
      //var _this= $("#VOUCH_THEAD").find("tr[id^="+s_tr_id+"]");
      var vouchList = [];
      var vouchRec = {};
     
      var vouch_tr_id =_this.attr("id");
      var vouch_kind = vouch_tr_id.substring(7, 8);
      var vouch_key = vouch_tr_id.substring(9);
      var img_path = _this.find("input[id^='TR_PATH']").val();
      var file_size = _this.find("input[id^='TR_FILE_SIZE']").val();
      var cloud_yn = _this.find("input[id^='CLOUD_YN']").val();
      var vouch_nm = "";
      if (vouch_kind == "3") {
	      vouch_nm = $(_this).find("input[id^=VOUCH_NM]").val();
      } else {
          vouch_nm =(vouch_kind=="1" ?  _this.find("td").eq(1).find("div.elipsis").attr("doc_no") :  _this.find("td").eq(1).find(".elipsis").text());
      }
      var vouch_new = _this.find("td").eq(3).find("input[name='VOUCH_RMK']").val();
      var vouch_rmk = "";
     
      var check =true;
      if(vouch_kind=="1"){//동일한 원안문서가 이미 있는지 체크
    	  $.each($("#VOUCH_THEAD").find("tr"), function(i,e){
    		  if(_this.index()==i || i==0){
    			  return true;
    		  }
    		  var item_vouch_kind =$(e).attr("id").substring(7, 8);
    		  var item_vouch_key =$(e).attr("id").substring(9);
    		  
    		  if(item_vouch_kind=="1" && vouch_key==item_vouch_key){//원안문서 이면서, 현재 저장하려고하는 문서랑 동일 건이면. 
    			  alert($.i18n.prop("msg194"));
    			  check =false;
    			  return false;
    		  }
    	  });
    	  
      }
      if(check===false){
    	  return;
      }
      
      
      vouch_rmk = vouch_new; 
      vouchRec["VOUCH_NM"] = vouch_nm;
      vouchRec["VOUCH_KIND"] = vouch_kind;
      vouchRec["CLOUD_YN"] = cloud_yn;
      if("Y" == cloud_yn){
            vouchRec["LNKD_KEY1"] = "0";
            vouchRec["RAND_KEY"] = vouch_key;
            vouchRec["IMG_PATH"] = img_path;
            vouchRec["FILE_SIZE"] = file_size;
      } else {
            vouchRec["LNKD_KEY1"] = vouch_key;
      }
      vouchRec["RMRK"] = vouch_rmk;
      vouchList[0] = vouchRec;
     
      var jexAjax = jex.createAjaxUtil("appr_c003"); 
      jexAjax.set("PTL_ID"                ,     g_ptl_id          );
      jexAjax.set("CHNL_ID"               ,     g_chnl_id         );
      jexAjax.set("USE_INTT_ID"           ,     g_use_intt_id     );
      jexAjax.set("VOUCH_REC"             ,     vouchList         );
      jexAjax.set("USER_ID"               ,     g_user_id         );
      jexAjax.set("USER_NM"               ,     g_user_nm         );
      jexAjax.set("APPR_SEQ_NO"           , g_appr_seq_no);
      jexAjax.set("PAPER_SEQ_NO"           , g_paper_seq_no);
      jexAjax.set("GB"               	  , "C"   );// 첨부파일 등록('C'), 첨부파일 삭제 ('D') 
      //console.log(g_draft_user_id);
      //console.log( $("#DOC_NO").val()    );
      jexAjax.set("DRAFT_USER_ID"        ,     g_draft_user_id         );
      jexAjax.set("DOC_NO"               ,     $("#DOC_NO").text()         );
      jexAjax.execute(function(dat){
            if(!jex.isError(dat)){
            	var vouch_seq_no=dat.ADD_REC[0].VOUCH_SEQ_NO;
            	$(_this).attr("vouch_seq_no",vouch_seq_no);
                alert(jex.getMsg($.i18n.prop("msg109")));//저장되었습니다.
           
                $(_this).find(".fileClass").remove(); // 저장이 되고 나서는 저장, 취소버튼 없애줌.
                if($(_this).find("input[name='VOUCH_RMK']").val() !=""){
                      var rmk = $(_this).find("input[name='VOUCH_RMK']").val();
                      $(_this).find("input[name='VOUCH_RMK']").parent().text(rmk);
                     
                      $(_this).find("input[name='VOUCH_RMK']").remove();
                     
                }
                else{
                      $(_this).find("input[name='VOUCH_RMK']").css("display","none");//비고 input box 도 없애줌.
                }
                try{
                	
                	if($("#ATCH_DEL_USE_YN").val()=="Y" && ($("#MNGR_MNU_OPEN_YN").val()=="Y" ||  parent.opener.document.location.href.indexOf("appr_list_0013")>-1)){
	              		var deleteHtml ="<a href='javascript:' onclick=\"fn_realVouchDel(this);\" class='atchDel'><img src='/img/ico/ico_delete.gif' alt='"+$.i18n.prop("msg77")+"'></a>"
	              		$(_this).find("td:last").find("div").append(deleteHtml);
                    }
                	
                	if (vouch_kind == "2") {
	                	var openImgHtml = '<span class="imgViewing" onclick="openImg(this);" style="float:right" url="'+img_path+'" down="true">▼</span>';
	                	$(_this).find("td:last").find("div").append(openImgHtml);
	                	if ($("#fileAttchPrint").find(".f_right").css("display") == "none") {
	                		$("#fileAttchPrint").find(".f_right").show();
	                	}
                	}
	            }catch(e){}
                
                
            }
      });  
}
/**
* 결재요청 함수
* Appr Request Function
* @return
  */
  function fn_saveAppr(data){
  try {
  if (!isReadyForAppr) {
  return false;
  }
  isReadyForAppr = false;

  	try {
  		var imgList = CrossEditor.GetBodyElementsByTagName("img");
  		var editorImgVolume = 0;
  		for (var i=0; i<imgList.length; i++) {
  			var encodedSrc = imgList[i].src.split("base64,")[1];
  			var decodedSrc = atob(encodedSrc);
  			editorImgVolume += decodedSrc.length;
  		}
  		if (editorImgVolume > 10000000) {
  			alert("에디터 내의 이미지는 10Mb로 제한됩니다.\n이미지의 총용량을 줄이고 다시 시도해 주시기 바랍니다.");
  			isReadyForAppr = true;
  			return false;
  		}
  	} catch (e) {}
  	
      if ("1" == g_paper_kind) {
    	  fn_getAtchEdit();
    	  if (editorGb == "cross") {
  	      //2025.01.08 구글 스프레드시트 복사 시 표의 사이즈가 달라지는 문제 발생하여 주석 처리
  		  //이 코드를 빼면 중앙정렬 후 스페이스바로 우측으로 붙이면 조회 화면에서 해당 값이 셀 옆으로 밀림
    		  fn_setTableLayout();
  		  fn_setUlLayout();
    	  }
      }
      
      var vouchRec = null;
      vouchList = [];
      var o_vouch_table = $("#R_TABLE #VOUCH_THEAD tr");
      var vouch_len = o_vouch_table.length; // 헤더제외
     
      var i_vouch = 0;
      var o_th = 1;           
      var o_th_cnt = 0;
      var eq_idx = 1;
      var flag = false;
      
      for(var i=1; i<vouch_len; i++){
            vouchRec = {};
            $o_vouch_tr = $(o_vouch_table).eq(i);
            var vouch_tr_id = $o_vouch_tr.attr("id");
            var vouch_kind = vouch_tr_id.substring(7, 8);
            var vouch_key = vouch_tr_id.substring(9);
  		var vouch_new = $o_vouch_tr.find("td").eq(3).find("input[name='VOUCH_RMK']").val();
          var vouch_rmk = "";
  		vouch_rmk = vouch_new; 
  		if ("3" === vouch_kind) {
  			vouchRec["VOUCH_NM"] = $o_vouch_tr.find("input[id^=VOUCH_NM]").val();
              vouchRec["VOUCH_KIND"] = vouch_kind;
  			vouchRec["LNKD_KEY1"] = vouch_key; //url
  			vouchRec["RMRK"] = vouch_rmk;      //비고
  		} else {
              var img_path = $o_vouch_tr.find("input[id^='TR_PATH']").val();
              var file_size = $o_vouch_tr.find("input[id^='TR_FILE_SIZE']").val();
              var cloud_yn = $o_vouch_tr.find("input[id^='CLOUD_YN']").val();
              //var vouch_nm = $o_vouch_tr.find("td").eq(1).text();
              var vouch_nm =(vouch_kind=="1" ?  $o_vouch_tr.find("td").eq(1).find("div.elipsis").attr("doc_no") :  $o_vouch_tr.find("td").eq(1).find(".elipsis").text());
              vouchRec["VOUCH_NM"] = vouch_nm;
              vouchRec["VOUCH_KIND"] = vouch_kind;
              vouchRec["CLOUD_YN"] = cloud_yn;
              if("Y" == cloud_yn){
                    vouchRec["LNKD_KEY1"] = "0";
                    vouchRec["RAND_KEY"] = vouch_key;
                    vouchRec["IMG_PATH"] = img_path;
                    vouchRec["FILE_SIZE"] = file_size;
              } else {
                    vouchRec["LNKD_KEY1"] = vouch_key;
              }
              vouchRec["RMRK"] = vouch_rmk;
  		}
            vouchList[i_vouch] = vouchRec;
            i_vouch++;
      }
     
      var itemRec = null;
      var itemList = [];
     
      if (g_paper_kind == "3") {
           
            // 양식내에 항목이 순서대로 있지 않을수도 있으므로 정렬한다.
            var usr_items = $('[usr_item_ord]');
           
            usr_items.sort(function(a,b) {
                a = parseInt($(a).attr("usr_item_ord"), 10);
                b = parseInt($(b).attr("usr_item_ord"), 10);
                if(a > b) {
                    return 1;
                } else if(a < b) {
                    return -1;
                } else {
                    return 0;
                }            
            });
           
            usr_items.each(function(i,e){
                  itemRec = {};
                  var ord = $(e).attr('usr_item_ord');
                  var attr = $(e).attr('usr_attr');
                
                  var item_lnkd1 = "";
                  var item_lnkd2 = "";
                  var item_lnkd3 = null;
                 
                  if ("3" == attr) {                        // 기간
                        item_lnkd1 = $(e).find("input[name='START_SELECT_DATE']").val().replace(/-/g, '');
                        item_lnkd2 = $(e).find("input[name='END_SELECT_DATE']").val().replace(/-/g, '');
                  } else if ("4" == attr) {           // 일자
                        item_lnkd1 = $(e).find("input[name='SELECT_DATE']").val().replace(/-/g, '');
                  } else if ("7" == attr) {           // 사용기간(시분)
                        var item_lnkd1_t = $(e).find("#START_SELECT_TIME").val();
                        var item_lnkd1_m = $(e).find("#START_SELECT_MIN").val();
                        var item_lnkd2_t = $(e).find("#END_SELECT_TIME").val();
                        var item_lnkd2_m = $(e).find("#END_SELECT_MIN").val();                  
                        item_lnkd1 = item_lnkd1_t + item_lnkd1_m;
                        item_lnkd2 = item_lnkd2_t + item_lnkd2_m;                                          
                  } else if ("8" == attr) {           // 사용자정의
                        item_lnkd1 = $(e).find("input[name^='USER_DEFINE_ATTR']:checked").val();
                  } else if ("10" == attr) {           //선택박스 (2018.09.17 배유연 추가)
                        item_lnkd1 = $(e).find("select[name^='SELECT_BOX']").val();
                  }  
                  else if ("11" == attr) {           //체크박스 (2018.09.17 배유연 추가)
                	  var arr ="";
                      //item_lnkd1 = $(e).find("input[name^='CHECK_BOX']").val();
                	  $.each($(e).find("input[name^='CHECK_BOX']"), function(j,g){
                		 
                		  if($(this).attr("checked")=="checked"){
                			  //arr.push($(g).val());
                			  arr += $(g).val()+"^";
                		  }
                		 
                	  });
                	  arr = arr.substring(0,arr.length-1);
                	  item_lnkd1 =arr;
                    if($(e).parent().hasClass("hhalf")){
                    	  if($(e).find("input[name^='CHECK_BOX']").attr("checked")=="checked"){
                    		  item_lnkd1="Y";
                    	  }else{
                    		  item_lnkd1="N";
                    	  }
                    }
                	}else if("13" ==attr){//2019.08.06 휴가기간 목록 
                		var s_date="";
                		var e_date="";
                		var item9="";// 일자등록여부는 하나의 tr이 아니라 예외처리
  					if ($("input[name=USER_DEFINE_ATTR_3]:checked").val() === "N") {
  						var canIsSeq = cnts_Null2Void($("#CAN_IS_SEQ").val()); //휴가취소 키
  						item_lnkd3 = canIsSeq;
  					}
  					
                		if($("#VC_DATE_LST").parent().find("p").eq(0).attr("btnopt")=="range"){
  	              		ord="1"
  	              		item9="1";
  	     				 	
  	     				 	$.each($("#VC_DATE_LST").parent().find("p").text().split("~"), function(j, k){
  	     				 		if(j==0){
  		       				 		s_date = k.replaceAll(" ","");
  		       						s_date = s_date.replaceAll("-","");
  		       						s_date = s_date.substring(0,8);
  	     				 		}
  	     				 		if(j==$("#VC_DATE_LST").parent().find("p").text().split("~").length-1){
  		       						e_date = k.replaceAll(" ","");
  		       						e_date = e_date.replaceAll("-","");
  		       						e_date = e_date.substring(0,8);
  	     				 		}
  	     				 	});
  	     				 	
  	       				item_lnkd1=s_date;
  	       				item_lnkd2=e_date;
  	       				itemRec["ITEM_SEQ_NO"]="8";
  	                	itemRec["ITVL_1"]="";
  	                	itemRec["ITVL_2"]="";
  	                	itemList.push(itemRec);
  	                	itemRec = {};
  	              	}else{
  	              		$.each($("#VC_DATE_LST").parent().find("p"), function(j,k){
  	              			
  	              			var date = jex.null2Void($(k).text(),"").replaceAll("-","").replaceAll(" ","");
  	              			
  	              			date = date.substring(0,8);
  	              		
  	              			if(j==0){
  	              				s_date=date;
  	              			}
  	              			if(j == $("#VC_DATE_LST").parent().find("p").length -1){
  	              				item_lnkd1 += date;
  	              				e_date=date;
  	              			}else{
  	              				item_lnkd1 += date+",";
  	              			}
  	              			
  	              		});
  	              		item9="2";
  	              		itemRec["ITEM_SEQ_NO"]="1";
  	                  	itemRec["ITVL_1"]=s_date;
  	                  	itemRec["ITVL_2"]=e_date;
  	                  	itemList.push(itemRec);
  	                  	itemRec = {};
  	              	}
  	              	itemRec["ITEM_SEQ_NO"]="9";
  	              	itemRec["ITVL_1"]=item9;
  	              	itemRec["ITVL_2"]="";
  	              	itemList.push(itemRec);
  	              	itemRec = {};
                	}else if( $("#PAPER_PATH").val().indexOf('insa_03')>=0 && "1" ==attr){//2020.02.24 배유연 추가 : 금액 항목 콤마 제거
                
                		item_lnkd1 = $(e).find("*[name='TEXT']").val().replace(/,/g, '');
                	}else {
                      item_lnkd1 = $(e).find("*[name='TEXT']").val();

                      // 휴가신청서이면서 취소 신청일경우는 무조건 음수로 들어가게.
                      if(g_paper_kind=="3" && $("#PAPER_PATH").val().indexOf('insa_01')>=0){
                    	 if(ord=="2" && $("input[name='USER_DEFINE_ATTR_3']:checked").val() == "N"){//일수면서 취소신청일경우
                    		
                    		  if(parseInt(item_lnkd1)>0){
                    			  item_lnkd1= "-"+item_lnkd1;
                    			
                    		  }
                    	  }
                      }
  	             } 
  	             itemRec["ITEM_SEQ_NO"] = ord;
  	             itemRec["ITVL_1"] = item_lnkd1;
  	             itemRec["ITVL_2"] = item_lnkd2;
  	             itemRec["ITVL_3"] = item_lnkd3;
  	             itemList.push(itemRec);
              });        
           
      } else {
            var o_item_table = $("#C_TBL #C_TBODY tr");            
            
            for(var i=0; i<g_paper_item_len; i++){
                  itemRec = {};
                  var item_key;
                  var item_lnkd1 = "";
                  var item_lnkd2 = "";
                  var item_lnkd3 = null;
                  var item_lnkd4 = null;
                                    
                  if(i==0){ eq_idx = 1; }
                  else if(flag){ eq_idx = o_th; }
                  else if(!flag){ eq_idx = o_th + 1; }
                         
                  if($(o_item_table).eq(eq_idx).find("td").length == 1){
                	  o_th = eq_idx;
                	  o_th_cnt = 0;
                  }else{         
                	  if(flag){                		  
                		  o_th_cnt = 1;
                		  flag = false;
                	  }else{         
                		  if(i!==0){o_th = o_th + 1;}
                		  o_th_cnt = 0;
                		  flag = true;
                	  }
                  }                       
                  
                  item_key = $(o_item_table).eq(eq_idx).find("th").eq(o_th_cnt).attr("usr-attr");  // th=item_seq_ td=input_type
                  o_item_value = $(o_item_table).eq(eq_idx).find("td").eq(o_th_cnt);
            
                  var s_input_type = $(o_item_value).attr("usr-attr");
                  if("3" == s_input_type){
                        item_lnkd1 = $(o_item_value).find(".START_SELECT_DATE").val();
                        item_lnkd2 = $(o_item_value).find(".END_SELECT_DATE").val();
                        item_lnkd3 = $(o_item_value).find(".START_SELECT_TIME").val();
                        item_lnkd4 = $(o_item_value).find(".END_SELECT_TIME").val();
                       
                  } else if("4" == s_input_type){
                        item_lnkd1 = $(o_item_value).find("[class^='SELECT_DATE']").val();
                        if(item_lnkd1 ==""){
                              item_lnkd1 = $(o_item_value).find("[id^='SELECT_DATE']").val()
                        }
                  } else if("7" == s_input_type){
                        item_lnkd1_t = $(o_item_value).find("#START_SELECT_TIME").val();
                        item_lnkd1_m = $(o_item_value).find("#START_SELECT_MIN").val();
                        item_lnkd2_t = $(o_item_value).find("#END_SELECT_TIME").val();
                        item_lnkd2_m = $(o_item_value).find("#END_SELECT_MIN").val();
                       
                        item_lnkd1 = item_lnkd1_t + item_lnkd1_m;
                        item_lnkd2 = item_lnkd2_t + item_lnkd2_m;
                  }else if ("8" == s_input_type) {           //라디오버튼 //여기부터 내일 다시 (값 넣는거부터 )
                        item_lnkd1 = $(o_item_value).find("input[type=radio]:checked").val();
               
                  } else if ("10" == s_input_type) {           //선택박스 (2018.09.17 배유연 추가)
                        item_lnkd1 = $(o_item_value).find("select").val();
                                               
                  }else if ("11" == s_input_type) {           //체크박스 (2018.09.17 배유연 추가)
                	  
                	  var arr ="";
                      //item_lnkd1 = $(e).find("input[name^='CHECK_BOX']").val();
                	  $.each($(o_item_value).find("input[type=checkbox]"), function(j,g){
                		  if($(this).attr("checked")=="checked"){
                			  //arr.push($(g).val());
                			  arr += $(g).val()+"^";
                		  }
                	  });
                	  arr = arr.substring(0,arr.length-1);
                	  item_lnkd1 =arr;
                	  
                  }else if ("12" == s_input_type) {           //직원항목추가
                	
                	  var jsonArr=[];
                	  $.each($(o_item_value).find(".name_cmb_multi_box").find("p"), function(i,e){
                		 var jsonData={};
                		 jsonData["KEY"] = $(e).attr("key");
                		 jsonData["VALUE"] = $(e).attr("data");
                		 jsonArr.push(jsonData);
                	  });
                	  item_lnkd1=encodeURIComponent(JSON.stringify(jsonArr));
                	  
                  }else if ("14" == s_input_type || "15" == s_input_type) {
  				//직원항목추가 (거래처)
                	
                	  var jsonArr=[];
                	  $.each($(o_item_value).find(".name_cmb_multi_box").find("p"), function(i,e){
                		 var jsonData={};
                		 jsonData["KEY"] = $(e).attr("key");
                		 jsonData["VALUE"] = $(e).attr("data");
               
                		 jsonArr.push(jsonData);
                	  });
                	  item_lnkd1=encodeURIComponent(JSON.stringify(jsonArr));
                                             
                  }else if ("16" == s_input_type || "17" == s_input_type) {    //사용금액, 신청금액 총합계
                	  item_lnkd1 = $(o_item_value).find("span").text().replace(/,/g, '');
                  }else if ("19" == s_input_type || "22" == s_input_type) {    //hbiz 통합예약번호, bzp 스케줄 번호
                	  item_lnkd1 = cnts_Null2Void($(o_item_value).find("div[name^=ITNM_"+s_input_type+"] p").text());
                  } else if (["20","21","23"].indexOf(s_input_type) > -1) {
         			  //직원항목추가 (예산부서, 용도)
                	  var encodedJson = $(o_item_value).find(".name_cmb_multi_box").find("p").attr("data");
                	  item_lnkd1 = encodedJson;
                  }else {
                	  	// 긴텍스트인 경우
                	  	if("9" == s_input_type){
                	  		item_lnkd1 = $(o_item_value).find("[name^='TXT_ITNM']").val()
                	  	}
                	  	else{
                	  		item_lnkd1 = $(o_item_value).find("input[name^='TXT_ITNM']").val();
                	  	}	  
                  }

  				if ("18" != s_input_type) {
         			  //에디터 항목 제외
  	                itemRec["ITEM_SEQ_NO"] = item_key;
  	                itemRec["ITVL_1"] = item_lnkd1;
  	                itemRec["ITVL_2"] = item_lnkd2;
  	                itemRec["ITVL_3"] = item_lnkd3;
  	                itemRec["ITVL_4"] = item_lnkd4;
  	                //itemList[i] = itemRec;
  					itemList.push(itemRec);
                  }
            }   

  		var o_editor_items = $("#EDITOR_TYPE_BOX_C").find("div[id^=ITNM_18_]");
            
            for(var i=0; i<o_editor_items.length; i++){
  			itemRec = {};
  			var item_lnkd1 = "";
  			var o_item = o_editor_items.eq(i);
  			var item_key = o_item.attr("id").split("ITNM_18_")[1];
  			item_lnkd1 = o_item.html();
  			itemRec["ITEM_SEQ_NO"] = item_key;
                itemRec["ITVL_1"] = item_lnkd1;
  			itemList.push(itemRec);
  		}
           
      }
      var stsRec = {};
      if(null != data)
            stsRec = decodeURIComponent(data.JSONDATA);
      var jexAjax = jex.createAjaxUtil("appr_c002"); 
      jexAjax.set("API_YN"                ,     "Y"                                                         );

      jexAjax.set("APPR_SEQ_NO"           ,     g_appr_seq_no                                               );
     
      jexAjax.set("PTL_ID"                ,     g_ptl_id                                                    );
      jexAjax.set("CHNL_ID"               ,     g_chnl_id                                                   );
      jexAjax.set("USE_INTT_ID"           ,     g_use_intt_id                                               );
      jexAjax.set("DRAFT_USER_ID"         ,     g_user_id                                                   );
      jexAjax.set("DRAFT_USER_NM"         ,     g_user_nm                                                   );
      
      jexAjax.set("DRAFT_USER_POS_NM"     ,     g_pos_nm                                                    );
      jexAjax.set("DRAFT_USER_DEPT_CD",   g_dept_cd                                                   );
      jexAjax.set("DRAFT_USER_DEPT_NM",   g_dept_nm                                                   );
      jexAjax.set("PAPER_SEQ_NO"          ,     g_paper_seq_no                                              );
      jexAjax.set("APPR_SUBJ"             ,       $("table#C_TBL").find("#APPR_SUBJ").val() );
      
      //2019.03.05 배유연 추가 : 의견 RECORD 생성
      var opinionRecs=[];
      if(jex.null2Void($("#DRAFT_OPINION_VALUE").val(),"") !=""){
    	  var opinionRec={};
    	  opinionRec["OPINION_GB"]="1";//1: 기안자의견
    	  opinionRec["OPINION_USER_ID"]=g_user_id;
    	  opinionRec["OPINION"]=$("#DRAFT_OPINION_VALUE").val();
    	  opinionRec["INSTANT_YN"]="N";
    	  opinionRec["SECRET_YN"]="N";
    	  opinionRecs.push(opinionRec);
      }
      if(jex.null2Void($("#INSTANT_OPINION_VALUE").val(),"") !=""){
    	  var opinionRec={};
    	  opinionRec["OPINION_GB"]="1";//1: 기안자의견
    	  opinionRec["OPINION_USER_ID"]=g_user_id;
    	  opinionRec["OPINION"]=$("#INSTANT_OPINION_VALUE").val();
    	  opinionRec["INSTANT_YN"]="Y";
    	  opinionRec["SECRET_YN"]="N";
    	  opinionRecs.push(opinionRec);
      }
      if(jex.null2Void($("#SECRET_OPINION_VALUE").val(),"") !=""){
    	  var opinionRec={};
    	  opinionRec["OPINION_GB"]="1";//1: 기안자의견
    	  opinionRec["OPINION_USER_ID"]=g_user_id;
    	  opinionRec["OPINION"]=$("#SECRET_OPINION_VALUE").val();
    	  opinionRec["INSTANT_YN"]="N";
    	  opinionRec["SECRET_YN"]="Y";
    	  opinionRecs.push(opinionRec);
      }
      jexAjax.set("APPR_OPINION_REC"             ,  opinionRecs    );
      if(g_paper_path == "cust_99_UTLZ_1808301082871.jsp" || g_paper_path == "cust_99_UTLZ_1808301082871_2.jsp"){
    	  //이문서는 제목에 양식지 명이 들어감
    	  jexAjax.set("APPR_SUBJ"             ,g_paper_nm);
      }
      if ("1" == g_paper_kind)
    	  if (editorGb == "daum") 
    		  jexAjax.set("APPR_CONT"             ,       Editor.getContent()           );
    	  else if (editorGb == "cross")
    		  jexAjax.set("APPR_CONT"             ,       CrossEditor.GetBodyValue()           );
      if ("4" == g_paper_kind && $("#PAPER_CATE").val() == "500"){
    	  jexAjax.set("APPR_CONT"             ,   $("#prior_div").html()    );
    	  jexAjax.set("APPR_PRIOR_GB"             ,   "Y"   );
    	  var priorRECS = [];
    	  
    	  var req_amt=0;
    	  var use_amt=0;
    	  
    	  if($("#noPriorData").css("display") == "table-row"){
    		  alert($.i18n.prop("msg79"));//경비 항목을 1개 이상 등록해야 합니다.
    		  return false;
    	  }
    	
    	 $("#apprPriorData tr").each(function(i,e){
    		 if($(this).attr("id") == "noPriorData")
    			return true;
    		 if($(this).hasClass("th"))
    		 	return true;
    		 
    		 var priorREC ={};
    	
    		 priorREC["PRE_SEQ"]=$(this).find(".pre_seq").attr("data");
    		 priorREC["USER_ID"]=g_user_id;
    		 
    		 req_amt += parseInt($(this).find(".req_amt").text().replace(/,/g, ''));
    		
    		 
    		 priorRECS.push(priorREC);
    			 
    	 });
    	 jexAjax.set("REQ_AMT"             ,   req_amt   );
    	 jexAjax.set("USE_AMT"             ,   use_amt   );
    	 jexAjax.set("PRIOR_REC"             ,   priorRECS   );
    	 
      }
    	 
      if ("-1" == g_rps_paper_cd)
            jexAjax.set("APPR_CONT"       , g_user_appr_cont                                        );
      jexAjax.set("DOC_GB_CD"             , $("input[name='raoDocType']:checked").val()     );
      jexAjax.set("PROC_GB"               , s_proc_gb                                                       );
      jexAjax.set("ERP_SEQ_NO"            , $("#frm_appr_dtl_0005").find("#ERP_SEQ_NO").val());
      jexAjax.set("VOUCH_REC"             , vouchList                                                       );
      jexAjax.set("ITEM_REC"              , itemList                                                        );
      jexAjax.set("STS_REC"               , jQuery.parseJSON(stsRec)                                    );
      
      jexAjax.set("EDITOR_ATCH_SRNO"      , g_editor_atch_srno                                        );
      jexAjax.set("PRE_APPR_SEQ_NO", $("#PRE_APPR_SEQ_NO").val()); //공통부로 2020.10.14
      jexAjax.set("APPR_MODE", $("#APPR_MODE").val()); //재기안이면 RE
      /* 출장계획/정산/명령/보고 */
      var tripArr = ['600','601','602','603','604','605'];
      
      if (tripArr.indexOf($("#PAPER_CATE").val())!=-1){
    	  
          jexAjax.set("APPR_TRIP_GB"  , "Y");
    	    jexAjax.set("TRIP_REC"      , fn_saveAppr_trip_rec());
    	    jexAjax.set("TRIP_EMP_REC"  , fn_saveAppr_emp_rec());
    	    jexAjax.set("REF_APPR_REC"  , fn_saveAppr_ref_rec());
    	 
  	    jexAjax.set("BIZ_CD"         , jex.null2Void($("#BIZ_NO").val(),"")); // 사업자번호
    	  
    	    if( $("#PAPER_CATE").val() == "601"){
    	  	  //jexAjax.set("TRAN_KIND_REC", fn_docuAddYn());
          	  jexAjax.set("APPR_CONT",		fn_saveAppr_trip_calcul_json());
          	  jexAjax.set("CD_RCPT_REC",	fn_saveAppr_trip_rcpt_rec());
            	  jexAjax.set("APPR_USER_REC",	jQuery.parseJSON(stsRec));
    	    }
    	    else if($("#PAPER_CATE").val() == "602"){
    	  	  jexAjax.set("APPR_CONT"    , fn_saveAppr_trip_order_json());
    	  	  jexAjax.set("APPR_USER_REC", jQuery.parseJSON(stsRec));
    	    }
    	    else if($("#PAPER_CATE").val() == "603"){
    	  	  jexAjax.set("APPR_CONT",		fn_saveAppr_trip_report_json());
    	  	  jexAjax.set("APPR_USER_REC",	jQuery.parseJSON(stsRec));
    	    }
    	    else if($("#PAPER_CATE").val() == "604"){
    	  	  jexAjax.set("APPR_CONT",		fn_saveAppr_trip_hbiz_json());
    	    }
    	    else if($("#PAPER_CATE").val() == "605"){
    	  	  jexAjax.set("APPR_CONT",		fn_saveAppr_trip_hbiz_json());
    	    }
      }
      /* 통합경비지출 , 지출결의*/
      if ($("#PAPER_CATE").val() == "700" || $("#PAPER_CATE").val() == "901"){
    	  jexAjax.set("BIZ_CD",		jex.null2Void($("#BIZ_NO").val(),"")); // 사업자번호
    	  jexAjax.set("USER_ID",	g_user_id);
    	  
    	  jexAjax.set("APPR_CONT",		fn_saveAppr_expense_json()); // 증빙내역 json
    	  jexAjax.set("CD_RCPT_REC",	fn_saveAppr_expense_rcpt_rec()); // 영수증 내역
    	  jexAjax.set("TAX_REC_JSON",	fn_saveAppr_expense_tax_rec()); // 계산서 내역
    	  jexAjax.set("APPR_USER_REC",	jQuery.parseJSON(stsRec)); // 사용자 정보
      }
      
      /* 예산관리 pro 용 결재요청 데이터*/ //2020.09.22 예산관리 pro 추가
      if ($("#PAPER_CATE").val() == "800" || $("#PAPER_CATE").val() == "801"){
    	  jexAjax.set("BIZ_CD",		jex.null2Void($("#BIZ_NO").val(),"")); // 사업자번호
    	  jexAjax.set("APPR_SQNO",	$("#APPR_SQNO").val());
    	  if (editorGb == "daum") 
    		  jexAjax.set("APPR_CONT",	Editor.getContent() );
    	  else if (editorGb == "cross")
    		  jexAjax.set("APPR_CONT",	CrossEditor.GetBodyValue() );
      }
  	/*휴가신청서 취소신청*/
  	if ("3" === g_paper_kind && $("#PAPER_PATH").val().indexOf("insa_01") > -1
  			&& $("input[name=USER_DEFINE_ATTR_3]:checked").val() === "N") {
  		jexAjax.set("CAN_IS_SEQ", cnts_Null2Void($("#CAN_IS_SEQ").val()));
  	}

      jexAjax.set("_LODING_BAR_YN_" , "Y");

  //    jexAjax.setAsync(false);
  jexAjax.setErrFn(function(dat) {
  isReadyForAppr = true;
  var loading = jex.plugin.get("JEX_LODING");
  if (loading)
  loading.stop();        
  if (dat.status == "400")
  alert("등록처리중 오류가 발생하였습니다.\n 결재문서 내용에 개인정보와 같은 부적합한 내용을 포함하고 있을 수 있습니다.");
  else
  alert($.i18n.prop("msg111"));//오류
  });
  jexAjax.execute(function(dat){
  isReadyForAppr = true;

            if(!jex.isError(dat)){
                  
            	if(s_proc_gb =="1" && $("#DRAFT_OPINION_VALUE").val() !=""){//임시저장일경우
            		alert($.i18n.prop("msg185")+"\n"+$.i18n.prop("M0000"));	
            	}else{
            		alert($.i18n.prop("M0000"));	
            	}
            	
                  if($("#PARENT_URL").val().indexOf("appr_list_0007")>= 0){// my기안문서이면
                	  opener.location.href = "javascript:fn_getMyApprSrc()";
                	// self.close(); //기존
                  }
                  // 2019.03.08_이현수 : 출장정산서 기타영수증 삭제 여부
                  if($("#PAPER_CATE").val() == "601"){
                  	  $("#AFTER_SAVE_YN").val("Y");
            	  }
                  
                  //2020.10.14 배유연 : 예산PRO 문서 저장시 추가요청
                  if($("#PAPER_CATE").val() == "800" || $("#PAPER_CATE").val() == "801"){
                	  window.opener.postMessage("reload", $("#BUDGET_API_URL").val()); 
                  }

  			  //2022.02.03 진호용 : 임시저장함 리로드
                  if(cnts_Null2Void($("#PRE_APPR_SEQ_NO").val(),"") != ""){
                	  try {
  					  window.opener.fn_appr_r008();
  					  reloadTmpList();
  				  } catch(e) {
  					//cross-origin(전자결재 아니면)
  				  } 
                  }

                  self.close(); //기존
                 
            }
      }); 
  } catch (e) {
  console.log(e);
  isReadyForAppr = true;
  }
  }
  /**
* 저장시 에디터내 첨부파일 태그 저장
* @return
  */
  function fn_getAtchEdit(){
  var panel;
  var paras;
  if (editorGb == "daum") {
  panel = Editor.getCanvas().getPanel("html");
  paras = panel.getDocument().getElementsByTagName("img");
  } else if (editorGb == "cross") {
  //panel = $("#NamoSE_Ifr__pe_aWs").contents().find("iframe[id=NamoSE_editorframe_pe_aWs]");
  //paras = panel.contents().get(0).getElementsByTagName("img");
  paras = CrossEditor.GetBodyElementsByTagName("img");
  }
  var editorRandKey = "";
  g_editor_atch_srno = "";
  for(var i=0; i<paras.length; i++){
  if("" != $.trim(paras[i].getAttribute('editor'))){               
  // 신규 IMG일때만 저장
  if(Number(paras[i].getAttribute("src").indexOf("http")) < 0){
  editorRandKey += paras[i].getAttribute('editor') + ":" + paras[i].getAttribute('rankey') + ",";
  }                
  // 위클라우드 사용일 때
  if("" != $.trim(paras[i].getAttribute("rankey"))){
  editorRandKey += paras[i].getAttribute('editor') + ":" + paras[i].getAttribute('rankey') + ",";
  }
  }
  }
  editorRandKey = editorRandKey.substring(0, editorRandKey.length-1);
  g_editor_atch_srno = editorRandKey;
  }
  function showImg(seq_no,url)
  {

  /*var imgList = [];
  imgList.push({imgUrl : g_rcpt_rec[j].LINK_URL,imgNm:"이미지1"});
  imgList.push({imgUrl : "https://platform-dev.bizplay.co.kr/wecloud3/20200406_a910ff07-ab6b-4e2f-b046-c05b29642c00_thum_500x500.png",imgNm:"이미지2"});

  bizjs.imgviewer.open({
  img       : imgList
  , bbUpload  : "Y"
  , zoomInOut : "3"
  , downBtn   : ""
  , alldownBtn: ""
  });*/
  if (parent.location.href.indexOf("appr_dtl_0008") > -1) {
  parent.showImg(seq_no, url, g_rcpt_rec);
  } else {
  showImg0008(seq_no, url, g_rcpt_rec);
  }




/*   
fileDownCnt = g_rcpt_rec.length;
fileDownIdx = 0;
$("#boxImg"       ).find("img"        ).attr("src",g_rcpt_rec[0].LINK_URL);
$("#boxImgConf" ).find(".img_name").html("영수증"+(fileDownIdx+1));
$("#boxImgConf" ).find(".img_name").data("FILE_NM",g_rcpt_rec[0].LINK_URL);
if(fileDownCnt > 1){
$("#btnImgNext").removeClass("off");
$("#btnImgNext").addClass   ("on");
}
$("#fileArea").show();
*/

}

//2021.06.21 진호용 추가 : 결재예정문서 이미지 클릭 임시
function showImg0008(seq, url,g_rcpt_rec)
{

	var imgList = [];
	var count =2;
	imgList.push({imgUrl : url,imgNm:"img1"});

	if(g_rcpt_rec !=null){
		if($("#PAPER_SEQ_NO").val()=="101"){
			$.each(g_rcpt_rec, function(i,e){
				if(cnts_Null2Void(e.SEQ_NO,"")==seq && cnts_Null2Void(e.LINK_URL,"")!=url){//2021.01.28 SEQ_NO(RESOLLIST_SEQ_NO) 경비관리는 해당값으로 사용함
					 imgList.push({imgUrl :e.LINK_URL,imgNm:"img"+count});
					 count++;
				}
			})
		}else{
			$.each(g_rcpt_rec, function(i,e){
				if(cnts_Null2Void(e.SEQ,"")==seq && cnts_Null2Void(e.LINK_URL,"")!=url){//2021.01.28 SEQ(APV_SEQ) 그 외 문서는 해당값으로 사용함.
					 imgList.push({imgUrl :e.LINK_URL,imgNm:"img"+count});
					 count++;
				}
			})
		}
		
		
	}
	
    
    bizjs.imgviewer.open({
            img       : imgList
          , bbUpload  : "Y"
          , zoomInOut : "3"
          , downBtn   : ""
          , alldownBtn: ""
    });


}
function showImg2(seq, url, img_rec)
{

	var imgList = [];
	var count = img_rec.length;
	img_rec = img_rec.replaceAll("+","%20");
	
	var img_rec_tmp = jQuery.parseJSON(decodeURIComponent(img_rec));

	if(img_rec_tmp !=null){
		if($("#PAPER_SEQ_NO").val()=="101"){
			$.each(img_rec_tmp, function(i,e){
				if(cnts_Null2Void(e.FILE_STRG_PATH,"")!==url){
					count--;
					imgList.push({imgUrl :e.FILE_STRG_PATH, imgNm:e.ORCP_FILE_NM, imgSeq:count});
				}
			})
		}else{
			$.each(img_rec_tmp, function(i,e){
				if(cnts_Null2Void(e.FILE_STRG_PATH,"")!==url){
					 count--;
					imgList.push({imgUrl :e.FILE_STRG_PATH, imgNm:e.ORCP_FILE_NM, imgSeq:count});
				}
			})
		}
		
	}
	
    
    bizjs.imgviewer.open({
            img       : imgList
          , bbUpload  : "Y"
          , zoomInOut : "3"
          , downBtn   : ""
          , alldownBtn: ""
    });
}

function setObserverIframe(iframeId) {
try {
var iframe = parent.document.getElementById(iframeId);
if (!iframe) return false;

		var innerDoc = iframe.contentDocument || iframe.contentWindow.document;
		if (!innerDoc) return false;
		
		var observer = new MutationObserver(function() {
			resizeIframe0005();
		});
		
		observer.observe(innerDoc.body, {
			childList: true,
			subtree: true
		});
	} catch(e) {
		console.log("setOvserverIframe error:", e);
	}
}
function fn_viewSummary(seq) {

      if ($.cookie("ppp_dtl_view_mode") == "SUMMARY") {
            $.cookie("ppp_dtl_view_mode", "TOTAL");
            $(".cardbill_wrap").css("display", "");
            $("#div_summary").css("display", "none");
            $("#div_summary2").css("display", "none");
            $("#SPAN_DETAIL").css("display", "");
            $("#btn_summary").text($.i18n.prop("msg113"));// 요약보기
            $("#SPAN_SUMMARY").hide();
            $("#SPAN_DETAIL").show();
            
           
      } else {
            $.cookie("ppp_dtl_view_mode", "SUMMARY");
            $(".cardbill_wrap").css("display", "none");
            $("#div_summary").css("display", "");
            $("#SPAN_DETAIL").css("display", "none");
            $("#btn_summary").text($.i18n.prop("msg156"));//전체보기
            $("#SPAN_SUMMARY").show();
            $("#SPAN_DETAIL").hide();
            if($("#summary_tran").is(':checked')){
            	$("#div_summary2").show();
            	$("#div_summary").hide();
            }else{
            	$("#div_summary2").hide();
            	$("#div_summary").show();
            }
      }
     
      $(".print_ss_head").css("display", "none");
      $("#ifrm_rel_print").contents().find(".view_cardbill").css("display","none");
      $("#ifrm_rel_print").contents().find(".view_cardbill").css("position","absolute");
      $("#ifrm_rel_print").contents().find(".thumb_bx").css("display","none");
     
      fn_printDetail();
      fn_printImage();//2019.02.12 배유연 추가: 첨부파일 보기 쿠키에서 가져오기

      	$("#ifrm_rel_print").contents().find(".cardbill_layout").each(function(i, e) {
            if (seq == (i+1)) {
				try {
					var container = (parent == null)
						? $('html, body') 
						: $(parent.document).find('html, body');
					
					$(e).prev().css("display", "block");
              
                  	$("#ifrm_rel_print").contents().find(".view_cardbill").css("display","block");
                  	$("#ifrm_rel_print").contents().find(".view_cardbill").css("position","static");
                  	$("#ifrm_rel_print").contents().find(".thumb_bx").css("display","block");
                 
                  	container.animate({
                  	    scrollTop: $(e).prev().offset().top
                  	}, 400);
				} catch(e) {console.log(e);}
              
				return false;
            }
      });


}
function autoResize(i, appr_bottom_yn) {

	if( $("#ifrm_rel").contents().find("body").children().length<1){
		return;
	}
	//2017.11.07 배유연추가 : 결재선 아래쪽에도 나오게하기.(연계문서일 경우)
	if (g_paper_seq_no == 101) {
        autoResize_101(i);
	}
	if(appr_bottom_yn=="Y" && g_sHtmlBRow !=""){
			if("101" == g_paper_seq_no){// 카드지출결의서
				//autoResize_101(i);
				$(".tbl_input2").eq(0).find("#APPR_SUBJ").parent().parent().after(g_sHtmlBottomLine);
				
				$(".tbl_input2").eq(0).find("#bDiv").append(g_sHtmlBRow);
				
				if("" != g_bottom_title) {
		          //  g_bottom_title = g_bottom_title.substring(0, g_bottom_title.length-1);
		            $(".tbl_input2").eq(0).find("#bThHeader").append($("<p>"+ g_bottom_title +"</p>"));
				}

				
			}
			if("111" ==g_paper_seq_no){ //매입세금계산 지출결의서
				var _this = $('#ifrm_rel').get(0).contentWindow.div_web;
	
				$(_this).find(".tbl_input2:eq(0)").find("tr:eq(0)").after(g_sHtmlBottomLine);
				//$(_this).find(".tbl_input2").find("#APPR_SUBJ").parent().parent().after(g_sHtmlBottomLine);
				$(_this).find(".tbl_input2:eq(0)").find("#bDiv").append(g_sHtmlBRow);
				
				if("" != g_bottom_title) {
  		          //  g_bottom_title = g_bottom_title.substring(0, g_bottom_title.length-1);
					$(_this).find(".tbl_input2:eq(0)").find("#bThHeader").append($("<p>"+ g_bottom_title +"</p>"));
				}
			}
		}
	
	
      /*if (g_paper_seq_no == 101)
           // autoResize_101(i);
      else {*/
	if (g_paper_seq_no != 101){
            if (g_appr_cont_use_yn == "Y") {
                  if (g_isFirst) {
                        $("#ifrm_rel").contents().find("#div_header").html($("#tempapprline")[0].outerHTML+$("#temptitle")[0].outerHTML+$("#tempdocinfo")[0].outerHTML);
                       
                        //2017.09.21 배유연 추가 :매입 div_file 에 우리꺼 붙여주기 //잠깐 빼놓기로함. 
                        //2018.04.05 배유연 수정 : 매입 다시 수정
                        if("111" ==g_paper_seq_no){
							  //우미건설은 첨부파일 영역이 없어서 $("#fileAttchPrint")[0].outerHTML 부분에서 오류가 발생한다.
							  try { $("#ifrm_rel").contents().find(".div_file").html($("#fileAttchPrint")[0].outerHTML); } catch(e) {}
                            //  $("#fileAttchPrint").css("display", "none");
                              $("#ifrm_rel").contents().find(".div_file").css("display","none");
                              var taxbill_count=0;
                              if(g_patial_taxbill_reject_yn=="N"){ //2019.06.18 배유연 추가 : 영수증 반려기능 사용업체만 보이게.
                            	  $("#ifrm_rel").contents().find(".btn_cancel").css("display","none");
                              }else{//g_patial_taxbill_reject_yn=='Y'  or 'A' 인경우
                            	  if(g_patial_taxbill_reject_yn=="A"){
                            		  $("#ifrm_rel").contents().find(".btn_cancel").css("display","none");
                            	  }
                            	  var taxbill_recs = jQuery.parseJSON(decodeURIComponent($("#TAXBILL_RECS").val()));
                            	  taxbill_count = taxbill_recs.length;
                            	
                            	  $.each(taxbill_recs, function(i,e){
                            		  if(jex.null2Void(e.STCL_YN,"")=="Y"){//결의취소건이면
                            			  $("#ifrm_rel").contents().find(".btn_cancel[rsolseq='"+e.RESOLLIST_SEQ_NO+"']").parent().parent().parent().find(".ly_res_bx").show();
                            			  taxbill_count--;
                            		  }
                            	  });
                            	
                              }
                              
                              //if($("#ifrm_rel").contents().find(".btn_cancel") !=null && $("#ifrm_rel").contents().find(".btn_cancel").length <2){
                              if(taxbill_count <2){// 계산서가 1개이면 반려버튼 삭제.
                            	  //console.log("여기들어옴");
                            	  $("#ifrm_rel").contents().find(".btn_cancel").css("display","none");
                              }
                            
                              if(g_taxbill_modify_yn=="Y"){
                            	  $("#ifrm_rel").contents().find(".btn_edit").css("display","");
                              }
                              
                              //2019.06.18 매입지출결의서-> 부분반려 버튼 이벤트
                              $("#ifrm_rel").contents().find(".btn_cancel").bind("click", function(){
                            	
                            	  if(confirm("계산서의 결의를 취소하시겠습니까?")){ // 기존 작성한 원안문서가 근기문서로 첨부됩니다. 첨부하시겠습니까?
                            		  var jexAjax = jex.createAjaxUtil("appr_partial_taxbill_reject_u001");
                            		  var _this = $(this);
                        		      jexAjax.set("PTL_ID"                , g_ptl_id);
                        		      jexAjax.set("CHNL_ID"               , g_chnl_id);
                        		      jexAjax.set("USE_INTT_ID"           , g_use_intt_id);
                        		      jexAjax.set("APPR_SEQ_NO"           , $(this).attr("apprseq"));
                        		      jexAjax.set("RESOLLIST_SEQ_NO"       , $(this).attr("rsolseq"));
                        		      jexAjax.set("PAPER_APPR_SEQ_NO"      ,g_appr_seq_no);
                        		      jexAjax.set("USER_ID"                , g_user_id);
                        		      jexAjax.set("PUB_DATE"               ,  $(this).parent().parent().find(".bul").text().split(" ")[1]);
                        		      jexAjax.set("PUB_COMPANY"            , $(this).parent().parent().find(".input_vbx_fixt2").text());
                        		      jexAjax.setAsync(false);
                        		      jexAjax.execute(function(dat){
                        		    	  
                        		    	  _this.parent().parent().parent().find(".ly_res_bx").show();
                        		    	  $("#frm_appr_dtl_0005").action="appr_dtl_0005.act";
                    		    		  $("#frm_appr_dtl_0005").find("#HEADER_HIDDEN").val("Y");
                    		    		  $("#frm_appr_dtl_0005").target = "_self";
                    		    		  $("#frm_appr_dtl_0005").submit();	
                        		    	  parent.fn_appr_opinion_r001();
                        		      });
                            		  
                            	  }
                              });
                              
                            //2019.06.18 매입지출결의서-> 부분반려 버튼 이벤트
                              $("#ifrm_rel").contents().find(".btn_edit").bind("click", function(){
                            	  fn_taxbillModify($(this).attr("issuid"),$(this).attr("apprseq"),$(this).attr("rsolseq"));
                              });
                            	  
                        }
                        
                       
                        $("#tempapprline").css("display", "none");
                        $("#temptitle").css("display", "none");
                        $("#tempdocinfo").css("display", "none");            
                        // WKHTMLTOPDF 변환을 위한 CSS 수정
                        $("#ifrm_rel").css("display", "");
                        $("#ifrm_rel").contents().find(".cardbill_box .right strong").css("letter-spacing", "0px");
                        
                        $("#ifrm_rel").contents().find(".cardbill_box .left li").css("letter-spacing", "0px");
                      
                        $("#ifrm_rel").contents().find(".cardtxt_tb th").css("width", "80px");               
                        $("#ifrm_rel").contents().find("#div_web").css("height", "auto");           
                        $("#ifrm_rel").contents().find("#div_web").removeClass("expreport_wrap");
                        $("#ifrm_rel").contents().find("textarea").each(function() {
                                this.style.height = "1px";
                                this.style.height = (this.scrollHeight-9)+"px";               
                                this.style.background = "#fff";
                        });
                        g_isFirst = false;
                  }
                 
                var iFrameID = document.getElementById('ifrm_rel');
                if(iFrameID) {
                      iFrameID.height = "";
                      g_ifrm_height = iFrameID.contentWindow.document.body.scrollHeight;
                      iFrameID.style.height =  "0";
                      iFrameID.style.height =  g_ifrm_height + "px";
                    
                }
            }
    }

	  
    if ("101" != g_paper_seq_no || g_rcpt_rec.length == 0) {
        setTimeout(function () {
            window.status = 'ready_to_print';        
        }, 500);
    }
   
    
    
    if (nonStopPrint == "P") {
        window.print();
        nonStopPrint ="";
    }    
    //사원번호표기되도록
    $("#ifrm_rel").contents().find("#draft_empl_no").text(g_draft_user_id_number);

	resizeIframe0005();
}
function autoResize_101(i)
{
if (g_appr_cont_use_yn == "Y") {
// WKHTMLTOPDF 변환을 위한 CSS 수정
$("#ifrm_rel").contents().find(".cardbill_box .right strong").css("letter-spacing", "0px");
$("#ifrm_rel").contents().find(".cardbill_box .left li").css("letter-spacing", "0px");
//$("#ifrm_rel").contents().find(".cardbill_box .left li").eq(0).css("letter-spacing", "-1px");
$("#ifrm_rel").contents().find(".cardtxt_tb th").css("letter-spacing", "0px");   // 박태혁 2019-01-25 수정               
$("#ifrm_rel").contents().find("#div_web").css("height", "auto");         
$("#ifrm_rel").contents().find("#div_web").removeClass("expreport_wrap");
//$("#ifrm_rel").contents().find(".cardbill_wrap").css("display", "none");

            //$("#ifrm_rel").contents().find("textarea").css("overflow", "visible");
            $("#ifrm_rel").contents().find("textarea").each(function() {
                this.style.height = "1px";
				var tmpH = 14;
				if ((this.scrollHeight-9) > 14) {
					tmpH = this.scrollHeight-9;
				}
                this.style.height = tmpH+"px";                  
                this.style.background = "#fff";
            });

            // URL 자동링크 생성
            var appr_cont = $("#ifrm_rel").contents().find("#APPR_CONT").find("pre").html();            
            if (appr_cont != null)
            	appr_cont = appr_cont.autoLink(); 
            $("#ifrm_rel").contents().find("#APPR_CONT").find("pre").html(appr_cont);
           
            /*var strControl = "<div style='position:absolute;top:-5px;right:0;' class='no-print'> " ;
            strControl    += "    <span class='print_ss_txt'><label><input type='checkbox' id='printDetail' onclick='fn_printDetail()'> 영수증펼치기</label>";
            strControl    += "<label><input type='checkbox' id='printImage' onclick='fn_printImage()' checked> 첨부파일 보기</label></span>";
                                                                   
            
            strControl    += " <span  class='btn_style3'><a id = 'btn_summary' href='javascript:' onclick='fn_viewSummary(0)'>요약보기</a></span>";
            strControl    += "</div>";*/
            //2018.10.15 배유연 수정
            var strControl = "<div class='print_ss_title'><div><span id='SPAN_DETAIL' class='print_ss_txt'>";
            strControl +="<label><input type='checkbox' id='printDetail' onclick='fn_printDetail()'> "+$.i18n.prop("msg112")+"</label><label><input type='checkbox' id='printImage' onclick='fn_printImage()' checked> "+$.i18n.prop("msg157")+"</label></span></div>";
            strControl +="<div><span class='print_ss_txt' id='SPAN_SUMMARY' style='display:none'>";
            strControl +="<label><input type='radio' name='summary_radio' checked id='summary_tran_grp'> "+$.i18n.prop("msg170")+"</label><label><input type='radio' name='summary_radio' id='summary_tran'> "+$.i18n.prop("msg171")+"</label></span></div>"
            	
            strControl +="<div style='position:absolute;top:-5px;right:0;'>";//영수증 펼치기. 첨부파일 보기
            strControl +="<span class='btn_style3'><a id = 'btn_summary' href='javascript:'  onclick='fn_viewSummary(0)'>"+$.i18n.prop("msg113")+"</a></span>";
            
            		"</div></div>";//요약보기
        
            // PDF 저장이 아닐때만
            //if (g_proc_gb != "P")
            //    strControl +=  "<div class='f_right' id='btnRLayer' style=''><input type='checkbox' id='printDetail' onclick='fn_printDetail()'>영수증 펼쳐서 보기</input></div>";
            //strControl = strControl + "</div>";
           
            if (g_proc_gb != "P") {
                 
                  
                  $("#ifrm_rel").contents().find("#totAmt_layer").attr("class", "mgt10");
                //2018.10.15 css 수정
                  $("#ifrm_rel").contents().find("#totAmt_layer").attr("style", "padding:15px 10px 13px 5px;background-color:#f0f1f3; height:14px;");
                  var strTotal = $("#ifrm_rel").contents().find("#totAmt_layer").text();              
                  $("#ifrm_rel").contents().find("#totAmt_layer").html(strControl);
                   
                  var strTotHtml ="<div class='print_ss_title bline mgt20'><h5 class='print_ss_tit5 mgt10'>" + strTotal + "</h5>";    
                  
                  /*if(g_patial_reject_yn=="Y"){// 부분 결재 취소 사용업체
                	  
                	  var strRejectBtn = "<div style='position:absolute;top:-5px;right:0;'><span class='btn_style3 return'><a href='javascript:' class='normal' id='REJECT_BTN' onclick='rejectRcpt()'>영수증 반려</a></span></div>";
                	  strTotHtml +=strRejectBtn;
                  }*/
                  strTotHtml+="</div>"
                  
                  $("#ifrm_rel").contents().find("#totAmt_layer").after(strTotHtml);
                 
                  //$("#ifrm_rel").contents().find("#totAmt_layer").css("height", "23px");
                  //$("#ifrm_rel").contents().find("#totAmt_layer").css("position", "relative");           
                  //$("#ifrm_rel").contents().find("#totAmt_layer").html($("#ifrm_rel").contents().find("#totAmt_layer").html()+strControl);
            }
			if (g_proc_gb.indexOf("P") > -1) {
				$("#ifrm_rel").contents().find(".cardbill_layout .cardtxt_tb").css("margin-bottom", "20px");
			}
            //$("#ifrm_rel_print").html($("#ifrm_rel").contents().find("div[id^='div_web']").html());
            $("#ifrm_rel_print").html($("#ifrm_rel").contents().find("div[id^='div_web']").html());
			//2022.03.08 진호용 추가 : 컴플라이언스 위반이력 출력 (결의서 작성 단계에는 해당 데이터가 없어서 조회 시 html 추가) 
//          var rec_sum = jQuery.parseJSON(decodeURIComponent(cnts_Null2Void($("#REC_SUM").val(),"").replaceAll("+", "%20"))); //자바에서 url인코딩을 할 경우 공백문자가 + 로 바뀐다
//			var brchMsg = "";
//			$.each(rec_sum, function(i, v) {
//				var brchMsg_arr = cnts_Null2Void(v.BRCH_MSG,'').split("^");
//				$.each(brchMsg_arr, function(j, bm) {
//					if (brchMsg.indexOf(bm) === -1) {
//						brchMsg += bm + ", ";
//					}
//				});
//			});
//			if (brchMsg != "") {
//				brchMsg = brchMsg.substring(0, brchMsg.length-2);
//				var cmpl_brch_html 	= '<tr>';
//				cmpl_brch_html 		+= '	<th scope="row"><div class="txt_r">'+$.i18n.prop("msg206")+'</div></th>';
//				cmpl_brch_html 		+= '	<td><div id="CMPL_BRCH" class="txt_r">'+brchMsg+'</div></td>';
//				cmpl_brch_html 		+= '</tr>';
//				$("#ifrm_rel_print").find("table").eq(0).find("tr").last().after(cmpl_brch_html);
//			}
$("#ifrm_rel_print").css("display", "block");
$("#ifrm_rel").css("display", "none");



            $("#ifrm_rel_print").contents().find(".cardbill_layout").each(function(i, e) {

            	
            	// 부분 반려 사용 업체이면

            	
            	var reject_yn="Y";// 반려영수증 여부
            	if(g_patial_reject_yn=="Y" || g_patial_reject_yn=="A"){// 부분반려 사용하면서 , 조회의 기능일땨는(결재화면일수도있고, my지출결의서 조회화면일수도있음)
                   
            		var resollist_seq_no = $(this).attr("resollist_seq_no");
            		
            		var rec_sum = jQuery.parseJSON(decodeURIComponent($("#REC_SUM").val()));
					$(rec_sum).each(function(j,k){ //  해당결의서에 있는 영수증 목록
						if(resollist_seq_no== k.RESOLLIST_SEQ_NO){//해당 영수증이면
							reject_yn="N";
							return true;
						} 
						
					});
				
					if(reject_yn=="Y" && resollist_seq_no!=undefined){//반려영수증이면
						var tmp_html ="<div class='maskBox' style='display:;'><div class='maskBox_table'><p class='maskBox_tableRow'><span class='maskBox_tableCell'>";
						tmp_html+="<em class='maskBox_inMessage'>"+$.i18n.prop("msg114")+"</em></span></p></div></div>";//반려된 영수증 입니다.
	            		$(this).after(tmp_html);   
	            		
	            		//$(this).find(".box_billEdit").remove();
					}
            	}
            	var tmp_html="<div class='box_billEdit cboth'>";
            	if(g_patial_reject_yn=="Y"){ // 부분반려 사용하는 업체이면서, 결재함에서 결재리스트에서 조회한경우
                    
            		var resollist_seq_no = $(this).attr("resollist_seq_no");
                    var tmp_html2 = "<a href='#none' class='btn_return_textType' style='margin-right:2px;' onclick='rejectRcpt("+resollist_seq_no+");'><span>"+$.i18n.prop("msg115")+"</span></a>";//영수증 반려
            		
            		if(reject_yn=="Y"){// 이미 반려처리된 영수증이면
            			//tmp_html="<div class='box_billEdit cboth'></div>";
            		}
            		
            		if(reject_yn!="Y"){
            			tmp_html +=tmp_html2;
            		}
            		
            	
            		//$(this).find(".cardtxt_tb").after(tmp_html);            	
            		
            	}
            	
            	if(g_receipt_modify_yn=="Y"){ // 부분반려 사용하는 업체이면서, 결재함에서 결재리스트에서 조회한경우
                    
            		var resollist_seq_no = $(this).attr("resollist_seq_no");
            		var tmp_html2 = "<a href='#none' class='btn_billEdit' title='"+$.i18n.prop("msg116")+"' onclick=\"receiptModify("+resollist_seq_no+",'101','');\"><span class='blind'>"+$.i18n.prop("msg116")+"</span></a>";//영수증 수정
            		
                    
                           	
            		tmp_html+=tmp_html2;
            	}
            	tmp_html+="</div>";
            	
            	
            	if(g_patial_reject_yn=="Y" || g_receipt_modify_yn=="Y"){
            		$(this).find(".cardtxt_tb").after(tmp_html)
            	}
            	
            	
                //if(g_proc_gb.indexOf("P") <0 ){//2019.12.09 : pdf저장시에는 첨부파일 이미지 안나오도록
            	var strImg = "";             
                var k = 0;
                $.each(g_rcpt_rec, function(j, v){
                      if (i+1 == Number(v.SEQ_NO) && v.LINK_URL != null) {
                          k += 1;
                          strImg += "<div class='thumb_cn fir'>";
                          strImg += "   <a href='javascript:' onclick=\"showImg("+v.SEQ_NO+",'"+v.LINK_URL+"')\"><img class='rcptImg' src='"+v.LINK_URL+"' width='100%' alt=''></a>";
                          strImg += "</div>";
                      }
                });
                if (k > 2) 
                      strImg = "<div class='thumb_bx' style='display:none'>" + strImg;
                else
                      strImg = "<div  class='thumb_bx type2' style='display:none'>" + strImg;
                strImg += "</div>";

                $(e).after(strImg);
                   
                //} 
				g_real_rcpt_img_cnt += k;
                  
             
                
	             var strBack = "   <div style='display:none;' class='print_ss_head'> ";
	             strBack += "<h1 class='print_ss_tit1'>"+$.i18n.prop("msg117")+" <span>"+$.i18n.prop("msg118")+"</span></h1>";// 지출결의서(상세)
	             strBack += "<div class='btn_r'><a href='javascript:' onclick='fn_viewSummary(0)' class='print_ss_btn'><span>"+$.i18n.prop("msg119")+"</span></a></div></div>"; // 돌아가기             
	             $(e).before(strBack);
                 
            });
           
			$("#ifrm_rel_print").contents().find(".rcptImg").on("load", checkPdf);
			$("#ifrm_rel_print").contents().find(".rcptImg").on("error", checkPdf);
                   
     
            if ($.cookie("ppp_dtl_view_mode") == "SUMMARY") {
                  $(".cardbill_wrap").css("display", "none");
                  $("#div_summary").css("display", "");
                  $("#SPAN_DETAIL").css("display", "none");
                  $("#btn_summary").text($.i18n.prop("msg156"));//전체보기
                  $("#SPAN_SUMMARY").show();
                  $("#SPAN_DETAIL").hide();
            } else {
                  $(".cardbill_wrap").css("display", "");
                  $("#div_summary").css("display", "none");
                  $("#SPAN_DETAIL").css("display", "");
                  $("#btn_summary").text($.i18n.prop("msg113"));//요약보기
                  $("#SPAN_SUMMARY").hide();
                  $("#SPAN_DETAIL").show();
            }
           
            //2018.07.17 배유연 추가 : 첨부파일 보기 쿠키로 처리
            var imageCheckYn = $.cookie("imageCheck");
            
            //2018.08.28 배유연 추가: 영수증펼치기 쿠키로 처리
            var printCheckYn = $.cookie("printCheck");
          
            if(imageCheckYn == "Y"){
            	
            	$("#ifrm_rel_print").contents().find("#printImage").attr("checked",true);
            	$("#ifrm_rel_print").contents().find(".thumb_bx").css("display","block");
                
                fn_ifrmReSize();
            }else {
            	$("#ifrm_rel_print").contents().find("#printImage").attr("checked",false);
            	$("#ifrm_rel_print").contents().find(".thumb_bx").css("display","none");
            }
            
          
         
            //영수증 펼치기 쿠키로 처리
            if(printCheckYn =="Y"){
            	
            	 $("#ifrm_rel_print").contents().find("#printDetail").attr("checked",true);
            	 $("#ifrm_rel_print").contents().find(".view_cardbill").css("display","block");
                 $("#ifrm_rel_print").contents().find(".view_cardbill").css("position","static");
               
                 fn_ifrmReSize(); 
            }else{
            	 $("#ifrm_rel_print").contents().find("#printDetail").attr("checked",false);
            	  $("#ifrm_rel_print").contents().find(".view_cardbill").css("display","none");
                  $("#ifrm_rel_print").contents().find(".view_cardbill").css("position","absolute");    
            }
            // 인쇄용 분할내역 생성
            var spl_html = '<div class="onlyprint" >';
            var spl_yn = "N";
           
            $("#ifrm_rel_print").contents().find(".rcpt_box").each(function(i, e) {
                  spl_yn = "Y";
                  var spl_title = '<div class="print_ss_title mgt10">';
                  spl_title += '<h5 class="print_ss_tit5"> '+$.i18n.prop("msg120")+' &nbsp <strong style="font-weight:normal;">' // 분할내역
                  $(e).prev().prev().find(".left").find("li").each(function(j, f) {
                        spl_title += '<span>' + $(f).html() + '</span>&nbsp&nbsp';
                  });
                  spl_title += '</strong></h5></div>';
                 
                  spl_html += spl_title;
                  spl_html += '<div class="print_ss_tbl_view mgt10" style=""> ';
                  spl_html += '<table class="print_ss_type3" summary="">';
                  spl_html += '     <caption></caption>';
                  spl_html += '     <colgroup>';
                  spl_html += '                 <col style="width:200px;">';
                  spl_html += '                 <col style="width:200px;">';
                  spl_html += '                 <col >';
                  spl_html += '                 <col style="width:200px;">';
                  spl_html += '                 </colgroup>';
                  spl_html += '                 <tbody>';
                  spl_html += '                       <tr class="th">';
                  spl_html += '                             <td><div>'+$.i18n.prop("msg46")+'</div></td>';//용도
                  spl_html += '                             <td><div>'+$.i18n.prop("msg85")+'</div></td>';//사업예산부서
                  spl_html += '                             <td><div>'+$.i18n.prop("msg44")+'</div></td>';//내용
                  spl_html += '                             <td><div>'+$.i18n.prop("msg58")+'</div></td>';    //금액                                    
                  spl_html += '                       </tr>';
                 
                  $(e).find("ul").each(function(k, g) {
                        var rcpt_tran_kind_nm = $(g).find("li[name='__RCPT__TRAN_KIND_NM']").text();
                        var rcpt_bgt_dvsn_nm = $(g).find("li[name='__RCPT__BGT_DVSN_NM']").text();
                        var rcpt_memo = $(g).find("li[name='__RCPT__MEMO']").text();
                        var rcpt_spl_amt = $(g).find("li[name='__RCPT__SPL_AMT']").text();
                       
                        spl_html += '<tr>';
                        spl_html += '<td><div>' + rcpt_tran_kind_nm + '</div></td>';
                        spl_html += '<td><div>' + rcpt_bgt_dvsn_nm + '</div></td>';
                        spl_html += '<td><div>' + rcpt_memo + '</div></td>';
                        spl_html += '<td><div class="tar">' + rcpt_spl_amt.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + '</div></td>';
                        spl_html += '</tr>';
                  });
                 
                 
                  spl_html += '         </tbody>';
                  spl_html += '     </table>';
                  spl_html += '</div>';
                 
            });        
            spl_html += '</div>';
           
            if (curViewCardBill != "") {
                $("#ifrm_rel_print").contents().find(".view_cardbill").each(function(i, e) {
                      if (curViewCardBill == "A" || Number(curViewCardBill) == i) {
                            $(e).css("display", "block");
                            $(e).css("position", "static");
                      }
                });
                
                if(curViewCardBill=="A")
                	 $("#ifrm_rel_print").contents().find("#printDetail").attr("checked",true);
            }; 
            
            if(g_proc_gb.indexOf("IMG")  >-1){
            	$("#ifrm_rel_print").contents().find(".thumb_bx").css("display","block");
            	$("#ifrm_rel_print").contents().find("#printImage").attr("checked",true);
            	
            }
            
            
            if (spl_yn == "Y")
                  $(".pop_container").append(spl_html);
            
            
            //2019.04.17 요약보기 라디오 이벤트 추가
            $("input:radio[name=summary_radio]").click(function() {
            
            	//console.log("여기탐")
                if($(this).attr("id") == "summary_tran"){
                	$("#div_summary2").show();
                	$("#div_summary").hide();
                }else{
                	$("#div_summary2").hide();
                	$("#div_summary").show();
                }
          });
          //2020.07.17 이미지 뷰잉기능 전자결재에서 제어하기
          $(".rec_img").find("img").click(function(e){
        	  e.stopPropagation();
        	  var url = $(this).attr("src");
        	  var seq_no = $(this).closest("table.cardbill_layout").attr("resollist_seq_no");
        	  showImg(seq_no,url);
        	  
          });
          //2020.11.24 사원번호 표기하기.
       
          $("#ifrm_rel_print").contents().find("#draft_empl_no").text(g_draft_user_id_number);
          
      }


}
function fn_ifrmReSize()
{
var iFrameID = document.getElementById('ifrm_rel');

    if(iFrameID) {
          // here you can make the height, I delete it first, then I make it again
          //iFrameID.height = iFrameID.height - 200 + "px";
          if($("#ifrm_rel_print").contents().find('.view_cardbill:visible').length > 0) {
            iFrameID.height = iFrameID.contentWindow.document.body.scrollHeight + "px";
            // 현재 펼쳐진 영수증의 순번을 구한다.
            var arr = $("#ifrm_rel_print").contents().find('.view_cardbill:visible').attr('id').split('_');
            curViewCardBill = arr[arr.length-1];           
      } else {
            curViewCardBill = "";
            iFrameID.height = g_ifrm_height + "px";
      }
    }
}
function cardBillDown(i){

       var j;
     
       if($("#ifrm_rel").contents().find('#cardViewGB1').val() == ''){
             $("#ifrm_rel").contents().find('#cardViewGB1').val(i);
       }
       if($("#ifrm_rel").contents().find('#cardViewGB1').val() != i){
             j = $("#ifrm_rel").contents().find('#cardViewGB1').val();
             if($("#ifrm_rel_print").contents().find('#cardbill_cont_'+j).hasClass('on')) {
                   $("#ifrm_rel_print").contents().find('#cardbill_cont_'+j).removeClass('on');
                   $("#ifrm_rel_print").contents().find('#view_cardbill_'+j).css('display','none');
             }
       }
       if($("#ifrm_rel_print").contents().find('#view_cardbill_'+i).css('display')=='none') {
             $("#ifrm_rel_print").contents().find('#cardbill_cont_'+i).addClass('on');
             $("#ifrm_rel_print").contents().find('#view_cardbill_'+i).css('display','');
             $("#ifrm_rel_print").contents().find('#view_cardbill_'+i).css("position","static");
       } else {
             $("#ifrm_rel_print").contents().find('#cardbill_cont_'+i).removeClass('on');
             $("#ifrm_rel_print").contents().find('#view_cardbill_'+i).css('display','none');
             $("#ifrm_rel_print").contents().find('#view_cardbill_'+i).css("position","absolute");
       }
       $("#ifrm_rel").contents().find('#cardViewGB1').val(i);
      fn_ifrmReSize();
}
function showRcptSplHist(i) {
//기존
/*var spl_list = [];

      $("#ifrm_rel_print").contents().find('#cardbill_cont_'+i).find('.rcpt_box').find('ul').each(function(i,e){
            var item = {};
            $(e).find('li').each(function(j,f){
                  item[$(f).attr('name').replace('__RCPT__', '')] =$(f).text()
     
            });
            spl_list[i] = item;
      });
     
      var json = {};
      json["REC"] = spl_list;
      $("#frm_appr_dtl_0005").find("#RCPT_SPL_HIST").val(encodeURIComponent(JSON.stringify(json)));
      open_smartPop({href:"appr_dtl_rel_0001.act", width: 680, height: 500, target : "appr_dtl_rel_0001", frm:$("#frm_appr_dtl_0005")});*/
	
	//2019.09.02 배유연 수정
	
	var paper_seq_no = "";
	var resollist_seq_no = i+1;
	var lngg_dsnc = $("#LNGG_DSNC").val();	// 다국어구분
	
    var jsonREC={};
    
    jsonREC["PAPER_SEQ_NO"]=g_appr_seq_no;
    jsonREC["RESOLLIST_SEQ_NO"]=resollist_seq_no;
    jsonREC["LNGG_DSNC"]=lngg_dsnc;
    

    var d = new Date(); 
    
    $("#TRMS_DT").val(d.getFullYear()+(d.getMonth() + 1));
    $("#TRMS_TKTM").val( d.getHours()+ d.getMinutes()+ d.getSeconds());
    $("#TRAN_NO").val("APPR_PROC_R006");
    
	$("#REQ_DATA").val(encodeURIComponent(jex.toStr(jsonREC)));
	//$("#CALLBACK_PAGE").val("appr_callback");
   
	openUrl = $("#WEBANK_URL").val()+"/APPR_PROC_R006.act"
	open_popup("frm_appr_dtl_0005",{sizeW:"941"  ,sizeH:"691", target:"window",action:openUrl});


}
//영수증 전체 펼치기
function fn_printDetail() {
if($("#printDetail").is(':checked')){
$("#ifrm_rel_print").contents().find(".view_cardbill").css("display","block");
$("#ifrm_rel_print").contents().find(".view_cardbill").css("position","static");
$.cookie("printCheck","Y");
fn_ifrmReSize();
} else {
$("#ifrm_rel_print").contents().find(".view_cardbill").css("display","none");
$("#ifrm_rel_print").contents().find(".view_cardbill").css("position","absolute");     
$.cookie("printCheck","N");
}
}    
function fn_printImage() { //첨부파일 보기버튼
if($("#printImage").is(':checked')){
$("#ifrm_rel_print").contents().find(".thumb_bx").css("display","block");
$.cookie("imageCheck","Y");
} else {
$("#ifrm_rel_print").contents().find(".thumb_bx").css("display","none");
$.cookie("imageCheck","N");
}    
}
/**
*  Json 데이터 소팅함수
* @param data
* @param key
* @return
  */
  function sortJSON(data, key) {
  return data.sort(function(a, b) {
  var x = a[key]; var y = b[key];
  return ((x < y) ? -1 : ((x > y) ? 1 : 0));
  });
  }
  function fn_apprStsList(){

  $("#btnStsInfo").click();    
  }
  //회람버튼 function
  function fn_share(){
  open_smartPop({href:"appr_dtl_0006.act", width: 500, height: 580, target : window, frm:$("#frm_appr_dtl_0005")});                  
  }

//2018.01.21 배유연 추가  : 해당 양식지에 등록된 결재선이 있는지(직원결재선관리 메뉴에서 추가한 결재선 )
function fn_apprline_by_paper(paper_seq_no){
var jexAjax = jex.createAjaxUtil("appr_paper_r008");
jexAjax.set("PTL_ID"                , g_ptl_id);
jexAjax.set("CHNL_ID"               , g_chnl_id);
jexAjax.set("USE_INTT_ID"           , g_use_intt_id);
jexAjax.set("PAPER_SEQ_NO"           , paper_seq_no);
jexAjax.set("USER_ID"                , g_user_id);

    jexAjax.setAsync(false);
    jexAjax.execute(function(dat){
    	if(parseInt(dat.APPRLINE_SEQ_NO) <0){
    		$("#PAPER_BY_APPRLINE_SEQ_NO").val(dat.APPRLINE_SEQ_NO);
    		$("#APPRLINE_SEQ_NO_FIX_YN").val(dat.APPRLINE_SEQ_NO_FIX_YN);
    		
    		   		
    	}
    });
}



//2018.08.24 배유연 추가 : 사전승인서 항목추가
function fn_apprPriorItemAdd(tx_gb, seq_no){

	  var openUrl = "";
	  var d = new Date(); 
	  
	 
	  
	   $("#TRMS_DT").val(d.getFullYear()+(d.getMonth() + 1));
	   $("#TRMS_TKTM").val( d.getHours()+ d.getMinutes()+ d.getSeconds());
	   $("#TRAN_NO").val("CRD_PREXPN_REG");
	   if(tx_gb=='C'){
		   $("#REQ_DATA").val(encodeURIComponent(jex.toStr({SEQ_NO : "",TX_GB : "1"})));
	   }else if(tx_gb=='U'){
		   $("#REQ_DATA").val(encodeURIComponent(jex.toStr({SEQ_NO : seq_no,TX_GB : "2"})));
	   }else if(tx_gb=='D'){
		   
		
		   $("#REQ_DATA").val(encodeURIComponent(jex.toStr({SEQ_NO : seq_no,TX_GB : "3"})));
	   }
		   
	   
	   $("#CALLBACK_PAGE").val("appr_callback");
	   /*if(location.href.indexOf("appplay")==-1){// 개발
	    
		   openUrl="http://dev.webank.com/CRD_PREXPN_REG.act";
		   
		   $("#CALLBACK_PAGE").val("http://approval.webcashcorp.com:82/appr/appr_callback.act");
	   }else{//운영
	      

		   openUrl="https://webank.appplay.co.kr/CRD_PREXPN_REG.act";
		   $("#CALLBACK_PAGE").val("https://approval.appplay.co.kr/appr/appr_callback.act");
	   }*/
	
	   openUrl = $("#WEBANK_URL").val()+ "/CRD_PREXPN_REG.act";
	   $("#CALLBACK_PAGE").val($("#SERVICE_URL").val()+"/appr/appr_callback.act");
	   
	   if(tx_gb=='D'){ // 삭제일 경우는 메시지 API 호출하기.
		   var jexAjax = jex.createAjaxUtil("appr_prior_d001");
		    jexAjax.set("PTL_ID"                , g_ptl_id);
		    jexAjax.set("CHNL_ID"               , g_chnl_id);
		    jexAjax.set("USE_INTT_ID"           , g_use_intt_id);
		    jexAjax.set("USER_ID"               , g_user_id);
		   /* jexAjax.set("TRMS_DT"               , d.getFullYear()+(d.getMonth() + 1)); 
		    jexAjax.set("TRMS_TKTM"             , d.getHours()+ d.getMinutes()+ d.getSeconds()); 
		    jexAjax.set("TRAN_NO"                  , "CRD_PREXPN_REG"); 
		    jexAjax.set("REQ_DATA"                  , $("#REQ_DATA").val()); */
		    jexAjax.set("SEQ_NO"               , seq_no);
		    jexAjax.set("TX_GB"               , 3);
		    
		    jexAjax.setAsync(false);
		    jexAjax.execute(function(dat){
		    	if(jex.null2Void(dat.PRE_SEQ) !=""){
		    		$("#PRE_SEQ_"+dat.PRE_SEQ).parent().remove();
		
		    		if($("#apprPriorData").find("tr").find("td[id^='PRE_SEQ_']").length<1){
		    			
		    			$("#noPriorData").css("display","table-row");
		    		}
		    	}
		    });
	   }else{ //그 외에는 팝업API 
		   open_popup("frm_appr_dtl_0005",{sizeW:"510"  ,sizeH:"600", target:"window",action:openUrl});
	   }
	   
	   
	   // 총금액 다시 계산하도록
	   var req_amt_sum=0;

		 $("#apprPriorData tr").each(function(i,e){
			 if($(this).attr("id") == "noPriorData")
				return true;
			 if($(this).hasClass("th"))
			 	return true;	
			 
			 
		
			 req_amt_sum += parseInt($(this).find(".req_amt").text().replace(/,/g, ''));
		 });
		 
		 
		 $("#prior_sum").text(formatter.number(req_amt_sum)+$.i18n.prop("msg52"))

}

//사전승인서 popup콜백함수
function apprPriorCallback(resultData){


	$("#noPriorData").css("display","none");
	var sHtml = "";
	
	
	if(resultData.TX_GB =="1" || resultData.TX_GB =="2"){
		var empl_rec = jex.null2Void(resultData.PRE_EMPL_REC);
		var empl_rec_str = "";
		
		if(jex.null2Void(empl_rec,"") !=""){
			/*if(empl_rec.length>1)
				empl_rec_str = empl_rec[0].BP_EMPL_NM+" 외 "+(empl_rec.length-1)+"명 참석";
			else
				empl_rec_str = empl_rec[0].BP_EMPL_NM;*/
			empl_rec_str+=empl_rec.length+"명 ("
			$.each(empl_rec, function(j,k){
			    empl_rec_str += k.BP_EMPL_NM;
			    if(j!= empl_rec.length-1){
			          empl_rec_str +=", ";
			        }
			  
			});
			empl_rec_str += ")";
			
			
		}
		var cust_rec = jex.null2Void(resultData.PRE_CUST_REC);
		var cust_rec_str = "";
		
		if(jex.null2Void(cust_rec,"") !="" ){
			/*if(cust_rec.length>1)
				cust_rec_str = cust_rec[0].BP_CUST_NM+" 외 "+(cust_rec.length-1)+"거래처 참석";
			else
				cust_rec_str = cust_rec[0].BP_CUST_NM;*/
			
			
			$.each(cust_rec, function(j,k){
			    cust_rec_str += k.BP_CUST_NM;
			    if(k!= cust_rec.length-1){
			          cust_rec_str +=", ";
			    }
	         
			});
	          
			cust_rec_str += " 거래처 참석";
					
		}
		 
		
		 var item_nm_08 ="";
         var item_nm_09 ="";
         var item_nm_10 ="";
         var item_nm_11 ="";
         var item_nm_12 ="";
         var item_nm_13 ="";
         var item_nm_14 ="";
         var item_nm_15 ="";
         

         $(resultData.TRAN_ITEM_REC).each( function(j,k){
        	 
        	

               if(jex.null2Void(k.ITEM_CD) =="08") item_nm_08 = jex.null2Void(k.ITEM_NM);
               if(jex.null2Void(k.ITEM_CD) =="09") item_nm_09 = jex.null2Void(k.ITEM_NM);
               if(jex.null2Void(k.ITEM_CD) =="10") item_nm_10 = jex.null2Void(k.ITEM_NM);
               if(jex.null2Void(k.ITEM_CD) =="11") item_nm_11 = jex.null2Void(k.ITEM_NM);
               if(jex.null2Void(k.ITEM_CD) =="12") item_nm_12 = jex.null2Void(k.ITEM_NM);
               if(jex.null2Void(k.ITEM_CD) =="13") item_nm_13 = jex.null2Void(k.ITEM_NM);
               if(jex.null2Void(k.ITEM_CD) =="14") item_nm_14 = jex.null2Void(k.ITEM_NM);
               if(jex.null2Void(k.ITEM_CD) =="15") item_nm_15 = jex.null2Void(k.ITEM_NM);
         });

		
         
       
         
		
		var content ="";

		content+= (jex.null2Void(resultData.BIZ_UNIT_NM) !="") ?  item_nm_09+":"+ jex.null2Void(resultData.BIZ_UNIT_NM) +"<br>" : "";
		
		content+= (jex.null2Void(resultData.MGMT1) !="")? jex.null2Void(resultData.MGMT_NM1)+":"+ jex.null2Void(resultData.MGMT1) +"<br>" : "";
		content+= (jex.null2Void(resultData.MGMT2) !="")? jex.null2Void(resultData.MGMT_NM2)+":"+  jex.null2Void(resultData.MGMT2) +"<br>" : "";
		content+= (jex.null2Void(resultData.MGMT3) !="")? jex.null2Void(resultData.MGMT_NM3)+":"+  jex.null2Void(resultData.MGMT3) +"<br>" : "";
		content+= (jex.null2Void(resultData.MGMT4) !="")? jex.null2Void(resultData.MGMT_NM4)+":"+  jex.null2Void(resultData.MGMT4) +"<br>" : "";
		content+= (jex.null2Void(resultData.MGMT5) !="")? jex.null2Void(resultData.MGMT_NM5)+":"+ jex.null2Void(resultData.MGMT5) +"<br>" : "";
		content+= (jex.null2Void(resultData.MGMT6) !="")? jex.null2Void(resultData.MGMT_NM6)+":"+  jex.null2Void(resultData.MGMT6) +"<br>" : "";
		content+= (jex.null2Void(resultData.MGMT7) !="")? jex.null2Void(resultData.MGMT_NM7)+":"+  jex.null2Void(resultData.MGMT7) +"<br>" : "";
		content+= (jex.null2Void(resultData.MGMT8) !="")? jex.null2Void(resultData.MGMT_NM8)+":"+  jex.null2Void(resultData.MGMT8) +"<br>" : "";
		content+= (jex.null2Void(resultData.ADDN_NM) !="")? item_nm_10+":"+  jex.null2Void(resultData.ADDN_NM) +"<br>" : "";
		content+= (jex.null2Void(empl_rec_str) !="")? item_nm_13+":"+  jex.null2Void(empl_rec_str) +"<br>" : "";
		content+= (jex.null2Void(cust_rec_str) !="")? item_nm_12+":"+  jex.null2Void(cust_rec_str) +"<br>" : "";

		
		content+= (jex.null2Void(resultData.TX_DTM) !="")? item_nm_08+":"+ resultData.TX_DTM.substring(0,10) +"<br>" : "";
		content+= (jex.null2Void(resultData.CAR_INFO) !="")? item_nm_15+":"+ resultData.CAR_INFO+"<br>" : "";
		//content+= (jex.null2Void(resultData.START_DTM)!="") ? item_nm_14+  ":"+ resultData.START_DTM.substring(0,4) +"-"+resultData.START_DTM.substring(4,6)+"-"+resultData.START_DTM.substring(6,8)+" ~" : "";
		//content+= (jex.null2Void(resultData.END_DTM)!="") ?  resultData.END_DTM.substring(0,4) +"-"+resultData.END_DTM.substring(4,6)+"-"+resultData.END_DTM.substring(6,8) : "";
		content+= (jex.null2Void(resultData.START_DTM)!="") ? item_nm_14+  ":"+ resultData.START_DTM.substring(0,10)+" ~" : "";
		content+= (jex.null2Void(resultData.END_DTM)!="") ?  resultData.END_DTM.substring(0,10) : "";


		
		
		
		var d = new Date(); 
		

		sHtml +="<tr >";
		sHtml +="<td><div class='tac'>"+ resultData.EXPN_DT.substring(0,4) +"-"+resultData.EXPN_DT.substring(4,6)+"-"+resultData.EXPN_DT.substring(6,8)+"</div></td>";
		sHtml +="<td><div class='tac'>"+resultData.TRAN_KIND_NM+"</div></td>";
		sHtml +="<td><div class='tar req_amt'>"+formatter.number(resultData.REQ_AMT)+"</div></td>";

		sHtml +="<td id=PRE_SEQ_"+resultData.PRE_SEQ+" class='pre_seq' data='"+resultData.PRE_SEQ+"'><div style='position:relative;padding-right:43px ' >";
		// 2019.01.09_이현수 : css 수정(width: 250px->80%)
		sHtml +="	<p style='padding:5px 0; text-overflow: ellipsis;   overflow: hidden;  white-space: nowrap;width: 80%;height: 40px;'>"+content;
		sHtml +="	<div style='position:absolute;right:0;top:50%;margin-top:-12px;padding:0 10px !important;'>";
		if(""!=content){
			sHtml +="		<a href='#none' class='more'><img src='../img/ico/ico_memo_y.png' alt='더보기' ></a>";
		}else{
			sHtml +="		<a href='#none' class='no_more'><img src='../img/ico/ico_memo_n.png' alt='더보기' ></a>";
		}
		//sHtml +="		<a href='#none' class='more'><img src='../img/ico/ico_memo_y.png' alt='더보기' ></a>";
		sHtml +="       <div class='layertype1' style='display:none;top:27px;right:0;width:250px;padding:0 !important;*padding:0;z-index:99999;'>";
		sHtml +="		<div class='toptail_layer' style='padding:0 10px !important;*padding:0;'><span class='tail' style='top:-7px;right:14px;'></span>";
				
		sHtml +="		<div style='padding:10px 0px 8px !important;line-height:17px;cursor:default !important;text-align:left !important;'>"+content;
		sHtml +="    </div></div></div></div></div></td>";
		sHtml +="<td><div class='tac' style='padding:0 10px !important;'><a href='#none' title='"+$.i18n.prop("msg160")+"' class='prior_update'><img src='/img/btn/btn_edit.png' alt='수정'></a>";
		sHtml +=" 			<a href='#none' title='"+$.i18n.prop("msg77")+"'  class='prior_delete'><img src='/img/btn/btn_delete2.png' alt='삭제'></a></div></td>";
		sHtml +="</tr>";
		
	}
	
	
	
	
	if(resultData.TX_GB == "1"){//등록
		$("#apprPriorData").append(sHtml);
	}else if(resultData.TX_GB == "2"){//수정
		var tr_seq = $("#PRE_SEQ_"+resultData.PRE_SEQ).parent().index();
		tr_seq = tr_seq- 1;
		$("#PRE_SEQ_"+resultData.PRE_SEQ).parent().remove();
		if(tr_seq > -1){// 아예 경비항목 존재 안할때.
			$(sHtml).insertAfter($("#apprPriorData").find("tr:eq("+tr_seq+")"));
		}else{// 아예 경비항목 존재 안할때.
			$("#apprPriorData").append(sHtml);
		}
	}else if(resultData.TX_GB == "3"){ //삭제
		
		
		
		$("#PRE_SEQ_"+resultData.PRE_SEQ).parent().remove();
		
		
		
		if($("#apprPriorData").find("tr").find("id^='PRE_SEQ_'").length<1){
			
			$("#noPriorData").css("display","table-row");
		}
	}
	
	
	//총 신청금액 구하기
	  var req_amt_sum=0;

	 $("#apprPriorData tr").each(function(i,e){
		 if($(this).attr("id") == "noPriorData")
			return true;
		 if($(this).hasClass("th"))
		 	return true;	
		 
		 
	
		 req_amt_sum += parseInt($(this).find(".req_amt").text().replace(/,/g, ''));
	 });
	 
	 
	 $("#prior_sum").text(formatter.number(req_amt_sum)+$.i18n.prop("msg52"))


}




//영수증반려 기능
function rejectRcpt(resollist_seq_no){

	if(resollist_seq_no==undefined){
		alert($.i18n.prop("msg139"))
	}

	var form = document.createElement("form");
    form.appendChild(getHiddenField("PTL_ID", g_ptl_id));
    form.appendChild(getHiddenField("CHNL_ID", g_chnl_id));
    form.appendChild(getHiddenField("USE_INTT_ID", g_use_intt_id));
    form.appendChild(getHiddenField("USER_ID", g_user_id));
    form.appendChild(getHiddenField("APPR_SEQ_NO", g_appr_seq_no));
    form.appendChild(getHiddenField("DRAFT_USER_ID", g_draft_user_id));

    var rec_sum = jQuery.parseJSON(decodeURIComponent($("#REC_SUM").val()));
 
    if(rec_sum.length==1){
    
    	alert($.i18n.prop("msg140"));
    	return false;
    }
    
	 $(rec_sum).each(function(j,k){ //  해당결의서에 있는 영수증 목록
		if(resollist_seq_no== k.RESOLLIST_SEQ_NO){//해당 영수증이면
			
			var _this = $(".cardbill_layout[resollist_seq_no="+resollist_seq_no+"]");
			
			form.appendChild(getHiddenField("CARD_NO", k.CARD_NO));
		    form.appendChild(getHiddenField("APV_DT", k.APV_DT));
		    form.appendChild(getHiddenField("SEQ", k.SEQ));
		    form.appendChild(getHiddenField("APV_NO", k.APV_NO));
		    form.appendChild(getHiddenField("RESOLLIST_SEQ_NO", k.RESOLLIST_SEQ_NO));
		    form.appendChild(getHiddenField("INFM1", $(_this).find(".cardbill_box").find("li").eq(0).text().substring(2,21)));
		    form.appendChild(getHiddenField("INFM2", $(_this).find(".cardbill_box").find("li").eq(1).text()));
		    form.appendChild(getHiddenField("INFM3", $(_this).find(".cardbill_box").find(".right").text()));
		    form.appendChild(getHiddenField("INFM4", $(_this).find(".cardbill_box").find(".right").find("strong").text()));
			return false;
			
		} 
	
	 });
	if(!confirm($.i18n.prop("msg141"))){
		return false;
	}

	form.appendChild(getHiddenField("DOC_NO", $("#DOC_NO").val()));
	form.appendChild(getHiddenField("CALLBACK_FN", "reject_callback"));

	form.setAttribute("method", "post");
	
	form.setAttribute("id", "frm_tmp");
	form.setAttribute("name", "frm_tmp");
	//form.setAttribute("CALLBACK_FN", "reject_callback");
	document.body.appendChild(form);
	open_smartPop({href:"appr_partial_reject_0002.act", width: 455, height: 373, target : window, frm:$("#frm_tmp")});
//	open_smartPop({href:"appr_partial_reject_0001.act", width: 450, height: 260, target : window, frm:$("#frm_tmp")});

	document.body.removeChild(form);

}

//영수증 반려 callback
function reject_callback(){

	 $("#frm_appr_dtl_0005").action="appr_dtl_0005.act";
	 $("#frm_appr_dtl_0005").find("#HEADER_HIDDEN").val("Y");
	 $("#frm_appr_dtl_0005").target = "_self";
	 $("#frm_appr_dtl_0005").submit();	
	 
	 parent.fn_appr_opinion_r001();

}



function receiptModify(resollist_seq_no, paper_seq_no, data){

	var form = document.createElement("form");
    form.appendChild(getHiddenField("PTL_ID", g_ptl_id));
    form.appendChild(getHiddenField("CHNL_ID", g_chnl_id));
    form.appendChild(getHiddenField("USE_INTT_ID", g_use_intt_id));
    form.appendChild(getHiddenField("USER_ID", g_user_id)); // 2019.02.01_이현수 : 오류 수정
    form.appendChild(getHiddenField("APPR_SEQ_NO", g_appr_seq_no));
    form.appendChild(getHiddenField("DRAFT_USER_ID", g_draft_user_id));

    var jsonREC={};
    
    if(paper_seq_no=="101"){
    	if(resollist_seq_no==undefined){
    		alert($.i18n.prop("msg145"));
    		return false;
    	}

    	var rec_sum =  jQuery.parseJSON(decodeURIComponent($("#REC_SUM").val())); 
        $(rec_sum).each(function(j,k){ //  해당결의서에 있는 영수증 목록
    		if(resollist_seq_no== k.RESOLLIST_SEQ_NO){//해당 영수증이면
    			
    			var _this = $(".cardbill_layout[resollist_seq_no="+resollist_seq_no+"]");
    			
    			jsonREC["TX_GB"]=k.CARD_GB;
    		    jsonREC["BANK_CD"]=k.BANK_CD;
    		    jsonREC["CARD_NO"]=k.CARD_NO;
    		    jsonREC["APV_DT"]=k.APV_DT;
    		    jsonREC["SEQ"]=k.SEQ;
    		    jsonREC["APV_NO"]=k.APV_NO;
    		    jsonREC["APV_TM"]=k.APV_TM;
    		    jsonREC["BANK_CD"]=k.BANK_CD;
    		    jsonREC["TX_GB"]=k.CARD_GB;
    		    
    		    // 2019.01.30_이현수 : 파라미터 추가
    		    jsonREC["APV_CAN_YN"] = k.APV_CAN_YN;		// 승인취소여부
    		    jsonREC["LNGG_DSNC"] = $("#LNGG_DSNC").val();	// 다국어구분
    		    //jsonREC["MAGR_AUTH_YN"] = "N";	// 관리자권한수정거래
    		    if(g_proc_gb =="C" || g_proc_gb =="U"){//기안작성 혹은 재기안일경우
    		    	jsonREC["MAGR_AUTH_YN"]	= "N";	// 관리자권한수정거래
    			}else{
    				jsonREC["MAGR_AUTH_YN"]	= "Y";	// 관리자권한수정거래
    			}
    		    
    		    jsonREC["CALLBACK_PAGE"]="";
    			return false;
    			
    		} 
    	
    	 });
    }/*else if(paper_seq_no =="601"){
    	var decode_data = JSON.parse(decodeURIComponent(data));
    	jsonREC["TX_GB"]=decode_data.TX_GB;
	    jsonREC["BANK_CD"]=decode_data.BANK_CD;
	    jsonREC["CARD_NO"]=decode_data.CARD_NO;
	    jsonREC["APV_DT"]=decode_data.APV_DT;
	    jsonREC["SEQ"]=decode_data.SEQ;
	    jsonREC["APV_NO"]=decode_data.APV_NO;
	    jsonREC["APV_TM"]=decode_data.APV_TM;
	    jsonREC["BANK_CD"]=decode_data.BANK_CD;
	    
	    jsonREC["CALLBACK_PAGE"]="";
    }*/
    
    jsonREC["APPR_SEQ_NO"]=g_appr_seq_no;

    var d = new Date(); 
    
    $("#TRMS_DT").val(d.getFullYear()+(d.getMonth() + 1));
    $("#TRMS_TKTM").val( d.getHours()+ d.getMinutes()+ d.getSeconds());
    $("#TRAN_NO").val("CRD_RCPT_REG");
    
	$("#REQ_DATA").val(encodeURIComponent(jex.toStr(jsonREC)));
	$("#CALLBACK_PAGE").val($("#SERVICE_URL").val()+"/appr/appr_callback2.act?callback_fn=fn_cardbill_modify_callback");
   
	openUrl = $("#WEBANK_URL").val()+"/CRD_RCPT_REG.act"

	$("#USER_ID").val(g_user_id);
	
	open_popup("frm_appr_dtl_0005",{sizeW:"941"  ,sizeH:"691", target:"window",action:openUrl});
	$("#USER_ID").val(g_user_id);
}

//2020.02.10 배유연 추가 : 계산서 수정 기능 추가
function fn_taxbillModify(issu_id,s_appr_seq_no,  reollist_seq_no){

	var form = document.createElement("form");
    form.appendChild(getHiddenField("TASK_ID", "M"));//S->M수정(2021.01.18 윤경준대리님 요청)
    form.appendChild(getHiddenField("USE_INTT_ID", g_use_intt_id));
    form.appendChild(getHiddenField("USER_ID", g_user_id));
    form.appendChild(getHiddenField("ISSU_ID", issu_id)); // 2019.02.01_이현수 : 오류 수정
    form.appendChild(getHiddenField("BIZ_NO", $("#BIZ_REG_NO").val()));
    form.appendChild(getHiddenField("USERDATA", $("#USERDATA").val()));
    form.appendChild(getHiddenField("APPR_SEQ_NO", s_appr_seq_no));
    form.appendChild(getHiddenField("PAPER_APPR_SEQ_NO", g_appr_seq_no));
    form.appendChild(getHiddenField("RESOLLIST_SEQ_NO", reollist_seq_no));
    form.appendChild(getHiddenField("LNGG_DSNC", $("#LNGG_DSNC").val()));
    form.setAttribute("method", "post");
    var urlData = $("#TAXBILL_URL").val()+"/TAX_POP_0001.act"

    form.setAttribute("action", urlData);
    form.setAttribute("id", "frm_tmp");
    form.setAttribute("name", "frm_tmp");
    document.body.appendChild(form);
    
    
    open_popup("frm_tmp",{sizeW:"1322" ,sizeH:"785", target:"window",action:urlData});
    document.body.removeChild(form);

}

//2019.05.08 배유연 추가 : 직원 항목 콜백함수
function apprEmplCallback(jsonData){
//console.log(jsonData);
//console.log(seq);
var empl_rec = jsonData;
var seq = jsonData.seq;

	var sHtml="";
	if(empl_rec !=null){
		$.each(empl_rec, function (i,e){
			
			if($("div[name='EMPL_ITNM_"+seq+"']").find(".name_cmb_multi_box").find("p[key='"+e.USER_ID+"']").length >0){
				return ;
			}else{ 
			
				sHtml +="<p class='name_cmb multi pdr15' key='"+e.USER_ID+"' data ="+encodeURIComponent(JSON.stringify(e))+"><span class='' title=''>"+e.FLNM+"("+e.DVSN_NM+","+e.JBCL_NM+")</span><a href='javascript:;'><img src='/img/ico/x_span.png' alt='' class='delete_empl'></a></p>";
			}
		});
		$("div[name='EMPL_ITNM_"+seq+"']").find(".name_cmb_multi_box").append(sHtml);
	}
}


function openLink(link){
window.open(link, "_blank");
}

function fn_pdfDown(opinionYn){
//여기서 curViewCardBill 한번 다시정리해야할듯..

	if($("#ifrm_rel_print").contents().find('.view_cardbill:visible').length > 0) {
        
        // 현재 펼쳐진 영수증의 순번을 구한다.
        var arr = $("#ifrm_rel_print").contents().find('.view_cardbill:visible').attr('id').split('_');
        curViewCardBill = arr[arr.length-1];       
    }else{
    	curViewCardBill="";
    }
	
	var addProcGb = "";
    
  
   
    if ($.cookie("ppp_dtl_view_mode") == "SUMMARY")
          addProcGb += "_S";
    
    //2020.06.29 첨부파일 보기 추가
    if ($('#printImage').is(':checked'))
        addProcGb += "_IMG";
    
    if (opinionYn=="Y") {
    	addProcGb += "_OPIN";
    } else if ("MAIN" === opinionYn) {
		addProcGb += "_MAIN";
	}
    
	//영수증 펼치기
    if ($('#printDetail').is(':checked') || "A" === opinionYn)
        addProcGb += "_A";
    else
        addProcGb += "_"+curViewCardBill;
   
    var status ="";
    status=',"STATUS":"'+window.status+'"';
    var params = '{"API_KEY":"PDF_0001"'
                   +',"PTL_ID":"'+g_ptl_id+'"'
                   +',"CHNL_ID":"'+g_chnl_id+'"'
                   +',"USE_INTT_ID":"'+g_use_intt_id+'"'
                   +',"USER_ID":"'+g_user_id+'"'
                   +status
                   +',"DN_NM":"'+$("#PAPER_NM").text()+'.pdf"'
                   +',"REQ_REC":['+
                   '{"URL":"'+$("#DTL_VIEW_URL").val()+'"'
                            +',"APPR_SEQ_NO":'+g_appr_seq_no
                            +',"USE_INTT_ID":"'+g_use_intt_id+'"'
                            +',"PTL_ID":"'+g_ptl_id+'"'
                            +',"CHNL_ID":"'+g_chnl_id+'"'
                          +',"USER_ID":"'+g_user_id+'"'
                          +',"PROC_GB":"P' + addProcGb + '"'
                          +',"LNGG_DSNC":"' + $("#LNGG_DSNC").val() + '"'
                                  +',"CNTS_CRTC_KEY":"' + $("#CNTS_CRTC_KEY").val() + '"}]}';            
    var urlData = $("#PDF_DOWN_URL").val();
var form = document.createElement("form");
form.setAttribute("method", "post");
form.setAttribute("action", urlData);
var hiddenField = document.createElement("input");
hiddenField.setAttribute("type", "hidden");
hiddenField.setAttribute("name", "JSONData");
hiddenField.setAttribute("value", params);
form.appendChild(hiddenField);
document.body.appendChild(form);
form.submit();

$("#opinionPDF").hide();
}


//2019.08.20 배유연 추가 : 결재 의견 조회
function fn_appr_opinion_r002(){
var jexAjax = jex.createAjaxUtil("appr_opinion_r001");
jexAjax.set("PTL_ID"			,$("#PTL_ID").val()    			);
jexAjax.set("CHNL_ID"			,$("#CHNL_ID").val()     				);
jexAjax.set("USE_INTT_ID"		,$("#USE_INTT_ID").val()          		);
jexAjax.set("APPR_SEQ_NO"		,g_appr_seq_no   		);
jexAjax.setAsync(false);
jexAjax.execute(function(dat){
if(!jex.isError(dat)){

			if(dat.APPR_OPINION_REC.length <1){// 결재의견이 없을 경우
				
				return ;
			}
			
			var jsonRECS=dat.APPR_OPINION_REC;
			var grouped = _.groupBy(jsonRECS, 'OPINION_DATE')  // underscore plugin 을 이용해서 그룹핑해줌.

			// 날짜, 이름, 시간 순으로 그룹핑 해야함
			
			var sHtml2 ="";
			
			$.each(grouped, function(i,e){
				
				var sort = _.sortBy(e, 'OPINION_TIME') ;
				//console.log(sort);
				$.each(sort, function(j, k){
					if(jex.null2Void(k.SECRET_YN,"")=="Y" && (g_apprline_kind!="2" && g_apprline_kind!="1")){// 보안의견-> 기안자, 결재자만 보임.
						return;
					}
					if(jex.null2Void(k.INSTANT_YN,"")=="Y" && ($("#APPR_STS").val()=="3" || $("#APPR_STS").val()=="4")){// 인스턴트 의견 -> 결재완료/반송시에는 안보임
						return;
					}
					
					sHtml2+="<tr><td><div>"+jex.null2Void(k.USER_NM,"")+"</div></td>"; //작성자
					
					if(""!=jex.null2Void(k.OPINION,"")){// 의견이면
						if(k.DEL_YN=='Y'){
							sHtml2 +="<td><div style='overflow:visible;position:relative;'>"+$.i18n.prop("msg182")+"("+k.DEL_DT.substring(0,4)+"-"+k.DEL_DT.substring(4,6)+"-"+k.DEL_DT.substring(6,8)+")</div></td>";
						}else{
							sHtml2 +="<td><div style='overflow:visible;position:relative;white-space: pre-line; word-break:break-all;'>"+k.OPINION+"</div></td>";
						}

					}
					if(""!=jex.null2Void(k.ATCH_SRNO,"")){//첨부파일이면
						if(k.DEL_YN=='Y'){
							sHtml2 +="<td><div style='overflow:visible;position:relative;'>"+$.i18n.prop("msg183")+"("+k.DEL_DT.substring(0,4)+"-"+k.DEL_DT.substring(4,6)+"-"+k.DEL_DT.substring(6,8)+")</div></td>";
						}else{
							sHtml2 +="<td><div style='overflow:visible;position:relative;white-space: pre-line;'><span>"+$.i18n.prop("msg184")+"</span> : "+k.ORCP_FILE_NM+"</div></td>";
						}
						
					}
					sHtml2 +="<td><div>"+skyComm.formatterDate(i)+" "+k.OPINION_TIME.substring(0,2)+":"+k.OPINION_TIME.substring(2,4)+"</div></td>"//작성일시
				});
				
			});
			$("#DIV_OPINION_PRINT").find("tbody").empty();
			$("#DIV_OPINION_PRINT").find("tbody").append(sHtml2);
			
			
			
		}
	});
}
/**
* 직원 항목에서 직원 팝업 호출 함수
* callback, url 등 option을 정의
* @param $this : $(this)를 변수로 받음
* @returns
  */
  function addEmpl($this){
  /*var SECR_KEY		= $("#EMPL_API_KEY").val();
  var seq				= $this.closest(".tbl_cmb").attr("name").replace("EMPL_ITNM_","")
  var CALLBACK_PAGE	= $("#SERVICE_URL").val()+"/appr/appr_callback_empl.act?empl_seq="+seq;
  var options = {
  SECR_KEY            : SECR_KEY,
  POST_CALLBACK_PAGE  : CALLBACK_PAGE,
  PTL_ID 				: $("#PTL_ID").val(),
  CHNL_ID 			: $("#CHNL_ID").val(),
  USE_INTT_ID 		: $("#USE_INTT_ID").val(),
  USER_ID 			: $("#USER_ID").val(),
  PTL_USER_YN         : "N",
  SEARCH_TYPE         : "J",
  POPUP_TYPE          : "P",
  MULT_SEL_YN 		: "N"
  };
  UserSearchLayerPopup(options); //직원/연락처 조회팝업 호출 함수
  */
  var url = $("#EMPL_POP_API_URL").val()+"com_empl_01.act";
  var seq				= $this.closest(".tbl_cmb").attr("name").replace("EMPL_ITNM_","");
  var CALLBACK_PAGE	= $("#SERVICE_URL").val()+"/appr/appr_callback_empl.act?empl_seq="+seq+"&callback_fn=apprEmplCallback";
  addEmplPop(url, $("#EMPL_API_KEY").val(), $("#USER_ID").val(), $("#USE_INTT_ID").val(),"E","M", "T",CALLBACK_PAGE ,"");
  }

/**
* 첨부파일 삭제(관리자 첨부파일 삭제 옵션 사용시 사용하는 함수)
* @returns
  */
  function fn_realVouchDel(_this){
  if(confirm($.i18n.prop("msg193"))){ //첨부파일을 삭제하시겠습니까?

  	var vouch_tr_id = $(_this).parent().parent().parent().attr("id");
  	var vouch_kind = vouch_tr_id.substring(7, 8);
      var vouch_key = $(_this).parent().parent().parent().attr("vouch_seq_no");
     
      	
  	
  	var jexAjax = jex.createAjaxUtil("appr_c003"); 
      jexAjax.set("PTL_ID"                ,     g_ptl_id          );
      jexAjax.set("CHNL_ID"               ,     g_chnl_id         );
      jexAjax.set("USE_INTT_ID"           ,     g_use_intt_id     );
      jexAjax.set("USER_ID"               ,     g_user_id         );
      jexAjax.set("USER_NM"               ,     g_user_nm         );
      jexAjax.set("APPR_SEQ_NO"           , g_appr_seq_no);
      jexAjax.set("PAPER_SEQ_NO"           , g_paper_seq_no);
      jexAjax.set("VOUCH_KIND"           , vouch_kind);
      jexAjax.set("VOUCH_SEQ_NO"           , vouch_key);//삭제하려는 VOUCH_SEQ_NO
      jexAjax.set("DRAFT_USER_ID"        ,     g_draft_user_id         );
      jexAjax.set("DOC_NO"               ,     $("#DOC_NO").text()         );
      jexAjax.set("GB"               , "D"   );// 첨부파일 등록('C'), 첨부파일 삭제 ('D')
      jexAjax.setAsync(false);
      jexAjax.execute(function(dat){
      		
      	$("#frm_appr_dtl_0005").attr("action","appr_dtl_0005.act");
     		$("#frm_appr_dtl_0005").find("#HEADER_HIDDEN").val("Y");
     		$("#frm_appr_dtl_0005").target = "_self";
     		$("#frm_appr_dtl_0005").submit();	
      	parent.fn_appr_opinion_r001();
      });
  }
  }

//2020.11.13 거래처 추가팝업
function fn_addCustPop(inq_gb, item_seq_no){

	var form = document.createElement("form");
    form.appendChild(getHiddenField("PTL_ID", g_ptl_id));
    form.appendChild(getHiddenField("CHNL_ID", g_chnl_id));
    form.appendChild(getHiddenField("USE_INTT_ID", g_use_intt_id));
    form.appendChild(getHiddenField("USER_ID", g_user_id)); 
    var jsonREC={};
    var d = new Date(); 
    jsonREC["INQ_GB"]=inq_gb;
    jsonREC["CALLBACK_PAGE"]=$("#SERVICE_URL").val()+"/appr/appr_callback_card.act?item_seq_no="+item_seq_no+"&callback_fn=fn_custPop_callback";
    $("#TRMS_DT").val(d.getFullYear()+(d.getMonth() + 1));
    $("#TRMS_TKTM").val( d.getHours()+ d.getMinutes()+ d.getSeconds());
    $("#TRAN_NO").val("CRD_MAGR_L021");
    
	$("#REQ_DATA").val(encodeURIComponent(jex.toStr(jsonREC)));
	//$("#CALLBACK_PAGE").val("appr_callback_card");
	//$("#CALLBACK_PAGE").val($("#SERVICE_URL").val()+"/appr/appr_callback_card.act?item_seq_no="+item_seq_no+"&callback_fn=fn_custPop_callback");
	
	openUrl = $("#WEBANK_URL").val()+"/CRD_MAGR_L021.act"

	
	open_popup("frm_appr_dtl_0005",{sizeW:"470"  ,sizeH:"595", target:"webankPopUp",action:openUrl});

}

function fn_custPop_callback(jsonData){

	var bp_cust_rec = jsonData.BP_CUST_REC;
	var seq = jsonData.seq;
	var inq_gb= $("div[name='CUST_ITNM_"+seq+"']").length >0 ? "1" : "2";//1:거래처, 2:거래처 담당자
	var sHtml="";

	if(bp_cust_rec !=null){
		$.each(bp_cust_rec, function (i,e){
			
			var json ={};
		
			if(inq_gb=="1"){//거래처
				
				if($("div[name='CUST_ITNM_"+seq+"']").find(".name_cmb_multi_box").find("p[key='"+e.BP_CUST_NO+"']").length >0){
					return true;
				}
				
				json["BP_CUST_NO"]=e.BP_CUST_NO;
				json["BP_CUST_NM"]=e.BP_CUST_NM;
				
				sHtml +="<p class='name_cmb multi pdr15' key='"+e.BP_CUST_NO+"' data="+encodeURIComponent(JSON.stringify(json))+">"+e.BP_CUST_NM+"<a href='javascript:;'><img src='/img/ico/x_span.png' alt='' class='delete_empl'></a></p>"
			}else{//거래처 담당자
				
				if($("div[name='CUST_MANAGER_ITNM_"+seq+"']").find(".name_cmb_multi_box").find("p[key='"+e.BP_CUST_NO+"_"+e.BP_MAGR_NO+"']").length >0){
					return true;
				}
				json["BP_CUST_NO"]=e.BP_CUST_NO;
				json["BP_MAGR_NO"]=e.BP_MAGR_NO;
				json["BP_MAGR_NM"]=e.BP_MAGR_NM;
				json["BP_CUST_NM"]=e.BP_CUST_NM;
				sHtml +="<p class='name_cmb multi pdr15' key='"+e.BP_CUST_NO+"_"+e.BP_MAGR_NO+"' data="+encodeURIComponent(JSON.stringify(json))+">"+e.BP_MAGR_NM+"("+e.BP_CUST_NM+")<a href='javascript:;'><img src='/img/ico/x_span.png' alt='' class='delete_empl'></a></p>"
			}
			
		});
		
		if(inq_gb=="1"){//거래처
			$("div[name='CUST_ITNM_"+seq+"']").find(".name_cmb_multi_box").append(sHtml);//거래처명
			
		}else{//거래처 담당자
			$("div[name='CUST_MANAGER_ITNM_"+seq+"']").find(".name_cmb_multi_box").append(sHtml);//거래처 담당자
			
		}
	}



}

/**
* 저장시 크로스에디터내 테이블 태그 스타일 추가 (2021.05.25 진호용)
* @return
  */
  function fn_setTableLayout(){
  var tableTags = CrossEditor.GetBodyElementsByTagName("table");
  for(var i=0; i<tableTags.length; i++){
  if (tableTags[i].getAttribute('align') == 'center') {
  tableTags[i].style.margin = '0 auto';
  }
  tableTags[i].style.tableLayout = 'auto';
  }
  }
  /**
* 저장시 크로스에디터 글머리 스타일 추가 (2024.04.23 진호용)
* @return
  */
  function fn_setUlLayout(){
  var ulTags = CrossEditor.GetBodyElementsByTagName("ul");
  for (var i=0; i<ulTags.length; i++) {
  if (cnts_Null2Void(ulTags[i].style.listStyleType) != '') {
  ulTags[i].style.marginLeft = '40px';
  }
  }
  var olTags = CrossEditor.GetBodyElementsByTagName("ol");
  for (var i=0; i<olTags.length; i++) {
  if (cnts_Null2Void(olTags[i].style.listStyleType) != '') {
  olTags[i].style.marginLeft = '40px';
  }
  }
  }
  //2021.05.24 진호용 추가 : 크로스에디터 로드 완료 함수
  function OnInitCompleted(e) {
  editorLoadYn = "Y";
  e.editorTarget.SetBodyValue(g_paper_cont);
  }

//2021.06.23 진호용 추가 : 새로 추가한 첨부파일 펼치기 버튼 함수
function openImg(element) {
if($(element).attr("down")){
var sHtml="<tr class='nohover fileviewing' style='display:table-row;cursor:default'><td colspan='4'><img src='"+$(element).attr("url")+"' style='max-width: 100%;height: auto;'></td></tr>";            	
$(element).parent().parent().parent().after(sHtml);
$(element).text("▲");
$(element).removeAttr("down");
$(element).attr("up",true);
}else{
$(element).parent().parent().parent().next().remove();
$(element).text("▼");
$(element).removeAttr("up");
$(element).attr("down",true);
}
}

//2021.06.30 진호용 추가 : 결의 중 영수증 수정 콜벡함수
function fn_cardbill_modify_callback() {
parent.fn_appr_opinion_r001();
}

//2021.07.27 진호용 추가 : 에디터 타입 입력항목 콜벡함수
function fn_editor_callback(data) {
$("#"+data["ELEMENT_ID"]).html(data["EDITOR_CONT"]);
}

//2021.08.12 진호용 추가 : 인텍스 매입지출결의서 요약보기 버튼
function fn_intax_summary() {
if ($("#ifrm_rel").contents().find("#div_summ").length == 0) {
fn_setIntaxSummaryHtml();
}
if ($("#ifrm_rel").contents().find(".input_vbx_wrap").css("display") == "block") {
$("#ifrm_rel").contents().find("#div_summ").show();
fn_intaxReSize($("#ifrm_rel").contents().find(".input_vbx_wrap"), $("#ifrm_rel").contents().find("#div_summ"));
$("#ifrm_rel").contents().find(".input_vbx_wrap").hide();
} else {
$("#ifrm_rel").contents().find(".input_vbx_wrap").show();
fn_intaxReSize($("#ifrm_rel").contents().find("#div_summ"), $("#ifrm_rel").contents().find(".input_vbx_wrap"));
$("#ifrm_rel").contents().find("#div_summ").hide();
}
}

function fn_setIntaxSummaryHtml() {
var jexAjax = jex.createAjaxUtil("appr_tms_r001");
jexAjax.set("USE_INTT_ID", $("#ifrm_rel").contents().find("#USE_INTT_ID").val());
jexAjax.set("APPR_SEQ_NO", $("#ifrm_rel").contents().find("#APPR_SEQ_NO").val());
jexAjax.setAsync(false);
jexAjax.execute(function(data) {
var useInttId	= $("#USE_INTT_ID").val();
//계정과목 변수
var acctHtml 	= "";
var acctNm	 	= "";
var acctCnt 	= 0;
var acctSum 	= 0;
var acctAmt		= 0;
//부서 변수
var deptHtml 	= "";
var deptNm 		= "";
var deptCnt 	= 0;
var deptSum 	= 0;
var deptAmt		= 0;
//통화코드 변수
var currCd		= $.i18n.prop('tms2');
//css 변수
var mgt20Txt	= "";
//컬럼명
var jukyoColNm 	= jex.null2Void(data.JUKYO_NM,"");
var deptColNm	= jex.null2Void(data.DEPT_NM,"");
//서울반도체 하드코딩
if(useInttId==="UTLZ_1905311605341" || //개발
useInttId==="UTLZ_1907221133890" || useInttId==="UTLZ_1904031017150"){//운영(서반, 서바)
jukyoColNm = $.i18n.prop('tms3');
deptColNm  = "Cost Center";

    	}
    	if(data.TAX_TYPE==="0701"){//0701:인보이스
    		currCd = data.CURR_CD;
    	}
    	
    	var head_html = '<div id="div_summ">';
    	head_html += '	<div class="input_vbx_tit tline" style="margin-top:0px;">';
    	head_html += '		<div class="left">';
    	head_html += '			<h2 class="no-bg"></h2>';
    	head_html += '		</div>';
    	head_html += '		<div class="right">';
    	head_html += '			<label><input type="radio" name="FLAG_GB" value="ACCT_NM" onchange="parent.fn_intaxFlagChange(this)" checked> '+$.i18n.prop('tms1')+'</label>&nbsp;&nbsp;';
    	head_html += '			<label id="DEPT_COL_NM"><input type="radio" name="FLAG_GB" onchange="parent.fn_intaxFlagChange(this)"> '+contents.custom.msg('tms11', {"0":deptColNm})+'</label>';
    	head_html += '		</div>'
    	head_html += '	</div>';
    	head_html += '	<div id="acct_nm_area"></div>';
    	head_html += '	<div id="dept_nm_area" style="display:none;"></div>';
    	head_html += '</div>';
    	$("#ifrm_rel").contents().find("#div_web").append(head_html);
    	
    	//계정과목별 보기 REC
    	$.each(data.ACCT_REC,function(i,v){
    		i = i+1;
    		
    		if(jex.null2Void(v["ACCT_NM"],"")===""){
    			acctNm = $.i18n.prop('tms4');
    		}else{
    			acctNm = v["ACCT_NM"];
    		}
    		
    		//HEAD
    		if(v["LAG_ACCT_NM"]==undefined || v["LAG_ACCT_NM"] !== v["ACCT_NM"] ){
    			//2021-02-16 백소진 추가 일반형 계정과목 X || 첫번째 인 경우
    			if(jex.null2Void(v["DRCR_TP_NM"],"") !== "" || i == 1){
    				acctCnt = 0;
    				acctSum = 0;
    				
    				if(i>1)
    					mgt20Txt = " mgt20";
    				
    				acctHtml += '<div class="acct_idx'+i+'">';
    				acctHtml += '	<div class="print_ss_title">';
    				acctHtml += '		<h5 class="print_ss_tit5'+mgt20Txt+'">'+acctNm+'</h5>';
    				acctHtml += '	</div>';
    				acctHtml += '	<div class="print_ss_tbl_view">';
    				acctHtml += '		<table class="print_ss_type" summary="">';
    				acctHtml += '			<caption></caption>';
    				acctHtml += '			<colgroup><col style="width:130px;"><col style="width:92px;"><col style="width:180px;"><col><col style="width:120px;"><col style="width:140px;"></colgroup>';
    				acctHtml += '			<thead>';
    				acctHtml += '				<tr>';
    				acctHtml += '					<th scope="col"><div>'+$.i18n.prop('tms5')+'</div></th>';
    				acctHtml += '					<th scope="col"><div>'+$.i18n.prop('tms6')+'</div></th>';
    				acctHtml += '					<th scope="col"><div>'+deptColNm+'</div></th>';
    				acctHtml += '					<th scope="col"><div>'+jukyoColNm+'</div></th>';
    				acctHtml += '					<th scope="col"><div>'+$.i18n.prop('tms7')+'</div></th>';
    				acctHtml += '					<th scope="col"><div>'+$.i18n.prop('tms8')+'</div></th>';
    				acctHtml += '				</tr>';
    				acctHtml += '			</thaed>';
    				acctHtml += '			<tbody>';	        				
    			}
    			
    		}
    		
    		//CENTER 
    		acctAmt = jex.null2Void(v["DRCR_TP_NM"]) == "" ? (Math.round(v["TOT_AMT"]*100)/100) : (Math.round(v["ACCT_AMT"]*100)/100);
    		acctCnt++;
    		acctSum += acctAmt;
    		
    		acctHtml += '					<tr>';
    		acctHtml += '						<td><div>'+v["SELR_CORP_NM"]+'</div></td>';
    		acctHtml += '						<td><div class="tac">'+contents.custom.date_format(v["REGS_DATE"])+'</div></td>';
    		acctHtml += '						<td><div>'+jex.null2Void(v["DEPT_NM"])+'</div></td>';
    		acctHtml += '						<td><div>'+v["SUMMARY"]+'</div></td>';
    		acctHtml += '						<td><div>'+jex.null2Void(v["DRCR_TP_NM"])+'</div></td>';
    		acctHtml += '						<td><div>'+numberFormat(Number(acctAmt))+' ('+currCd+')</div></td>';
    		acctHtml += '					</tr>';
    		
    		//TAIL
    		if(v["LEAD_ACCT_NM"]==undefined || v["LEAD_ACCT_NM"] !== v["ACCT_NM"]){//END
    			acctSum = (Math.round(acctSum*100)/100);
    			
    			//2021-02-16 백소진 추가 일반형 차대구분X || 마지막 rec인 경우
    			if(jex.null2Void(v["DRCR_TP_NM"]) !== "" || data.ACCT_REC.length == i ){
    				acctHtml += '				<tr class="total">';
    				acctHtml += '					<td colspan="6" class="tar"><div>';
    				acctHtml += '						<p class="won"><span class="no">'+contents.custom.msg('tms9', {"0":acctCnt})+'</span> <em>'+numberFormat(Number(acctSum))+' ('+currCd+')</em></p>';
    				acctHtml += '					</div></td>';
    				acctHtml += '			</tbody>';
    				acctHtml += '		</table>';
    				acctHtml += '	</div>';
    				acctHtml += '</div>';	        				
    			}
    			
    		}
    	});
    	
    	mgt20Txt = "";
    	
    	//부서별 보기 REC
    	$.each(data.DEPT_REC,function(i,v){
    		i = i+1;
    		
    		if(jex.null2Void(v["DEPT_NM"])===""){
    			deptNm = "미설정";
    		}else{
    			deptNm = v["DEPT_NM"];
    		}
    		
    		//HEAD
    		if(v["LAG_DEPT_NM"]==undefined || v["LAG_DEPT_NM"] !== v["DEPT_NM"]){
    			deptCnt = 0;
    			deptSum = 0;
    			
    			if(i>1)
    				mgt20Txt = " mgt20";
    			
    			deptHtml += '<div class="dept_idx'+i+'">';
    			deptHtml += '	<div class="print_ss_title">';
    			deptHtml += '		<h5 class="print_ss_tit5'+mgt20Txt+'">'+deptNm+'</h5>';
    			deptHtml += '	</div>';
    			deptHtml += '	<div class="print_ss_tbl_view">';
        		deptHtml += '		<table class="print_ss_type" summary="">';
        		deptHtml += '			<caption></caption>';
        		deptHtml += '			<colgroup><col style="width:130px;"><col style="width:92px;"><col style="width:180px;"><col><col style="width:70px;"><col style="width:140px;"></colgroup>';
        		deptHtml += '			<thead>';
        		deptHtml += '				<tr>';
        		deptHtml += '					<th scope="col"><div>'+$.i18n.prop('tms5')+'</div></th>';
        		deptHtml += '					<th scope="col"><div>'+$.i18n.prop('tms6')+'</div></th>';
        		deptHtml += '					<th scope="col"><div>'+$.i18n.prop('tms10')+'</div></th>';
        		deptHtml += '					<th scope="col"><div>'+jukyoColNm+'</div></th>';
        		deptHtml += '					<th scope="col"><div>'+$.i18n.prop('tms7')+'</div></th>';
        		deptHtml += '					<th scope="col"><div>'+$.i18n.prop('tms8')+'</div></th>';
        		deptHtml += '				</tr>';
        		deptHtml += '			</thaed>';
        		deptHtml += '			<tbody>';
    		}
    		
    		//CENTER
    		deptAmt = jex.null2Void(v["DRCR_TP_NM"]) == "" ? (Math.round(v["TOT_AMT"]*100)/100) : (Math.round(v["ACCT_AMT"]*100)/100);
    		deptCnt++;
    		deptSum += deptAmt;
    		
    		deptHtml += '					<tr>';
    		deptHtml += '						<td><div>'+v["SELR_CORP_NM"]+'</div></td>';
    		deptHtml += '						<td><div class="tac">'+contents.custom.date_format(v["REGS_DATE"])+'</div></td>';
    		deptHtml += '						<td><div>'+jex.null2Void(v["ACCT_NM"],"")+'</div></td>';
    		deptHtml += '						<td><div>'+v["SUMMARY"]+'</div></td>';
    		deptHtml += '						<td><div>'+jex.null2Void(v["DRCR_TP_NM"],"")+'</div></td>';
    		deptHtml += '						<td><div>'+numberFormat(Number(deptAmt))+' ('+currCd+')</div></td>';
    		deptHtml += '					</tr>';
    		
    		//TAIL
    		if(v["LEAD_DEPT_NM"]==undefined || v["LEAD_DEPT_NM"] !== v["DEPT_NM"]){//END
    			deptSum = (Math.round(deptSum*100)/100);
    			
    			deptHtml += '				<tr class="total">';
        		deptHtml += '					<td colspan="6" class="tar"><div>';
        		deptHtml += '						<p class="won"><span class="no">'+contents.custom.msg('tms9', {"0":deptCnt})+'</span> <em>'+numberFormat(Number(deptSum))+' ('+currCd+')</em></p>';
        		deptHtml += '					</div></td>';
    			deptHtml += '			</tbody>';
        		deptHtml += '		</table>';
        		deptHtml += '	</div>';
        		deptHtml += '</div>';
    		}
    	});
    	
    	$("#ifrm_rel").contents().find(".tline .left>h2").text("("+$.i18n.prop('tms6')+": " + contents.custom.date_format(data.MIN_REGS_DATE) + " ~ " + contents.custom.date_format(data.MAX_REGS_DATE) + ")");
    	$("#ifrm_rel").contents().find("#acct_nm_area").html(acctHtml);
    	$("#ifrm_rel").contents().find("#dept_nm_area").html(deptHtml);
    	
    });
}

function fn_intaxFlagChange(element) {
var _thisValue	 = $(element).val();

	if(_thisValue==="ACCT_NM"){
		$("#ifrm_rel").contents().find("#acct_nm_area").show();
		fn_intaxReSize($("#ifrm_rel").contents().find("#dept_nm_area"), $("#ifrm_rel").contents().find("#acct_nm_area"));
		$("#ifrm_rel").contents().find("#dept_nm_area").hide();
	}else{
		$("#ifrm_rel").contents().find("#dept_nm_area").show();
		fn_intaxReSize($("#ifrm_rel").contents().find("#acct_nm_area"), $("#ifrm_rel").contents().find("#dept_nm_area"));
		$("#ifrm_rel").contents().find("#acct_nm_area").hide();
	}
}

function fn_intaxReSize(element1, element2) {
var iFrameID = document.getElementById("ifrm_rel");
var t1 = $(element1)[0].scrollHeight;
var t2 = $(element2)[0].scrollHeight;
if(iFrameID) {
iFrameID.style.height = iFrameID.contentWindow.innerHeight - t1
+ t2 + "px";
}
}

function fn_setVouchSize() {
if ($("#vouchSizeMsg").length == 0) {
var tmp_html = "";
tmp_html += "<span id='vouchSizeMsg' class='tx_canUpload'></span>";
$("#fileAttchPrint").find(".mgb5").append(tmp_html);
}
var mbSize 	  = g_limited_vouch_size/(1024*1024);
//var fixedSize = mbSize.toFixed(2);
var fixedSize = Math.floor(mbSize*100) / 100;
//fixedSize = fixedSize == "0.00" ? "0" : fixedSize;
$("#vouchSizeMsg").text(contents.custom.msg('msg204', {"0":fixedSize}));
}

function checkPdf() {
g_rcpt_img_load_cnt += 1;
if (g_real_rcpt_img_cnt == g_rcpt_img_load_cnt) {
resizeIframe0005();
setTimeout(function() {
window.status = 'ready_to_print';
}, 200);
}
}

//2023.08.07 진호용 추가 : 외부문서 첨부(cfg)
function fn_extVouchCallback(data) {
var trlength = parseInt($("#VOUCH_THEAD tr").length);
var vouchHtml = "";
data = jQuery.parseJSON(data);
if (Array.isArray(data)) {
$.each(data, function(i,v) {
var vouchNm = cnts_Null2Void(v.SITE_CD) == "" ? cnts_Null2Void(v.RESP_CD) : cnts_Null2Void(v.SITE_CD);
var url = cnts_Null2Void(v.RESP_NM);
vouchHtml += '<tr id="TR_KIND3_'+url+'">';
vouchHtml += '<input type="hidden" id="VOUCH_NM'+trlength+'" value="'+vouchNm+'" />';
vouchHtml += '<input type="hidden" id="TR_PATH'+trlength+'" value="'+url+'" />';
vouchHtml += '<td><div>외부</div></td>';//외부
vouchHtml += "<td><div style='position:relative;'><div class='elipsis'><a class='show_vouch_box' href='"+url+"' target='_blank'>"+vouchNm+"</a></div>";
vouchHtml += '<!-- 레이어 --><div class="ly_reply vouch_box" style="display:none;position:absolute;top:31px;left:10px;width:300px;">' +
'<div class="inner"><span class="bg_arr" style="left:26px;"></span>'+vouchNm+'</div></div><!-- //레이어 -->' +
'</div></td>';
vouchHtml += "<td></td>";
vouchHtml += "<td><div><input type='text' style='width:97%;' name='VOUCH_RMK'/></div></td>";
//2017.10.23 배유연 수정 : 처음 기안 작성화면만 삭제 버튼, 결재/완료 문서는 저장/취소버튼
if(g_appr_sts =="" || "RE" == g_appr_mode){ // 처음 기안 문서 작성화면
vouchHtml += "<td><div><a href='javascript:' onclick=\"fn_vouchDel(this);\"><img src='../../img/ico/ico_delete.gif' alt='"+$.i18n.prop("msg77")+"'></a></div></td>";
}
else{ // 그외에 진행, 완료 문서
vouchHtml += "<td><div><a href='javascript:;' class='fileClass btn_style3' onclick=\"fn_updateAttch_save(this);\"><span>저장</span></a><a href='javascript:;' class='fileClass btn_style3'  onclick=\"fn_vouchDel(this);\"><span>취소</span></a></div></td>";
}
vouchHtml += "</tr>";
trlength++;
});
$("#VOUCH_THEAD tr:last").after(vouchHtml);
}
}

function fn_cardSsoPop(tranNo, element) {
var jexAjax = jex.createAjaxUtil("card_api_key_r001");
jexAjax.set("PTL_ID", g_ptl_id);
jexAjax.set("CHNL_ID", g_chnl_id);
jexAjax.set("USE_INTT_ID", g_use_intt_id);
jexAjax.set("USER_ID", g_user_id);
jexAjax.set("TRAN_NO", tranNo);
jexAjax.setAsync(false);
jexAjax.execute(function(dat) {
if (!jex.isError(dat)) {
g_webank_sso_item_seq = $(element).closest("td").prev().attr("usr-attr");
fn_addCardSsoPop(tranNo, dat.CNTS_CRTC_KEY);
}
});
}

//2023.09.07 경비 SSO KEY 사용 팝업
function fn_addCardSsoPop(tranNo, ssoKey){
open_popup("frm_tmp",{sizeW:"470" ,sizeH:"510", target:"webankPopUp", action:""});

	var form = document.createElement("form");
    form.appendChild(getHiddenField("PTL_ID", g_ptl_id));
    form.appendChild(getHiddenField("CHNL_ID", g_chnl_id));
    form.appendChild(getHiddenField("USE_INTT_ID", g_use_intt_id));
    form.appendChild(getHiddenField("USER_ID", g_user_id));
	form.appendChild(getHiddenField("SSO_KEY", ssoKey));
	form.appendChild(getHiddenField("API_CODE", "APPROVAL")); 
    
	openUrl = $("#WEBANK_URL").val()+"/"+tranNo+".act"
	
	form.setAttribute("method", "post");
	form.setAttribute("action", openUrl);
	form.setAttribute("target", "webankPopUp");
	form.setAttribute("id", "frm_tmp");
	form.setAttribute("name", "frm_tmp");
	
	document.body.appendChild(form);
	
	$("#frm_tmp").submit();
	$("#frm_tmp").remove();
}

function fn_callbackSsoPop(itemType, respData) {
if (respData != null) {
var sHtml = "";
var json = {};

		if ("20" == itemType) {
			if($("th[usr-attr="+g_webank_sso_item_seq+"]").next().find(".name_cmb_multi_box").find("p[key='"+respData.CODE+"']").length >0){
				return true;
			}
			json["CODE"] = respData.CODE;
			json["ERP_CODE"] = respData.ERP_CODE;
			json["NAME"] = respData.NAME;
		
			sHtml += "<p class='name_cmb multi pdr15' key='"+respData.CODE+"' data="+encodeURIComponent(JSON.stringify(json))+">"+respData.NAME+"<a href='javascript:;'><img src='/img/ico/x_span.png' alt='' class='delete_empl'></a></p>"
		} else if ("21" == itemType) {
			if($("th[usr-attr="+g_webank_sso_item_seq+"]").next().find(".name_cmb_multi_box").find("p[key='"+respData.TRAN_KIND_CD+"']").length >0){
				return true;
			}
			json["TRAN_KIND_CD"] = respData.TRAN_KIND_CD;
			json["ERP_CD"] = respData.ERP_CD;
			json["TRAN_KIND_NM"] = respData.TRAN_KIND_NM;
			json["TRAN_GRP_CD"] = respData.TRAN_GRP_CD;
			json["TRAN_GRP_NM"] = respData.TRAN_GRP_NM;
			json["MEMO"] = respData.MEMO;
		
			sHtml += "<p class='name_cmb multi pdr15' key='"+respData.TRAN_KIND_CD+"' data="+encodeURIComponent(JSON.stringify(json))+">"+respData.TRAN_KIND_NM+"<a href='javascript:;'><img src='/img/ico/x_span.png' alt='' class='delete_empl'></a></p>"
		} else if ("23" == itemType) {
			if($("th[usr-attr="+g_webank_sso_item_seq+"]").next().find(".name_cmb_multi_box").find("p[key='"+respData.CODE+"']").length >0){
				return true;
			}
			json["CODE"] = respData.CODE;
			json["ERP_CD"] = respData.ERP_CD;
			json["NAME"] = respData.NAME;
		
			sHtml += "<p class='name_cmb multi pdr15' key='"+respData.CODE+"' data="+encodeURIComponent(JSON.stringify(json))+">"+respData.NAME+"<a href='javascript:;'><img src='/img/ico/x_span.png' alt='' class='delete_empl'></a></p>"
		}
		
		$("th[usr-attr="+g_webank_sso_item_seq+"]").next().find(".name_cmb_multi_box").empty();
		$("th[usr-attr="+g_webank_sso_item_seq+"]").next().find(".name_cmb_multi_box").append(sHtml);
	}
}

function openBgtProPop() {
var popUrl = "https://budget-dev.appplay.co.kr/bgmn_comm_0017_01.act";
var nowDate = new Date();
var year = nowDate.getFullYear();
var dateString = year + (nowDate.getMonth()+1) + nowDate.getDate();
var ptlId = g_ptl_id;
var chnlId = g_chnl_id;
var useInttId = g_use_intt_id;
var bizNo = $("#BIZ_REG_NO").val();
var userId = g_user_id;
if (popUrl.indexOf("-dev") > -1) {
ptlId = "PTL_51"
chnlId = "CHNL_1";
useInttId = "UTLZ_1610271700739";
bizNo = "2148935102";
userId = "sbook01";
}

	//팝업
	open_popup("frm_tmp",{sizeW:"966" ,sizeH:"659", target:"bgtProPopUp", action:""});
	
	var form = document.createElement("form");
    form.appendChild(getHiddenField("paramBgyyyy", year));
    form.appendChild(getHiddenField("paramBgDRAFT_DATE", dateString));
    form.appendChild(getHiddenField("paramBgPTL_ID", ptlId));
    form.appendChild(getHiddenField("paramBgCHNL_ID", chnlId));
    form.appendChild(getHiddenField("paramBgUSE_INTT_ID", useInttId));
    form.appendChild(getHiddenField("paramBgBIZ_NO", bizNo));
    form.appendChild(getHiddenField("paramBgUSER_ID", userId));
	form.appendChild(getHiddenField("paramBgCalldomain", window.location.href));
//	form.appendChild(getHiddenField("paramBgBudgetExecData", budgetExecData));

	form.setAttribute("method", "post");
	form.setAttribute("action", popUrl);
	form.setAttribute("target", "bgtProPopUp");
	form.setAttribute("id", "frm_tmp");
	form.setAttribute("name", "frm_tmp");
	
	document.body.appendChild(form);
	
	$("#frm_tmp").submit();
	$("#frm_tmp").remove();
}

function bgtProCallback(data) {
data = JSON.parse(decodeURIComponent(data));
var itemSqnoGroup = _.groupBy(data, "ITEMSQNO");
var tableHtml = '<table width="838" class="txc-table" border="0" cellspacing="0" cellpadding="0" style="margin: 0px; padding: 0px; empty-cells: show; border-collapse: collapse; width: 838px; table-layout: fixed; color: rgb(85, 85, 85); font-family: Dotum, 돋움, Gulim, 굴림, Arial, sans-serif; font-size: 12px; border: currentcolor;">';
tableHtml += '<caption></caption>';
tableHtml += '<colgroup><col style="width:94px;">';//예산항목
tableHtml += '<col style="width:94px;">';//예산분기
tableHtml += '<col style="width:259px;">';//원가부서
tableHtml += '<col style="width:90px;">';//예산
tableHtml += '<col style="width:103px;">';//해당 건 집행액
tableHtml += '<col style="width:100px;">';//누적 집행액
tableHtml += '<col style="width:92px;"></colgroup>';//잔여 예산
tableHtml += '<tbody style="margin: 0px; padding: 0px;">';
tableHtml += '<tr style="margin: 0px; padding: 0px;">';
tableHtml += '<td style="margin: 0px; padding: 0px; border: 1px solid rgb(204, 204, 204); height: 30px; background-color: rgb(246, 246, 246);">';
tableHtml += '<p style="text-align: center; line-height: 1.8;">';
tableHtml += '<span style="margin: 0px; padding: 0px; font-family: Arial;">';
tableHtml += '<b style="margin: 0px; padding: 0px;">';
tableHtml += '<span style="font-family: Arial; color: rgb(0, 0, 0); font-size: 9pt;">';
tableHtml += '<span style="color: rgb(0, 0, 0); font-family: Arial;">예산항목</span></span></b></span></p></td>';
tableHtml += '<td style="margin: 0px; padding: 0px; height: 30px; border-top: 1px solid rgb(204, 204, 204); border-right: 1px solid rgb(204, 204, 204); border-bottom: 1px solid rgb(204, 204, 204); background-color: rgb(246, 246, 246);">';
tableHtml += '<p style="text-align: center;">';
tableHtml += '<b style="font-family: Arial; text-align: center; margin: 0px; padding: 0px;">예산분기</b></p></td>';
tableHtml += '<td style="margin: 0px; padding: 0px; height: 30px; border-top: 1px solid rgb(204, 204, 204); border-right: 1px solid rgb(204, 204, 204); border-bottom: 1px solid rgb(204, 204, 204); background-color: rgb(246, 246, 246);">';
tableHtml += '<p style="text-align: center;">';
tableHtml += '<span style="margin: 0px; padding: 0px; font-family: Arial;">';
tableHtml += '<b style="margin: 0px; padding: 0px;">';
tableHtml += '<span style="font-family: Arial; color: rgb(0, 0, 0); font-size: 9pt;">';
tableHtml += '<span style="color: rgb(0, 0, 0); font-family: Arial;">원가부서</span></span></b></span></p></td>';
tableHtml += '<td style="margin: 0px; padding: 0px; height: 30px; border-top: 1px solid rgb(204, 204, 204); border-right: 1px solid rgb(204, 204, 204); border-bottom: 1px solid rgb(204, 204, 204); background-color: rgb(246, 246, 246);">';
tableHtml += '<p style="text-align: center;">';
tableHtml += '<span style="margin: 0px; padding: 0px; font-family: Arial;">';
tableHtml += '<b style="margin: 0px; padding: 0px;">';
tableHtml += '<span style="font-family: Arial; color: rgb(0, 0, 0); font-size: 9pt;">';
tableHtml += '<span style="color: rgb(0, 0, 0); font-family: Arial;">예산</span></span></b></span></p></td>';
tableHtml += '<td style="margin: 0px; padding: 0px; height: 30px; border-top: 1px solid rgb(204, 204, 204); border-right: 1px solid rgb(204, 204, 204); border-bottom: 1px solid rgb(204, 204, 204); background-color: rgb(246, 246, 246);">';
tableHtml += '<p style="text-align: center;">';
tableHtml += '<span style="margin: 0px; padding: 0px; font-family: Arial;">';
tableHtml += '<b style="margin: 0px; padding: 0px;">';
tableHtml += '<span style="font-family: Arial; color: rgb(0, 0, 0); font-size: 9pt;">';
tableHtml += '<span style="color: rgb(0, 0, 0); font-family: Arial;">해당 건 집행액</span></span></b></span></p></td>';
tableHtml += '<td style="margin: 0px; padding: 0px; height: 30px; border-top: 1px solid rgb(204, 204, 204); border-right: 1px solid rgb(204, 204, 204); border-bottom: 1px solid rgb(204, 204, 204); background-color: rgb(246, 246, 246);">';
tableHtml += '<p style="text-align: center;">';
tableHtml += '<span style="margin: 0px; padding: 0px; font-family: Arial;">';
tableHtml += '<b style="margin: 0px; padding: 0px;">';
tableHtml += '<span style="font-family: Arial; color: rgb(0, 0, 0); font-size: 9pt;">';
tableHtml += '<span style="color: rgb(0, 0, 0); font-family: Arial;">누적 집행액</span></span></b></span></p></td>';
tableHtml += '<td style="margin: 0px; padding: 0px; width: 92px; height: 30px; border-top: 1px solid rgb(204, 204, 204); border-right: 1px solid rgb(204, 204, 204); border-bottom: 1px solid rgb(204, 204, 204); background-color: rgb(246, 246, 246);">';
tableHtml += '<p style="text-align: center;">';
tableHtml += '<span style="margin: 0px; padding: 0px; font-family: Arial;">';
tableHtml += '<b style="margin: 0px; padding: 0px;">';
tableHtml += '<span style="font-family: Arial; color: rgb(0, 0, 0); font-size: 9pt;">';
tableHtml += '<span style="color: rgb(0, 0, 0); font-family: Arial;">잔여 예산</span></span></b></span></p></td>';
tableHtml += "</tr>";
$.each(itemSqnoGroup, function(i,v) {
var quarterGbnGroup = _.groupBy(v, "QUARTER_GBN");
$.each(quarterGbnGroup, function(j, quaterItem) {
$.each(quaterItem, function(k, tr) {
tableHtml += '<tr style="margin: 0px; padding: 0px;">';
if (j === 0 && k === 0) {
tableHtml += '<td rowspan="'+v.length+'" style="margin: 0px; padding: 0px; height: 28px; border-right: 1px solid rgb(204, 204, 204); border-bottom: 1px solid rgb(204, 204, 204); border-left: 1px solid rgb(204, 204, 204);">';
tableHtml += '<p style="text-align: center;">';
tableHtml += '<font face="Arial" style="margin: 0px; padding: 0px;">';
tableHtml += '<span style="font-family: Arial; color: rgb(0, 0, 0); font-size: 9pt;">';
tableHtml += '<span style="color: rgb(0, 0, 0); font-family: Arial;">';
tableHtml += bgtItem.ITEM_NM; //예산항목
tableHtml += '</span></span></font></p></td>';
}
if (k === 0) {
tableHtml += '<td rowspan="'+j.length+'" style="margin: 0px; padding: 0px; height: 28px; border-right: 1px solid rgb(204, 204, 204); border-bottom: 1px solid rgb(204, 204, 204);">';
tableHtml += '<p style="text-align: center;">';
tableHtml += '<font face="Arial" style="margin: 0px; padding: 0px;">';
tableHtml += '<span style="font-family: Arial; color: rgb(0, 0, 0); font-size: 9pt;">';
tableHtml += '<span style="color: rgb(0, 0, 0); font-family: Arial;">';
tableHtml += bgtItem.QUARTER_GBN; //예산분기
tableHtml += '</span></span></font></p></td>';
}
tableHtml += '<td style="margin: 0px; padding: 0px; height: 28px; border-right: 1px solid rgb(204, 204, 204); border-bottom: 1px solid rgb(204, 204, 204);">';
tableHtml += '<p style="text-align: left;">';
tableHtml += '<span style="color: rgb(0, 0, 0); font-family: Arial; text-align: start; white-space: nowrap; background-color: rgb(255, 255, 255);">';
tableHtml += bgtItem.UNIT_NM; //원가부서
tableHtml += '</span></p></td>';
tableHtml += "</td>";
tableHtml += '<td style="margin: 0px; padding: 0px; height: 28px; border-right: 1px solid rgb(204, 204, 204); border-bottom: 1px solid rgb(204, 204, 204);">';
tableHtml += '<p style="text-align: right;">';
tableHtml += '<span style="color: rgb(0, 0, 0); font-family: Arial; text-align: start; white-space: nowrap; background-color: rgb(255, 255, 255);">';
tableHtml += bgtItem.QUARTER_BUDGET_AMT; //예산
tableHtml += '</span></p></td>';
tableHtml += "</td>";
tableHtml += '<td style="margin: 0px; padding: 0px; height: 28px; border-right: 1px solid rgb(204, 204, 204); border-bottom: 1px solid rgb(204, 204, 204);">';
tableHtml += '<p style="text-align: right;">';
tableHtml += '<span style="color: rgb(0, 0, 0); font-family: Arial; text-align: start; white-space: nowrap; background-color: rgb(255, 255, 255);">';
tableHtml += bgtItem.ACCUMULATE_AMT; //해당 건 집행액
tableHtml += '</span></p></td>';
tableHtml += "</td>";
tableHtml += '<td style="margin: 0px; padding: 0px; height: 28px; border-right: 1px solid rgb(204, 204, 204); border-bottom: 1px solid rgb(204, 204, 204);">';
tableHtml += '<p style="text-align: right;">';
tableHtml += '<span style="color: rgb(0, 0, 0); font-family: Arial; text-align: start; white-space: nowrap; background-color: rgb(255, 255, 255);">';
tableHtml += bgtItem.CURR_AMT; //누적집행액
tableHtml += '</span></p></td>';
tableHtml += "</td>";
tableHtml += '<td style="margin: 0px; padding: 0px; height: 28px; border-right: 1px solid rgb(204, 204, 204); border-bottom: 1px solid rgb(204, 204, 204);">';
tableHtml += '<p style="text-align: right;">';
tableHtml += '<span style="color: rgb(0, 0, 0); font-family: Arial; text-align: start; white-space: nowrap; background-color: rgb(255, 255, 255);">';
tableHtml += bgtItem.REMAIN_BUDGET_AMT; //잔여예산
tableHtml += '</span></p></td>';
tableHtml += "</td>";
tableHtml += "</tr>";
});
});
});
tableHtml += "</tbody></table>";

	Editor.modify({
		inputmode : "original",
		content   : Editor.getContent() +"<br>"+ tableHtml
	});
}

function reloadTmpList() {
if (opener) {
window.opener.postMessage("reloadTmpList", "*");
}
}

function resizeIframe0005() {
try {
var iframe = parent.document.getElementById("ifrm_0005");
if (!iframe) return false;

		var innerDoc = iframe.contentDocument || iframe.contentWindow.document;
		var newH = innerDoc.body.scrollHeight;
		newH += 100;
		if (newH < 738) newH = 738;
		$(parent.document).find(".pop_container").css("height", newH+"px");
	} catch(e) {console.log(e);}
}
