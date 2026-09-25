'use strict';
// =============================================================================
// Preset Studio · 课时包编辑器（v5 预设编辑器大改）
//   脑图结构：班级包 > 课堂包 > *课时包（引用 *活动包 + 挂 *器材包）。
//   课时只存 activityIds 引用（活动预设独立维护），器材按课时单独配置；
//   两者都支持后期单独替换添加（对应脑图 * 说明）。
//   依赖 window.Editor（el/esc/activities 缓存）。
// =============================================================================
(function (global) {
  const Editor = global.Editor;
  const $ = (id) => document.getElementById(id);
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function toast(t, err) { if (Editor.toast) Editor.toast(t, err); }

  function actChipsHTML(selectedIds) {
    const acts = Editor.activities || [];
    if (!acts.length) return '<p class="hint">还没有活动预设，先到「活动预设」页创建，再回来勾选。</p>';
    const sel = new Set(selectedIds || []);
    return '<div class="lesson-acts">' + acts.map((a) =>
      '<label class="tpl-chip"><input type="checkbox" data-l-act value="' + esc(a.presetId) + '"'
      + (sel.has(a.presetId) ? ' checked' : '') + ' /> ' + esc(a.name) + '</label>'
    ).join('') + '</div>';
  }

  function lessonEqRowHTML(e) {
    return '<div class="eq-row lesson-eq-row">'
      + '<input data-le-id value="' + esc(e.eqId || '') + '" placeholder="器材编号" maxlength="30" />'
      + '<input data-le-name value="' + esc(e.eqName || '') + '" placeholder="器材名称" maxlength="30" />'
      + '<input data-le-preset type="number" min="0" max="99" value="' + (e.preset != null ? e.preset : 1) + '" title="默认数量" />'
      + '<button type="button" class="row-del" data-le-del>×</button></div>';
  }

  function lessonHTML(l) {
    return '<div class="lesson-row" data-lesson>'
      + '<div class="lesson-head">'
      + '<input data-l-name value="' + esc(l.name || '') + '" placeholder="课时名称（如 第1课 点亮 LED）" maxlength="40" />'
      + '<button type="button" class="row-del" data-l-del>×</button></div>'
      + actChipsHTML(l.activityIds || [])
      + '<div class="lesson-eq">' + (l.equipment || []).map(lessonEqRowHTML).join('') + '</div>'
      + '<button type="button" class="btn btn-ghost lesson-eq-add" data-l-eq-add>+ 本课时器材</button>'
      + '</div>';
  }

  function render(lessons) {
    const host = $('c-lessons-editor');
    if (!host) return;
    const list = lessons && lessons.length ? lessons : [];
    host.innerHTML = list.length
      ? list.map(lessonHTML).join('')
      : '<p class="hint">未安排课时 → 手动添加，或「导入课件生成课时」骨架（活动/器材后补）。</p>';
  }

  function collect() {
    const host = $('c-lessons-editor');
    if (!host) return [];
    const rows = [];
    host.querySelectorAll('[data-lesson]').forEach((rowEl, li) => {
      const name = rowEl.querySelector('[data-l-name]').value.trim();
      if (!name) return;
      const activityIds = [];
      rowEl.querySelectorAll('[data-l-act]:checked').forEach((c) => activityIds.push(c.value));
      const equipment = [];
      rowEl.querySelectorAll('.lesson-eq-row').forEach((eq) => {
        const eqId = eq.querySelector('[data-le-id]').value.trim();
        const eqName = eq.querySelector('[data-le-name]').value.trim();
        if (!eqId && !eqName) return;
        equipment.push({
          eqId: eqId || 'EQ-' + (equipment.length + 1),
          eqName: eqName || eqId || '器材' + (equipment.length + 1),
          category: '其他',
          preset: Math.max(0, Number(eq.querySelector('[data-le-preset]').value) || 1),
        });
      });
      rows.push({ lessonId: 'L' + (li + 1), name, activityIds, equipment, note: null });
    });
    return rows;
  }

  function addLesson(l) {
    const host = $('c-lessons-editor');
    if (!host) return;
    host.querySelector('.hint') && (host.innerHTML = '');
    host.insertAdjacentHTML('beforeend', lessonHTML(l || {}));
  }

  // 追加一个课时（智能生成课件导入用）；返回生成的课时名
  function appendSkel(name) {
    const list = collect();
    const dup = list.filter((l) => l.name === name).length;
    const finalName = dup ? name + '（' + (dup + 1) + '）' : name;
    addLesson({ name: finalName, activityIds: [], equipment: [] });
    return finalName;
  }

  function fill(lessons) { render(lessons || []); }
  function reset() { render([]); }

  // 活动预设变化后重建勾选 chips（collect→fill 往返，保留已填课时内容）
  function refreshChips() {
    const host = $('c-lessons-editor');
    if (host && host.querySelector('[data-lesson]')) fill(collect());
  }

  function bind() {
    const host = $('c-lessons-editor');
    if (host) {
      host.addEventListener('click', (e) => {
        const del = e.target.closest('[data-l-del]');
        const eqAdd = e.target.closest('[data-l-eq-add]');
        const eqDel = e.target.closest('[data-le-del]');
        if (del) {
          del.closest('[data-lesson]').remove();
          if (!host.querySelector('[data-lesson]')) render([]);
        } else if (eqAdd) {
          eqAdd.closest('[data-lesson]').querySelector('.lesson-eq')
            .insertAdjacentHTML('beforeend', lessonEqRowHTML({}));
        } else if (eqDel) {
          eqDel.closest('.lesson-eq-row').remove();
        }
      });
    }
    const add = $('btn-lesson-add');
    if (add) add.onclick = () => addLesson({});
  }

  global.PresetLessons = { bind, fill, reset, collect, addLesson, appendSkel, refreshChips };
})(window);
