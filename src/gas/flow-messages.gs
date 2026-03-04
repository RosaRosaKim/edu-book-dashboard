/**
 * Flow 메시지 중앙 관리
 * - 모든 Flow 알림 메시지를 한 곳에서 관리
 * - sendFlowMsg() 헬퍼로 일관된 발송
 */

var FLOW_LINK = {
  DASHBOARD: 'https://rosarosakim.github.io/edu-book-dashboard/edu-book-dashboard.html?tab=dashboard',
       CARD: 'https://rosarosakim.github.io/edu-book-dashboard/edu-book-dashboard.html?tab=card'
};

var FLOW_MSG = {
  // #1 교육비 잔액 안내 (관리자→사용자)
  balanceInfo: function(used, remain, limit, pending) {
    var lines = [
      '- 사용 금액: ' + used.toLocaleString() + '원',
    ];
    if (pending > 0) lines.push('- 진행중 금액: ' + pending.toLocaleString() + '원');
    lines.push('- 잔여 금액: ' + remain.toLocaleString() + '원');
    lines.push('- 연간 한도: ' + limit.toLocaleString() + '원');
    return {
      content: lines.join('\n'),
      link: FLOW_LINK.DASHBOARD,
      previewTitle: '📚 교육비 잔액'
    };
  },
  // #2 결재 완료. 교육/도서 신청서 시트에 변경이 발생할 때 트리거
  approvalComplete: function(reqType, docId, title, cost, totalUsed, remain) {
    return {
      content: '- 문서번호: ' + docId + '\n- 과정/도서명: ' + title + '\n- 금액: ' + Number(cost).toLocaleString() + '원\n- 총 사용: ' + totalUsed.toLocaleString() + '원\n- 잔액: ' + remain.toLocaleString() + '원',
      link: FLOW_LINK.DASHBOARD,
      previewTitle: '✅ '+reqType + ' 결재 완료'
    };
  },
  // #3 결재 완료 (레거시). 레거시 알람 프로세스 (개별 행 단위로 호출되는 함수)
  approvalNotice: function(title, cost, totalUsed, remain) {
    return {
      content: '과정: ' + title + '\n- 금액: ' + Number(cost).toLocaleString() + '원\n- 총 사용: ' + totalUsed.toLocaleString() + '원\n- 잔액: ' + remain.toLocaleString() + '원',
      link: FLOW_LINK.DASHBOARD,
      previewTitle: '📖 교육비 잔액 안내'
    };
  },
  // #4 밥카 결재 안내 (14일+1영업일)
  cardDay14: function() {
    return {
      content: '밥값은 회사가, 결재는 내가! \n 링크를 클릭하면 밥카메뉴에서 바로 결재할 수 있어',
      link: FLOW_LINK.CARD,
      previewTitle: '🍚 밥카결재하는날'
    };
  },
  // #5 밥카 미결재 리마인더
  cardReminder: function() {
    return {
      content: '아직 밥카 결재 안한 것 같아...\n 링크를 클릭하면 밥카메뉴에서 바로 결재할 수 있어',
      link: FLOW_LINK.CARD,
      previewTitle: '⏰ 밥카결재 마지막날'
    };
  },
  // #6 밥카 잔액 알림
  cardDailyBalance: function(remain, budget, used, count) {
    var remainDays = _calcRemainingBizDays();
    var dailyAvg = remainDays > 0 ? Math.round(remain / remainDays) : 0;
    var comment = '';
    if (dailyAvg >= 15000) comment = ' 스테이크 가능 🥩';
    else if (dailyAvg < 8000) comment = ' 편의점 각 🏪';

    return {
      content: '밥카 잔액: ' + _fmtMoney(remain) + '원 (남은 출근일 ' + remainDays + '일)\n일평균잔액 ' + _fmtMoney(dailyAvg) + '원' + comment,
      link: FLOW_LINK.CARD,
      previewTitle: '💵 ' + (new Date().getMonth()+1) + '월' + new Date().getDate() + '일 잔액 ' + _fmtMoney(remain) + '원'
    };
  },
  // #7 밥카 초과 사용 환불 안내
  cardRefund: function(overAmount, periodLabel) {
    return {
      content: periodLabel + ' 밥카 한도 초과분 ' + _fmtMoney(overAmount) + '원을 환불해 줘.\n\n🏦 신한은행 100-023-136929 (주)엠로',
      link: FLOW_LINK.CARD,
      previewTitle: '🐷 왜케 많이 먹었어..'
    };
  },
  // #8 BizFlow 인증번호
  verifyCode: function(code) {
    return {
      content: 'BizFlow 인증번호: ' + code + '\n\n5분 내에 입력해줘.',
      link: FLOW_LINK.DASHBOARD,
      previewTitle: '🔐 본인 맞죠?'
    };
  },
  // #8 밥카 자동결재 성공
  cardAutoSuccess: function(mode, count) {
    var label = mode === 'draft' ? '임시저장' : mode === 'submit' ? '결재요청' : '알림';
    return {
      content: '밥카 자동 ' + label + ' 완료! (' + count + '건)',
      link: FLOW_LINK.CARD,
      previewTitle: '밥카 자동결재 완료'
    };
  },
  // #9 밥카 자동결재 실패
  cardAutoFail: function(mode, reason) {
    var label = mode === 'draft' ? '임시저장' : mode === 'submit' ? '결재요청' : '알림';
    return {
      content: '밥카 자동 ' + label + ' 실패\n사유: ' + reason,
      link: FLOW_LINK.CARD,
      previewTitle: '밥카 자동결재 실패'
    };
  }
};

/** FLOW_MSG 헬퍼: 메시지 객체로 Flow 발송 */
function sendFlowMsg(knoxId, msg) {
  return sendFlowGAS(knoxId, msg.content, msg.link, msg.previewTitle);
}
