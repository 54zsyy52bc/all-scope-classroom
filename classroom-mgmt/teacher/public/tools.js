'use strict';
// =============================================================================
// 教师大屏 · 课堂小工具集：快速计时器 / 随机分组 / 小组积分板
//   计时器：独立于活动计时，倒计时结束 WebAudio 蜂鸣（关弹窗后仍在后台走）。
//   随机分组：本堂课已登记学生加密随机洗牌 → 按组数/每组人数均分。
//   积分板：按小组 +1/-1 计分，按 sessionId 存 localStorage（换课自动清零）。
//   依赖 window.Dashboard（api/toast/esc）。
// =============================================================================
(function () {
  const D = window.Dashboard;
  const $ = (id) => document.getElementById(id);
  const esc = D.esc;
  const fast = () => window.DashboardTools && window.DashboardTools._fast;

  // ---------- 计时器 ----------
  let tLeft = 0, tTotal = 0, tTimer = null, tRunning = false;
  const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');

  function renderTimer() {
    $('tl-time').textContent = fmt(Math.max(0, tLeft));
    $('tl-bar').style = 'width:' + (tTotal ? Math.round(tLeft / tTotal * 100) : 0) + '%';
  }
  function beep() {
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      [0, 0.25, 0.5].forEach((t) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.25, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.2);
      });
      setTimeout(() => ctx.close(), 1200);
    } catch (e) { /* 音频不可用静默 */ }
  }
  function stopTick() { if (tTimer) { clearInterval(tTimer); tTimer = null; } tRunning = false; }
  function startTimer() {
    if (tRunning) return;
    if (!tLeft) {
      const m = Number($('tl-min').value) || 0, s = Number($('tl-sec').value) || 0;
      tLeft = tTotal = m * 60 + s;
      if (!tLeft) { D.toast('请先设置时长', true); return; }
    }
    tRunning = true;
    $('tl-start').disabled = true; $('tl-pause').hidden = false;
    tTimer = setInterval(() => {
      tLeft -= 1;
      renderTimer();
      if (tLeft <= 0) {
        stopTick(); beep();
        $('tl-start').disabled = false; $('tl-pause').hidden = true;
        D.toast('计时结束 ⏰');
      }
    }, fast() ? 20 : 1000);
  }
  function pauseTimer() {
    stopTick();
    $('tl-start').disabled = false; $('tl-pause').hidden = true;
  }
  function resetTimer() {
    stopTick(); tLeft = 0; tTotal = 0; renderTimer();
    $('tl-start').disabled = false; $('tl-pause').hidden = true;
  }

  // ---------- 数据加载（分组/积分共用） ----------
  async function loadSnapshot() {
    const j = await D.api('GET', '/api/v1/dashboard/snapshot');
    return (j && j.code === 0 && j.data) || null;
  }

  // ---------- 随机分组 ----------
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const c = new Uint32Array(1);
      (globalThis.crypto || {}).getRandomValues ? crypto.getRandomValues(c) : (c[0] = Math.floor(Math.random() * 0xffffffff));
      const j = c[0] % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  async function makeGroups() {
    const snap = await loadSnapshot();
    const list = ((snap && snap.seats) || []).filter((s) => s.name && !s.exited)
      .map((s) => ({ seat: s.seat, name: s.name }));
    if (list.length < 2) { D.toast('本堂课还没有可分组的已登记学生', true); return; }
    const mode = $('rg-mode').value;
    const n = Number($('rg-num').value) || 2;
    let groups = [];
    if (mode === 'count') {
      const k = Math.max(1, Math.min(n, list.length));
      groups = Array.from({ length: k }, () => []);
      shuffle(list).forEach((s, i) => groups[i % k].push(s));
    } else {
      const size = Math.max(1, n);
      const k = Math.ceil(list.length / size);
      groups = Array.from({ length: k }, () => []);
      shuffle(list).forEach((s, i) => groups[Math.floor(i / size)].push(s));
    }
    $('rg-result').innerHTML = groups.map((g, i) =>
      '<div class="rg-group"><b>第 ' + (i + 1) + ' 组（' + g.length + ' 人）</b>'
      + g.map((s) => '<span>' + esc(s.name) + '<i>' + esc(s.seat) + '</i></span>').join('')
      + '</div>').join('');
    D.toast('已随机分成 ' + groups.length + ' 组');
  }

  // ---------- 小组积分板 ----------
  let scoreSid = '', scores = {};
  function saveScores() {
    try { localStorage.setItem('kct-scores-' + scoreSid, JSON.stringify(scores)); } catch (e) { /* 隐私模式忽略 */ }
  }
  function renderScores(groups) {
    $('sc-board').innerHTML = (groups || []).map((g) =>
      '<div class="sc-card"><b>' + esc(g) + '</b>'
      + '<div class="sc-num">' + (scores[g] || 0) + '</div>'
      + '<div class="sc-btns">'
      + '<button type="button" class="btn btn-sm" data-sc-add="-1">−1</button>'
      + '<button type="button" class="btn btn-sm btn-primary" data-sc-add="1">+1</button>'
      + '<button type="button" class="btn btn-sm btn-primary" data-sc-add="5">+5</button>'
      + '</div></div>').join('') || '<p class="hint">暂无小组</p>';
  }
  async function loadScores() {
    const snap = await loadSnapshot();
    scoreSid = (snap && snap.session && snap.session.sessionId) || '';
    const groups = ((snap && snap.groups) || []).map((g) => g.groupId);
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('kct-scores-' + scoreSid) || '{}'); } catch (e) { /* 忽略坏档 */ }
    scores = {};
    groups.forEach((g) => { scores[g] = Number(saved[g]) || 0; });
    renderScores(groups);
  }
  function onScoreClick(e) {
    const b = e.target.closest('[data-sc-add]');
    if (!b) return;
    const card = b.closest('.sc-card');
    const g = card && card.querySelector('b');
    if (!g) return;
    scores[g.textContent] = (scores[g.textContent] || 0) + Number(b.dataset.scAdd);
    card.querySelector('.sc-num').textContent = scores[g.textContent];
    saveScores();
  }
  function resetScores() {
    Object.keys(scores).forEach((k) => { scores[k] = 0; });
    saveScores();
    renderScores(Object.keys(scores));
    D.toast('积分已清零');
  }

  // ---------- 弹窗与页签 ----------
  function showTab(mode) {
    ['timer', 'group', 'score'].forEach((m) => { $('tl-panel-' + m).hidden = m !== mode; });
    ['timer', 'group', 'score'].forEach((m) => {
      $('tab-' + m).className = 'btn btn-sm' + (m === mode ? ' btn-primary' : ' btn-ghost');
    });
  }
  async function open() {
    $('overlay-tools').hidden = false;
    await loadScores();
  }
  function bind() {
    const b = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    b('btn-tools', open);
    b('tab-timer', () => showTab('timer'));
    b('tab-group', () => showTab('group'));
    b('tab-score', () => showTab('score'));
    b('tl-start', startTimer);
    b('tl-pause', pauseTimer);
    b('tl-reset', resetTimer);
    b('rg-make', makeGroups);
    b('sc-reset', resetScores);
    const board = $('sc-board');
    if (board) board.addEventListener('click', onScoreClick);
  }
  bind(); // 脚本在 body 末尾，元素已就绪（不占 DOMContentLoaded，避免监听互相覆盖）

  window.DashboardTools = { open, _fast: false, _scores: () => scores };
})();
