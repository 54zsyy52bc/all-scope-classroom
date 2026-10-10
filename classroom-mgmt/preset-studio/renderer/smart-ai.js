'use strict';
// Preset Studio · 智能生成 · 模型接入层。
// 每台备课机本机各存一份 API 配置（meta 库 + localStorage 双写）；OpenAI 兼容接口，
// 网络在主进程（ai:chat）发送以规避渲染层 CORS。依赖 window.AiChat（../src/ai-chat.js）。
// 两条路径：① 一键调用模型自动回填（主路径）② 失败/未配置时回退"复制提示词 + 开网页 + 回贴"。
(function (global) {
  const $ = (id) => document.getElementById(id);
  const AI = global.AiChat;
  const CONFIG_KEY = 'ai-config-v1';
  let ctx = null; // 由 smart-studio 注入：{ pickAndParse, buildPrompt, pushDrafts, mergeItems, note, toast }
  let lastPrompt = ''; // 手动网页路径复用最近一次提示词

  function readInputs() {
    const g = (id) => { const el = $(id); return el ? el.value.trim() : ''; };
    return { baseUrl: g('ss-ai-base'), apiKey: g('ss-ai-key'), model: g('ss-ai-model') };
  }

  function fillInputs(cfg) {
    const m = { 'ss-ai-base': cfg.baseUrl, 'ss-ai-key': cfg.apiKey, 'ss-ai-model': cfg.model };
    for (const id of Object.keys(m)) { const el = $(id); if (el && m[id]) el.value = m[id]; }
  }

  async function loadConfig() {
    let cfg = null;
    try { if (global.StudioApi && global.StudioApi.metaGet) cfg = await global.StudioApi.metaGet(CONFIG_KEY); } catch (_e) { /* 主进程读失败回落本地 */ }
    if (!cfg) { try { cfg = JSON.parse(global.localStorage.getItem(CONFIG_KEY) || 'null'); } catch (_e) { /* 忽略 */ } }
    if (cfg && typeof cfg === 'object') fillInputs(cfg);
  }

  async function saveConfig() {
    if (!ctx) return false;
    const cfg = readInputs();
    if (!cfg.baseUrl || !cfg.model) { ctx.toast('接口地址与模型名必填', true); return false; }
    try { if (global.StudioApi && global.StudioApi.metaSet) await global.StudioApi.metaSet({ key: CONFIG_KEY, value: cfg }); } catch (_e) { /* 本地仍有 */ }
    try { global.localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (_e) { /* 忽略 */ }
    ctx.toast('模型接入配置已保存（仅本机）');
    return true;
  }

  function configReady() {
    const c = readInputs();
    return !!(c.baseUrl && c.model);
  }

  function showLegacy(show) {
    const t = $('ss-ai-tools');
    const c = $('ss-ai-import-card');
    if (t) t.hidden = !show;
    if (c) c.hidden = !show;
  }

  // 主路径：导入课件 → 配置就绪则直接调模型 → JSON 提取 → 合入草稿；异常回退手动网页方式
  async function autoGenerate() {
    if (!ctx) return;
    const parsed = await ctx.pickAndParse();
    if (!parsed) return;
    const aiReady = parsed.filter((p) => (p.lines || []).length);
    if (!aiReady.length) { ctx.toast('没有可识别文本的课件（仅支持 PPTX/DOCX），请改用快速识别', true); return; }
    ctx.pushDrafts(aiReady); // 先按文件名落骨架草稿，模型结果回来后覆盖增强
    if (!configReady()) {
      showLegacy(true);
      ctx.note('模型接口尚未配置：请在「模型接入」填接口地址 / API Key / 模型名并保存后重试；'
        + '或直接用下方手动网页方式。已生成骨架草稿 ' + aiReady.length + ' 条。');
      ctx.toast('请先配置模型接口', true);
      return;
    }
    const prompt = ctx.buildPrompt(aiReady);
    lastPrompt = prompt;
    const btn = $('ss-ai-call');
    if (btn) btn.disabled = true;
    ctx.note('正在调用模型生成课时包（共 ' + aiReady.length + ' 个课件，小模型可能需要 1-3 分钟，请勿关闭窗口）…');
    try {
      const r = await global.StudioApi.aiChat(Object.assign(readInputs(), { prompt }));
      const data = AI.extractModelJson(r.content);
      const items = (Array.isArray(data) ? data : [data]).map(AI.normalizeAiItem).filter(Boolean);
      const merged = ctx.mergeItems(items);
      if (!merged) {
        ctx.toast('模型结果里没有可用条目', true);
        ctx.note('模型已返回但无有效条目。可展开下方手动网页方式重试，或检查提示词要求。');
        showLegacy(true);
      } else {
        ctx.note('模型结果已合入草稿：' + merged + ' 条。请检查修改后确认入库。');
        ctx.toast('已合入模型结果：' + merged + ' 条');
      }
    } catch (e) {
      ctx.toast('模型调用失败：' + ((e && e.message) || e), true);
      ctx.note('已回退手动流程：提示词已复制到剪贴板，可打开 AI 网页生成后回贴到下方。');
      showLegacy(true);
      try {
        if (global.StudioApi && global.StudioApi.openAiPage) {
          await global.StudioApi.openAiPage(($('ss-ai-url') || {}).value || '', prompt);
        }
      } catch (_e) { /* 打不开网页不阻断 */ }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // 手动回贴路径：解析粘贴的模型输出 → 合入草稿
  async function applyPasted() {
    if (!ctx) return;
    const ta = $('ss-ai-result');
    if (!ta || !ta.value.trim()) { ctx.toast('请先粘贴 AI 返回的 JSON', true); return; }
    let data;
    try { data = AI.extractModelJson(ta.value); } catch (e) { ctx.toast('JSON 解析失败：' + e.message, true); return; }
    const items = (Array.isArray(data) ? data : [data]).map(AI.normalizeAiItem).filter(Boolean);
    if (!items.length) { ctx.toast('AI 结果里没有可用条目', true); return; }
    const merged = ctx.mergeItems(items);
    ctx.note('AI 结果已合入草稿：' + merged + ' 条。请检查修改后确认入库。');
    ta.value = '';
    ctx.toast('已合入 AI 结果：' + merged + ' 条');
  }

  // 手动网页方式按钮：复制最近提示词 + 打开网页
  async function openWeb() {
    const url = ($('ss-ai-url') || {}).value || '';
    try { global.localStorage.setItem('ss-ai-url', url); } catch (_e) { /* 忽略 */ }
    if (global.StudioApi && global.StudioApi.openAiPage) {
      const r = await global.StudioApi.openAiPage(url, lastPrompt);
      ctx.note('AI 网页' + (r.opened ? '已打开' : '未打开（请填写 http/https 地址）')
        + '，提示词' + (r.copied ? '已复制' : '未复制') + '。生成后把 JSON 回贴到下方。');
    }
  }

  function init(context) {
    ctx = context;
    const btn = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    btn('ss-ai-save', saveConfig);
    btn('ss-ai-call', autoGenerate);
    btn('ss-ai-apply', applyPasted);
    btn('ss-ai-open', openWeb);
    loadConfig();
  }

  global.PresetSmartAI = { init, autoGenerate, saveConfig, loadConfig, applyPasted };
})(window);
