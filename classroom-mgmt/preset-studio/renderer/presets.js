'use strict';
// 教室编辑器 · 预设管理（班级/活动 CRUD）。依赖 window.Editor。
// 班级：name/totalSeats/groupSize/note + info/students[]/lessons[]（v5）
// 活动：name/category/note + equipment[] + taskTemplates[]
(function (global) {
  const Editor = global.Editor;
  // ---------- 班级预设 ----------
  function renderClassList(classes) {
    const host = Editor.el('class-list');
    if (!classes.length) { host.innerHTML = '<p class="hint">还没有班级预设，先在上方新建一个。</p>'; return; }
    host.innerHTML = classes.map((c) => '<div class="list-item">'
      + '<div class="li-main"><div class="li-title">' + Editor.esc(c.name) + '</div>'
      + '<div class="li-sub">' + c.totalSeats + ' 座 · 每组 ' + c.groupSize + ' 人'
      + (c.students && c.students.length ? ' · 学生 ' + c.students.length : '')
      + (c.lessons && c.lessons.length ? ' · 课时 ' + c.lessons.length : '') + (c.note ? ' · ' + Editor.esc(c.note) : '') + '</div></div>'
      + '<div class="li-actions">'
      + '<button class="mini-btn" data-class-edit="' + Editor.esc(c.presetId) + '">编辑</button>'
      + '<button class="mini-btn danger" data-class-del="' + Editor.esc(c.presetId) + '">删除</button></div></div>'
    ).join('');
  }
  // P1-3：保存后的持久化"下一步"引导（toast 3.2s 会消失，此条常驻；终点=导出预设包）
  function renderNextStep(c) {
    const bar = Editor.el('class-nextstep');
    if (!bar) return;
    const steps = [];
    if (!(c && c.students && c.students.length)) steps.push({ key: 'students', label: '② 录入学生名单', hint: '可导入 CSV 一键完成' });
    if (!(c && c.lessons && c.lessons.length)) steps.push({ key: 'lessons', label: '③ 安排课时', hint: '「智能生成」导入课件可自动建' });
    if (!(c && c.equipment && c.equipment.length)) steps.push({ key: 'equipment', label: '④ 配置上课器材', hint: '每节课固定发放的器材' });
    const exportBtn = '<button type="button" class="mini-btn nextstep-export" data-export-now>'
      + (steps.length ? '完成 → 导出预设包' : '内容已完整 → 导出预设包') + '</button>';
    bar.hidden = false;
    bar.innerHTML = (steps.length
      ? '<span class="ns-label">接下来：</span>' + steps.map((s) => '<button type="button" class="mini-btn" data-goto-step="'
        + s.key + '" title="' + Editor.esc(s.hint) + '">' + Editor.esc(s.label) + '</button>').join('')
      : '<span class="ns-ok">该班级内容已完整</span>') + exportBtn;
  }
  function fillClassForm(c) {
    Editor.el('c-name').value = c.name; Editor.el('c-seats').value = c.totalSeats;
    Editor.el('c-group').value = c.groupSize; Editor.el('c-note').value = c.note || '';
    // v5：信息包 / 学生包 / 课时包 回填
    const info = c.info || {};
    Editor.el('c-grade').value = info.grade || '';
    Editor.el('c-room').value = info.room || '';
    Editor.el('c-teacher').value = info.teacher || '';
    if (global.PresetRoster) global.PresetRoster.fill(c.students || []);
    if (global.PresetLessons) global.PresetLessons.fill(c.lessons || []);
    Editor.el('c-name').dataset.editId = c.presetId;
    Editor.el('btn-class-save').textContent = '保存修改';
    if (global.PresetClassUi) global.PresetClassUi.fill(c); // v4.2：分组配置 + 上课器材
    renderNextStep(c);
  }
  function collectClassForm() {
    const body = {
      name: Editor.el('c-name').value.trim(),
      totalSeats: Number(Editor.el('c-seats').value) || 50,
      groupSize: Number(Editor.el('c-group').value) || 5,
      note: Editor.el('c-note').value.trim(),
    };
    // v5：信息包 / 学生包 / 课时包 随预设保存
    body.info = {
      grade: Editor.el('c-grade').value.trim() || null, room: Editor.el('c-room').value.trim() || null,
      teacher: Editor.el('c-teacher').value.trim() || null, semester: null,
    };
    if (global.PresetRoster) body.students = global.PresetRoster.collect();
    if (global.PresetLessons) body.lessons = global.PresetLessons.collect();
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
    const j = editId ? await Editor.api('PUT', '/api/v1/presets/classes/' + editId, body)
      : await Editor.api('POST', '/api/v1/presets/classes', body);
    if (j && j.code === 0) {
      // 连贯化：保存后保持编辑态（表单=最新内容），继续调整不必重新「编辑」
      await Editor.refreshPresets();
      const pid = (j.data && (j.data.preset_id || j.data.presetId)) || editId;
      const saved = (Editor.classes || []).find((c) => c.presetId === pid);
      if (saved) fillClassForm(saved); else resetClassForm();
      Editor.toast(saved ? '已保存，可继续调整（新建班级请点「清空新建」）' : '班级预设已保存');
    }
  }
  function resetClassForm() {
    Editor.el('c-name').value = ''; Editor.el('c-seats').value = 50;
    Editor.el('c-group').value = 5; Editor.el('c-note').value = '';
    // v5：信息包 / 学生包 / 课时包 重置
    Editor.el('c-grade').value = ''; Editor.el('c-room').value = ''; Editor.el('c-teacher').value = '';
    if (global.PresetRoster) global.PresetRoster.reset();
    if (global.PresetLessons) global.PresetLessons.reset();
    delete Editor.el('c-name').dataset.editId;
    Editor.el('btn-class-save').textContent = '保存班级预设';
    if (global.PresetClassUi) global.PresetClassUi.reset();
  }
  async function removeClass(id, name) {
    if (!await global.PresetDialog.confirmDialog({ title: '删除班级预设', message: '删除班级预设「' + name + '」？', confirmText: '删除', danger: true })) return;
    const j = await Editor.api('DELETE', '/api/v1/presets/classes/' + id);
    if (j && j.code === 0) { Editor.toast('已删除'); Editor.refreshPresets(); }
  }
  // ---------- 器材 / 任务模板编辑器行 ----------
  function renderEqEditor(rows) {
    const host = Editor.el('eq-editor');
    const list = rows.length ? rows : [{ eqId: '', eqName: '', category: '', preset: 1 }];
    host.innerHTML = list.map((e, i) => '<div class="eq-row">'
      + '<input data-eq-id="' + i + '" list="dict-eq" value="' + Editor.esc(e.eqId || '') + '" placeholder="编号（可联想字典，如 DEV-BOARD）" />'
      + '<input data-eq-name="' + i + '" value="' + Editor.esc(e.eqName || '') + '" placeholder="名称（如 开发板）" />'
      + '<input data-eq-cat="' + i + '" value="' + Editor.esc(e.category || '') + '" placeholder="分类" />'
      + '<input data-eq-preset="' + i + '" type="number" min="0" max="99" value="' + (e.preset != null ? e.preset : 1) + '" title="登记页默认勾选数量" />'
      + '<button type="button" class="row-del" data-eq-del="' + i + '">×</button></div>').join('');
  }
  function collectEqRows() {
    const rows = [];
    Editor.el('eq-editor').querySelectorAll('.eq-row').forEach((rowEl) => {
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
  function renderTplEditor(rows) {
    const host = Editor.el('tpl-editor');
    const list = rows.length ? rows : [{ title: '', desc: '' }];
    host.innerHTML = list.map((t, i) => '<div class="tpl-row">'
      + '<input data-tpl-title="' + i + '" value="' + Editor.esc(t.title || '') + '" placeholder="活动标题" />'
      + '<input data-tpl-desc="' + i + '" value="' + Editor.esc(t.desc || '') + '" placeholder="说明（选填）" />'
      + '<button type="button" class="row-del" data-tpl-del="' + i + '">×</button></div>').join('');
  }
  function collectTplRows() {
    const rows = [];
    Editor.el('tpl-editor').querySelectorAll('.tpl-row').forEach((rowEl) => {
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
    host.innerHTML = acts.map((a) => '<div class="list-item">'
      + '<div class="li-main"><div class="li-title">' + Editor.esc(a.name) + (a.category ? ' <span class="hint">' + Editor.esc(a.category) + '</span>' : '') + '</div>'
      + '<div class="li-sub">' + a.equipment.length + ' 件器材 · ' + a.taskTemplates.length + ' 个活动模板'
      + (a.timed ? ' · 计时 ' + Math.round((a.durationSec || 0) / 60) + ' 分钟' : '') + (a.note ? ' · ' + Editor.esc(a.note) : '') + '</div></div>'
      + '<div class="li-actions">'
      + '<button class="mini-btn" data-activity-edit="' + Editor.esc(a.presetId) + '">编辑</button>'
      + '<button class="mini-btn" data-activity-export="' + Editor.esc(a.presetId) + '">导出包</button>'
      + '<button class="mini-btn danger" data-activity-del="' + Editor.esc(a.presetId) + '">删除</button></div></div>'
    ).join('');
  }
  function fillActivityForm(a) {
    Editor.el('a-name').value = a.name; Editor.el('a-category').value = a.category || '';
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
    Editor.el('a-name').value = ''; Editor.el('a-category').value = ''; Editor.el('a-note').value = '';
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
    const j = editId ? await Editor.api('PUT', '/api/v1/presets/activities/' + editId, body)
      : await Editor.api('POST', '/api/v1/presets/activities', body);
    if (j && j.code === 0) {
      // 连贯化：保存后保持编辑态，器材/模板可接着改
      await Editor.refreshPresets();
      const pid = (j.data && (j.data.preset_id || j.data.presetId)) || editId;
      const saved = (Editor.activities || []).find((a) => a.presetId === pid);
      if (saved) fillActivityForm(saved); else resetActivityForm();
      Editor.toast(saved ? '已保存，可继续调整（新建活动请点「清空新建」）' : '活动预设已保存');
      // P0-2：从班级页"去创建活动预设"跳来的，保存成功后自动回班级页
      if (Editor._returnTo) { const back = Editor._returnTo; Editor._returnTo = null; if (Editor.gotoTab) Editor.gotoTab(back); }
    }
  }
  async function removeActivity(id, name) {
    if (!await global.PresetDialog.confirmDialog({ title: '删除活动预设', message: '删除活动预设「' + name + '」？', confirmText: '删除', danger: true })) return;
    const j = await Editor.api('DELETE', '/api/v1/presets/activities/' + id);
    if (j && j.code === 0) { Editor.toast('已删除'); Editor.refreshPresets(); }
  }
  // P1-5：清空新建补确认（表单有内容时；无弹窗组件环境如测试桩直接放行）
  async function resetClassFormConfirmed() {
    const dlg = global.PresetDialog;
    const hasContent = Editor.el('c-name').value.trim()
      || (global.PresetRoster && global.PresetRoster.collect().length) || (global.PresetLessons && global.PresetLessons.collect().length)
      || (global.PresetClassUi && global.PresetClassUi.collectClassEq && global.PresetClassUi.collectClassEq().length);
    if (hasContent && dlg && dlg.confirmDialog) {
      const ok = await dlg.confirmDialog({
        title: '清空当前表单', confirmText: '清空', danger: true,
        message: '将清空表单内所有未保存内容（学生名单、课时安排、上课器材等）。已保存的班级预设不受影响。',
      });
      if (!ok) return;
    }
    resetClassForm();
  }
  // ---------- 事件委托 ----------
  function bindPresetEvents() {
    const cls = Editor.el('panel-classes');
    cls.addEventListener('click', (e) => {
      const edit = e.target.closest('[data-class-edit]');
      const del = e.target.closest('[data-class-del]');
      const step = e.target.closest('[data-goto-step]');
      const exp = e.target.closest('[data-export-now]');
      if (exp) {
        const b = document.getElementById('btn-export-pkg');
        if (b && b.onclick) b.onclick();
      } else if (step) {
        const target = document.getElementById({ students: 'c-students-editor', lessons: 'c-lessons-editor', equipment: 'class-eq-editor' }[step.dataset.gotoStep]);
        if (target && target.scrollIntoView) {
          const reduce = global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
          target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
        }
      } else if (edit) {
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
        const a = (Editor.activities || []).find((x) => x.presetId === del.dataset.activityDel); if (a) removeActivity(a.presetId, a.name);
      } else if (exp) {
        const a = (Editor.activities || []).find((x) => x.presetId === exp.dataset.activityExport);
        if (a) exportActivity(a.presetId, a.name);
      } else if (eqAdd) {
        renderEqEditor(collectEqRows().concat([{ eqId: '', eqName: '', category: '', preset: 1 }]));
      } else if (tplAdd) {
        renderTplEditor(collectTplRows().concat([{ title: '', desc: '' }]));
      } else if (eqDel) {
        const rows = collectEqRows(); rows.splice(Number(eqDel.dataset.eqDel), 1); renderEqEditor(rows);
      } else if (tplDel) {
        const rows = collectTplRows(); rows.splice(Number(tplDel.dataset.tplDel), 1); renderTplEditor(rows);
      }
    });
    Editor.el('btn-class-save').onclick = saveClass;
    Editor.el('btn-class-reset').onclick = resetClassFormConfirmed;
    Editor.el('btn-activity-save').onclick = saveActivity;
    Editor.el('btn-activity-reset').onclick = resetActivityForm;
    Editor.el('a-timed').addEventListener('change', (e) => { Editor.el('a-duration').disabled = !e.target.checked; });
  }
  function render(classes, activities) {
    renderClassList(classes);
    renderActivityList(activities);
  }
  global.PresetView = { render, bindPresetEvents, renderEqEditor, renderTplEditor, editClass: fillClassForm, editActivity: fillActivityForm };
})(window);
