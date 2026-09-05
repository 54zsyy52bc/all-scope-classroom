'use strict';
// =============================================================================
// Preset Studio · 班级预设扩展 UI（v4.2）
//   - 分组配置编辑器：组名 + 每组人数；「按均分生成 / 添加分组 / 删除行」；
//     配置分组后座位数自动 = 各组之和（开始上课时按自定义分组生成小组墙）
//   - 上课器材编辑器：每节课都发放的器材（可选），开课时与活动器材合并下发
//   - 器材字典联想：维护 dict-eq datalist（活动器材行与上课器材行的 eqId 输入共用）
// 依赖 window.Editor（el/esc）与 window.StudioApi（不直接使用）；由 app.js 在刷新后调用。
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

  // ---------- 器材字典 → datalist（活动行 / 上课器材行 共用联想）----------
  function refreshDictOptions(dict) {
    const dl = $('dict-eq');
    if (!dl) return;
    dl.innerHTML = (dict || []).map((d) =>
      '<option value="' + esc(d.eqId) + '">' + esc(d.eqName) + (d.category ? ' · ' + esc(d.category) : '') + '</option>'
    ).join('');
  }

  // ---------- 分组编辑器 ----------
  function groupRowHTML(name, size) {
    return '<div class="group-row">'
      + '<input data-g-name value="' + esc(name || '') + '" placeholder="组名（如 第一组 / G1）" maxlength="20" />'
      + '<input data-g-size type="number" min="1" max="99" value="' + (size || 5) + '" title="人数" />'
      + '<button type="button" class="row-del" data-group-del>×</button></div>';
  }

  function readGroups() {
    const host = $('groups-editor');
    if (!host) return [];
    const rows = [];
    host.querySelectorAll('.group-row').forEach((r) => {
      const name = r.querySelector('[data-g-name]').value.trim();
      const size = Math.max(1, Number(r.querySelector('[data-g-size]').value) || 1);
      if (name) rows.push({ groupId: name, size });
    });
    return rows;
  }

  function renderGroups(groups) {
    const host = $('groups-editor');
    if (!host) return;
    const list = groups && groups.length ? groups : [];
    host.innerHTML = list.length
      ? list.map((g) => groupRowHTML(g.groupId, g.size)).join('')
      : '<p class="hint">未配置 → 上课时按「人数 ÷ 分组大小」自动均分小组。</p>';
  }

  // 座位数联动：有分组行时 c-seats = 各组人数之和（防配错）
  function syncSeats() {
    const seats = $('c-seats');
    if (!seats) return;
    const rows = readGroups();
    if (rows.length) {
      const sum = rows.reduce((acc, g) => acc + g.size, 0);
      seats.value = sum;
    }
  }

  function autoGroups() {
    const total = Math.max(1, Number($('c-seats') ? $('c-seats').value : 50) || 50);
    const gs = Math.max(1, Number($('c-group') ? $('c-group').value : 5) || 5);
    const groups = [];
    let remain = total;
    for (let i = 1; remain > 0; i += 1) {
      const size = Math.min(gs, remain);
      groups.push({ groupId: 'G' + i, size });
      remain -= size;
    }
    renderGroups(groups);
    toast('已按每组 ' + gs + ' 人生成 ' + groups.length + ' 个分组');
  }

  function addGroup() {
    const host = $('groups-editor');
    if (!host) return;
    host.querySelector('.hint') && (host.innerHTML = '');
    host.insertAdjacentHTML('beforeend', groupRowHTML('', 5));
  }

  // ---------- 上课器材编辑器（结构同活动器材行，独立容器，dict 联想）----------
  function classEqRowHTML(e) {
    return '<div class="eq-row">'
      + '<input data-eq-id list="dict-eq" value="' + esc(e.eqId || '') + '" placeholder="编号（可联想字典，如 LED）" />'
      + '<input data-eq-name value="' + esc(e.eqName || '') + '" placeholder="名称（如 LED）" />'
      + '<input data-eq-cat value="' + esc(e.category || '') + '" placeholder="分类" />'
      + '<input data-eq-preset type="number" min="0" max="99" value="' + (e.preset != null ? e.preset : 1) + '" title="登记页默认勾选数量" />'
      + '<button type="button" class="row-del" data-eq-del>×</button></div>';
  }

  function renderClassEq(rows) {
    const host = $('class-eq-editor');
    if (!host) return;
    const list = rows && rows.length ? rows : [];
    host.innerHTML = list.length
      ? list.map(classEqRowHTML).join('')
      : '<p class="hint">未配置 → 只下发所选活动的器材；配置后两者合并去重。</p>';
  }

  function collectClassEq() {
    const host = $('class-eq-editor');
    if (!host) return [];
    const rows = [];
    host.querySelectorAll('.eq-row').forEach((r) => {
      const eqId = r.querySelector('[data-eq-id]').value.trim();
      const eqName = r.querySelector('[data-eq-name]').value.trim();
      if (!eqId && !eqName) return;
      rows.push({
        eqId: eqId || 'EQ-' + (rows.length + 1),
        eqName: eqName || eqId || '器材' + (rows.length + 1),
        category: r.querySelector('[data-eq-cat]').value.trim() || '其他',
        preset: Math.max(0, Number(r.querySelector('[data-eq-preset]').value) || 1),
      });
    });
    return rows;
  }

  // ---------- 表单挂接（presets.js 调用）----------
  function reset() {
    renderGroups([]);
    renderClassEq([]);
  }

  function fill(c) {
    renderGroups(c.groups || []);
    renderClassEq(c.equipment || []);
  }

  function bind() {
    const ga = $('btn-group-auto');
    if (ga) ga.onclick = autoGroups;
    const gadd = $('btn-group-add');
    if (gadd) gadd.onclick = addGroup;
    const gHost = $('groups-editor');
    if (gHost) {
      gHost.addEventListener('click', (e) => {
        if (e.target.closest('[data-group-del]')) {
          e.target.closest('.group-row').remove();
          if (!gHost.querySelector('.group-row')) renderGroups([]);
          syncSeats();
        }
      });
      gHost.addEventListener('input', (e) => {
        if (e.target.closest('[data-g-size]')) syncSeats();
      });
    }
    const ceqAdd = $('btn-class-eq-add');
    if (ceqAdd) ceqAdd.onclick = () => {
      const host = $('class-eq-editor');
      if (!host) return;
      host.querySelector('.hint') && (host.innerHTML = '');
      host.insertAdjacentHTML('beforeend', classEqRowHTML({}));
    };
    const ceqHost = $('class-eq-editor');
    if (ceqHost) {
      ceqHost.addEventListener('click', (e) => {
        const del = e.target.closest('[data-eq-del]');
        if (!del) return;
        del.closest('.eq-row').remove();
        if (!ceqHost.querySelector('.eq-row')) renderClassEq([]);
      });
    }
  }

  global.PresetClassUi = {
    bind, reset, fill,
    collectGroups: readGroups,
    collectClassEq,
    refreshDictOptions,
  };
})(window);
