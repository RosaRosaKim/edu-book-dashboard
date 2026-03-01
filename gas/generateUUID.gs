/**
 * 웹페이지관리 시트에서 UUID가 없는 기존 사용자들에게
 * 일괄적으로 UUID를 생성하여 채워주는 관리용 함수
 * (스프레드시트 메뉴에서 수동 실행용)
 */
function generateExistingUUIDs() {
  _generateUUIDs(false);
  SpreadsheetApp.getUi().alert("UUID가 없는 모든 사용자에게 고유 토큰 배정 완료!");
}

/**
 * 매월 20일 트리거: 전체 UUID 초기화 (기존 UUID도 새로 발급)
 * 트리거 설정: 시간 기반 트리거 → 매월 20일
 */
function resetAllUUIDs() {
  const count = _generateUUIDs(true);
  console.log(`[UUID 초기화] ${count}명의 UUID 갱신 완료!`);
}

/**
 * UUID 생성 공통 로직
 * @param {boolean} forceAll - true: 모든 사용자 UUID 재발급, false: 빈 행만 채움
 * @returns {number} 변경된 행 수
 */
function _generateUUIDs(forceAll) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const adminSheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  if (!adminSheet) return 0;

  const data = adminSheet.getDataRange().getValues();
  const uuidColIndex = 2; // C열 (0부터 시작)
  let count = 0;

  data.forEach((row, index) => {
    if (index === 0) return; // 헤더 제외
    if (!row[0]) return; // knoxId가 없으면 건너뛰기

    if (forceAll || !row[uuidColIndex]) {
      const newUuid = Utilities.getUuid();
      adminSheet.getRange(index + 1, 3).setValue(newUuid);
      count++;
    }
  });

  return count;
}