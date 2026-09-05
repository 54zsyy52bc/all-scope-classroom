'use strict';
// =============================================================================
// 教室编辑器 · 预设管理（班级 / 活动 CRUD）
//
// 依赖 window.Editor（app.js 注入的公共工具：api / toast / esc / refreshPresets）
// 班级预设：name / totalSeats / groupSize / note
// 活动预设：name / category / note + equipment[]（eqId/eqName/category/preset）+ taskTemplates[]（title/desc）
// =============================================================================
(function (global) {
  const Editor = global.Editor;

  // ---------- 班级预设 ----------
  function renderClassList(classes) {
    const host = Editor.el('class-list');
    if (!classes.length) { host.innerHTML = '<p class="hint">还没有班级预设，先在上方新建一个。</p>'; return; }
    host.innerHTML = classes.map((c) =>
      '<div class="list-item">'
      + '<div class="li-main"><div class="li-title">' + Editor.esc(c.name) + '</div>'
      + '<div class="li-sub">' + c.totalSeats + ' 座 · 每组 ' + c.groupSize + ' 人' + (c.note ? ' · ' + Editor.esc(c.note) : '') + '</div></div>'
      + '<div class="li-actions">'
      + '<button class="mini-btn" data-class-edit="' + Editor.esc(c.presetId) + '">编辑</button>'
      + '<button class="mini-btn danger" data-class-del="' + Editor.esc(c.presetId) + '">删除</button>'
      + '</div></div>'
    ).join('');
  }

  function fillClassForm(c) {
    Editor.el('c-name').value = c.name;
    Editor.el('c-seats').value = c.totalSeats;
    Editor.el('c-group').value = c.groupSize;
    Editor.el('c-note').value = c.note || '';
    Editor.el('c-name').dataset.editId = c.presetId;
    Editor.el('btn-class-save').textContent = '保存修改';
    // v4.2：分组配置 + 上课器材 回填
    if (global.PresetClassUi) global.PresetClassUi.fill(c);
  }

  function collectClassForm() {
    const body = {
      name: Editor.el('c-name').value.trim(),
      totalSeats: Number(Editor.el('c-seats').value) || 50,
      groupSize: Number(Editor.el('c-group').value) || 5,
      note: Editor.el('c-note').value.trim(),
    };
    // v4.2：分组配置与上课器材随预设保存（服务端标准化并联动座位数）
    if (global.PresetClassUi) {
      body.groups = global.PresetClassUi.collectGroups();
      body.equipment = global.PresetClassUi.collectClassEq();
    }
    return body;
  }

  async function saveClass() {
    const body = collectClassForm();
    if (!body.name) { Editor.toast('班级名称不能为空', true); return; }
    const editId = Editor.el('c-name').dataset.editId;
    const j = editId
      ? await Editor.api('PUT', '/api/v1/presets/classes/' + editId, body)
      : await Editor.api('POST', '/api/v1/presets/classes', body);
    if (j && j.code === 0) {
      Editor.toast(editId ? '班级预设已更新' : '班级预设已保存');
      resetClassForm();
      Editor.refreshPresets();
    }
  }

  function resetClassForm() {
    Editor.el('c-name').value = '';
    Editor.el('c-seats').value = 50;
    Editor.el('c-group').value = 5;
    Editor.el('c-note').value = '';
    delete Editor.el('c-name').dataset.editId;
    Editor.el('btn-class-save').textContent = '保存班级预设';
    if (global.PresetClassUi) global.PresetClassUi.reset();
  }

  async function removeClass(id, name) {
    if (!global.confirm('删除班级预设「' + name + '」？')) return;
    const j = await Editor.api('DELETE', '/api/v1/presets/classes/' + id);
    if (j && j.code === 0) { Editor.toast('已删除'); Editor.refreshPresets(); }
  }

  // ---------- 器材编辑器行 ----------
  function renderEqEditor(rows) {
    const host = Editor.el('eq-editor');
    const list = rows.length ? rows : [{ eqId: '', eqName: '', category: '', preset: 1 }];
    host.innerHTML = list.map((e, i) =>
      '<div class="eq-row">'
      + '<input data-eq-id="' + i + '" list="dict-eq" value="' + Editor.esc(e.eqId || '') + '" placeholder="编号（可联想字典，如 DEV-BOARD）" />'
      + '<input data-eq-name="' + i + '" value="' + Editor.esc(e.eqName || '') + '" placeholder="名称（如 开发板）" />'
      + '<input data-eq-cat="' + i + '" value="' + Editor.esc(e.category || '') + '" placeholder="分类" />'
      + '<input data-eq-preset="' + i + '" type="number" min="0" max="99" value="' + (e.preset != null ? e.preset : 1) + '" title="登记页默认勾选数量" />'
      + '<button type="button" class="row-del" data-eq-del="' + i + '">×</button>'
      + '</div>'
    ).join('');
  }

  function collectEqRows() {
    const rows = [];
    const host = Editor.el('eq-editor');
    host.querySelectorAll('.eq-row').forEach((rowEl) => {
      const eqId = rowEl.querySelector('[data-eq-id]').value.trim();
      const eqName = rowEl.querySelector('[data-eq-name]').value.trim();
      if (!eqId && !eqName) return; // 空行忽略
      rows.push({
        eqId: eqId || 'EQ-' + (rows.length + 1),
        eqName: eqName || eqId || ('器材' + (rows.length + 1)),
        category: rowEl.querySelector('[data-eq-cat]').value.trim() || '其他',
        preset: Math.max(0, Number(rowEl.querySelector('[data-eq-preset]').value) || 1),
      });
    });
    return rows;
  }

  // ---------- 任务模板编辑器行 ----------
  function renderTplEditor(rows) {
    const host = Editor.el('tpl-editor');
    const list = rows.length ? rows : [{ title: '', desc: '' }];
    host.innerHTML = list.map((t, i) =>
      '<div class="tpl-row">'
      + '<input data-tpl-title="' + i + '" value="' + Editor.esc(t.title || '') + '" placeholder="任务标题" />'
      + '<input data-tpl-desc="' + i + '" value="' + Editor.esc(t.desc || '') + '" placeholder="说明（选填）" />'
      + '<button type="button" class="row-del" data-tpl-del="' + i + '">×</button>'
      + '</div>'
    ).join('');
  }

  function collectTplRows() {
    const rows = [];
    const host = Editor.el('tpl-editor');
    host.querySelectorAll('.tpl-row').forEach((rowEl) => {
      const title = rowEl.querySelector('[data-tpl-title]').value.trim();
      if (!title) return;
      rows.push({ title, desc: rowEl.querySelector('[data-tpl-desc]').value.trim() });
    });
    return rows;
  }

  // ---------- 活动预设 ----------
  // 单活动预设包导出（v4.2：把某活动单独打包 .kctpreset，供分发给其他班级/同事/另一台办公电脑）
  async function exportActivity(id, name) {
    try {
      const pkg = await global.StudioApi.pkgExport({ activities: [id] });
      if (!pkg.activities.length) { Editor.toast('导出失败：未找到该活动', true); return; }
      const file = await global.StudioApi.pkgSaveFile(pkg);
      if (file) Editor.toast('已导出活动包「' + name + '」→ ' + file);
    } catch (e) { Editor.toast((e && e.message) || '导出失败', true); }
  }

  function renderActivityList(acts) {
    const host = Editor.el('activity-list');
    if (!acts.length) { host.innerHTML = '<p class="hint">还没有活动预设，先在上方新建一个。</p>'; return; }
    host.innerHTML = acts.map((a) =>
      '<div class="list-item">'
      + '<div class="li-main"><div class="li-title">' + Editor.esc(a.name) + (a.category ? ' <span class="hint">' + Editor.esc(a.category) + '</span>' : '') + '</div>'
      + '<div class="li-sub">' + a.equipment.length + ' 件器材 · ' + a.taskTemplates.length + ' 个任务模板'
      + (a.timed ? ' · 计时 ' + Math.round((a.durationSec || 0) / 60) + ' 分钟' : '')
      + (a.note ? ' · ' + Editor.esc(a.note) : '') + '</div></div>'
      + '<div class="li-actions">'
      + '<button class="mini-btn" data-activity-edit="' + Editor.esc(a.presetId) + '">编辑</button>'
      + '<button class="mini-btn" data-activity-export="' + Editor.esc(a.presetId) + '">导出包</button>'
      + '<button class="mini-btn danger" data-activity-del="' + Editor.esc(a.presetId) + '">删除</button>'
      + '</div></div>'
    ).join('');
  }

  function fillActivityForm(a) {
    Editor.el('a-name').value = a.name;
    Editor.el('a-category').value = a.category || '';
    Editor.el('a-note').value = a.note || '';
    Editor.el('a-timed').checked = !!a.timed;
    Editor.el('a-duration').value = a.durationSec ? Math.round(a.durationSec / 60) : 10;
    Editor.el('a-duration').disabled = !a.timed;
    renderEqEditor(a.equipment || []);
    renderTplEditor(a.taskTemplates || []);
    Editor.el('a-name').dataset.editId = a.presetId;
    Editor.el('btn-activity-save').textContent = '保存修改';
  }

  function resetActivityForm() {
    Editor.el('a-name').value = '';
    Editor.el('a-category').value = '';
    Editor.el('a-note').value = '';
    Editor.el('a-timed').checked = false;
    Editor.el('a-duration').value = 10;
    Editor.el('a-duration').disabled = true;
    renderEqEditor([]);
    renderTplEditor([]);
    delete Editor.el('a-name').dataset.editId;
    Editor.el('btn-activity-save').textContent = '保存活动预设';
  }

  async function saveActivity() {
    const body = {
      name: Editor.el('a-name').value.trim(),
      category: Editor.el('a-category').value.trim(),
      note: Editor.el('a-note').value.trim(),
      timed: Editor.el('a-timed').checked,
      durationSec: Editor.el('a-timed').checked ? (Number(Editor.el('a-duration').value) || 10) * 60 : 0,
      equipment: collectEqRows(),
      taskTemplates: collectTplRows(),
    };
    if (!body.name) { Editor.toast('活动名称不能为空', true); return; }
    if (!body.equipment.length) { Editor.toast('请至少添加一件器材', true); return; }
    const editId = Editor.el('a-name').dataset.editId;
    const j = editId
      ? await Editor.api('PUT', '/api/v1/presets/activities/' + editId, body)
      : await Editor.api('POST', '/api/v1/presets/activities', body);
    if (j && j.code === 0) {
      Editor.toast(editId ? '活动预设已更新' : '活动预设已保存');
      resetActivityForm();
      Editor.refreshPresets();
    }
  }

  async function removeActivity(id, name) {
    if (!global.confirm('删除活动预设「' + name + '」？')) return;
    const j = await Editor.api('DELETE', '/api/v1/presets/activities/' + id);
    if (j && j.code === 0) { Editor.toast('已删除'); Editor.refreshPresets(); }
  }

  // ---------- 事件委托 ----------
  function bindPresetEvents() {
    const cls = Editor.el('panel-classes');
    cls.addEventListener('click', (e) => {
      const edit = e.target.closest('[data-class-edit]');
      const del = e.target.closest('[data-class-del]');
      if (edit) {
        const c = (Editor.classes || []).find((x) => x.presetId === edit.dataset.classEdit);
        if (c) fillClassForm(c);
      } else if (del) {
        const c = (Editor.classes || []).find((x) => x.presetId === del.dataset.classDel);
        if (c) removeClass(c.presetId, c.name);
      }
    });
    const act = Editor.el('panel-activities');
    act.addEventListener('click', (e) => {
      const edit = e.target.closest('[data-activity-edit]');
      const del = e.target.closest('[data-activity-del]');
      const exp = e.target.closest('[data-activity-export]');
      const eqAdd = e.target.closest('#btn-eq-add');
      const tplAdd = e.target.closest('#btn-tpl-add');
      const eqDel = e.target.closest('[data-eq-del]');
      const tplDel = e.target.closest('[data-tpl-del]');
      if (edit) {
        const a = (Editor.activities || []).find((x) => x.presetId === edit.dataset.activityEdit);
        if (a) fillActivityForm(a);
      } else if (del) {
        const a = (Editor.activities || []).find((x) => x.presetId === del.dataset.activityDel);
        if (a) removeActivity(a.presetId, a.name);
      } else if (exp) {
        const a = (Editor.activities || []).find((x) => x.presetId === exp.dataset.activityExport);
        if (a) exportActivity(a.presetId, a.name);
      } else if (eqAdd) {
        renderEqEditor(collectEqRows().concat([{ eqId: '', eqName: '', category: '', preset: 1 }]));
      } else if (tplAdd) {
        renderTplEditor(collectTplRows().concat([{ title: '', desc: '' }]));
      } else if (eqDel) {
        const rows = collectEqRows();
        rows.splice(Number(eqDel.dataset.eqDel), 1);
        renderEqEditor(rows);
      } else if (tplDel) {
        const rows = collectTplRows();
        rows.splice(Number(tplDel.dataset.tplDel), 1);
        renderTplEditor(rows);
      }
    });
    Editor.el('btn-class-save').onclick = saveClass;
    Editor.el('btn-activity-save').onclick = saveActivity;
    Editor.el('a-timed').addEventListener('change', (e) => { Editor.el('a-duration').disabled = !e.target.checked; });
  }

  function render(classes, activities) {
    renderClassList(classes);
    renderActivityList(activities);
  }

  global.PresetView = { render, bindPresetEvents, renderEqEditor, renderTplEditor };
})(window);
