/**
 * Flow 메시지 중앙 관리
 * - 모든 Flow 알림 메시지를 한 곳에서 관리
 * - sendFlowMsg() 헬퍼로 일관된 발송
 */

var FLOW_LINK = {
  DASHBOARD: 'https://rosarosakim.github.io/edu-book-dashboard/edu-book-dashboard.html?tab=dashboard',
       CARD: 'https://rosarosakim.github.io/edu-book-dashboard/edu-book-dashboard.html?tab=card',
   APPROVAL: 'https://rosarosakim.github.io/edu-book-dashboard/edu-book-dashboard.html?tab=approval',
       LIFE: 'https://rosarosakim.github.io/edu-book-dashboard/edu-book-dashboard.html?tab=life'
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
  // #4 밥카 자동결재 모드별 통합 알림 (14일+1영업일)
  cardAutoAlarm: function(mode, amount) {
    if (mode === 'alarm') {
      return {
        content: '밥값은 회사가, 결재는 내가!\n링크를 클릭하면 밥카메뉴에서 바로 결재할 수 있어',
        link: FLOW_LINK.CARD,
        previewTitle: '🍚 밥카결재하는날'
      };
    }
    var fmt = _fmtMoney(amount);
    if (mode === 'draft') {
      return {
        content: 'Bizplay에 임시저장했어',
        link: FLOW_LINK.APPROVAL,
        previewTitle: '📝 밥카 ' + fmt + '원 임시저장'
      };
    }
    // submit
    return {
      content: 'Bizplay에 결재요청했어',
      link: FLOW_LINK.APPROVAL,
      previewTitle: '🚀 밥카 ' + fmt + '원 결재요청'
    };
  },
  // #5 밥카 미결재 리마인더
  cardReminder: function() {
    return {
      content: '아직 밥카 결재 안한 것 같아...\n링크를 클릭하면 밥카메뉴에서 바로 결재할 수 있어',
      link: FLOW_LINK.CARD,
      previewTitle: '⏰ 밥카결재 마지막날'
    };
  },
  // #6 밥카 잔액 알림
  cardDailyBalance: function(remain, budget, used, count) {
    var remainDays = _calcRemainingBizDays();
    var dailyAvg = remainDays > 0 ? Math.round(remain / remainDays) : 0;
    return {
      content: '남은 출근일 ' + remainDays + '일\n일평균잔액 ' + _fmtMoney(dailyAvg) + '원',
      link: FLOW_LINK.CARD,
      previewTitle: '💵 ' + (new Date().getMonth()+1) + '월' + new Date().getDate() + '일 잔액 ' + _fmtMoney(remain) + '원'
    };
  },
  // #6b 밥카 다중카드 잔액 알림 (합산 메시지)
  cardDailyBalanceMulti: function(cardSummaries) {
    // cardSummaries: [{ name, remain, used, hasLimit, isLunch }]
    var remainDays = _calcRemainingBizDays();
    var parts = cardSummaries.map(function(c) {
      if (c.isLunch || c.hasLimit) {
        return c.name + ': 잔액 ' + _fmtMoney(c.remain) + '원';
      }
      return c.name + ': 사용 ' + _fmtMoney(c.used) + '원';
    });
    var lunchCard = cardSummaries.find(function(c) { return c.isLunch; });
    var dailyAvg = (lunchCard && remainDays > 0) ? Math.round(lunchCard.remain / remainDays) : 0;
    return {
      content: parts.join(' | ') + '\n남은 출근일 ' + remainDays + '일',
      link: FLOW_LINK.CARD,
      previewTitle: '💵 ' + (new Date().getMonth()+1) + '월' + new Date().getDate() + '일 ' + (lunchCard ? '잔액 ' + _fmtMoney(lunchCard.remain) + '원' : parts[0])
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
  // #8 밥카 자동결재요청 실패
  cardAutoFail: function(mode, reason) {
    var label = mode === 'draft' ? '임시저장' : mode === 'submit' ? '결재요청' : '알림';
    return {
      content: '[' + label + '모드] 자동 처리 실패\n사유: ' + reason,
      link: FLOW_LINK.CARD,
      previewTitle: '밥카 자동결재 실패'
    };
  },
  // #9 교육/도서 신청서 동기화 실패
  // #10 오늘의 식단 알림
  todayMenu: function(date, menus) {
    return {
      content: '🍽 오늘의 식단 (' + date + ')\n\n' + menus,
      link: '',
      previewTitle: '오늘의 당산푸드스토리'
    };
  },

  // #11 이쏜미 초대 메시지
  itsOnMeInvite: function(creatorName, store, deadlineStr, sessionId) {
    return {
      content: store + ' · ' + deadlineStr + ' 마감\n\n링크 눌러서 메뉴 골라줘',
      link: FLOW_LINK.LIFE + '&itsOnMe=' + sessionId,
      previewTitle: '☕ ' + creatorName + ' 프로가 메뉴 주문을 받고 있어'
    };
  },
  // #12 이쏜미 취합 결과
  itsOnMeSummary: function(store, responses) {
    var total = responses.length;
    var totalPrice = 0;
    // 메뉴+옵션 조합으로 그룹핑
    var groups = {};
    var noChoice = [];
    for (var i = 0; i < responses.length; i++) {
      var r = responses[i];
      if (!r.menu) { noChoice.push(r.name); continue; }
      totalPrice += (r.price || 0);
      var key = r.menu + (r.options ? ' (' + r.options + ')' : '');
      if (!groups[key]) groups[key] = { label: key, names: [], price: r.price || 0 };
      groups[key].names.push(r.name);
    }
    var lines = [];
    var idx = 1;
    var keys = Object.keys(groups);
    for (var j = 0; j < keys.length; j++) {
      var g = groups[keys[j]];
      var priceTag = g.price ? ' ' + g.price.toLocaleString() + '원' : '';
      lines.push(idx + '. ' + g.label + priceTag + ' x' + g.names.length + '\n   - ' + g.names.join(', '));
      idx++;
    }
    if (noChoice.length) {
      lines.push('\n미선택 x' + noChoice.length + '\n   - ' + noChoice.join(', '));
    }
    if (totalPrice > 0) {
      lines.push('\n총 금액: ' + totalPrice.toLocaleString() + '원');
    }
    return {
      content: lines.join('\n\n'),
      link: '',
      previewTitle: '☕ ' + store + ' 주문 취합 (' + total + '명' + (totalPrice ? ', ' + totalPrice.toLocaleString() + '원' : '') + ')'
    };
  },
  // #12b 이쏜미 세션 변경 알림 (발송자에게)
  itsOnMeUpdate: function(actorName, action) {
    return {
      content: actorName + ' 프로가 ' + action,
      link: '',
      previewTitle: '☕ 이쏜미 ' + action
    };
  },
  // #12c 이쏜미 마감 임박 리마인드
  itsOnMeReminder: function(store, deadlineStr, sessionId) {
    return {
      content: '아직 메뉴를 안 골랐어! ' + deadlineStr + '에 마감이야.',
      link: FLOW_LINK.LIFE + '&itsOnMe=' + sessionId,
      previewTitle: '⏰ ' + store + ' 마감 5분 전!'
    };
  },

  // #13 투표 초대
  voteInvite: function(creatorName, title, deadlineStr, sessionId) {
    return {
      content: deadlineStr + ' 마감\n\n링크 눌러서 투표해줘',
      link: FLOW_LINK.LIFE + '&vote=' + sessionId,
      previewTitle: '📊 ' + title
    };
  },
  // #14 투표 리마인드
  voteReminder: function(title, deadlineStr, sessionId) {
    return {
      content: '아직 투표 안 했어! ' + deadlineStr + '에 마감이야.',
      link: FLOW_LINK.LIFE + '&vote=' + sessionId,
      previewTitle: '⏰ 투표 마감 5분 전!'
    };
  },
  // #15 투표 결과 (전원 발송)
  voteResult: function(title, items, tally, totalVoters, isAnon) {
    var lines = [];
    var totalVotes = 0;
    for (var i = 0; i < items.length; i++) {
      var t = tally[items[i]];
      if (t) totalVotes += t.count;
    }
    for (var j = 0; j < items.length; j++) {
      var entry = tally[items[j]];
      var count = entry ? entry.count : 0;
      var pct = totalVotes > 0 ? Math.round(count / totalVotes * 100) : 0;
      var line = (j + 1) + '. ' + items[j] + ' — ' + count + '표 (' + pct + '%)';
      if (!isAnon && entry && entry.names && entry.names.length) {
        line += '\n   ' + entry.names.join(', ');
      }
      lines.push(line);
    }
    return {
      content: lines.join('\n\n'),
      link: '',
      previewTitle: '📊 ' + title + ' 결과 (' + totalVoters + '명 참여)'
    };
  },

  syncFail: function(reason) {
    return {
      content: '교육/도서 신청서 자동 동기화 실패\n사유: ' + reason,
      link: FLOW_LINK.DASHBOARD,
      previewTitle: '⚠️ 신청서 동기화 실패'
    };
  }
};

/** FLOW_MSG 헬퍼: 메시지 객체로 Flow 발송 (이쏜미/투표 링크에만 자동 인증 토큰 삽입) */
function sendFlowMsg(knoxId, msg) {
  var link = msg.link;
  if (link && (link.indexOf('&itsOnMe=') !== -1 || link.indexOf('&vote=') !== -1)) {
    var ft = _generateFlowToken(knoxId);
    link += '&ft=' + ft;
  }
  return sendFlowGAS(knoxId, msg.content, link, msg.previewTitle);
}
