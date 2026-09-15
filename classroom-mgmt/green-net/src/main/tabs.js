'use strict';
// =============================================================================
// 标签管理器：一个标签 = 一个 WebContentsView
//
// 为什么用 WebContentsView 而不是 <webview>：
//   - webview 已不推荐且隔离性差；WebContentsView 是 Electron 30+ 的官方方案
//   - 每个标签独立 webContents / 独立 loading 状态，标签栏状态推送更准确
//
// 屏蔽拦截共三层（缺一层就会被绕过）：
//   L1 navigate() 入口   —— 地址栏输入、首页卡片点击、新标签打开
//   L2 will-navigate / will-redirect —— 页面内点击链接、JS 跳转、服务端 302
//   L3 webRequest.onBeforeRequest —— 兜底：子资源（图片/脚本/iframe）与漏网的主框架请求
// 命中后统一跳到内置页 gnet://blocked/，而不是 Chromium 的错误页（对学生不可读）。
// =============================================================================
const { WebContentsView } = require('electron');
const U = require('./util');

const INTERNAL_HOSTS = ['home', 'ip', 'siot', 'admin', 'blocked', 'locked', 'error', 'qy', 'help'];

function createTabs(deps) {
  const {
    host, session, logger, blocklist, getConfig, pagePreloadPath, onState, onBlocked, onExternal, isLocked,
  } = deps;

  const tabs = new Map();
  const order = [];
  let activeId = null;
  let bounds = { x: 0, y: 0, width: 0, height: 0 };
  let visible = true;
  let seq = 0;
  let flushTimer = null;

  // ---- 状态推送（节流 80ms，避免 loading 期间狂刷 IPC）----
  function scheduleState() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (onState) { try { onState(state()); } catch (_e) { /* noop */ } }
    }, 80);
  }

  function state() {
    return {
      tabs: order.map((id) => {
        const t = tabs.get(id);
        return {
          id: t.id,
          url: t.url,
          displayUrl: displayUrl(t.url),
          title: t.title,
          favicon: t.favicon,
          loading: t.loading,
          canGoBack: t.canGoBack,
          canGoForward: t.canGoForward,
          crashed: t.crashed,
          internal: U.isInternalUrl(t.url) || /^gnet:/i.test(t.url),
          audible: false,
        };
      }),
      activeId,
      visible,
    };
  }

  // 地址栏显示文案：内置页给出中文名，外网页显示原始 URL
  function displayUrl(url) {
    const m = String(url || '').match(/^gnet:\/\/([a-z]+)\//i);
    if (m) {
      const map = {
        home: '绿网导航首页', ip: '本机 IP 地址', siot: 'SIoT 控制台',
        admin: '教师管理', blocked: '网页已屏蔽', locked: '课堂锁定中',
        error: '打不开这个网页', qy: '全域课堂连接', help: '使用帮助',
      };
      return map[m[1].toLowerCase()] || '绿网';
    }
    if (U.isInternalUrl(url)) return '绿网';
    return String(url || '');
  }

  function internalUrl(hostName, params) {
    const h = INTERNAL_HOSTS.includes(hostName) ? hostName : 'home';
    let q = '';
    if (params && typeof params === 'object') {
      const sp = new URLSearchParams();
      for (const k of Object.keys(params)) {
        const v = params[k];
        if (v === undefined || v === null || v === '') continue;
        sp.set(k, String(v).slice(0, 500));
      }
      const s = sp.toString();
      if (s) q = '?' + s;
    }
    return `gnet://${h}/${q}`;
  }

  // ---- 单个标签的 webContents 事件接线 ----
  function wire(tab) {
    const wc = tab.view.webContents;
    const sync = () => {
      try {
        tab.url = wc.getURL() || tab.url;
        tab.canGoBack = wc.navigationHistory.canGoBack();
        tab.canGoForward = wc.navigationHistory.canGoForward();
      } catch (_e) { /* noop */ }
      scheduleState();
    };

    wc.on('did-start-loading', () => { tab.loading = true; sync(); });
    wc.on('did-stop-loading', () => { tab.loading = false; sync(); });
    wc.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) { tab.url = url; scheduleState(); }
    });
    wc.on('did-navigate', (_e, url) => { tab.url = url; tab.crashed = false; sync(); });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) { tab.url = url; sync(); } });
    wc.on('page-title-updated', (_e, title) => { tab.title = U.str(title, 120) || displayUrl(tab.url); scheduleState(); });
    wc.on('page-favicon-updated', (_e, icons) => {
      tab.favicon = (Array.isArray(icons) && icons.length) ? String(icons[0]).slice(0, 500) : '';
      scheduleState();
    });

    // L2：页面内导航 / JS 跳转
    wc.on('will-navigate', (e, url) => {
      const r = guard(url);
      if (r.blocked) {
        e.preventDefault();
        showBlocked(tab, url, r);
      }
    });
    // L2b：服务端 302 —— 重定向目标同样要过屏蔽引擎
    wc.on('will-redirect', (e, url, isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      const r = guard(url);
      if (r.blocked) {
        e.preventDefault();
        showBlocked(tab, url, r);
      }
    });

    // 新窗口 / target=_blank → 统一转为本浏览器新标签，不弹出独立窗口
    wc.setWindowOpenHandler(({ url }) => {
      const r = guard(url);
      if (r.blocked) {
        showBlocked(tab, url, r);
        return { action: 'deny' };
      }
      createTab(url, { activate: true });
      return { action: 'deny' };
    });

    // 渲染进程崩溃：不静默，标记 crashed 让工具栏给出「重新加载」
    wc.on('render-process-gone', (_e, details) => {
      tab.crashed = true;
      tab.loading = false;
      tab.crashReason = (details && details.reason) || 'unknown';
      if (logger) logger.error(`标签页渲染进程结束：${tab.id} reason=${tab.crashReason}`);
      scheduleState();
    });

    // 主框架加载失败：统一换成内置错误页（学生看得懂）
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (errorCode === -3) return; // ERR_ABORTED：被主动取消，不算失败
      if (/^gnet:/i.test(String(validatedURL || ''))) return; // 内置页自身不再递归
      tab.loading = false;
      if (logger) logger.warn(`加载失败 ${errorCode} ${errorDescription} ${validatedURL}`);
      navigateInternal(tab.id, 'error', {
        code: String(errorCode), desc: String(errorDescription || ''), url: String(validatedURL || ''),
      });
    });

    // 右键菜单：机房场景关闭（避免「查看源代码 / 检查」入口）
    wc.on('context-menu', (e) => { try { e.preventDefault(); } catch (_e) { /* noop */ } });

    // 键盘兜底：屏蔽开发者工具快捷键
    wc.on('before-input-event', (e, input) => {
      const cfg = getConfig();
      if (cfg.allowDevTools) return;
      const key = String(input.key || '').toLowerCase();
      const ctrl = input.control || input.meta;
      if (key === 'f12' || (ctrl && input.shift && key === 'i') || (ctrl && input.shift && key === 'j')) {
        e.preventDefault();
      }
      if (ctrl && key === 'u') e.preventDefault(); // 查看源代码
    });
  }

  // 统一判定 + 审计
  function guard(url) {
    const r = blocklist.check(url);
    if (r.blocked && logger) {
      const why = r.rule ? `${r.rule.type}=${r.rule.value}` : r.reason;
      logger.warn(`已屏蔽 ${url}（${why}）`);
    }
    return r;
  }

  function showBlocked(tab, url, result) {
    tab.blocked = { url, reason: result.reason, rule: result.rule || null, at: Date.now() };
    tab.url = internalUrl('blocked', {
      url,
      reason: result.reason,
      rule: result.rule ? `${result.rule.type} = ${result.rule.value}` : '',
      note: result.rule ? result.rule.note : '',
    });
    try { tab.view.webContents.loadURL(tab.url); } catch (_e) { /* noop */ }
    if (onBlocked) { try { onBlocked({ url, ...result, tabId: tab.id }); } catch (_e) { /* noop */ } }
  }

  // ---- 标签增删改查 ----
  function createTab(url, opts) {
    const o = opts || {};
    const cfg = getConfig();
    if (order.length >= cfg.maxTabs) {
      if (logger) logger.warn(`标签数已达上限 ${cfg.maxTabs}`);
      if (onBlocked) { try { onBlocked({ url, reason: 'too-many-tabs' }); } catch (_e) { /* noop */ } }
      return null;
    }
    seq += 1;
    const id = 't' + seq;
    const view = new WebContentsView({
      webPreferences: {
        session,
        preload: pagePreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        disableDialogs: false,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const tab = {
      id, view, url: '', title: '新标签页', favicon: '', loading: true,
      canGoBack: false, canGoForward: false, crashed: false, blocked: null,
    };
    tabs.set(id, tab);
    order.push(id);
    wire(tab);
    attach(tab);
    applyBounds();

    tab.url = url || internalUrl('home');
    try { view.webContents.loadURL(tab.url); } catch (e) {
      if (logger) logger.error(`标签加载异常：${e.message}`);
    }
    if (o.activate !== false) activeId = id;
    tab.title = displayUrl(tab.url);
    syncVisibility();
    scheduleState();
    return tab;
  }

  function attach(tab) {
    try { host.contentView.addChildView(tab.view); } catch (_e) { /* 已挂载 */ }
  }

  function detach(tab) {
    try { host.contentView.removeChildView(tab.view); } catch (_e) { /* 未挂载 */ }
  }

  function closeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return false;
    const idx = order.indexOf(id);
    tabs.delete(id);
    order.splice(idx, 1);
    detach(tab);
    try { tab.view.webContents.close(); } catch (_e) { /* noop */ }
    if (activeId === id) {
      const next = order[Math.min(idx, order.length - 1)] || order[0] || null;
      activeId = next;
      syncVisibility();
    }
    if (!order.length) {
      // 关掉最后一个标签 = 回首页（不退出浏览器，学生不容易"迷路"）
      createTab(internalUrl('home'), { activate: true });
      return true;
    }
    scheduleState();
    return true;
  }

  function activateTab(id) {
    if (!tabs.has(id) || activeId === id) return false;
    activeId = id;
    syncVisibility();
    scheduleState();
    return true;
  }

  // 只把当前激活标签挂到窗口上；其余从视图树移除（webContents 保留，状态不丢）
  function syncVisibility() {
    for (const id of order) {
      const t = tabs.get(id);
      if (!t) continue;
      if (visible && id === activeId) attach(t);
      else detach(t);
    }
    applyBounds();
  }

  function applyBounds() {
    for (const id of order) {
      const t = tabs.get(id);
      if (!t) continue;
      try {
        t.view.setBounds({
          x: Math.round(bounds.x), y: Math.round(bounds.y),
          width: Math.max(0, Math.round(bounds.width)), height: Math.max(0, Math.round(bounds.height)),
        });
      } catch (_e) { /* noop */ }
    }
  }

  function setBounds(next) {
    bounds = Object.assign({}, bounds, next || {});
    applyBounds();
  }

  function setVisible(v) {
    visible = !!v;
    syncVisibility();
    scheduleState();
  }

  function active() { return tabs.get(activeId) || null; }

  // 反查：webRequest / session 事件只给 webContentsId，需要映射回标签对象。
  // 用在 L3 兜底拦截里，把「被拦的主框架请求」落到正确的标签上显示屏蔽页。
  // 注意：webContentsId 可能是 undefined（如非主框架或内部请求），此时返回 null，
  //       调用方必须判空——这是正常路径，不是错误。
  function findByWebContentsId(webContentsId) {
    if (webContentsId === undefined || webContentsId === null) return null;
    const want = Number(webContentsId);
    if (!Number.isFinite(want)) return null;
    for (const t of tabs.values()) {
      try {
        if (t.view && t.view.webContents && t.view.webContents.id === want) return t;
      } catch (_e) { /* webContents 已销毁 → 跳过 */ }
    }
    return null;
  }

  // L1：程序化导航入口（地址栏 / 首页卡片 / 新标签）
  // 学生手输"internal:xxx"时只放行安全的几个内置页；教师管理页只能由外壳的按钮打开，
  // 这样即使有人在地址栏里试 internal:admin 也进不去（管理页自身还有口令门，双保险）。
  const USER_INTERNAL = ['home', 'ip', 'siot', 'qy', 'help'];

  function navigate(id, rawUrl) {
    const tab = tabs.get(id);
    if (!tab) return { ok: false, err: '标签不存在' };
    const n = U.normalizeUrl(rawUrl);
    if (!n.ok) return { ok: false, err: n.err };

    if (U.isInternalUrl(n.url)) {
      const a = U.internalAction(n.url);
      if (!USER_INTERNAL.includes(a)) return { ok: false, err: '这个页面只能从工具栏按钮打开' };
      return navigateInternal(tab.id, a, {});
    }
    const r = guard(n.url);
    if (r.blocked) {
      showBlocked(tab, n.url, r);
      return { ok: true, blocked: true };
    }
    if (onExternal) { try { onExternal(n.url); } catch (_e) { /* noop */ } }
    try {
      tab.url = n.url;
      tab.view.webContents.loadURL(n.url);
      return { ok: true, blocked: false };
    } catch (e) {
      return { ok: false, err: String(e.message || e) };
    }
  }

  function navigateInternal(id, hostName, params) {
    const tab = id === undefined || id === null ? active() : tabs.get(id);
    if (!tab) return { ok: false, err: '标签不存在' };
    const u = internalUrl(hostName, params);
    try {
      tab.url = u;
      tab.title = displayUrl(u);
      tab.view.webContents.loadURL(u);
      scheduleState();
      return { ok: true };
    } catch (e) {
      return { ok: false, err: String(e.message || e) };
    }
  }

  function goBack(id) {
    const t = tabs.get(id === undefined ? activeId : id);
    if (!t) return false;
    try { if (t.view.webContents.navigationHistory.canGoBack()) { t.view.webContents.navigationHistory.goBack(); return true; } } catch (_e) { /* noop */ }
    return false;
  }

  function goForward(id) {
    const t = tabs.get(id === undefined ? activeId : id);
    if (!t) return false;
    try { if (t.view.webContents.navigationHistory.canGoForward()) { t.view.webContents.navigationHistory.goForward(); return true; } } catch (_e) { /* noop */ }
    return false;
  }

  function reload(id) {
    const t = tabs.get(id === undefined ? activeId : id);
    if (!t) return false;
    try { t.view.webContents.reload(); return true; } catch (_e) { return false; }
  }

  function stop(id) {
    const t = tabs.get(id === undefined ? activeId : id);
    if (!t) return false;
    try { t.view.webContents.stop(); return true; } catch (_e) { return false; }
  }

  function hardReset() {
    for (const id of order.slice()) closeTab(id);
    createTab(internalUrl('home'), { activate: true });
  }

  function destroy() {
    for (const t of tabs.values()) {
      detach(t);
      try { t.view.webContents.close(); } catch (_e) { /* noop */ }
    }
    tabs.clear();
    order.length = 0;
    activeId = null;
  }

  return {
    state, createTab, closeTab, activateTab, navigate, navigateInternal,
    goBack, goForward, reload, stop, active, setBounds, setVisible,
    displayUrl, internalUrl, destroy, hardReset, findByWebContentsId, showBlocked,
    count: () => order.length,
  };
}

module.exports = { createTabs, INTERNAL_HOSTS };
