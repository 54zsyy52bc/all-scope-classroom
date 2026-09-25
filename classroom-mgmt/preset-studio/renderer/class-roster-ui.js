'use strict';
// =============================================================================
// Preset Studio · 学生包编辑器（v5 预设编辑器大改）
//   - 学生名单行编辑器：学号 / 姓名 / 分组；「从名单生成分组」按分组名聚合 → 分组配置
//   - 依赖 window.Editor（esc/toast）；由 app.js 装配、presets.js 的 fill/collect 调用
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

  function rowHTML(s) {
    return '<div class="roster-row">'
      + '<input data-s-no value="' + esc(s.studentNo || '') + '" placeholder="学号" maxlength="20" />'
      + '<input data-s-name value="' + esc(s.name || '') + '" placeholder="姓名" maxlength="30" />'
      + '<input data-s-group value="' + esc(s.group || '') + '" placeholder="分组（可空）" maxlength="20" />'
      + '<button type="button" class="row-del" data-s-del>×</button></div>';
  }

  function render(rows) {
    const host = $('c-students-editor');
    if (!host) return;
    const list = rows && rows.length ? rows : [];
    host.innerHTML = list.length
      ? list.map(rowHTML).join('')
      : '<p class="hint">未录入学生 → 可手动「+ 添加学生」，或用「智能生成」导入名单（分组配置仍按上方均分）。</p>';
  }

  function collect() {
    const host = $('c-students-editor');
    if (!host) return [];
    const rows = [];
    host.querySelectorAll('.roster-row').forEach((r) => {
      const name = r.querySelector('[data-s-name]').value.trim();
      if (!name) return; // 无姓名丢弃
      rows.push({
        studentNo: r.querySelector('[data-s-no]').value.trim(),
        name,
        group: r.querySelector('[data-s-group]').value.trim(),
        seat: rows.length + 1,
      });
    });
    return rows;
  }

  function addRow(s) {
    const host = $('c-students-editor');
    if (!host) return;
    host.querySelector('.hint') && (host.innerHTML = '');
    host.insertAdjacentHTML('beforeend', rowHTML(s || {}));
  }

  // 从名单聚合生成分组配置（复用 preset-class-ui 的分组编辑器渲染）
  function deriveGroups() {
    const students = collect();
    if (!students.length) { toast('名单为空，先录入或导入学生', true); return; }
    const order = [];
    const count = {};
    for (const s of students) {
      if (!s.group) continue;
      if (!(s.group in count)) { count[s.group] = 0; order.push(s.group); }
      count[s.group] += 1;
    }
    if (!order.length) { toast('名单里没有填写分组，无法生成', true); return; }
    const groups = order.map((g) => ({ groupId: g, size: count[g] }));
    if (global.PresetClassUi) global.PresetClassUi.renderGroups(groups);
    const seats = $('c-seats');
    if (seats) seats.value = students.length;
    toast('已按名单生成 ' + groups.length + ' 个分组，座位数 = 学生数 ' + students.length);
  }

  function fill(students) { render(students || []); }
  function reset() { render([]); }

  function bind() {
    const host = $('c-students-editor');
    if (host) {
      host.addEventListener('click', (e) => {
        const del = e.target.closest('[data-s-del]');
        if (!del) return;
        del.closest('.roster-row').remove();
        if (!host.querySelector('.roster-row')) render([]);
      });
    }
    const add = $('btn-student-add');
    if (add) add.onclick = () => addRow({});
    const dg = $('btn-roster-groups');
    if (dg) dg.onclick = deriveGroups;
  }

  global.PresetRoster = { bind, fill, reset, collect, addRow, render };
})(window);
