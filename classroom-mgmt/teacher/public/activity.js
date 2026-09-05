'use strict';
// =============================================================================
// 教师大屏 · 活动发布与计时控制
//
// 职责：发布活动（预设/自定义 + 可选计时）、进行中活动计时条（暂停/继续/调时长/
// 重计时/结束）、截止提醒（SSE activity.timer）、锁定策略开关（open/activity）。
//
// 依赖 window.Dashboard（api/toast/esc/refreshSoon）；snapshot 通过 app.js 的
// onSnapshot 钩子喂入；SSE 事件经 stream.js 转发到 onSse。
// =============================================================================
(function (global) {
  const D = global.Dashboard;
  const $ = (id) => document.getElementById(id);
  function esc(s) { return D.esc(s); }
  function toast(t, e) { return D.toast(t, e); }
  async function api(m, u, b) { return D.api(m, u, b); }

  let sessionId = null;
  let barTimer = null;
  let barTask = null; // {taskId,title,desc,timed,timerState,remainingMs,durationSec}
  let expiredToasted = false; // 同一活动只弹一次"已截止"toast，避免每次快照刷新重复轰炸

  // ---------- 计时条 ----------
  function fmt(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60).toString().padStart(2, '0') + ':' + (s % 60).toString().padStart(2, '0');
  }

  function renderBar() {
    const bar = $('activity-bar');
    if (!barTask || !barTask.timed || barTask.timerState === 'closed' || barTask.timerState === 'idle') {
      bar.hidden = true;
      stopTick();
      return;
    }
    bar.hidden = false;
    $('ab-title').textContent = barTask.title || '未命名活动';
    $('ab-desc').textContent = barTask.desc || '';
    $('ab-time').textContent = fmt(barTask.remainingMs);
    const running = barTask.timerState === 'running';
    $('ab-state').textContent = running ? '进行中' : barTask.timerState === 'paused' ? '已暂停' : '已截止';
    $('ab-time').dataset.state = barTask.timerState;
    $('ab-pause').hidden = !running;
    $('ab-resume').hidden = running || barTask.timerState !== 'paused';
    if (barTask.timerState === 'expired' && !expiredToasted) {
      expiredToasted = true;
      D.toast('活动已截止：' + (barTask.title || ''), true);
    }
    if (barTask.timerState !== 'expired') expiredToasted = false;
    startTick();
  }

  function startTick() {
    if (barTimer) return;
    barTimer = setInterval(() => {
      if (barTask && barTask.timerState === 'running') {
        barTask.remainingMs = Math.max(0, (barTask.remainingMs || 0) - 1000);
        if (barTask.remainingMs <= 0) { barTask.timerState = 'expired'; }
        $('ab-time').textContent = fmt(barTask.remainingMs);
        $('ab-state').textContent = barTask.timerState === 'expired' ? '已截止' : '进行中';
      }
    }, 1000);
  }
  function stopTick() {
    if (barTimer) { clearInterval(barTimer); barTimer = null; }
  }

  // ---------- snapshot 钩子（app.js 喂入）----------
  function onSnapshot(sess, currentTask) {
    sessionId = sess ? sess.sessionId : null;
    barTask = currentTask ? {
      taskId: currentTask.taskId, title: currentTask.title, desc: currentTask.desc || '',
      timed: !!currentTask.timed, timerState: currentTask.timerState || 'idle',
      remainingMs: currentTask.remainingMs != null ? currentTask.remainingMs : 0,
      durationSec: currentTask.durationSec,
    } : null;
    renderBar();
    if (sess) updatePolicyLabel(sess.policyMode);
  }

  // ---------- SSE 钩子（stream.js 转发）----------
  function onSse(e) {
    const d = e.data ? JSON.parse(e.data) : {};
    const p = d.payload || {};
    if (e.event === 'activity.timer') {
      if (barTask && p.taskId === barTask.taskId) {
        barTask.timerState = p.state || barTask.timerState;
        if (p.remainingMs != null) barTask.remainingMs = p.remainingMs;
        renderBar();
      }
    } else if (e.event === 'policy.changed') {
      updatePolicyLabel(p.mode);
      if (p.locked) toast('学生端已锁定（非活动时间）', true);
    }
  }

  // ---------- 发布活动 ----------
  function fillPresetSelect() {
    const sel = $('f-task-preset');
    const cur = sel.value;
    sel.innerHTML = '<option value="">（现场自定义）</option>'
      + D.presets.activities.map((a) => '<option value="' + esc(a.presetId) + '">' + esc(a.name)
        + (a.timed ? '（默认计时 ' + (a.durationSec ? Math.round(a.durationSec / 60) : '?') + ' 分钟）' : '') + '</option>').join('');
    if (cur) sel.value = cur;
  }

  function onPresetChange() {
    const a = D.presets.activities.find((x) => x.presetId === $('f-task-preset').value);
    if (a) {
      $('f-task-title').value = a.name;
      $('f-task-desc').value = '';
      const tpl = a.taskTemplates && a.taskTemplates[0];
      if (tpl) $('f-task-desc').value = tpl.desc || '';
      $('f-task-timed').checked = !!a.timed;
      $('f-task-duration').value = a.durationSec ? Math.round(a.durationSec / 60) : 10;
      $('f-task-duration').disabled = !a.timed;
    }
  }

  // 操作防抖：计时控制/发布/策略切换请求未返回时忽略重复点击
  const busy = {};
  function actGuard(key) {
    if (busy[key]) { toast('操作处理中，请稍候…', true); return false; }
    busy[key] = true;
    return true;
  }
  function actDone(key) { busy[key] = false; }

  async function publishActivity() {
    if (!sessionId) { toast('请先开始上课', true); return; }
    if (!actGuard('publish')) return;
    try {
      const title = $('f-task-title').value.trim();
      if (!title) { toast('请填写活动标题', true); return; }
      const presetId = $('f-task-preset').value;
      const timed = $('f-task-timed').checked;
      const durationSec = timed ? (Number($('f-task-duration').value) || 10) * 60 : 0;
      const body = { title, desc: $('f-task-desc').value.trim(), timed, durationSec };
      if (presetId) { body.source = 'preset'; body.activityPresetId = presetId; }
      const j = await api('POST', '/api/v1/sessions/' + sessionId + '/activities', body);
      if (j && j.code === 0) {
        $('overlay-task').hidden = true;
        toast('已发布活动' + (timed ? '（计时 ' + Math.round(durationSec / 60) + ' 分钟）' : ''));
        D.refreshSoon();
      }
    } finally { actDone('publish'); }
  }

  // ---------- 计时控制 ----------
  async function timerAction(action, durationSec) {
    if (!sessionId || !barTask) return;
    if (!actGuard('timer')) return;
    try {
      const body = { action };
      if (action === 'adjust' && durationSec) body.durationSec = durationSec;
      const j = await api('POST', '/api/v1/sessions/' + sessionId + '/activities/' + barTask.taskId + '/timer', body);
      if (j && j.code === 0) { D.refreshSoon(); }
    } finally { actDone('timer'); }
  }

  // ---------- 锁定策略开关 ----------
  let policyMode = 'open';
  function updatePolicyLabel(mode) {
    if (mode) policyMode = mode;
    $('btn-policy').textContent = '锁定策略：' + (policyMode === 'activity' ? '仅活动期间可用' : '全课可用');
  }
  async function togglePolicy() {
    if (!sessionId) { toast('请先开始上课', true); return; }
    if (!actGuard('policy')) return;
    try {
      const next = policyMode === 'activity' ? 'open' : 'activity';
      const j = await api('POST', '/api/v1/sessions/' + sessionId + '/policy', { mode: next });
      if (j && j.code === 0) {
        policyMode = next;
        updatePolicyLabel(next);
        toast(next === 'activity' ? '已启用：非活动时间学生端自动锁定' : '已切换为全课可用');
      }
    } finally { actDone('policy'); }
  }

  // ---------- 初始化 ----------
  function bind() {
    $('btn-task').onclick = () => {
      fillPresetSelect();
      $('f-task-preset').value = '';
      $('f-task-title').value = '';
      $('f-task-desc').value = '';
      $('f-task-timed').checked = false;
      $('f-task-duration').value = 10;
      $('f-task-duration').disabled = true;
      $('overlay-task').hidden = false;
    };
    $('confirm-task').onclick = publishActivity;
    $('f-task-preset').addEventListener('change', onPresetChange);
    $('f-task-timed').addEventListener('change', (e) => { $('f-task-duration').disabled = !e.target.checked; });
    $('ab-pause').onclick = () => timerAction('pause');
    $('ab-resume').onclick = () => timerAction('resume');
    $('ab-restart').onclick = () => timerAction('restart');
    $('ab-stop').onclick = () => { if (global.confirm('结束当前活动计时？')) timerAction('stop'); };
    $('ab-adjust').onclick = () => {
      const min = global.prompt('调整时长为（分钟）：', barTask ? Math.round((barTask.durationSec || 600) / 60) : 10);
      const n = Number(min);
      if (n > 0 && n <= 120) timerAction('adjust', n * 60);
    };
    $('btn-policy').onclick = togglePolicy;
  }

  global.DashboardActivity = { init: bind, onSnapshot, onSse, fillPresetSelect };
})(window);
