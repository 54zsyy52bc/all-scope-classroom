'use strict';
// =============================================================================
// 教师大屏 · OOBE 首次运行向导（类似 Windows 开箱体验）。
// 四步：欢迎 → 上课四步 → 预设与内容 → 小工具；完成/跳过写 localStorage 标记。
// 纯前端引导，不动服务端数据。依赖 window.Dashboard（esc）。
// =============================================================================
(function () {
  const $ = (id) => document.getElementById(id);
  const KEY = 'kct-oobe-done';
  let step = 1;
  const TOTAL = 4;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function done() {
    try { localStorage.setItem(KEY, '1'); } catch (e) { /* 隐私模式忽略 */ }
  }

  function render() {
    for (let i = 1; i <= TOTAL; i += 1) { const p = $('tb-step-' + i); if (p) p.hidden = i !== step; }
    const dots = $('tb-dots');
    if (dots) dots.innerHTML = Array.from({ length: TOTAL }, (_, i) =>
      '<i class="' + (i + 1 === step ? 'on' : (i + 1 < step ? 'done' : '')) + '"></i>').join('');
    const prev = $('tb-prev');
    if (prev) prev.hidden = step === 1;
    const next = $('tb-next');
    if (next) next.textContent = step === TOTAL ? '完成，进入大屏' : '下一步';
    const skip = $('tb-skip');
    if (skip) skip.hidden = step === TOTAL;
  }

  function next() {
    if (step >= TOTAL) {
      done();
      const ov = $('overlay-oobe');
      if (ov) ov.hidden = true;
      return;
    }
    step += 1;
    render();
  }
  function prev() { if (step > 1) { step -= 1; render(); } }
  function skip() {
    done();
    const ov = $('overlay-oobe');
    if (ov) ov.hidden = true;
  }

  function maybeShow() {
    let seen = null;
    try { seen = localStorage.getItem(KEY); } catch (e) { seen = null; }
    if (seen === '1') return;
    const ov = $('overlay-oobe');
    if (ov) { ov.hidden = false; render(); }
  }

  function bind() {
    const b = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    b('tb-next', next);
    b('tb-prev', prev);
    b('tb-skip', skip);
    const openManage = $('tb-open-manage');
    if (openManage) openManage.onclick = () => {
      const m = $('btn-manage');
      if (m) m.click();
      skip();
    };
  }
  bind(); // 脚本在 body 末尾，元素已就绪（不占 DOMContentLoaded，避免监听互相覆盖）
  maybeShow();

  window.DashboardOobe = { next, prev, skip, render, _reset: () => { try { localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ } step = 1; } };
})();
