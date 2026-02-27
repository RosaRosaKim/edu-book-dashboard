/**
 * 웹페이지관리 시트에서 UUID가 없는 기존 사용자들에게
 * 일괄적으로 UUID를 생성하여 채워주는 관리용 함수
 */
function generateExistingUUIDs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const adminSheet = ss.getSheetByName(SHEET_NAME.ADMIN);
  if (!adminSheet) return;

  const data = adminSheet.getDataRange().getValues();
  const uuidColIndex = 2; // C열 (0부터 시작하므로 2)

  data.forEach((row, index) => {
    if (index === 0) return; // 헤더 제외

    // UUID가 비어 있는 경우에만 새로 생성해서 채움
    if (!row[uuidColIndex]) {
      const newUuid = Utilities.getUuid();
      // 시트는 1부터 시작하므로 index + 1, 열은 C열이므로 3
      adminSheet.getRange(index + 1, 3).setValue(newUuid);
      console.log(`${index + 1}행: 새로운 UUID 생성 완료 (${newUuid})`);
    }
  });

  SpreadsheetApp.getUi().alert("UUID가 없는 모든 사용자에게 고유 토큰 배정이 완료되었습니다.");
}