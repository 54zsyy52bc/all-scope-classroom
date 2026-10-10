'use strict';
// Preset Studio · 智能生成页（独立）：批量导入课件 → 课时包草稿 → 修改 → 确认入库。
// 快速=关键词识别+器材字典命中；AI=本机配置模型直接调用（smart-ai.js 编排）或回退网页回贴。
// 入库=新建活动（同名复用）→ 课时追加到所选班级。依赖 window.Editor / window.PresetSmartAI。
(function (global) {
  const Editor = global.Editor;
  const $ = (id) => document.getElementById(id);
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(t, err) { if (Editor.toast) Editor.toast(t, err); }
  function note(html) { const n = $('ss-note'); if (!n) return; n.hidden = !html; n.innerHTML = html || ''; }
  // ---------- 草稿状态：{ fileName, lessonName, activities:[name], equipment:[{eqId,eqName,preset}] } ----------
  // P1-4：草稿落 localStorage（AI 路径成本 5-10 分钟，关窗全丢不可接受）；测试/无 localStorage 环境自动降级内存态
  const DRAFT_KEY = 'ss-drafts-v1';
  function lsOk() { try { return !!global.localStorage; } catch (_e) { return false; } }
  function loadDrafts() {
    if (!lsOk()) return [];
    try { const raw = JSON.parse(global.localStorage.getItem(DRAFT_KEY) || '[]'); return Array.isArray(raw) ? raw : []; }
    catch (_e) { return []; }
  }
  function saveDrafts() { if (!lsOk()) return; try { global.localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts)); } catch (_e) { /* 忽略 */ } }
  let drafts = loadDrafts();
  // ---------- 批量导入 + 主进程解析 ----------
  async function pickAndParse() {
    if (!global.StudioApi || !global.StudioApi.pickCourseware) { toast('当前环境不支持文件导入', true); return null; }
    let picked;
    try { picked = await global.StudioApi.pickCourseware(); } catch (e) { toast((e && e.message) || '读取失败', true); return null; }
    if (!picked || !picked.files || !picked.files.length) return null;
    const files = picked.files; let parsed = [];
    const paths = files.map((f) => f.filePath).filter(Boolean);
    if (paths.length && global.StudioApi.parseCourseware) {
      try { parsed = await global.StudioApi.parseCourseware({ paths, dict: Editor.dict || [] }) || []; }
      catch (e) { toast('课件解析失败：' + ((e && e.message) || e), true); }
    }
    return files.map((f) => parsed.find((p) => p && p.fileName === f.fileName)
      || { fileName: f.fileName, baseName: f.baseName, titles: [], equipment: [], lines: [] });
  }
  function pushDrafts(parsedArr) {
    for (const p of parsedArr) {
      if (drafts.some((d) => d.fileName === p.fileName)) continue; // 重复导入跳过
      drafts.push({
        fileName: p.fileName, lessonName: p.baseName || (p.fileName || '').replace(/\.[^.]+$/, ''),
        activities: (p.titles || []).slice(0, 15), equipment: (p.equipment || []).slice(0, 20),
      });
    }
    saveDrafts();
    renderDrafts();
  }
  async function importQuick() {
    const parsed = await pickAndParse();
    if (!parsed) return;
    pushDrafts(parsed);
    const actN = parsed.reduce((s, p) => s + (p.titles || []).length, 0);
    const eqN = parsed.reduce((s, p) => s + (p.equipment || []).length, 0);
    note('快速识别完成：' + parsed.length + ' 个课件 → 草稿（活动标题 ' + actN + '，器材命中 ' + eqN
      + '）。可在下方修改后确认入库。');
    toast('已生成草稿：' + parsed.length + ' 条');
  }
  // ---------- AI 结果合入（mergeItems 供 smart-ai.js 一键调用与手动回贴共用） ----------
  function buildPrompt(parsedArr) {
    const dictTxt = (Editor.dict || []).filter((d) => d && d.eqId)
      .map((d) => d.eqId + (d.eqName ? '(' + d.eqName + ')' : '')).join('、');
    const body = parsedArr.map((p) => '【课件：' + p.fileName + '】\n' + (p.lines || []).join('\n')).join('\n\n');
    return '你是课程设计助手。请根据下面的课件文本，为每个课件生成一个"课时包"JSON：\n'
      + '格式：[{"courseware":"课件文件名","lessonName":"课时名",'
      + '"activities":[{"name":"活动名"}],"equipment":[{"eqId":"器材编码","preset":数量}]}]\n'
      + '要求：activities 从课件中的活动/实验/任务环节提炼；equipment 只用器材字典中的 eqId：'
      + (dictTxt || '（字典为空，equipment 返回 []）') + '。\n只输出 JSON，不要其他文字。\n\n' + body;
  }
  function mergeItems(items) {
    let merged = 0;
    for (const it of items) {
      const target = it.courseware && drafts.find((d) => d.fileName === it.courseware
        || d.lessonName === it.courseware || d.fileName.replace(/\.[^.]+$/, '') === it.courseware);
      if (target) {
        if (it.lessonName) target.lessonName = it.lessonName;
        if (it.activities.length) target.activities = it.activities;
        if (it.equipment.length) target.equipment = it.equipment;
      } else drafts.push({
        fileName: it.courseware || 'AI-' + (drafts.length + 1),
        lessonName: it.lessonName || it.courseware || 'AI 课时',
        activities: it.activities, equipment: it.equipment,
      });
      merged += 1;
    }
    renderDrafts();
    saveDrafts();
    return merged;
  }
  // ---------- 草稿渲染（事件委托，可修改） ----------
  function draftHTML(d, i) {
    const actRows = d.activities.map((a, ai) =>
      '<div class="ss-row"><input data-d-act value="' + esc(a) + '" placeholder="活动名" maxlength="40" />'
      + '<button type="button" class="row-del" data-d-act-del="' + ai + '">-</button></div>').join('');
    const eqRows = d.equipment.map((e, ei) =>
      '<div class="ss-row ss-eq"><input data-d-eqid list="dict-eq" value="' + esc(e.eqId) + '" placeholder="器材编码" maxlength="30" />'
      + '<input data-d-eqname value="' + esc(e.eqName) + '" placeholder="器材名称" maxlength="30" />'
      + '<input data-d-pre type="number" min="1" max="99" value="' + (e.preset || 1) + '" title="默认数量" />'
      + '<button type="button" class="row-del" data-d-eq-del="' + ei + '">-</button></div>').join('');
    return '<div class="draft-card" data-draft="' + i + '">'
      + '<div class="draft-head"><input data-d-name value="' + esc(d.lessonName) + '" placeholder="课时名" maxlength="40" />'
      + '<span class="hint">' + esc(d.fileName) + '</span>'
      + '<button type="button" class="row-del" data-d-del="' + i + '">×删除</button></div>'
      + '<div class="draft-sec"><span class="hint">活动</span>' + (actRows || '<span class="hint">无</span>') + '</div>'
      + '<div class="draft-sec"><span class="hint">器材</span>' + (eqRows || '<span class="hint">无</span>') + '</div>'
      + '<div class="mini-actions"><button type="button" class="btn btn-ghost" data-d-act-add>+ 活动</button>'
      + '<button type="button" class="btn btn-ghost" data-d-eq-add>+ 器材</button></div></div>';
  }
  function renderDrafts() {
    const host = $('ss-drafts');
    if (!host) return;
    host.innerHTML = drafts.length ? drafts.map(draftHTML).join('')
      : '<p class="hint">还没有草稿 —— 先在上方导入课件。</p>';
    refreshClassOptions();
  }
  function readDraftCard(card) {
    const activities = [...card.querySelectorAll('[data-d-act]')].map((x) => x.value.trim()).filter(Boolean);
    const equipment = [...card.querySelectorAll('.ss-eq')].map((row) => {
      const q = (sel) => { const el = row.querySelector(sel); return el ? el.value.trim() : ''; };
      return {
        eqId: q('[data-d-eqid]'), eqName: q('[data-d-eqname]'),
        preset: Math.max(1, Number(q('[data-d-pre]')) || 1),
      };
    }).filter((e) => e.eqId || e.eqName);
    const nameEl = card.querySelector('[data-d-name]');
    return { lessonName: nameEl ? nameEl.value.trim() : '', activities, equipment };
  }
  function onDraftClick(e) {
    const card = e.target.closest('.draft-card');
    if (!card) return;
    const i = Number(card.dataset.draft);
    const actDel = e.target.closest('[data-d-act-del]');
    const eqDel = e.target.closest('[data-d-eq-del]');
    const actAdd = e.target.closest('[data-d-act-add]');
    const eqAdd = e.target.closest('[data-d-eq-add]');
    const del = e.target.closest('[data-d-del]');
    if (actDel) {
      actDel.closest('.ss-row').remove();
    } else if (eqDel) {
      eqDel.closest('.ss-row').remove();
    } else if (actAdd) {
      card.querySelector('.draft-sec').insertAdjacentHTML('beforeend',
        '<div class="ss-row"><input data-d-act value="" placeholder="活动名" maxlength="40" />'
        + '<button type="button" class="row-del" data-d-act-del="0">-</button></div>');
    } else if (eqAdd) {
      card.querySelectorAll('.draft-sec')[1].insertAdjacentHTML('beforeend',
        '<div class="ss-row ss-eq"><input data-d-eqid list="dict-eq" value="" placeholder="器材编码" maxlength="30" />'
        + '<input data-d-eqname value="" placeholder="器材名称" maxlength="30" />'
        + '<input data-d-pre type="number" min="1" max="99" value="1" title="默认数量" />'
        + '<button type="button" class="row-del" data-d-eq-del="0">-</button></div>');
    } else if (del) {
      drafts.splice(i, 1); syncDraftsFromDom(); saveDrafts(); renderDrafts();
    }
  }
  // 把 DOM 当前编辑值同步回 drafts（入库前统一读取）
  function syncDraftsFromDom() {
    const host = $('ss-drafts');
    if (!host) return;
    host.querySelectorAll('.draft-card').forEach((card, i) => {
      if (!drafts[i]) return;
      const r = readDraftCard(card);
      drafts[i].lessonName = r.lessonName; drafts[i].activities = r.activities; drafts[i].equipment = r.equipment;
    });
  }
  // ---------- 确认入库 ----------
  function refreshClassOptions() {
    const sel = $('ss-target-class');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = (Editor.classes || []).map((c) =>
      '<option value="' + esc(c.presetId) + '">' + esc(c.name) + '</option>').join('')
      || '<option value="">（无班级，请先到班级页创建）</option>';
    if (cur) sel.value = cur;
  }
  async function commit() {
    syncDraftsFromDom();
    if (!drafts.length) { toast('草稿为空', true); return; }
    const targetId = ($('ss-target-class') || {}).value;
    const cls = (Editor.classes || []).find((c) => c.presetId === targetId);
    if (!cls) { toast('请先选择目标班级（无班级请先到班级页创建）', true); return; }
    const known = new Map((Editor.activities || []).map((a) => [a.name, a.presetId]));
    const newLessons = [];
    let actCreated = 0;
    for (const d of drafts) {
      if (!d.lessonName) continue;
      const ids = [];
      for (const name of d.activities) {
        let id = known.get(name);
        if (!id) {
          const j = await Editor.api('POST', '/api/v1/presets/activities', {
            name, category: '课件', note: '智能生成（' + d.fileName + '）',
            timed: false, durationSec: 0, equipment: [], taskTemplates: [],
          });
          if (j && j.code === 0 && j.data && j.data.preset_id) {
            id = j.data.preset_id;
            known.set(name, id);
            (Editor.activities = Editor.activities || []).push({ presetId: id, name, timed: false, durationSec: 0, equipment: [], taskTemplates: [] });
            actCreated += 1;
          }        }
        if (id) ids.push(id);
      }
      newLessons.push({ name: d.lessonName, activityIds: ids, equipment: d.equipment, note: null });
    }
    const body = {
      name: cls.name, totalSeats: cls.totalSeats, groupSize: cls.groupSize, note: cls.note,
      info: cls.info || null, students: cls.students || [], groups: cls.groups || [],
      equipment: cls.equipment || [], lessons: (cls.lessons || []).concat(newLessons),
    };
    const j = await Editor.api('PUT', '/api/v1/presets/classes/' + cls.presetId, body);
    if (!(j && j.code === 0)) return; // api 失败已 toast
    await Editor.refreshPresets();
    drafts = []; saveDrafts(); renderDrafts();
    note('入库完成：新增课时 ' + newLessons.length + ' 个 → 「' + esc(cls.name) + '」，新建活动 ' + actCreated + ' 个。');
    toast('已入库：' + newLessons.length + ' 个课时，' + actCreated + ' 个新活动');
    if (Editor.openClass) Editor.openClass(cls.presetId); // 连贯化：入库后直达班级课时编辑
  }
  // P0-1：班级页「批量导入课件」跳转过来时预选目标班级
  function preselectClass(classId) {
    refreshClassOptions();
    const sel = $('ss-target-class');
    if (sel && classId) sel.value = classId;
  }
  // P1-4：清空草稿补确认（与删除班级/活动的谨慎度对齐）；无弹窗组件环境（测试桩）直接清
  async function clearDrafts() {
    if (!drafts.length) { drafts = []; renderDrafts(); note(''); return; }
    const dlg = global.PresetDialog;
    if (dlg && dlg.confirmDialog) {
      const ok2 = await dlg.confirmDialog({
        title: '清空草稿', confirmText: '清空', danger: true,
        message: '将丢弃 ' + drafts.length + ' 条未入库草稿，此操作不可恢复。',
      });
      if (!ok2) return;
    }
    drafts = []; saveDrafts(); renderDrafts(); note('');
  }
  // ---------- 绑定 ----------
  function bind() {
    const btn = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    btn('ss-import-quick', importQuick);
    btn('ss-import-ai', () => { if (global.PresetSmartAI) global.PresetSmartAI.autoGenerate(); });
    // AI 链路（模型配置 / 一键调用 / 回贴解析 / 开网页）统一在 smart-ai.js 内绑定与编排
    if (global.PresetSmartAI) {
      global.PresetSmartAI.init({ pickAndParse, buildPrompt, pushDrafts, mergeItems, note, toast });
    }
    btn('ss-commit', commit);
    btn('ss-clear', clearDrafts);
    const host = $('ss-drafts');
    if (host) host.addEventListener('click', onDraftClick);
  }
  global.PresetSmartStudio = { bind, renderDrafts, refreshClassOptions, preselectClass, clearDrafts, _drafts: () => drafts };
})(window);
