'use strict';
// =============================================================================
// 教师大屏 · OOBE 首次运行向导（全屏，类似 Windows 开箱体验）。
// 五步：欢迎 → 教师信息 → 课堂四步 → 预设与内容（可一键导入预设包）→ 小工具。
// 完成/跳过写 localStorage 标记；教师姓名存 kct-teacher-info 并自动预填「开始上课」。
// 纯前端引导，不动服务端数据。依赖 window.Dashboard（无强依赖）。
// =============================================================================
(function () {
  const $ = (id) => document.getElementById(id);
  const KEY = 'kct-oobe-done';
  const TKEY = 'kct-teacher-info';
  const STEP_IDS = ['tb-step-1', 'tb-step-teacher', 'tb-step-2', 'tb-step-3', 'tb-step-4'];
  let step = 1; // 1 基下标（1..5）

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function done() {
    try { localStorage.setItem(KEY, '1'); } catch (e) { /* 隐私模式忽略 */ }
  }

  function render() {
    STEP_IDS.forEach((id, i) => { const p = $(id); if (p) p.hidden = i + 1 !== step; });
    const dots = $('tb-dots');
    if (dots) dots.innerHTML = STEP_IDS.map((_, i) =>
      '<i class="' + (i + 1 === step ? 'on' : (i + 1 < step ? 'done' : '')) + '"></i>').join('');
    const prev = $('tb-prev');
    if (prev) prev.hidden = step === 1;
    const next = $('tb-next');
    if (next) next.textContent = step === STEP_IDS.length ? '完成，进入大屏' : '下一步';
    const skip = $('tb-skip');
    if (skip) skip.hidden = step === STEP_IDS.length;
  }

  function readTeacher() {
    try { return JSON.parse(localStorage.getItem(TKEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function saveTeacher() {
    const name = ($('tb-teacher-name') || {}).value.trim();
    const school = ($('tb-teacher-school') || {}).value.trim();
    if (!name) return; // 留空 = 暂不填写
    try { localStorage.setItem(TKEY, JSON.stringify({ name: name.slice(0, 20), school: school.slice(0, 30) })); } catch (e) { /* 忽略 */ }
  }

  // 把已保存的教师姓名预填进「开始上课」表单（返回用户/跳过向导的用户也受益）
  function prefillTeacher() {
    const t = readTeacher();
    const f = $('f-teacher');
    if (t && t.name && f && !f.value.trim()) f.value = t.name;
  }

  // 「开始上课」提交的姓名回写，下次自动预填（借 click 捕获，不覆盖 app.js 的 onclick）
  function hookStart() {
    const sb = $('btn-start');
    if (!sb || !sb.addEventListener) return;
    sb.addEventListener('click', () => {
      const f = $('f-teacher');
      const name = f ? f.value.trim() : '';
      if (!name) return;
      try {
        const t = readTeacher();
        localStorage.setItem(TKEY, JSON.stringify({ name: name.slice(0, 20), school: String(t.school || '').slice(0, 30) }));
      } catch (e) { /* 忽略 */ }
    });
  }

  function next() {
    if (step === 2) saveTeacher();
    if (step >= STEP_IDS.length) {
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

  // 一键导入预设包：打开「预设管理」并直接拉起文件选择（复用 manage.js 既有导入/预演/确认流程）
  function openImport() {
    const m = $('btn-manage');
    if (m) m.click();
    skip();
    setTimeout(() => { const f = $('m-import-file'); if (f) f.click(); }, 150);
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
    b('tb-import-now', openImport);
    const openManage = $('tb-open-manage');
    if (openManage) openManage.onclick = () => {
      const m = $('btn-manage');
      if (m) m.click();
      skip();
    };
    prefillTeacher();
    hookStart();
  }
  bind(); // 脚本在 body 末尾，元素已就绪（不占 DOMContentLoaded，避免监听互相覆盖）
  maybeShow();

  window.DashboardOobe = {
    next, prev, skip, render, prefillTeacher,
    _reset: () => { try { localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ } step = 1; },
  };
})();
