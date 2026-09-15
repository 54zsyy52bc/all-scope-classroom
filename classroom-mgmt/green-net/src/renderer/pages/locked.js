'use strict';
// 课堂锁定页：由全域 cmd policy{locked:true} 触发。
// 这一页是"锁屏语义" —— 学生能确认自己被锁了、为什么被锁，但不能从这里上网。
(function () {
  const { api, esc, param, log } = window.GN;

  const PHASE_MAP = { waiting: '等待上课', checkin: '课前登记', task: '活动进行中', return: '器材归还', closed: '已下课' };
  let task = null;
  let gotAt = 0;
  let base = null;
  let state = '';

  function paintCountdown() {
    const el = document.getElementById('countdown');
    if (!task || !task.timed || base == null) { el.textContent = ''; return; }
    let ms = base;
    if (state === 'running') ms = Math.max(0, base - (Date.now() - gotAt));
    const s = Math.max(0, Math.round(ms / 1000));
    const txt = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    el.textContent = (state === 'expired' || s === 0) ? '活动时间到' : '距离活动结束还有 ' + txt;
  }

  async function refresh() {
    try {
      const r = await api.getQy();
      if (!r || !r.ok) return;
      const q = r.qy || {};
      document.getElementById('phase-line').textContent = q.phase
        ? '当前阶段：' + (PHASE_MAP[q.phase] || q.phase)
        : '老师还没有开始上课。';
      if (q.task) {
        task = q.task;
        base = task.remainingMs != null ? Number(task.remainingMs) : (task.durationSec != null ? task.durationSec * 1000 : null);
        gotAt = Date.now();
        state = task.timerState || 'idle';
      }
      paintCountdown();
      if (!r.lock) {
        // 已解锁：留在这一页没有意义，自动回首页
        log('锁定已解除，返回首页');
        api.openInternal('home');
      }
    } catch (e) { log('locked refresh 异常：' + (e && e.message)); }
  }

  window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-qy').onclick = () => api.openInternal('qy');
    document.getElementById('btn-ip').onclick = () => api.openInternal('ip');
    if (api.onQy) api.onQy(refresh);
    refresh();
    setInterval(refresh, 3000);
    setInterval(paintCountdown, 500);
  });
})();
