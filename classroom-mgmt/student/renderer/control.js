'use strict';
// =============================================================================
// 学生端 · 活动计时器与锁定遮罩（软锁）
//
// 依赖注入：create(ctx) 接收控制器闭包内的共享值。
// ctx = { state, els, toast, renderStage }
//   applyTimer(payload)：处理 cmd task_timer（pause/resume/adjust/restart/expired/sync）
//   applyPolicy(payload)：处理 cmd policy（locked → 全屏遮罩拦截输入，心跳保持）
// 计时为「本地渲染驱动 + 教师端广播校准」：running 每秒递减，截止/暂停以广播为准。
// =============================================================================
(function (global) {
  function create(c) {
    const state = c.state;
    const els = c.els;
    const toast = c.toast;
    const renderStage = c.renderStage;
    let tickTimer = null;

    // ---------- 计时器 ----------
    function applyTimer(p) {
      const t = state.currentTask;
      if (!t || !t.taskId || String(p.taskId) !== t.taskId) return;
      const action = p.timerAction || 'sync';
      if (action === 'pause') {
        t.timerState = 'paused';
        if (p.remainingMs != null) t.remainingMs = p.remainingMs;
      } else if (action === 'resume' || action === 'restart' || action === 'adjust' || action === 'sync' || action === 'start') {
        t.timerState = 'running';
        if (p.remainingMs != null) t.remainingMs = p.remainingMs;
        if (action === 'adjust' && p.durationSec) t.durationSec = p.durationSec;
      } else if (action === 'expired') {
        t.timerState = 'expired';
        t.remainingMs = 0;
        toast('活动已截止：' + (t.title || ''), 'error');
        beep();
      } else if (action === 'stop') {
        // 教师提前结束活动：收拢倒计时（视图隐藏计时器），不再本地继续倒数
        t.timerState = 'closed';
        t.remainingMs = 0;
      }
      renderStage();
    }

    // ---------- 锁定遮罩 ----------
    function applyPolicy(p) {
      if (!p) return;
      state.locked = !!p.locked;
      renderLock();
      if (p.locked) toast(p.reason === 'no-activity' ? '教师讲解中，电脑已锁定' : '电脑已锁定', 'info');
      else toast('电脑已解锁，可以操作', 'info');
    }

    function renderLock() {
      const ov = els.lock;
      if (!ov) return;
      ov.hidden = !state.locked;
    }

    // 截止提示音（尽力而为，失败静默）
    function beep() {
      try {
        const ctx = global.AudioContext || global.webkitAudioContext;
        if (!ctx) return;
        const ac = new ctx();
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.connect(g); g.connect(ac.destination);
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.2, ac.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.6);
        o.start();
        o.stop(ac.currentTime + 0.6);
      } catch (_e) { /* 音频不可用忽略 */ }
    }

    // 本地倒计时：running 时每秒递减并重渲染任务卡（以教师端广播为最终校准）
    function startTicker() {
      if (tickTimer) return;
      tickTimer = setInterval(() => {
        const t = state.currentTask;
        if (t && t.timed && t.timerState === 'running' && t.remainingMs != null) {
          t.remainingMs = Math.max(0, t.remainingMs - 1000);
          if (t.remainingMs <= 0) {
            t.timerState = 'expired'; // 本地兜底；教师端截止广播会校准
            toast('活动已截止：' + (t.title || ''), 'error');
            beep();
          }
          if (state.phase === 'task') renderStage();
        }
      }, 1000);
    }

    return { applyTimer, applyPolicy, startTicker };
  }

  global.StudentControl = { create };
})(window);
