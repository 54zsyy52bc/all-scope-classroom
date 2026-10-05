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
    const [cj, aj, sj] = await Promise.all([
      D.api('GET', '/api/v1/presets/classes'),
      D.api('GET', '/api/v1/presets/activities'),
      D.api('GET', '/api/v1/presets/appsets'),
    ]);
    D.presets.classes = (cj && cj.code === 0) ? cj.data : [];
    D.presets.activities = (aj && aj.code === 0) ? aj.data : [];
    D.presets.appSets = (sj && sj.code === 0) ? sj.data : [];
    fillSelects();
    if (global.DashboardManage) global.DashboardManage.render();
  }

  function fillSelects() {
    const cs = $('f-class-preset');
    const cur = cs.value;
    cs.innerHTML = '<option value="">（不使用预设，手动填写）</option>'
      + D.presets.classes.map((c) => '<option value="' + esc(c.presetId) + '">'
        + esc(c.name) + '（' + c.totalSeats + ' 座' + (c.lessons && c.lessons.length ? ' · ' + c.lessons.length + ' 课时' : '') + '）</option>').join('');
    if (cur) cs.value = cur;
    fillAppSetSelect();
    onClassChange();
  }

  // v5.6：应用包下拉（独立清单，与班级/课时无关；开课时选用）
  function fillAppSetSelect() {
    const ss = $('f-appset');
    if (!ss) return;
    const cur = ss.value;
    ss.innerHTML = '<option value="">（不切换：用学生机本机全部课程应用）</option>'
      + (D.presets.appSets || []).map((s) => '<option value="' + esc(s.appSetId) + '">'
        + esc(s.name) + '（' + ((s.apps && s.apps.length) || 0) + ' 应用）</option>').join('');
    if (cur && (D.presets.appSets || []).some((s) => s.appSetId === cur)) ss.value = cur;
    onAppSetChange();
  }

  function onAppSetChange() {
    const hint = $('f-appset-hint');
    if (!hint) return;
    const s = (D.presets.appSets || []).find((x) => x.appSetId === $('f-appset').value);
    hint.textContent = s
      ? '开课后学生桌面只显示与本机应用同名的磁贴：' + s.apps.join('、')
      : '应用包在预设编辑器里创建、随预设包导入；开课后学生桌面只显示与包内应用同名的磁贴';
  }

  // v5.2：课时预设下拉随所选班级联动（班级无课时 → 仅提示项）
  function fillLessonSelect() {
    const ls = $('f-lesson-preset');
    if (!ls) return;
    const cur = ls.value;
    const c = D.presets.classes.find((x) => x.presetId === $('f-class-preset').value);
    const lessons = (c && c.lessons) || [];
    ls.innerHTML = '<option value="">（不使用课时）</option>'
      + lessons.map((l) => '<option value="' + esc(l.lessonId) + '">'
        + esc(l.name) + '（' + ((l.activityIds && l.activityIds.length) || 0) + ' 活动 · ' + ((l.equipment && l.equipment.length) || 0) + ' 器材）</option>').join('');
    if (cur && lessons.some((l) => l.lessonId === cur)) ls.value = cur;
    onLessonChange();
  }

  function onClassChange() {
    const c = D.presets.classes.find((x) => x.presetId === $('f-class-preset').value);
    if (c) {
      $('f-class').value = c.name;
      $('f-seats').value = c.totalSeats;
    }
    fillLessonSelect();
  }

  function onLessonChange() {
    const hint = $('f-lesson-hint');
    if (!hint) return;
    const c = D.presets.classes.find((x) => x.presetId === $('f-class-preset').value);
    const lessons = (c && c.lessons) || [];
    const l = lessons.find((x) => x.lessonId === $('f-lesson-preset').value);
    hint.textContent = l
      ? '课时「' + l.name + '」：' + ((l.equipment && l.equipment.length) || 0) + ' 件课时器材（并入班级上课器材）、'
        + ((l.activityIds && l.activityIds.length) || 0) + ' 个活动将随课堂下发'
      : '选班级预设后可从此处选课时，该课时的器材与活动将随课堂下发';
  }

  // 课中任务模板快捷按钮：优先当前课时快照挂的活动，兼容旧会话的活动预设
  function renderTaskTemplates(sess) {
    const box = $('tpl-chips');
    if (!sess) { box.hidden = true; return; }
    let tpls = [];
    if (sess.lesson && Array.isArray(sess.lesson.activityIds) && sess.lesson.activityIds.length) {
      const seen = new Set();
      for (const actId of sess.lesson.activityIds) {
        const a = D.presets.activities.find((x) => x.presetId === actId);
        if (!a) continue;
        if (a.taskTemplates && a.taskTemplates.length) {
          for (const t of a.taskTemplates) {
            if (t && t.title && !seen.has(t.title)) { seen.add(t.title); tpls.push(t); }
          }
        } else if (!seen.has(a.name)) {
          seen.add(a.name);
          tpls.push({ title: a.name, desc: '来自课时活动预设' });
        }
      }
    } else if (sess.activityPresetId) {
      const a = D.presets.activities.find((x) => x.presetId === sess.activityPresetId);
      tpls = a ? (a.taskTemplates || []) : [];
    }
    if (!tpls.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = tpls.map((t, i) =>
      '<button class="tpl-chip" data-tpl="' + i + '" title="' + esc(t.desc || '') + '">' + esc(t.title) + '</button>'
    ).join('');
    box._tpls = tpls;
  }

  function bind() {
    $('f-class-preset').addEventListener('change', onClassChange);
    const ls = $('f-lesson-preset');
    if (ls) ls.addEventListener('change', onLessonChange);
    const as = $('f-appset');
    if (as) as.addEventListener('change', onAppSetChange);
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
