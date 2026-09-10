'use strict';
// =============================================================================
// 教师大屏 · SSE 事件流（stream.ready 全量 + 增量事件 → 快照重取）与事件日志
//
// 依赖 window.Dashboard（api / toast / esc）；渲染回调用 bind() 注入，避免耦合。
// 求助提醒状态机在 help-alert.js（纯逻辑可单测），本文件只管渲染与发声。
//
// 求助提醒：横幅常驻（未处理前不消失）+ 每 repeatMs 重播蜂鸣 + 教师可「已阅」静音。
// 现场反馈"学生点了一次求助就不提示了"——原实现 15s 自隐 + 8s 全局限频，
// 学生仍在求助中也不再提醒，起不到"叫老师过去看"的作用。
// =============================================================================
(function (global) {
  const D = global.Dashboard;
  const MAX_EVENTS = 60;
  const $ = (id) => document.getElementById(id);
  const BEEP_MIN_GAP_MS = 1500; // 多组同时求助时，避免提示音连成一串

  let applySnapshotFn = null;
  let refreshSoonFn = null;
  let setConnFn = null;
  // 未处理求助集合 + 蜂鸣节流（help-alert.js，纯逻辑可单测）
  const helpAlert = (global.HelpAlert || { create: () => null }).create();
  let helpTimer = null;
  let lastBeepAt = 0;

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

  // ---------------------------------------------------------------------------
  // 求助提醒：渲染 + 发声
  // ---------------------------------------------------------------------------
  function beepHelp(force) {
    const now = Date.now();
    if (!force && now - lastBeepAt < BEEP_MIN_GAP_MS) return;
    lastBeepAt = now;
    try {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (AC) {
        const ac = new AC(); const g = ac.createGain(); g.connect(ac.destination);
        for (let k = 0; k < 3; k += 1) {
          const o = ac.createOscillator(); o.connect(g);
          o.frequency.value = 880; o.type = 'square';
          o.start(ac.currentTime + k * 0.28); o.stop(ac.currentTime + k * 0.28 + 0.18);
        }
      }
    } catch (_e) { /* 无声环境忽略 */ }
  }

  function renderHelpBanner() {
    const banner = $('help-banner');
    if (!banner) return;
    if (!helpAlert.count()) { banner.hidden = true; banner.dataset.muted = 'false'; return; }
    banner.hidden = false;
    banner.dataset.muted = helpAlert.isMuted() ? 'true' : 'false';
    const t = $('help-banner-text');
    if (t) t.textContent = helpAlert.text() + (helpAlert.isMuted() ? '（已静音）' : '');
  }

  // 学生状态变化 → 维护待处理集合；新求助立刻响，处理完（切走状态）自动收起横幅
  function onTaskStatusHelp(ev) {
    const r = helpAlert.update(ev);
    if (!r || !r.changed) return;
    renderHelpBanner();
    if (r.isNewHelp) beepHelp(true);
  }

  function startHelpTicker() {
    if (helpTimer) return;
    helpTimer = setInterval(() => {
      const now = Date.now();
      if (helpAlert.dueForBeep(now)) { helpAlert.markBeep(now); beepHelp(false); }
    }, 1000);
  }

  // 教师点横幅「已阅」：停蜂鸣，横幅保留到所有求助处理完
  function ackHelp() {
    helpAlert.acknowledge();
    renderHelpBanner();
  }

  function bindHelpWidgets() {
    const hb = $('help-banner');
    if (hb) hb.addEventListener('click', ackHelp);
    const hbAck = $('help-banner-ack');
    if (hbAck) hbAck.addEventListener('click', (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      ackHelp();
    });
    startHelpTicker();
  }

  // 快照对齐：F5 刷新 / 断线重连后，用快照里的 taskStatus=help 座位重建待处理集合，
  // 避免"刷新一下提醒就没了"（横幅与蜂鸣由快照恢复，不依赖事件是否收到）。
  function syncHelpFromSeats(seats) {
    const helpSeats = (seats || []).filter((s) => s && s.taskStatus === 'help');
    const helpSet = {};
    for (const s of helpSeats) helpSet[String(s.seat)] = s;
    let changed = false;
    for (const p of helpAlert.list()) {
      if (!helpSet[p.seat] && helpAlert.update({ seat: p.seat, status: 'done' }).changed) changed = true;
    }
    for (const s of helpSeats) {
      const r = helpAlert.update({ seat: s.seat, name: s.name || '', status: 'help' });
      if (r.changed) { changed = true; if (r.isNewHelp) beepHelp(true); }
    }
    if (changed) renderHelpBanner();
    return helpAlert.count();
  }

  function bind(ctx) {
    applySnapshotFn = ctx.applySnapshot;
    refreshSoonFn = ctx.refreshSoon;
    setConnFn = ctx.setConn;
    bindHelpWidgets();
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
      onTaskStatusHelp({
        seat: d.payload.seat, name: d.payload.name || '', status: d.payload.status,
      });
      if (refreshSoonFn) refreshSoonFn();
    });
    es.addEventListener('group.done', (e) => {
      const d = JSON.parse(e.data);
      logEvent('终端 ' + String((d.payload && d.payload.groupId) || '').replace(/^G/, '') + ' 组登记完成');
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

  global.DashboardStream = { bind, openStream, logEvent, syncHelpFromSeats, ackHelp };
})(window);
