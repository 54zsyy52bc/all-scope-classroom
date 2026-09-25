'use strict';
// =============================================================================
// 教师大屏 · 随机抽选小工具（名单抽选 + 摄像头抽选）
//   名单模式：数据源 = 当前课堂快照 seats（有姓名且未退出的座位），滚动高亮减速定格，
//             最终中奖者用 crypto.getRandomValues 决定（公平可复现）。
//   摄像头模式：getUserMedia 打开教室摄像头，3×3 方格轮盘抽"屏幕方位"（第几行第几列），
//             定格后截取中奖格子画面；不支持的环境（非 localhost/https）安全降级提示。
//   依赖 window.Dashboard（api/toast/esc）。
// =============================================================================
(function () {
  const D = window.Dashboard;
  const $ = (id) => document.getElementById(id);
  const esc = D.esc;
  let names = [];            // 名单模式候选：{ seat, name, groupId }
  let cells = [];            // 名单格元素引用
  let camCells = [];         // 摄像头格元素引用
  let camStream = null;
  let camVideo = null;
  let camCanvas = null;
  let rollTimer = null;
  let rafId = 0;
  let rolling = false;
  let history = [];
  const GRID = 3;            // 摄像头 3×3

  function randInt(n) { // 加密级随机
    const a = new Uint32Array(1);
    (globalThis.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : (a[0] = Math.floor(Math.random() * 0xffffffff));
    return a[0] % n;
  }

  function showPanel(mode) {
    $('pk-panel-names').hidden = mode !== 'names';
    $('pk-panel-cam').hidden = mode !== 'cam';
    $('pk-tab-names').className = 'btn btn-sm' + (mode === 'names' ? ' btn-primary' : ' btn-ghost');
    $('pk-tab-cam').className = 'btn btn-sm' + (mode === 'cam' ? ' btn-primary' : ' btn-ghost');
    if (mode !== 'cam') stopCam();
  }

  // ---------- 名单模式 ----------
  async function loadNames() {
    const j = await D.api('GET', '/api/v1/dashboard/snapshot');
    const snap = j && j.code === 0 && j.data;
    names = ((snap && snap.seats) || []).filter((s) => s.name && !s.exited)
      .map((s) => ({ seat: s.seat, name: s.name, groupId: s.groupId }));
    const host = $('pk-names');
    if (!names.length) {
      host.innerHTML = '<p class="hint">本堂课还没有已登记学生（或未开课）。</p>';
      cells = [];
      return;
    }
    host.innerHTML = names.map((n, i) =>
      '<div class="pk-cell" data-i="' + i + '"><b>' + esc(n.name) + '</b><span>' + esc(n.seat) + ' 号 · ' + esc(n.groupId || '—') + '</span></div>'
    ).join('');
    cells = [...host.children];
  }

  // steps 后高亮恰落在 winner（(idx0+steps) % n === winner）
  function stepsToLand(idx0, winner, n, minSteps) {
    return minSteps + ((winner - idx0 - minSteps) % n + n) % n;
  }

  function rollNames() {
    if (rolling) return Promise.resolve(null);
    if (names.length < 2) { D.toast('名单不足 2 人，无法抽选', true); return Promise.resolve(null); }
    rolling = true;
    $('pk-roll').disabled = true;
    const winner = randInt(names.length);
    const fast = window.DashboardPicker && window.DashboardPicker._fast;
    const base = fast ? 4 : 70;
    const grow = fast ? 8 : 560;
    const minSteps = fast ? 8 : 22;
    let idx = 0;
    const steps = stepsToLand(0, winner, names.length, minSteps);
    let done = 0;
    return new Promise((resolve) => {
      const tick = () => {
        if (cells[idx]) cells[idx].className = 'pk-cell';
        idx = (idx + 1) % names.length;
        if (cells[idx]) cells[idx].className = 'pk-cell hot';
        done += 1;
        if (done >= steps) {
          rolling = false;
          $('pk-roll').disabled = false;
          announce('名单抽选', names[winner].name + '（' + names[winner].seat + ' 号）');
          resolve(names[winner]);
          return;
        }
        rollTimer = setTimeout(tick, base + Math.pow(done / steps, 3) * grow);
      };
      tick();
    });
  }

  // ---------- 摄像头模式 ----------
  async function startCam() {
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { D.toast('当前环境不支持摄像头（需 localhost 或 https 打开大屏）', true); return false; }
    try {
      camStream = await md.getUserMedia({ video: { width: 640, height: 480 } });
    } catch (e) { D.toast('摄像头打开失败：' + (e.message || e), true); return false; }
    camVideo = $('pk-video');
    camVideo.srcObject = camStream;
    try { await camVideo.play(); } catch (e) { /* 自动播放被拦时用户手点 */ }
    camCanvas = $('pk-canvas');
    const draw = () => {
      drawGrid();
      rafId = requestAnimationFrame(draw);
    };
    draw();
    return true;
  }

  function stopCam() {
    if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (camVideo) camVideo.srcObject = null;
  }

  function drawGrid(hotIdx) {
    if (!camCanvas || !camCanvas.width) return;
    const ctx = camCanvas.getContext('2d');
    const w = camCanvas.width, h = camCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    for (let i = 1; i < GRID; i += 1) {
      ctx.beginPath(); ctx.moveTo(w * i / GRID, 0); ctx.lineTo(w * i / GRID, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, h * i / GRID); ctx.lineTo(w, h * i / GRID); ctx.stroke();
    }
    if (hotIdx == null) return;
    const r = Math.floor(hotIdx / GRID), c = hotIdx % GRID;
    ctx.fillStyle = 'rgba(37,99,235,.35)';
    ctx.fillRect(w * c / GRID, h * r / GRID, w / GRID, h / GRID);
    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 4;
    ctx.strokeRect(w * c / GRID + 2, h * r / GRID + 2, w / GRID - 4, h / GRID - 4);
  }

  async function rollCam() {
    if (rolling) return null;
    rolling = true;
    $('pk-cam-roll').disabled = true;
    const ok = camStream ? true : await startCam();
    if (!ok) { rolling = false; $('pk-cam-roll').disabled = false; return null; }
    const winner = randInt(GRID * GRID);
    const fast = window.DashboardPicker && window.DashboardPicker._fast;
    const base = fast ? 4 : 70;
    const grow = fast ? 8 : 560;
    const minSteps = fast ? 8 : 24;
    let idx = 0;
    const steps = stepsToLand(0, winner, GRID * GRID, minSteps);
    let done = 0;
    return new Promise((resolve) => {
      const tick = () => {
        idx = (idx + 1) % (GRID * GRID);
        drawGrid(idx);
        done += 1;
        if (done >= steps) {
          rolling = false;
          $('pk-cam-roll').disabled = false;
          const r = Math.floor(winner / GRID) + 1, c = winner % GRID + 1;
          snapWinner(winner);
          announce('摄像头抽选', '屏幕第 ' + r + ' 行 · 第 ' + c + ' 列区域的同学');
          resolve({ row: r, col: c });
          return;
        }
        rollTimer = setTimeout(tick, base + Math.pow(done / steps, 3) * grow);
      };
      tick();
    });
  }

  // 定格中奖格子画面（视频帧裁剪到小画布）
  function snapWinner(idx) {
    const shot = $('pk-shot');
    if (!shot || !camVideo || !camVideo.videoWidth) return;
    const vw = camVideo.videoWidth, vh = camVideo.videoHeight;
    shot.width = 240; shot.height = 180;
    const ctx = shot.getContext('2d');
    const r = Math.floor(idx / GRID), c = idx % GRID;
    ctx.drawImage(camVideo, vw * c / GRID, vh * r / GRID, vw / GRID, vh / GRID, 0, 0, 240, 180);
  }

  // ---------- 公共 ----------
  function announce(kind, text) {
    $('pk-result').innerHTML = '<b>' + esc(kind) + '</b>：' + esc(text);
    history.unshift(kind + ' · ' + text);
    history = history.slice(0, 6);
    $('pk-history').innerHTML = history.map((h) => '<div class="pk-h">' + esc(h) + '</div>').join('');
  }

  async function open() {
    $('overlay-picker').hidden = false;
    showPanel('names');
    await loadNames();
  }

  function close() {
    stopCam();
    if (rollTimer) { clearTimeout(rollTimer); rollTimer = null; }
    rolling = false;
  }

  function bind() {
    const b = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    b('btn-picker', open);
    b('pk-tab-names', () => showPanel('names'));
    b('pk-tab-cam', () => showPanel('cam'));
    b('pk-roll', rollNames);
    b('pk-cam-roll', rollCam);
    b('pk-close', close);
    // 画布尺寸对齐视频显示尺寸
    const v = $('pk-video');
    if (v) v.addEventListener('loadedmetadata', () => {
      const c = $('pk-canvas');
      c.width = v.clientWidth || 640;
      c.height = v.clientHeight || 480;
    });
  }

  // 脚本位于 body 末尾，弹层元素均已解析，直接绑定（不占 DOMContentLoaded，避免与其他模块的监听互相覆盖）
  bind();

  window.DashboardPicker = { open, close, rollNames, rollCam, _fast: false };
})();
