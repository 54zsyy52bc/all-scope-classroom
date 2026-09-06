'use strict';
// =============================================================================
// 大屏 · 待激活座位（v4.2.1 闭环修复）
//   学生登记座位号超出课堂范围时，服务端 SSE 推 seat.outofrange；教师可一键
//   "激活该座位"扩容（db.admitSeatsTo 只补种新增座位，不清空已登记学生）。
// 依赖由 app.js 在 bind 时注入（$ / esc / api / logEvent / refreshSoon / withGuard）。
// =============================================================================
(function (global) {
  const pendingSeats = {}; // seat -> { seat, name, totalSeats }
  let d = null;

  function render() {
    if (!d) return;
    const host = d.$('pending-seats');
    const seats = Object.keys(pendingSeats).sort();
    if (!seats.length) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    host.innerHTML = seats.map((s) =>
      '<div class="pending-seat">'
      + '<span class="pending-text">座位 ' + d.esc(s) + ' 号登记超出课堂范围（上限 ' + d.esc(pendingSeats[s].totalSeats) + '）'
      + (pendingSeats[s].name ? ' · ' + d.esc(pendingSeats[s].name) : '') + '</span>'
      + '<button type="button" class="btn btn-ghost seat-admit" data-seat="' + d.esc(s) + '">激活该座位</button>'
      + '</div>'
    ).join('');
  }

  async function admit(seat) {
    const j = await d.api('POST', '/api/v1/commands/admit-seat', { seat });
    if (j && j.code === 0) {
      delete pendingSeats[seat];
      render();
      d.logEvent('已激活座位 ' + seat + '（课堂座位上限扩至 ' + j.data.totalSeats + ' 座）');
      d.refreshSoon();
    }
  }

  // 供 stream.js：SSE seat.outofrange → 登记进待激活队列
  function add(info) {
    if (!info || info.seat == null) return;
    const s = String(info.seat);
    if (!/^\d{1,2}$/.test(s)) return;
    const key = s.length === 1 ? '0' + s : s;
    if (!pendingSeats[key]) pendingSeats[key] = { seat: key, name: info.name || '', totalSeats: info.totalSeats };
    render();
  }

  function init(deps) {
    d = deps;
    global.Dashboard = global.Dashboard || {};
    global.Dashboard.addPendingSeat = add;
    const host = d.$('pending-seats');
    if (host) {
      host.addEventListener('click', (e) => {
        const btn = e.target.closest ? e.target.closest('.seat-admit[data-seat]') : null;
        if (btn) d.withGuard('admit:' + btn.dataset.seat, () => admit(btn.dataset.seat))();
      });
    }
    render();
  }

  global.DashboardAdmit = { init, add, render, pending: pendingSeats };
})(window);
