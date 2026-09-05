'use strict';
// =============================================================================
// 教师大屏 · 预设逻辑（班级/活动预设下拉、开始上课选预设、任务模板快捷按钮）
//
// 依赖 window.Dashboard（app.js 注入：api / toast / esc / presets 存储）
// 本模块只负责预设数据的加载与选择联动，渲染与操作在 app.js / manage.js。
// =============================================================================
(function (global) {
  const D = global.Dashboard;
  const $ = (id) => document.getElementById(id);
  function esc(s) { return D.esc(s); }

  // ---------- 加载与填充 ----------
  async function refresh() {
    const [cj, aj] = await Promise.all([
      D.api('GET', '/api/v1/presets/classes'),
      D.api('GET', '/api/v1/presets/activities'),
    ]);
    D.presets.classes = (cj && cj.code === 0) ? cj.data : [];
    D.presets.activities = (aj && aj.code === 0) ? aj.data : [];
    fillSelects();
    if (global.DashboardManage) global.DashboardManage.render();
  }

  function fillSelects() {
    const cs = $('f-class-preset');
    const cur = cs.value;
    cs.innerHTML = '<option value="">（不使用预设，手动填写）</option>'
      + D.presets.classes.map((c) => '<option value="' + esc(c.presetId) + '">' + esc(c.name) + '（' + c.totalSeats + ' 座）</option>').join('');
    if (cur) cs.value = cur;

    const as = $('f-activity-preset');
    const curA = as.value;
    as.innerHTML = '<option value="">（不使用预设）</option>'
      + D.presets.activities.map((a) => '<option value="' + esc(a.presetId) + '">' + esc(a.name) + (a.category ? ' · ' + esc(a.category) : '') + '</option>').join('');
    if (curA) as.value = curA;
    onClassChange();
    onActivityChange();
  }

  function onClassChange() {
    const c = D.presets.classes.find((x) => x.presetId === $('f-class-preset').value);
    if (c) {
      $('f-class').value = c.name;
      $('f-seats').value = c.totalSeats;
    }
  }

  function onActivityChange() {
    const a = D.presets.activities.find((x) => x.presetId === $('f-activity-preset').value);
    $('f-activity-hint').textContent = a
      ? a.equipment.length + ' 件器材 · ' + a.taskTemplates.length + ' 个任务模板将随上课下发'
      : '选活动预设后，器材清单与任务模板将随上课下发';
  }

  // 上课中的活动预设 → 任务弹窗模板快捷按钮
  function renderTaskTemplates(sess) {
    const box = $('tpl-chips');
    if (!sess || !sess.activityPresetId) { box.hidden = true; return; }
    const a = D.presets.activities.find((x) => x.presetId === sess.activityPresetId);
    const tpls = a ? a.taskTemplates : [];
    if (!tpls.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = tpls.map((t, i) =>
      '<button class="tpl-chip" data-tpl="' + i + '" title="' + esc(t.desc || '') + '">' + esc(t.title) + '</button>'
    ).join('');
    box._tpls = tpls;
  }

  function bind() {
    $('f-class-preset').addEventListener('change', onClassChange);
    $('f-activity-preset').addEventListener('change', onActivityChange);
    $('tpl-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-tpl]');
      if (!chip) return;
      const tpl = $('tpl-chips')._tpls[Number(chip.dataset.tpl)];
      if (tpl) {
        $('f-task-title').value = tpl.title;
        $('f-task-desc').value = tpl.desc || '';
      }
    });
  }

  global.DashboardPreset = { refresh, bind, renderTaskTemplates };
})(window);
