'use strict';
// Preset Studio · OOBE 首次运行向导（类似 Windows 开箱体验）。
// 四步：欢迎 → 创建第一个班级 → 器材字典种子 → 完成。完成/跳过均写 meta.oobeDone。
// 依赖 window.StudioApi（metaGet/metaSet/saveClass/saveDict）与 window.Editor（toast/refreshPresets）。
(function (global) {
  const $ = (id) => document.getElementById(id);
  const S = () => global.StudioApi;
  let step = 1;
  const TOTAL = 4;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function toast(t, err) { if (global.Editor && global.Editor.toast) global.Editor.toast(t, err); }

  function render() {
    for (let i = 1; i <= TOTAL; i += 1) { const p = $('ob-step-' + i); if (p) p.hidden = i !== step; }
    const dots = $('ob-dots');
    if (dots) dots.innerHTML = Array.from({ length: TOTAL }, (_, i) =>
      '<i class="' + (i + 1 === step ? 'on' : (i + 1 < step ? 'done' : '')) + '"></i>').join('');
    const prev = $('ob-prev');
    if (prev) prev.hidden = step === 1;
    const next = $('ob-next');
    if (next) next.textContent = step === TOTAL ? '完成，开始使用' : '下一步';
    const skip = $('ob-skip');
    if (skip) skip.hidden = step === TOTAL;
  }

  async function finish() {
    try { await S().metaSet('oobeDone', true); } catch (e) { /* 写失败不阻断 */ }
    const ov = $('overlay-oobe');
    if (ov) ov.hidden = true;
    if (global.Editor && global.Editor.refreshPresets) await global.Editor.refreshPresets();
    toast('设置完成，欢迎使用全域预设编辑器');
  }

  async function next() {
    if (step === 2) {
      const name = ($('ob-class-name') || {}).value.trim();
      if (name) {
        const body = {
          name,
          totalSeats: Number(($('ob-seats') || {}).value) || 50,
          groupSize: Number(($('ob-group') || {}).value) || 5,
          note: 'OOBE 创建',
        };
        const j = await S().saveClass(body);
        if (j && j.preset_id) toast('班级「' + name + '」已创建');
        if (global.Editor) global.Editor.classes = global.Editor.classes || [];
      }
    }
    if (step === 3) {
      const ck = $('ob-dict-seed');
      if (ck && ck.checked) {
        const SEED = [
          { eqId: 'LED', eqName: 'LED 发光二极管', category: '元件' },
          { eqId: 'BB-830', eqName: '面包板 830 孔', category: '工具' },
          { eqId: 'UNO', eqName: 'Arduino UNO 主控', category: '主控' },
          { eqId: 'JUMPER', eqName: '杜邦线', category: '耗材' },
          { eqId: 'R-220', eqName: '电阻 220Ω', category: '元件' },
          { eqId: 'SOLDER-SET', eqName: '电烙铁套装', category: '工具' },
        ];
        let added = 0;
        for (const it of SEED) {
          try { await S().saveDict(it); added += 1; } catch (e) { /* 已存在等错误跳过 */ }
        }
        toast('已导入 ' + added + ' 条常用器材');
      }
    }
    if (step >= TOTAL) { await finish(); return; }
    step += 1;
    render();
  }

  function prev() { if (step > 1) { step -= 1; render(); } }
  async function skip() {
    try { await S().metaSet('oobeDone', true); } catch (e) { /* 忽略 */ }
    const ov = $('overlay-oobe');
    if (ov) ov.hidden = true;
  }

  async function maybeShow() {
    let done = null;
    try { done = await S().metaGet('oobeDone'); } catch (e) { done = null; }
    if (done) return;
    const ov = $('overlay-oobe');
    if (ov) { ov.hidden = false; render(); }
  }

  function bind() {
    const b = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    b('ob-next', next);
    b('ob-prev', prev);
    b('ob-skip', skip);
  }
  bind();
  maybeShow();

  global.Oobe = { next, prev, skip, render, maybeShow };
})(window);
