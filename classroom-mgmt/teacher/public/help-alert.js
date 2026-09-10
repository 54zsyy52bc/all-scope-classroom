'use strict';
// =============================================================================
// 教师大屏 · 求助提醒状态机（纯逻辑，无 DOM，可单测）
//
// 现场反馈："学生点了求助，大屏响一次就不提示了"。
// 原实现是一事件一提示：15 秒后横幅自动隐藏、蜂鸣 8 秒全局限频，
// 学生仍处于求助中也不再提醒。现在改为「未处理求助」集合：
//   - 状态切到 help 的座位进集合，切走（doing/done）即出集合；
//   - 只要有未处理求助，横幅常驻不自动消失；
//   - 新座位求助立刻响；此后每隔 repeatMs 重播一次，直到处理完或教师静音。
// =============================================================================
(function (global) {
  const DEFAULT_REPEAT_MS = 20000;

  function create(opts) {
    const o = opts || {};
    const repeatMs = Number(o.repeatMs) > 0 ? Number(o.repeatMs) : DEFAULT_REPEAT_MS;
    const pending = new Map(); // seat -> { seat, name }
    let lastBeepAt = 0;
    let muted = false; // 教师点「已阅」后静音，等新的求助再恢复

    // 学生状态变化：help 进集合、其他状态出集合
    function update(ev) {
      const seat = ev && ev.seat != null ? String(ev.seat) : '';
      if (!seat) return { changed: false, isNewHelp: false };
      const status = ev.status;
      if (status === 'help') {
        const isNewHelp = !pending.has(seat);
        const prev = pending.get(seat) || {};
        pending.set(seat, { seat, name: ev.name || prev.name || '' });
        if (isNewHelp) muted = false; // 新求助 → 解除静音
        return { changed: true, isNewHelp };
      }
      return { changed: pending.delete(seat), isNewHelp: false };
    }

    function list() {
      return Array.from(pending.values()).sort((a, b) => a.seat.localeCompare(b.seat));
    }

    function count() { return pending.size; }

    function text() {
      const arr = list();
      if (!arr.length) return '';
      const who = arr.map((x) => (x.name ? x.name + '（' + x.seat + ' 号）' : x.seat + ' 号')).join('、');
      return arr.length === 1
        ? who + ' 正在求助，请过去看一下！'
        : arr.length + ' 位同学在求助：' + who;
    }

    // 到达重播间隔且未静音时返回 true（首个求助由调用方 in stream 立即响）
    function dueForBeep(now) {
      return !muted && pending.size > 0 && (now - lastBeepAt) >= repeatMs;
    }

    function markBeep(now) { lastBeepAt = now; }
    function acknowledge() { muted = true; } // 教师「已阅」：停蜂鸣，横幅保留到处理完
    function isMuted() { return muted; }
    function reset() { pending.clear(); lastBeepAt = 0; muted = false; }

    return {
      update, list, count, text, dueForBeep, markBeep, acknowledge, isMuted, reset,
      get repeatMs() { return repeatMs; },
    };
  }

  global.HelpAlert = { create };
})(typeof window !== 'undefined' ? window : globalThis);
