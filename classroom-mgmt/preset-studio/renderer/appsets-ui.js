'use strict';
// =============================================================================
// Preset Studio · 应用包编辑器（v5.6）
// 应用包 = 一套"学生桌面磁贴"应用名清单，与班级/课时互不绑定；
// 老师开始上课时选用一套，学生端按应用名匹配本机 desktop-config 过滤磁贴。
// 依赖 Editor（app.js 注入 el/esc/toast）与 window.StudioApi.saveAppSet/removeAppSet。
// =============================================================================
(function (global) {
  const el = (id) => document.getElementById(id);
  const esc = (s) => global.Editor.esc(s);
  let editingId = null; // 正在编辑的 appSetId（null = 新建）

  function parseApps(text) {
    return String(text || '').split('\n').map((x) => x.trim()).filter(Boolean);
  }
  function appsText(apps) { return (apps || []).join('\n'); }

  function render() {
    const host = el('appset-list');
    const list = global.Editor.appSets || [];
    if (!list.length) {
      host.innerHTML = '<p class="hint">还没有应用包 —— 先在上方创建一套（例如"焊接课套件"）。</p>';
      return;
    }
    host.innerHTML = list.map((s) =>
      '<div class="list-item">'
      + '<div class="li-main"><div class="li-title">' + esc(s.name) + '（' + (s.apps || []).length + ' 应用）</div>'
      + '<div class="li-sub">' + esc((s.apps || []).join('、')) + '</div></div>'
      + '<div class="li-actions">'
      + '<button class="mini-btn" data-as-edit="' + esc(s.appSetId) + '">编辑</button>'
      + '<button class="mini-btn danger" data-as-del="' + esc(s.appSetId) + '">删除</button>'
      + '</div></div>'
    ).join('');
  }

  function resetForm() {
    editingId = null;
    el('as-name').value = '';
    el('as-note').value = '';
    el('as-apps').value = '';
  }

  async function save() {
    const name = el('as-name').value.trim();
    const apps = parseApps(el('as-apps').value);
    if (!name) { global.Editor.toast('应用包名称必填', true); return; }
    if (!apps.length) { global.Editor.toast('至少填一个应用名（每行一个）', true); return; }
    if (apps.length > 24) { global.Editor.toast('应用数量不能超过 24', true); return; }
    try {
      const row = { name, apps, note: el('as-note').value.trim() || null };
      if (editingId) row.app_set_id = editingId;
      await global.StudioApi.saveAppSet(row);
      global.Editor.toast(editingId ? '应用包已更新' : '应用包已保存');
      resetForm();
      await global.Editor.refreshPresets();
    } catch (e) { global.Editor.toast((e && e.message) || '保存失败', true); }
  }

  async function remove(appSetId, name) {
    if (!await global.PresetDialog.confirmDialog({
      title: '删除应用包',
      message: '删除应用包「' + name + '」？（已导出的预设包不受影响，重新导出即可）',
      confirmText: '删除', danger: true,
    })) return;
    try {
      await global.StudioApi.removeAppSet(appSetId);
      if (editingId === appSetId) resetForm();
      global.Editor.toast('已删除');
      await global.Editor.refreshPresets();
    } catch (e) { global.Editor.toast((e && e.message) || '删除失败', true); }
  }

  function edit(appSetId) {
    const s = (global.Editor.appSets || []).find((x) => x.appSetId === appSetId);
    if (!s) return;
    editingId = appSetId;
    el('as-name').value = s.name || '';
    el('as-note').value = s.note || '';
    el('as-apps').value = appsText(s.apps);
    el('as-name').focus();
  }

  function bind() {
    el('btn-appset-save').onclick = save;
    el('btn-appset-reset').onclick = () => {
      if (el('as-name').value.trim() || el('as-apps').value.trim()) {
        global.PresetDialog.confirmDialog({
          title: '清空新建', message: '当前表单有未保存内容，确认清空？', confirmText: '清空', danger: true,
        }).then((ok) => { if (ok) resetForm(); });
      } else resetForm();
    };
    el('appset-list').addEventListener('click', (e) => {
      const ed = e.target.closest('[data-as-edit]');
      if (ed) return edit(ed.dataset.asEdit);
      const del = e.target.closest('[data-as-del]');
      if (del) {
        const s = (global.Editor.appSets || []).find((x) => x.appSetId === del.dataset.asDel);
        if (s) remove(s.appSetId, s.name);
      }
      return undefined;
    });
  }

  global.AppSetsUi = { bind, render, resetForm };
})(window);
