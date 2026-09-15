'use strict';
// 屏蔽提示页：说清"被拦了什么、为什么"，并给出回得去的出口（学生不会卡死在那里）
(function () {
  const { api, esc, param } = window.GN;

  const REASON_TEXT = {
    rule: ['被屏蔽的网站', '这个网址命中了老师设置的屏蔽名单。'],
    'not-allowlisted': ['不在允许清单里', '现在只允许访问老师指定的网站。'],
    locked: ['课堂锁定中', '现在还不能上网，请等老师发布任务。'],
  };

  const url = param('url');
  const reason = param('reason') || 'rule';
  const rule = param('rule');
  const note = param('note');

  const t = REASON_TEXT[reason] || REASON_TEXT.rule;
  document.getElementById('headline').textContent = t[0];
  document.getElementById('sub').textContent = t[1];
  document.getElementById('url-box').textContent = url || '(未记录到网址)';
  if (rule || note) {
    document.getElementById('rule-line').textContent =
      '拦截依据：' + (rule ? '规则「' + rule + '」' : '') + (note ? '　备注：' + note : '');
  }

  document.getElementById('btn-home').onclick = () => api.openInternal('home');
  document.getElementById('btn-back').onclick = () => { if (api.back) api.back(); };
})();
