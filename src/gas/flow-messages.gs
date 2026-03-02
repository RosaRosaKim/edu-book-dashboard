/**
 * Flow 메시지 중앙 관리
 * - 모든 Flow 알림 메시지를 한 곳에서 관리
 * - sendFlowMsg() 헬퍼로 일관된 발송
 */

var FLOW_LINK = {
  DASHBOARD: 'https://rosarosakim.github.io/edu-book-dashboard/edu-book-dashboard.html',
  CARD: 'https://rosarosakim.github.io/edu-book-dashboard/edu-book-dashboard.html?tab=card'
};

var FLOW_MSG = {
  // #1 교육비 잔액 안내 (관리자→사용자)
  balanceInfo: function(used, remain, limit) {
    return {
      content: '- 사용 금액: ' + used.toLocaleString() + '원\n- 잔여 금액: ' + remain.toLocaleString() + '원\n- 연간 한도: ' + limit.toLocaleString() + '원',
      link: FLOW_LINK.DASHBOARD,
      previewTitle: '교육비 잔액 안내'
    };
  },
  // #2 결재 완료. 교육/도서 신청서 시트에 변경이 발생할 때 트리거
  approvalComplete: function(reqType, docId, title, cost, totalUsed, remain) {
    return {
      content: '- 문서번호: ' + docId + '\n- 과정/도서명: ' + title + '\n- 금액: ' + Number(cost).toLocaleString() + '원\n- 총 사용: ' + totalUsed.toLocaleString() + '원\n- 잔액: ' + remain.toLocaleString() + '원',
      link: FLOW_LINK.DASHBOARD,
      previewTitle: reqType + ' 결재 완료'
    };
  },
  // #3 결재 완료 (레거시). 레거시 알람 프로세스 (개별 행 단위로 호출되는 함수)
  approvalNotice: function(title, cost, totalUsed, remain) {
    return {
      content: '과정: ' + title + '\n- 금액: ' + Number(cost).toLocaleString() + '원\n- 총 사용: ' + totalUsed.toLocaleString() + '원\n- 잔액: ' + remain.toLocaleString() + '원',
      link: FLOW_LINK.DASHBOARD,
      previewTitle: '교육비 잔액 안내'
    };
  },
  // #4 밥카 결재 안내 (15일)
  cardDay15: function() {
    return {
      content: '밥값은 회사가, 결재는 내가! 🍚',
      link: FLOW_LINK.CARD,
      previewTitle: '밥카결재하자'
    };
  },
  // #5 밥카 미결재 리마인더
  cardReminder: function() {
    return {
      content: '아직 밥카 결재 안한 것 같아...',
      link: FLOW_LINK.CARD,
      previewTitle: '밥카결재하자'
    };
  },
  // #6 밥카 잔액 알림
  cardDailyBalance: function(remain, budget, used, count) {
    return {
      content: '밥카 잔액: ' + _fmtMoney(remain) + '원 / ' + _fmtMoney(budget) + '원 (사용 ' + _fmtMoney(used) + '원, ' + count + '건)',
      link: FLOW_LINK.CARD,
      previewTitle: '잔액알림'
    };
  }
};

/** FLOW_MSG 헬퍼: 메시지 객체로 Flow 발송 */
function sendFlowMsg(knoxId, msg) {
  return sendFlowGAS(knoxId, msg.content, msg.link, msg.previewTitle);
}
