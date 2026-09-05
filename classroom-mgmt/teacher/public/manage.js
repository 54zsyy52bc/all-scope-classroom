'use strict';
// =============================================================================
// 教师大屏 · 预设管理面板（v4 收编版）
// 职责边界（分离式架构：办公端 Preset Studio 负责编辑，本机只接收与使用）：
//   1. 导入预设包：选文件 → 服务端预演（新增/覆盖/跳过）→ 教师确认 → 落库
//   2. 导出本机预设备份（.kctpreset 文件，供回迁办公端继续编辑）
//   3. 预设列表（只读摘要）+ 删除（数据卫生，清掉误导入的预设）
// 已移除：新建 / 编辑表单（编辑职责在办公端 Preset Studio）。
// 依赖 window.Dashboard（app.js 注入：api / toast / esc / presets / refreshPresets）
// =============================================================================
(function (global) {
  const D = global.Dashboard;
  const $ = (id) => document.getElementById(id);
  const ACTION_LABEL = { added: '新增', updated: '覆盖', skipped: '跳过' };

  function esc(s) { return D.esc(s); }
  function toast(t, e) { return D.toast(t, e); }
  async function api(m, u, b) { return D.api(m, u, b); }

  // ---------- 列表渲染（只读摘要 + 删除）----------
  function timeText(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function renderClassList() {
    const host = $('m-class-list');
    const list = D.presets.classes || [];
    if (!list.length) { host.innerHTML = '<p class="list-empty">暂无班级预设。请在办公电脑「预设编辑器」中创建后，点「导入预设包」。</p>'; return; }
    host.innerHTML = list.map((c) =>
      '<div class="list-item">'
      + '<div class="li-main"><div>' + esc(c.name) + '（' + c.totalSeats + ' 座 · ' + c.groupSize + ' 人/组）</div>'
      + '<div class="li-sub">更新于 ' + timeText(c.updatedAt) + (c.note ? ' · ' + esc(c.note) : '') + '</div></div>'
      + '<span class="li-actions"><button class="mini-btn danger" data-class-del="' + esc(c.presetId) + '">删除</button></span>'
      + '</div>'
    ).join('');
  }

  function renderActivityList() {
    const host = $('m-activity-list');
    const list = D.presets.activities || [];
    if (!list.length) { host.innerHTML = '<p class="list-empty">暂无活动预设。请在办公电脑「预设编辑器」中创建后，点「导入预设包」。</p>'; return; }
    host.innerHTML = list.map((a) =>
      '<div class="list-item">'
      + '<div class="li-main"><div>' + esc(a.name) + (a.category ? ' · ' + esc(a.category) : '') + '</div>'
      + '<div class="li-sub">' + a.equipment.length + ' 件器材 · ' + a.taskTemplates.length + ' 个任务模板'
      + (a.timed ? ' · 默认计时 ' + Math.round((a.durationSec || 0) / 60) + ' 分钟' : '')
      + '</div></div>'
      + '<span class="li-actions"><button class="mini-btn danger" data-activity-del="' + esc(a.presetId) + '">删除</button></span>'
      + '</div>'
    ).join('');
  }

  async function removeClass(id, name) {
    if (!global.confirm('删除班级预设「' + name + '」？\n（预设由办公端维护，此删除仅影响本机）')) return;
    const j = await api('DELETE', '/api/v1/presets/classes/' + id);
    if (j && j.code === 0) { toast('已删除'); D.refreshPresets(); }
  }

  async function removeActivity(id, name) {
    if (!global.confirm('删除活动预设「' + name + '」？\n（预设由办公端维护，此删除仅影响本机）')) return;
    const j = await api('DELETE', '/api/v1/presets/activities/' + id);
    if (j && j.code === 0) { toast('已删除'); D.refreshPresets(); }
  }

  // ---------- 导出备份（.kctpreset 文件下载）----------
  async function exportPackage() {
    const j = await api('GET', '/api/v1/presets/export');
    if (!j || j.code !== 0) { toast('导出失败', true); return; }
    const pkg = j.data;
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const fname = '预设备份_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + '.kctpreset';
    const blob = new global.Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('已导出备份：' + pkg.classes.length + ' 班级 / ' + pkg.activities.length + ' 活动');
  }

  // ---------- 导入预设包 ----------
  let importPkgCache = null; // 最近一次预览的包，供"确认导入"使用（避免预演阶段文件被改动）

  function pickFile() { $('m-import-file').click(); }

  function readFile(file) {
    return new global.Promise((resolve, reject) => {
      const r = new global.FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(new Error('读取文件失败'));
      r.readAsText(file, 'utf-8');
    });
  }

  async function onFileChosen(e) {
    const file = e.target && e.target.files && e.target.files[0];
    e.target.value = ''; // 允许重复选择同一文件
    if (!file) return;
    let pkg;
    try {
      pkg = JSON.parse(await readFile(file));
    } catch (_err) {
      showImportError('无法解析文件「' + file.name + '」：不是有效的 JSON。');
      return;
    }
    importPkgCache = pkg; // 预演与确认共用同一份原始包
    const j = await api('POST', '/api/v1/presets/import', pkg); // 预演，不落库
    if (!j || j.code !== 0) {
      showImportError((j && j.message) || '预设包校验失败，请确认文件来自「预设编辑器」导出的备份。');
      return;
    }
    renderImportPreview(j.data);
  }

  function showImportError(msg) {
    const box = $('m-import-result');
    box.hidden = false;
    box.innerHTML = '<p class="import-err">' + esc(msg) + '</p>'
      + '<div class="import-actions"><button class="btn btn-ghost" id="m-import-cancel">关闭</button></div>';
    $('m-import-cancel').onclick = () => { box.hidden = true; };
  }

  function renderImportPreview(prev) {
    const box = $('m-import-result');
    const items = (prev.items || []).map((it) =>
      '<div><span class="tag ' + (it.action === 'added' ? 'add' : it.action === 'updated' ? 'upd' : 'skip') + '">'
      + ACTION_LABEL[it.action] + '</span>' + (it.kind === 'class' ? '班级 · ' : '活动 · ') + esc(it.name)
      + (it.action === 'skipped' ? '（本机版本较新，保留）' : '') + '</div>'
    ).join('');
    box.hidden = false;
    box.innerHTML = '<h4>导入预演结果</h4>'
      + '<div class="import-summary">'
      + '<span class="imp-add">新增 <b>' + (prev.added || 0) + '</b></span>'
      + '<span class="imp-upd">覆盖 <b>' + (prev.updated || 0) + '</b></span>'
      + '<span class="imp-skip">跳过 <b>' + (prev.skipped || 0) + '</b></span></div>'
      + (items ? '<div class="import-items">' + items + '</div>' : '')
      + '<div class="import-actions">'
      + ((prev.added || prev.updated)
        ? '<button class="btn btn-primary" id="m-import-commit">确认导入</button>' : '')
      + '<button class="btn btn-ghost" id="m-import-cancel">取消</button></div>';
    const cm = $('m-import-commit');
    if (cm) cm.onclick = commitImport;
    $('m-import-cancel').onclick = () => { box.hidden = true; };
  }

  async function commitImport() {
    if (!importPkgCache) { toast('没有待导入的预设包', true); return; }
    const j = await api('POST', '/api/v1/presets/import?commit=true', importPkgCache);
    if (!j || j.code !== 0) { toast((j && j.message) || '导入失败', true); return; }
    toast('已导入：新增 ' + (j.data.added || 0) + '，覆盖 ' + (j.data.updated || 0));
    importPkgCache = null;
    $('m-import-result').hidden = true;
    D.refreshPresets();
  }

  // ---------- 事件 ----------
  function bind() {
    $('btn-manage').onclick = () => { $('manage').hidden = false; };
    $('btn-manage-close').onclick = () => { $('manage').hidden = true; };
    $('m-import-btn').onclick = pickFile;
    $('m-export-btn').onclick = exportPackage;
    $('m-import-file').addEventListener('change', onFileChosen);

    const cls = $('m-class-list');
    cls.addEventListener('click', (e) => {
      const del = e.target.closest('[data-class-del]');
      if (!del) return;
      const c = (D.presets.classes || []).find((x) => x.presetId === del.dataset.classDel);
      if (c) removeClass(c.presetId, c.name);
    });
    const acts = $('m-activity-list');
    acts.addEventListener('click', (e) => {
      const del = e.target.closest('[data-activity-del]');
      if (!del) return;
      const a = (D.presets.activities || []).find((x) => x.presetId === del.dataset.activityDel);
      if (a) removeActivity(a.presetId, a.name);
    });
  }

  function render() {
    renderClassList();
    renderActivityList();
  }

  global.DashboardManage = { init: bind, render };
})(window);
