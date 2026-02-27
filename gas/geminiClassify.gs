/**
 * [주1회 수동/트리거 실행] 시트 내장 =GEMINI() 수식으로 교육/도서 데이터를 분류하여
 * AI자동분류 시트에 (분류명, 빈도, 금액) 집계 결과를 갱신
 *
 * 흐름:
 *   1. 완료 건 수집 → "AI분류작업" 헬퍼 시트에 과정명 + GEMINI 수식 쓰기
 *   2. GEMINI 수식이 시트 내부에서 자동 분류 (대기)
 *   3. 분류 결과 읽어서 "AI자동분류" 시트에 집계
 *
 * 사전 설정: 없음 (API 키 불필요, 시트 내장 Gemini 사용)
 */

var HELPER_SHEET_NAME_ = "AI분류작업";
var POLL_INTERVAL_MS_  = 15000;  // 수식 완료 확인 간격 15초
var POLL_TIMEOUT_MS_   = 600000; // 최대 대기 10분 (GAS 6분 제한 고려 시 조정)

var CLASSIFY_PROMPT_ = '다음 교육/도서 과정명을 아래 7개 분류 중 하나로만 답해줘. 분류명만 출력해. '
  + '분류: AI 툴 구독, 외국어/커뮤니케이션, AI/데이터 분석/ML, 보안, S/W 개발/DevOps/인프라, 경영/전략/직무 일반, 기타/미분류. '
  + '과정명: ';

function runGeminiClassify() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dataSheet = ss.getSheetByName(SHEET_NAME.DATA);
  var bookSheet = ss.getSheetByName(SHEET_NAME.BOOK);
  var aiSheet   = ss.getSheetByName(SHEET_NAME.AI);

  if (!aiSheet) { console.log("AI자동분류 시트 없음"); return; }

  // 1. 완료 건 수집
  var items = collectCompletedItems_(dataSheet, bookSheet);
  if (items.length === 0) { console.log("분류 대상 없음"); return; }
  console.log("분류 대상: " + items.length + "건");

  // 2. 헬퍼 시트 생성/초기화 → 과정명 + GEMINI 수식 쓰기
  var helper = getOrCreateHelperSheet_(ss);
  writeItemsWithFormula_(helper, items);
  SpreadsheetApp.flush(); // 수식 실행 트리거

  // 3. GEMINI 수식 완료 대기
  console.log("GEMINI 수식 처리 대기 중...");
  var success = waitForFormulas_(helper, items.length);
  if (!success) {
    console.error("시간 초과: 일부 수식이 아직 처리 중입니다. 나중에 collectResults 수동 실행하세요.");
    return;
  }

  // 4. 결과 읽기 → 집계 → AI자동분류 시트 갱신
  collectAndWriteResults_(helper, aiSheet, items);

  console.log("분류 완료!");
}

/**
 * GEMINI 수식이 이미 완료된 상태에서 결과만 집계 (수동 실행용)
 */
function collectResults() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var helper  = ss.getSheetByName(HELPER_SHEET_NAME_);
  var aiSheet = ss.getSheetByName(SHEET_NAME.AI);

  if (!helper || !aiSheet) { console.log("필수 시트 없음"); return; }

  var lastRow = helper.getLastRow();
  if (lastRow <= 1) { console.log("헬퍼 시트에 데이터 없음"); return; }

  var data = helper.getRange(2, 1, lastRow - 1, 3).getValues(); // A:과정명, B:금액, C:분류결과
  var items = data.map(function (row) {
    return { title: row[0], cost: Number(row[1]) || 0 };
  });

  collectAndWriteResults_(helper, aiSheet, items);
  console.log("집계 완료!");
}

/** 매주 월요일 오전 9시 실행 트리거 등록 (1회만 실행) */
function createWeeklyTrigger() {
  ScriptApp.newTrigger("runGeminiClassify")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .create();
}

// ─────────────────────────────────────────────
//  내부 함수
// ─────────────────────────────────────────────

/** 완료 건 수집 */
function collectCompletedItems_(dataSheet, bookSheet) {
  var items = [];
  [dataSheet, bookSheet].forEach(function (sheet) {
    if (!sheet) return;
    var rows = sheet.getDataRange().getValues();
    rows.shift();
    rows.forEach(function (row) {
      if (String(row[DATA_COL.STATUS]).trim() === "완료") {
        items.push({
          title: String(row[DATA_COL.TITLE]),
          cost:  Number(row[DATA_COL.COST]) || 0
        });
      }
    });
  });
  return items;
}

/** 헬퍼 시트 생성 또는 초기화 */
function getOrCreateHelperSheet_(ss) {
  var sheet = ss.getSheetByName(HELPER_SHEET_NAME_);
  if (!sheet) {
    sheet = ss.insertSheet(HELPER_SHEET_NAME_);
  } else {
    sheet.clear();
  }
  // 헤더
  sheet.getRange(1, 1, 1, 3).setValues([["과정명", "금액", "분류결과"]]);
  sheet.getRange(1, 1, 1, 3).setFontWeight("bold");
  return sheet;
}

/** 헬퍼 시트에 과정명 + 금액 + GEMINI 수식 쓰기 */
function writeItemsWithFormula_(helper, items) {
  var rows = items.map(function (item, i) {
    var rowNum = i + 2; // 데이터는 2행부터
    return [
      item.title,
      item.cost,
      '=GEMINI("' + CLASSIFY_PROMPT_ + '" & A' + rowNum + ')'
    ];
  });

  helper.getRange(2, 1, rows.length, 3).setValues(rows);
  console.log(rows.length + "건 수식 입력 완료");
}

/** GEMINI 수식 완료 대기 (폴링) */
function waitForFormulas_(helper, itemCount) {
  var elapsed = 0;

  while (elapsed < POLL_TIMEOUT_MS_) {
    Utilities.sleep(POLL_INTERVAL_MS_);
    elapsed += POLL_INTERVAL_MS_;
    SpreadsheetApp.flush();

    var values = helper.getRange(2, 3, itemCount, 1).getDisplayValues();
    var pending = 0;
    for (var i = 0; i < values.length; i++) {
      var v = values[i][0];
      if (!v || v === "Loading..." || v === "로드 중..." || v === "#BUSY!" || v === "") {
        pending++;
      }
    }

    console.log("[" + Math.round(elapsed / 1000) + "초] 완료: " + (itemCount - pending) + "/" + itemCount);

    if (pending === 0) return true;
  }

  return false;
}

/** 헬퍼 시트 결과 읽기 → 집계 → AI자동분류 시트 갱신 */
function collectAndWriteResults_(helper, aiSheet, items) {
  var lastRow = helper.getLastRow();
  var data = helper.getRange(2, 1, lastRow - 1, 3).getDisplayValues();

  // 유효 분류명 목록
  var validCategories = [
    "AI 툴 구독", "외국어/커뮤니케이션", "AI/데이터 분석/ML",
    "보안", "S/W 개발/DevOps/인프라", "경영/전략/직무 일반", "기타/미분류"
  ];

  var classified = data.map(function (row, i) {
    var raw = String(row[2]).trim();
    // 유효 분류명이 아니면 기타로
    var category = "기타/미분류";
    for (var j = 0; j < validCategories.length; j++) {
      if (raw.indexOf(validCategories[j]) !== -1) {
        category = validCategories[j];
        break;
      }
    }
    return {
      title:    row[0],
      cost:     Number(row[1]) || 0,
      category: category
    };
  });

  // 집계
  var summary = aggregateByCategory_(classified);
  writeToAiSheet_(aiSheet, summary);

  console.log(summary.length + "개 카테고리, " + classified.length + "건 집계 완료");
  summary.forEach(function (s) {
    console.log("  " + s.name + ": " + s.frequency + "건, " + s.amount + "원");
  });
}

/** 분류별 집계 */
function aggregateByCategory_(classified) {
  var map = {};
  classified.forEach(function (item) {
    var cat = item.category;
    if (!map[cat]) map[cat] = { name: cat, frequency: 0, amount: 0 };
    map[cat].frequency += 1;
    map[cat].amount += item.cost;
  });
  return Object.values(map).sort(function (a, b) { return b.amount - a.amount; });
}

/** AI자동분류 시트 갱신 */
function writeToAiSheet_(aiSheet, summary) {
  var lastRow = aiSheet.getLastRow();
  if (lastRow > 1) {
    aiSheet.getRange(2, 1, lastRow - 1, 3).clearContent();
  }
  if (summary.length > 0) {
    var values = summary.map(function (s) { return [s.name, s.frequency, s.amount]; });
    aiSheet.getRange(2, 1, values.length, 3).setValues(values);
  }
}
