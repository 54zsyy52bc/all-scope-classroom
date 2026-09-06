'use strict';
// =============================================================================
// 教师大屏 · SSE 事件流（stream.ready 全量 + 增量事件 → 快照重取）与事件日志
//
// 依赖 window.Dashboard（api / toast / esc）；渲染回调用 bind() 注入，避免耦合。
// =============================================================================
(function (global) {
  const D = global.Dashboard;
  const MAX_EVENTS = 60;
  const $ = (id) => document.getElementById(id);

  let applySnapshotFn = null;
  let refreshSoonFn = null;
  let setConnFn = null;

  function time(ts) {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2, '0') + ':' +
      d.getMinutes().toString().padStart(2, '0') + ':' +
      d.getSeconds().toString().padStart(2, '0');
  }

  function esc(s) { return D.esc(s); }

  function logEvent(text) {
    const body = $('events-body');
    const div = document.createElement('div');
    const t = document.createElement('time');
    t.textContent = time(Date.now());
    div.appendChild(t);
    div.appendChild(document.createTextNode(text));
    body.prepend(div);
    while (body.children.length > MAX_EVENTS) body.removeChild(body.lastChild);
  }

  function bind(ctx) {
    applySnapshotFn = ctx.applySnapshot;
    refreshSoonFn = ctx.refreshSoon;
    setConnFn = ctx.setConn;
  }

  function openStream() {
    const es = new EventSource('/api/v1/dashboard/stream');
    es.addEventListener('stream.ready', (e) => {
      try {
        const d = JSON.parse(e.data);
        if (applySnapshotFn) applySnapshotFn(d.payload && d.payload.snapshot);
      } catch (_e) { /* 忽略坏帧 */ }
    });
    es.addEventListener('student.checkin', (e) => {
      const d = JSON.parse(e.data);
      logEvent(esc(d.payload.name || '') + '（' + esc(d.payload.seat) + ' 号）完成登记');
      if (refreshSoonFn) refreshSoonFn();
    });
    es.addEventListener('task.status', (e) => {
      const d = JSON.parse(e.data);
      logEvent(esc(d.payload.seat) + ' 号 ' + (d.payload.status || ''));
      if (refreshSoonFn) refreshSoonFn();
    });
    es.addEventListener('student.return', (e) => {
      const d = JSON.parse(e.data);
      logEvent(esc(d.payload.seat) + ' 号归还器材');
      if (refreshSoonFn) refreshSoonFn();
    });
    es.addEventListener('conflict.detected', (e) => {
      const d = JSON.parse(e.data);
      logEvent('冲突：' + esc(d.payload.seat) + ' 号多机器上报');
      if (refreshSoonFn) refreshSoonFn();
    });
    // 座位登记超出课堂范围 → 大屏"待激活座位"（教师一键激活扩容，闭环修复）
    es.addEventListener('seat.outofrange', (e) => {
      const d = JSON.parse(e.data);
      if (global.Dashboard && global.Dashboard.addPendingSeat) {
        global.Dashboard.addPendingSeat({
          seat: d.payload.seat, name: d.payload.name, totalSeats: d.payload.totalSeats,
        });
      }
    });
    // 活动计时 / 锁定策略（转发给 activity.js 渲染计时条与策略开关）
    es.addEventListener('activity.timer', (e) => {
      if (global.DashboardActivity) global.DashboardActivity.onSse({ event: 'activity.timer', data: e.data });
      if (refreshSoonFn) refreshSoonFn();
    });
    es.addEventListener('policy.changed', (e) => {
      if (global.DashboardActivity) global.DashboardActivity.onSse({ event: 'policy.changed', data: e.data });
    });
    es.onerror = () => { if (setConnFn) setConnFn({ state: 'offline' }); };
  }

  global.DashboardStream = { bind, openStream, logEvent };
})(window);
