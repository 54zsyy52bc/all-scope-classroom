'use strict';
// =============================================================================
// Preset Studio · 智能生成（v5 预设编辑器大改，脑图：导入相关数据 → 活动包 / 学生包）
//   - 导入学生名单（CSV/TSV/TXT：学号,姓名,分组）→ 填充学生包 + 自动生成分组配置
//   - 批量导入课件（PPTX/DOCX/PDF 多选）→ 主进程解压识别活动标题（活动/实验/任务…），
//     每课件生成一个课时，识别到的活动批量创建并自动挂接（同名去重；PDF 仅按文件名生成骨架）
//   - parseRosterText 纯逻辑在 src/class-parts.js（无头单测），这里只管选文件与回填 UI
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

  // 解析在渲染层 require 主进程共享模块不可行（contextIsolation）——
  // 这里内置一份与 src/class-parts.js parseRosterText 等价的轻量解析（有单测对齐）。
  function parseRosterText(text) {
    const raw = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    const lines = raw.split(/\r\n|\n|\r/).map((l) => l.trim()).filter((l) => l);
    if (!lines.length) throw new Error('名单为空');
    const splitRow = (l) => l.split(/\t|,|，/).map((c) => c.trim().replace(/^"|"$/g, ''));
    let start = 0;
    if (splitRow(lines[0]).some((c) => /姓名|name|学生/.test(c))) start = 1;
    const students = [];
    for (let i = start; i < lines.length; i += 1) {
      const cols = splitRow(lines[i]);
      const name = cols[1] || '';
      if (!name) continue;
      students.push({ studentNo: cols[0] || '', name: name.slice(0, 30), group: cols[2] || '', seat: students.length + 1 });
    }
    if (!students.length) throw new Error('没有解析到有效学生（每行需含姓名列）');
    return students;
  }

  function setNote(html) {
    const n = $('roster-import-note');
    if (!n) return;
    if (!html) { n.hidden = true; n.innerHTML = ''; return; }
    n.hidden = false;
    n.innerHTML = html;
  }

  // 导入学生名单：选文件 → 解析 → 填学生包 + 生成分组 + 座位数联动
  async function importRoster() {
    if (!global.StudioApi || !global.StudioApi.pickRoster) { toast('当前环境不支持文件导入', true); return; }
    let opened;
    try { opened = await global.StudioApi.pickRoster(); } catch (e) { toast((e && e.message) || '读取失败', true); return; }
    if (!opened) return; // 用户取消
    let students;
    try { students = parseRosterText(opened.text); }
    catch (e) { toast('名单解析失败：' + (e && e.message || e), true); return; }

    if (global.PresetRoster) global.PresetRoster.fill(students);
    // 分组：按名单分组名聚合（与 PresetRoster.deriveGroups 同规则）
    const order = [];
    const count = {};
    for (const s of students) {
      if (!s.group) continue;
      if (!(s.group in count)) { count[s.group] = 0; order.push(s.group); }
      count[s.group] += 1;
    }
    if (order.length && global.PresetClassUi) {
      global.PresetClassUi.renderGroups(order.map((g) => ({ groupId: g, size: count[g] })));
    }
    const seats = $('c-seats');
    if (seats) seats.value = students.length;
    setNote('已导入 <b>' + esc(opened.fileName) + '</b>：' + students.length + ' 名学生'
      + (order.length ? '，' + order.length + ' 个分组（' + order.map((g) => esc(g)).join('、') + '）' : '，未含分组（按均分配置）'));
    toast('学生名单已导入：' + students.length + ' 人');
  }

  // 批量导入课件：多选 → 主进程解析内容识别活动标题 → 每课件一个课时 + 活动预设批量创建并挂接
  async function importCourseware() {
    if (!global.StudioApi || !global.StudioApi.pickCourseware) { toast('当前环境不支持文件导入', true); return; }
    let picked;
    try { picked = await global.StudioApi.pickCourseware(); } catch (e) { toast((e && e.message) || '读取失败', true); return; }
    if (!picked || !picked.files || !picked.files.length) return; // 用户取消
    const files = picked.files;
    if (!global.PresetLessons) { toast('课时编辑器未装配', true); return; }

    // 1) 内容识别：主进程解压 PPTX/DOCX 按关键词提取候选活动标题（与 files 顺序对齐）
    const parsedMap = {};
    const paths = files.map((f) => f.filePath).filter(Boolean);
    if (paths.length && global.StudioApi.parseCourseware) {
      try {
        const parsed = await global.StudioApi.parseCourseware(paths) || [];
        parsed.forEach((p) => { if (p && p.fileName) parsedMap[p.fileName] = p; });
      } catch (e) { toast('课件内容识别失败：' + ((e && e.message) || e), true); }
    }

    // 2) 逐课件建课时：识别到的标题→活动预设（同名去重复用），未识别→纯骨架
    const cache = Editor.activities = Editor.activities || [];
    const known = new Map(cache.map((a) => [a.name, a.presetId]));
    const added = [];
    let actCount = 0;
    const reasons = [];
    for (const f of files) {
      const info = parsedMap[f.fileName] || { titles: [] };
      if (info.reason) reasons.push(f.baseName + '：' + info.reason);
      const ids = [];
      for (const title of (info.titles || [])) {
        let id = known.get(title);
        if (!id) {
          const j = await Editor.api('POST', '/api/v1/presets/activities', {
            name: title, category: '课件', note: '由课件「' + f.baseName + '」内容识别生成',
            timed: false, durationSec: 0, equipment: [], taskTemplates: [],
          });
          if (j && j.code === 0 && j.data && j.data.preset_id) {
            id = j.data.preset_id;
            known.set(title, id);
            cache.push({ presetId: id, name: title, timed: false, durationSec: 0, equipment: [], taskTemplates: [] });
            actCount += 1;
          }
        }
        if (id) ids.push(id);
      }
      const lessonName = global.PresetLessons.appendSkel(f.baseName, ids);
      added.push(lessonName + '（活动 ' + ids.length + '）');
    }
    if (Editor.refreshPresets) await Editor.refreshPresets(); // 统一刷列表与 chips
    setNote('已导入 <b>' + files.length + '</b> 个课件 → ' + esc(added.join('、'))
      + '，新建活动 ' + actCount + ' 个'
      + (reasons.length ? '<br />' + esc(reasons.join('<br />')) : ''));
    toast('批量导入完成：' + files.length + ' 个课时，新建活动 ' + actCount + ' 个');
  }

  function bind() {
    const r = $('btn-roster-import');
    if (r) r.onclick = importRoster;
    const c = $('btn-lesson-courseware');
    if (c) c.onclick = importCourseware;
  }

  global.PresetSmart = { bind, importRoster, importCourseware, parseRosterText };
})(window);
