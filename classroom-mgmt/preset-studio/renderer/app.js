'use strict';
// =============================================================================
// Preset Studio · 渲染层主控
// 职责：
//   1) Editor 公共工具（el/esc/toast/icon/api）+ 预设数据缓存（classes/activities/dict）
//   2) api 适配层：把 presets.js 的 REST 调用形态（Editor.api('POST','/api/v1/...')）
//      映射为 window.StudioApi（preload IPC 桥 → 主进程本地库）——presets.js 零改动复用
//   3) 页签切换（班级预设 / 活动预设 / 器材字典）
//   4) 预设包导出（主进程对话框落盘）/ 导入（选文件 → 预演 → 确认合并）
// 说明：本应用完全离线，无课堂控制职责（那是教室大屏的）。
// =============================================================================
(function (global) {
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function toast(text, isErr) {
    const t = el('toast');
    t.textContent = text;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.hidden = true; }, 3200);
  }
  function icon(name, size) {
    return window.Icons && window.Icons.svg ? window.Icons.svg(name, size || 20, '') : '';
  }

  // ---------- api 适配层：REST 形态 → StudioApi（主进程本地库）----------
  async function api(method, url, body) {
    const S = global.StudioApi;
    const mClass = url.match(/^\/api\/v1\/presets\/classes(?:\/(.+))?$/);
    const mAct = url.match(/^\/api\/v1\/presets\/activities(?:\/(.+))?$/);
    try {
      let data;
      if (mClass) {
        const id = mClass[1];
        if (method === 'GET') data = (await S.listAll()).classes;
        else if (method === 'POST') data = await S.saveClass(body || {});
        else if (method === 'PUT') data = await S.saveClass(Object.assign({ preset_id: id }, body || {}));
        else if (method === 'DELETE') data = await S.removeClass(id);
        else throw new Error('不支持的班级预设调用');
      } else if (mAct) {
        const id = mAct[1];
        if (method === 'GET') data = (await S.listAll()).activities;
        else if (method === 'POST') data = await S.saveActivity(body || {});
        else if (method === 'PUT') data = await S.saveActivity(Object.assign({ preset_id: id }, body || {}));
        else if (method === 'DELETE') data = await S.removeActivity(id);
        else throw new Error('不支持的活动预设调用');
      } else {
        throw new Error('Preset Studio 不支持该接口: ' + url);
      }
      return { code: 0, data };
    } catch (e) {
      toast((e && e.message) || '操作失败', true);
      return { code: 1, message: (e && e.message) || '操作失败' };
    }
  }

  // ---------- Editor 全局（供 presets.js 复用）----------
  const Editor = {
    el, esc, toast, icon, api,
    classes: [], activities: [], dict: [],
    refreshPresets: null, // init 后注入
  };
  global.Editor = Editor;

  // ---------- 页签 ----------
  function bindTabs() {
    document.querySelectorAll('.tab').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        const panel = el('panel-' + b.dataset.tab);
        if (panel) panel.classList.add('active');
      });
    });
  }

  // ---------- 器材字典 ----------
  function renderDict() {
    const host = el('dict-list');
    const list = Editor.dict || [];
    if (!list.length) { host.innerHTML = '<p class="hint">字典为空，先在上方添加常用器材。</p>'; return; }
    host.innerHTML = list.map((d) =>
      '<div class="list-item">'
      + '<div class="li-main"><div class="li-title"><code>' + esc(d.eqId) + '</code> · ' + esc(d.eqName) + '</div>'
      + '<div class="li-sub">' + esc(d.category || '其他') + '</div></div>'
      + '<div class="li-actions"><button class="mini-btn danger" data-dict-del="' + esc(d.eqId) + '">删除</button></div>'
      + '</div>'
    ).join('');
  }

  async function saveDictItem() {
    const item = {
      eqId: el('d-eqid').value.trim(),
      eqName: el('d-eqname').value.trim(),
      category: el('d-category').value.trim() || '其他',
    };
    if (!item.eqId || !item.eqName) { toast('设备编码与名称必填', true); return; }
    try {
      await global.StudioApi.saveDict(item);
      el('d-eqid').value = ''; el('d-eqname').value = ''; el('d-category').value = '';
      toast('器材已保存');
      refreshPresets();
    } catch (e) { toast((e && e.message) || '保存失败', true); }
  }

  async function removeDictItem(eqId, name) {
    if (!global.confirm('从字典删除「' + name + '」？\n（已保存活动中的器材不受影响）')) return;
    try {
      await global.StudioApi.removeDict(eqId);
      toast('已删除');
      refreshPresets();
    } catch (e) { toast((e && e.message) || '删除失败', true); }
  }

  // ---------- 预设包 导入 / 导出 ----------
  const ACTION_LABEL = { added: '新增', updated: '覆盖', skipped: '跳过' };

  async function exportPkg() {
    try {
      const pkg = await global.StudioApi.pkgExport();
      if (!pkg.classes.length && !pkg.activities.length) {
        toast('当前没有可导出的预设（先创建班级/活动预设）', true);
        return;
      }
      const file = await global.StudioApi.pkgSaveFile(pkg);
      if (file) toast('已导出：' + pkg.classes.length + ' 班级 / ' + pkg.activities.length + ' 活动 → ' + file);
      // file 为 null = 用户取消
    } catch (e) { toast((e && e.message) || '导出失败', true); }
  }

  async function importPkg() {
    try {
      const opened = await global.StudioApi.pkgOpenFile();
      if (!opened) return; // 用户取消
      const prev = await global.StudioApi.pkgPreview(opened.pkg);
      showImportPreview(opened, prev);
    } catch (e) {
      toast((e && e.message) || '导入失败：请确认文件是「预设编辑器」导出的 .kctpreset', true);
    }
  }

  function showImportPreview(opened, prev) {
    el('import-file-name').textContent = '文件：' + opened.fileName + '（导出于 ' + new Date(opened.pkg.exportedAt).toLocaleString() + '）';
    const items = (prev.items || []).map((it) =>
      '<div><span class="tag ' + (it.action === 'added' ? 'add' : it.action === 'updated' ? 'upd' : 'skip') + '">'
      + ACTION_LABEL[it.action] + '</span>' + (it.kind === 'class' ? '班级 · ' : '活动 · ') + esc(it.name)
      + (it.action === 'skipped' ? '（本机版本较新，保留）' : '') + '</div>'
    ).join('');
    const hasChange = (prev.added || 0) + (prev.updated || 0) > 0;
    el('import-result').innerHTML = '<div class="import-summary">'
      + '<span>新增 <b>' + (prev.added || 0) + '</b></span>'
      + '<span>覆盖 <b>' + (prev.updated || 0) + '</b></span>'
      + '<span>跳过 <b>' + (prev.skipped || 0) + '</b></span></div>'
      + (items ? '<div class="import-items">' + items + '</div>' : '');
    el('import-commit').hidden = !hasChange;
    el('overlay-import').hidden = false;
    el('import-result')._opened = opened;
  }

  async function commitImport() {
    const opened = el('import-result')._opened;
    if (!opened) return;
    try {
      const ret = await global.StudioApi.pkgCommit(opened.pkg);
      el('overlay-import').hidden = true;
      toast('已导入：新增 ' + (ret.added || 0) + '，覆盖 ' + (ret.updated || 0));
      refreshPresets();
    } catch (e) { toast((e && e.message) || '导入失败', true); }
  }

  // ---------- 数据刷新 ----------
  async function refreshPresets() {
    try {
      const all = await global.StudioApi.listAll();
      Editor.classes = all.classes || [];
      Editor.activities = all.activities || [];
      Editor.dict = all.dict || [];
      if (global.PresetView) global.PresetView.render(Editor.classes, Editor.activities);
      renderDict();
      // v4.2：器材字典 → 输入联想（活动器材行 / 上课器材行共用 datalist）
      if (global.PresetClassUi) global.PresetClassUi.refreshDictOptions(Editor.dict);
    } catch (e) { toast('读取本地数据失败：' + (e && e.message || e), true); }
  }
  Editor.refreshPresets = refreshPresets;

  // ---------- 事件 ----------
  function bind() {
    bindTabs();
    el('btn-export-pkg').onclick = exportPkg;
    el('btn-import-pkg').onclick = importPkg;
    el('import-cancel').onclick = () => { el('overlay-import').hidden = true; };
    el('import-commit').onclick = commitImport;
    el('btn-dict-save').onclick = saveDictItem;
    el('dict-list').addEventListener('click', (e) => {
      const del = e.target.closest('[data-dict-del]');
      if (!del) return;
      const d = (Editor.dict || []).find((x) => x.eqId === del.dataset.dictDel);
      if (d) removeDictItem(d.eqId, d.eqName);
    });
    // 活动表单 a-timed 联动已在 presets.js bindPresetEvents 内绑定
    if (global.PresetView) global.PresetView.bindPresetEvents();
    // v4.2：班级分组配置 / 上课器材 UI + 初始空态
    if (global.PresetClassUi) { global.PresetClassUi.bind(); global.PresetClassUi.reset(); }
  }

  function init() {
    bind();
    refreshPresets();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
