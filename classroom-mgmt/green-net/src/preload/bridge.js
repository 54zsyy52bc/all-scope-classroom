'use strict';
// =============================================================================
// 预加载桥（shell.js / page.js 共用）
//
// 暴露给渲染层的唯一对象 window.greenNet。
// 安全约定（不可放宽）：
//   · contextIsolation: true —— 渲染层拿不到 ipcRenderer 本体
//   · 不暴露任何"任意通道调用"能力，只有固定方法
//   · 不暴露 fs / child_process / shell / 口令哈希
//   · 所有入参在这里先收敛形状，主进程再按"发送方 URL"二次鉴权
//
// ★ 注意：本文件会被注入到**不可信的网页**（page.js 场景）。
//   因此这里暴露的方法多寡不是安全边界，主进程 ipc.js 的逐通道鉴权才是。
// =============================================================================
const { contextBridge, ipcRenderer } = require('electron');

const CH = {
  runtime: 'gnet:runtime',
  tabsList: 'gnet:tabs:list',
  tabsCreate: 'gnet:tabs:create',
  tabsClose: 'gnet:tabs:close',
  tabsActivate: 'gnet:tabs:activate',
  navGo: 'gnet:nav:go',
  navBack: 'gnet:nav:back',
  navForward: 'gnet:nav:forward',
  navReload: 'gnet:nav:reload',
  navStop: 'gnet:nav:stop',
  navInternal: 'gnet:nav:internal',
  layoutSet: 'gnet:layout:set',
  layoutVisible: 'gnet:layout:visible',
  navGet: 'gnet:nav-config:get',
  navSave: 'gnet:nav-config:save',
  blockGet: 'gnet:blocklist:get',
  blockSave: 'gnet:blocklist:save',
  blockCheck: 'gnet:blocklist:check',
  adminState: 'gnet:admin:state',
  adminSetup: 'gnet:admin:setup',
  adminVerify: 'gnet:admin:verify',
  adminChange: 'gnet:admin:change',
  settingsGet: 'gnet:settings:get',
  settingsSave: 'gnet:settings:save',
  netInfo: 'gnet:net:info',
  netCopy: 'gnet:net:copy',
  siotProbe: 'gnet:siot:probe',
  siotOpen: 'gnet:siot:open',
  qyGet: 'gnet:qy:get',
  qyRestart: 'gnet:qy:restart',
  lockGet: 'gnet:lock:get',
  lockSet: 'gnet:lock:set',
  log: 'gnet:log',
};

const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// 推送事件白名单（渲染层无法订阅任意通道）
const EVT = ['gnet:tabs', 'gnet:blocked', 'gnet:notice', 'gnet:lock', 'gnet:task', 'gnet:qy', 'gnet:shortcut', 'gnet:focus-url'];

function sub(name, cb) {
  if (!EVT.includes(name) || typeof cb !== 'function') return () => {};
  const fn = (_e, payload) => { try { cb(payload); } catch (_err) { /* 渲染层异常不影响主进程 */ } };
  ipcRenderer.on(name, fn);
  return () => { try { ipcRenderer.removeListener(name, fn); } catch (_err) { /* noop */ } };
}

function build(opts) {
  const o = opts || {};
  const api = {
    version: '1.0.0',
    role: o.role || 'page',

    // ---- 运行时 ----
    getRuntime: () => ipcRenderer.invoke(CH.runtime),

    // ---- 标签 ----
    listTabs: () => ipcRenderer.invoke(CH.tabsList),
    createTab: (url) => ipcRenderer.invoke(CH.tabsCreate, str(url, 2048)),
    closeTab: (id) => ipcRenderer.invoke(CH.tabsClose, str(id, 16)),
    activateTab: (id) => ipcRenderer.invoke(CH.tabsActivate, str(id, 16)),

    // ---- 导航 ----
    go: (url, tabId) => ipcRenderer.invoke(CH.navGo, { url: str(url, 2048), tabId: str(tabId, 16) }),
    back: () => ipcRenderer.invoke(CH.navBack),
    forward: () => ipcRenderer.invoke(CH.navForward),
    reload: () => ipcRenderer.invoke(CH.navReload),
    stop: () => ipcRenderer.invoke(CH.navStop),
    openInternal: (action) => ipcRenderer.invoke(CH.navInternal, str(action, 24)),

    // ---- 布局（仅外壳使用；主进程只放行 shell）----
    setContentBounds: (rect) => ipcRenderer.invoke(CH.layoutSet, {
      x: num(rect && rect.x, 0), y: num(rect && rect.y, 0),
      width: Math.max(0, num(rect && rect.width, 0)), height: Math.max(0, num(rect && rect.height, 0)),
    }),
    setContentVisible: (v) => ipcRenderer.invoke(CH.layoutVisible, !!v),

    // ---- 导航首页内容 ----
    getNavConfig: () => ipcRenderer.invoke(CH.navGet),
    saveNavConfig: (config, by) => ipcRenderer.invoke(CH.navSave, { config: config || {}, by: str(by, 40) }),
    resetNavConfig: () => ipcRenderer.invoke(CH.navSave, { action: 'reset' }),

    // ---- 屏蔽列表 ----
    getBlocklist: () => ipcRenderer.invoke(CH.blockGet),
    saveBlocklist: (patch) => ipcRenderer.invoke(CH.blockSave, patch || {}),
    checkUrl: (url) => ipcRenderer.invoke(CH.blockCheck, str(url, 2048)),

    // ---- 教师口令 ----
    adminState: () => ipcRenderer.invoke(CH.adminState),
    adminSetup: (pwd) => ipcRenderer.invoke(CH.adminSetup, str(pwd, 128)),
    adminVerify: (pwd) => ipcRenderer.invoke(CH.adminVerify, str(pwd, 128)),
    adminChange: (oldPwd, newPwd) => ipcRenderer.invoke(CH.adminChange, { oldPwd: str(oldPwd, 128), newPwd: str(newPwd, 128) }),

    // ---- 系统设置 ----
    getSettings: () => ipcRenderer.invoke(CH.settingsGet),
    saveSettings: (patch) => ipcRenderer.invoke(CH.settingsSave, patch || {}),

    // ---- 本机网络 ----
    getNetInfo: () => ipcRenderer.invoke(CH.netInfo),
    copyText: (t) => ipcRenderer.invoke(CH.netCopy, str(t, 4000)),

    // ---- SIoT ----
    probeSiot: () => ipcRenderer.invoke(CH.siotProbe),
    openSiotConsole: (force) => ipcRenderer.invoke(CH.siotOpen, { force: !!force }),

    // ---- 全域联动 ----
    getQy: () => ipcRenderer.invoke(CH.qyGet),
    restartQy: () => ipcRenderer.invoke(CH.qyRestart),

    // ---- 锁定 ----
    getLock: () => ipcRenderer.invoke(CH.lockGet),
    setLock: (v) => ipcRenderer.invoke(CH.lockSet, !!v),

    // ---- 日志 ----
    log: (line) => ipcRenderer.invoke(CH.log, str(line, 400)),
  };

  // 事件订阅（返回取消函数，便于页面卸载时清理）
  if (o.events !== false) {
    api.onTabs = (cb) => sub('gnet:tabs', cb);
    api.onBlocked = (cb) => sub('gnet:blocked', cb);
    api.onNotice = (cb) => sub('gnet:notice', cb);
    api.onLock = (cb) => sub('gnet:lock', cb);
    api.onTask = (cb) => sub('gnet:task', cb);
    api.onQy = (cb) => sub('gnet:qy', cb);
    api.onShortcut = (cb) => sub('gnet:shortcut', cb);
    api.onFocusUrl = (cb) => sub('gnet:focus-url', cb);
  }
  return api;
}

function expose(role, events) {
  const api = build({ role, events });
  try {
    contextBridge.exposeInMainWorld('greenNet', api);
  } catch (_e) {
    // 无 Electron 的纯浏览器预览环境：挂到 window 上让页面仍能渲染（能力自动降级）
    // eslint-disable-next-line no-undef
    if (typeof window !== 'undefined') window.greenNet = api;
  }
}

module.exports = { CH, build, expose, str, num };
