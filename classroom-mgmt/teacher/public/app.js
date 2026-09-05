'use strict';
// =============================================================================
// 教师大屏控制器：快照渲染 + SSE 实时刷新 + 教师操作（开始/任务/下课/关机/导出/复位）。
//
// 数据源：
//   GET  /api/v1/dashboard/snapshot   全量快照（revision 与 SSE 同源）
//   GET  /api/v1/dashboard/stream     SSE：stream.ready(全量) / student.checkin /
//                                     task.status / student.return / conflict.detected
// 写操作走扁平别名（legacy 路由）或 canonical 嵌套路由，见下方 API 常量。
// =============================================================================
(function () {
  const API = {
    start: '/api/v1/sessions',
    end: '/api/v1/session/end',
    finish: '/api/v1/session/finish',
    shutdown: '/api/v1/commands/shutdown',
    reset: '/api/v1/commands/reset',
    snapshot: '/api/v1/dashboard/snapshot',
  };
  const PHASE_LABEL = { waiting: '待课', checkin: '登记中', task: '课中', return: '归还中', closed: '已结束' };
  const SEAT_LABEL = { doing: '进行中', done: '已完成', help: '求助' };

  const $ = (id) => document.getElementById(id);
  let snapTimer = null;
  const presets = { classes: [], activities: [] };

  // 公共 API：供 presets.js / activity.js / manage.js / stream.js 复用
  window.Dashboard = {
    api, toast, esc, presets, refreshSoon,
    refreshPresets: () => (window.DashboardPreset ? window.DashboardPreset.refresh() : Promise.resolve()),
  };

  // ---------- 工具 ----------
  function toast(text, isErr) {
    const t = $('toast');
    t.textContent = text;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.hidden = true; }, 3200);
  }

  async function api(method, url, body) {
    try {
      const r = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json();
      if (j.code !== 0) toast((j.errorCode || '') + ' ' + (j.message || '操作失败'), true);
      return j;
    } catch (e) {
      toast('请求失败：' + e.message, true);
      return null;
    }
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function icon(name, size, cls) {
    return window.Icons && window.Icons.svg ? window.Icons.svg(name, size || 24, cls || '') : '';
  }

  // ---------- 渲染 ----------
  function applySnapshot(snap) {
    if (!snap) return;
    const sess = snap.session;
    document.body.dataset.phase = sess ? sess.phase : 'waiting';
    $('phase-pill').textContent = PHASE_LABEL[sess ? sess.phase : 'waiting'] || sess.phase;
    $('class-meta').textContent = sess
      ? esc((sess.className || '未命名班级')) + ' · ' + esc(sess.teacher || '') + ' · 座位 ' + sess.totalSeats
        + (sess.activityName ? ' · 活动：' + esc(sess.activityName) : '')
      : '尚未开课';
    setConn(snap.mqtt);
    if (window.DashboardPreset) window.DashboardPreset.renderTaskTemplates(sess);
    if (window.DashboardActivity) window.DashboardActivity.onSnapshot(sess, snap.currentTask);

    const s = snap.stats || {};
    $('st-checkin').textContent = s.checkedIn || 0;
    $('st-checkin-rate').textContent = Math.round((s.checkinRate || 0) * 100) + '%';
    $('st-pending').textContent = s.pending || 0;
    $('st-online').textContent = s.online || 0;
    $('st-online-rate').textContent = Math.round((s.online / Math.max(1, sess ? sess.totalSeats : 1)) * 100) + '%';
    $('st-help').textContent = s.taskHelp || 0;
    $('st-task-done').textContent = s.taskDone || 0;
    $('st-returned').textContent = s.returned || 0;

    renderTask(snap.currentTask, s);
    renderGroups(snap.groups || [], snap.seats || []);
    renderAlerts(snap.conflicts || []);
  }

  function setConn(mqtt) {
    const st = (mqtt && mqtt.state) || 'offline';
    const pill = $('conn-pill');
    pill.dataset.state = st;
    const ic = st === 'online' ? 'circle-check' : (st === 'reconnecting' ? 'loader-circle' : 'wifi-off');
    pill.innerHTML = icon(ic, 16)
      + ({ online: 'SIoT 在线', reconnecting: '重连中', offline: 'SIoT 离线' }[st] || st);
  }

  function renderTask(task, stats) {
    const banner = $('task-banner');
    if (!task) { banner.hidden = true; return; }
    banner.hidden = false;
    $('task-title').textContent = task.title || '未命名任务';
    $('task-desc').textContent = task.desc || '';
    $('task-icon').innerHTML = icon('clipboard-check', 28);
    $('ts-doing').textContent = (stats && stats.taskDoing) || 0;
    $('ts-done').textContent = (stats && stats.taskDone) || 0;
    $('ts-help').textContent = (stats && stats.taskHelp) || 0;
  }

  function renderGroups(groups, seats) {
    const host = $('groups');
    if (!groups.length) {
      host.innerHTML = '<div class="groups-empty">点击「开始上课」后，这里会显示各小组的实时状态</div>';
      return;
    }
    const bySeat = {};
    for (const s of seats) bySeat[s.seat] = s;

    host.innerHTML = groups.map((g) => {
      const tiles = g.seats.map((seatNo) => {
        const st = bySeat[seatNo] || {};
        const cls = [];
        if (st.conflict) cls.push('s-conflict');
        if (!st.online) cls.push('s-offline');
        if (st.checkinStatus === 'pending') cls.push('s-pending');
        if (st.taskStatus) cls.push('s-' + st.taskStatus);
        return '<div class="seat ' + cls.join(' ') + '" data-seat="' + esc(seatNo)
          + '" title="' + esc(seatNo) + '号 · ' + esc(st.name || '未登记')
          + (st.taskStatus ? ' · ' + SEAT_LABEL[st.taskStatus] : '') + '">'
          + '<span class="no">' + esc(seatNo) + '</span>'
          + '<span class="nm">' + esc(st.name || (st.checkinStatus === 'pending' ? '未登记' : '')) + '</span>'
          + '</div>';
      }).join('');

      const badge = g.hasHelp
        ? '<span class="group-badge b-help">求助 ' + g.helpCount + '</span>'
        : (g.returned
          ? '<span class="group-badge b-done">已归还</span>'
          : '<span class="group-badge">' + g.checkedIn + '/' + g.seats.length + ' 登记</span>');

      return '<section class="group' + (g.hasHelp ? ' has-help' : '') + (g.returned ? ' all-returned' : '') + '">'
        + '<div class="group-head"><span class="group-name">' + esc(g.groupId) + '</span>' + badge + '</div>'
        + '<div class="group-seats">' + tiles + '</div>'
        + '</section>';
    }).join('');
  }

  function renderAlerts(conflicts) {
    const box = $('alerts');
    const real = (conflicts || []).filter((c) => (c.machineIds || []).length > 1);
    if (!real.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<b>座位冲突：</b>' + real.map((c) => esc(c.seat) + ' 号被 ' + esc(c.machineIds.join(' / ')) + ' 上报').join('；');
  }

  function logEvent(text) {
    if (window.DashboardStream && window.DashboardStream.logEvent) window.DashboardStream.logEvent(text);
  }

  // ---------- SSE 实时刷新（事件合并 + 快照重取，避免增量补丁复杂度）----------
  function refreshSoon() {
    if (snapTimer) return;
    snapTimer = setTimeout(async () => {
      snapTimer = null;
      const j = await api('GET', API.snapshot);
      if (j && j.code === 0) applySnapshot(j.data);
    }, 250);
  }

  function openStream() {
    if (!window.DashboardStream) return;
    window.DashboardStream.bind({ applySnapshot, refreshSoon, setConn });
    window.DashboardStream.openStream();
  }

  // ---------- 教师操作 ----------
  // 关键写操作防抖：请求未返回时忽略重复点击（防"双击下课/关机/开始/复位"重复提交）
  const busy = {};
  const guard = (k) => (busy[k] ? (toast('操作处理中，请稍候…', true), false) : ((busy[k] = true), true));
  const withGuard = (k, fn) => async (...a) => { if (!guard(k)) return; try { await fn(...a); } finally { busy[k] = false; } };

  function openModal(name) {
    $('overlay-' + name).hidden = false;
    const first = $('overlay-' + name).querySelector('input');
    if (first) setTimeout(() => first.focus(), 50);
  }
  function closeModal(name) {
    $('overlay-' + name).hidden = true;
  }

  async function onStart() {
    const teacher = $('f-teacher').value.trim();
    const className = $('f-class').value.trim();
    const totalSeats = Math.max(1, Math.min(99, Number($('f-seats').value) || 50));
    if (!teacher) { toast('请填写教师姓名', true); return; }
    const body = { teacher, className, totalSeats };
    if ($('f-class-preset').value) body.classPresetId = $('f-class-preset').value;
    if ($('f-activity-preset').value) body.activityPresetId = $('f-activity-preset').value;
    const j = await api('POST', API.start, body);
    if (j && j.code === 0) {
      closeModal('start');
      const act = j.data && j.data.activityName ? ' · 活动：' + j.data.activityName : '';
      logEvent('开始上课：' + teacher + ' · ' + (className || '未命名班级') + ' · ' + totalSeats + ' 座' + act);
      refreshSoon();
    }
  }

  async function onEnd() {
    if (!window.confirm('确认下课？将进入归还阶段，学生归还全部器材后自动关机。')) return;
    const j = await api('POST', API.end);
    if (j && j.code === 0) { logEvent('已下课，进入归还阶段'); refreshSoon(); }
  }

  async function onFinish() {
    if (!window.confirm('确认结束课堂？本堂课将关闭归档，之后可重新开始上课。')) return;
    const j = await api('POST', API.finish);
    if (j && j.code === 0) { logEvent('课堂已结束归档'); refreshSoon(); }
  }

  async function onShutdown() {
    if (!window.confirm('确认向全部学生机下发关机指令？')) return;
    const j = await api('POST', API.shutdown, { force: true });
    if (j && j.code === 0) { logEvent('已下发强制关机指令'); refreshSoon(); }
  }

  async function onResetSeat(seat) {
    if (!window.confirm('确认重置 ' + seat + ' 号座位的登记？')) return;
    const j = await api('POST', API.reset, { seat });
    if (j && j.code === 0) { logEvent('已重置 ' + seat + ' 号登记'); refreshSoon(); }
  }

  async function onExport(format) {
    const j = await api('GET', API.snapshot);
    const sid = j && j.code === 0 && j.data && j.data.session && j.data.session.sessionId;
    if (!sid) { toast('当前没有可导出的课堂会话', true); return; }
    const m = await api('POST', '/api/v1/sessions/' + sid + '/exports', { formats: [format] });
    if (!m || m.code !== 0) return;
    const files = (m.data && m.data.files) || [];
    if (!files.length) { toast('未生成导出文件', true); return; }
    for (const f of files) {
      const a = document.createElement('a');
      a.href = f.downloadUrl;
      a.download = f.fileName;
      a.target = '_blank';
      a.click();
    }
    logEvent('导出 ' + format.toUpperCase() + '：' + files.map((f) => f.fileName).join('、'));
    toast('已生成 ' + files.length + ' 个 ' + format.toUpperCase() + ' 文件');
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $('btn-start').onclick = () => openModal('start');
    $('btn-end').onclick = withGuard('end', onEnd);
    $('btn-finish').onclick = withGuard('finish', onFinish);
    $('btn-shutdown').onclick = withGuard('shutdown', onShutdown);
    $('btn-export-xlsx').onclick = withGuard('export-xlsx', () => onExport('xlsx'));
    $('btn-export-csv').onclick = withGuard('export-csv', () => onExport('csv'));
    $('confirm-start').onclick = withGuard('start', onStart);
    document.querySelectorAll('[data-close]').forEach((b) => {
      b.onclick = () => closeModal(b.dataset.close);
    });
    $('groups').addEventListener('click', (e) => {
      const tile = e.target.closest ? e.target.closest('[data-seat]') : null;
      if (tile) withGuard('reset:' + tile.dataset.seat, () => onResetSeat(tile.dataset.seat))();
    });
    $('brand-mark').innerHTML = icon('package-check', 26);
    if (window.DashboardPreset) window.DashboardPreset.bind();
    $('overlay-start').querySelectorAll('input').forEach((i) => {
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') withGuard('start', onStart)(); });
    });
    if (window.DashboardActivity) window.DashboardActivity.init();
    if (window.DashboardManage) window.DashboardManage.init();
  }

  async function init() {
    bind();
    if (window.DashboardPreset) await window.DashboardPreset.refresh();
    const j = await api('GET', API.snapshot);
    if (j && j.code === 0) applySnapshot(j.data);
    openStream();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
