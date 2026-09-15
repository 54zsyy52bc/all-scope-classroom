'use strict';
// =============================================================================
// 绿网 · 物联网实践学生专用浏览器 —— 主进程入口
//
// 模块装配图（谁依赖谁）：
//
//   index.js ──┬─ config ──────── app-config.json（窗口/下载/SIoT/全域 参数）
//              ├─ blocklist ───── data/blocklist.json（屏蔽引擎，纯函数可单测）
//              ├─ nav-config ──── data/nav-config.json（导航首页内容）
//              ├─ admin-auth ──── data/admin.json（教师口令 scrypt 哈希）
//              ├─ protocol ────── gnet:// 内置页（home/ip/siot/admin/blocked/locked/error/qy/help）
//              ├─ tabs ────────── 每个标签一个 WebContentsView + 三层拦截
//              ├─ session-policy ─ 下载/权限/证书 管控
//              ├─ netinfo ─────── 本机 IP
//              ├─ siot-console ── SIoT 探活与一键打开
//              ├─ qy-bridge ───── 全域 MQTT 联动（只读下行 + 可选心跳）
//              ├─ trust ───────── IPC 发送方鉴权分级
//              └─ ipc ─────────── 渲染层通道（按发送方 URL 鉴权）
//
// 启动顺序（顺序本身是正确性的一部分）：
//   initBase()      日志 + 配置 + machineId        —— 建窗口要读配置，必须最先
//   createWindow()  创建 BrowserWindow（外壳）      —— tabs 需要它作为 WebContentsView 宿主
//   initModules()   分区/协议/存储/标签/全域/IPC    —— 装配其余全部能力
// =============================================================================
const path = require('node:path');
const fs = require('node:fs');

// ★ Electron API 必须先取出并做一次显式自检。
//   踩坑记录（这个坑花了很久才定位，务必看懂再改）：
//   宿主环境（CLI / IDE 集成终端 / CI 容器）常会给子进程注入
//     ELECTRON_RUN_AS_NODE=1
//   一旦带上它启动，electron.exe 会「退化成纯 Node」——Electron 的内建模块
//   不再注册，Module.builtinModules 里没有 'electron'，于是 require('electron')
//   顺着普通模块解析落到 node_modules/electron/index.js；
//   而那个 npm 包 module.exports 的正是「electron.exe 的路径字符串」。
//   后果：这里拿到字符串，下游所有模块都会以 "undefined is not a function" 炸开。
//   修复不在代码里，而在启动环境里——见 scripts/smoke.js 的 sanitizeEnv()。
const electron = require('electron');
if (!electron || typeof electron !== 'object' || !electron.app || !electron.protocol) {
  const hint = process.env.ELECTRON_RUN_AS_NODE
    ? '检测到环境变量 ELECTRON_RUN_AS_NODE=' + process.env.ELECTRON_RUN_AS_NODE
      + '，它会强制 electron.exe 以纯 Node 模式运行（正是本错误的根因）。'
      + '请先清除该变量（Windows: set ELECTRON_RUN_AS_NODE= / PowerShell: $env:ELECTRON_RUN_AS_NODE=$null）。'
    : '请确认是用 Electron 运行时启动：node_modules/electron/dist/electron.exe .'
      + '（而不是 node src/main/index.js）。';
  // eslint-disable-next-line no-console
  console.error('[boot] 无法取得 Electron API：require("electron") 返回了 '
    + typeof electron + '（' + String(electron).slice(0, 120) + '）');
  // eslint-disable-next-line no-console
  console.error('[boot] ' + hint);
  process.exit(3);
}
const { app, BrowserWindow, Menu, session, ipcMain, protocol } = electron;

const APP_ROOT = path.join(__dirname, '..', '..');
const SRC_DIR = path.join(APP_ROOT, 'src');
const PAGES_DIR = path.join(SRC_DIR, 'renderer', 'pages');
const DATA_DIR = path.join(APP_ROOT, 'data');
const SEED_NAV = path.join(SRC_DIR, 'seed', 'nav-config.default.json');

const { createLogger } = require('./logger');
const { createConfig } = require('./config');
const { resolveProxy } = require('./proxy');
const blocklistMod = require('./blocklist');
const navMod = require('./nav-config');
const { createAuth } = require('./admin-auth');
const { createTabs } = require('./tabs');
const protocolMod = require('./protocol');
const { attachSessionPolicy } = require('./session-policy');
const { createQyBridge } = require('./qy-bridge');
const siotMod = require('./siot-console');
const netinfoMod = require('./netinfo');
const { createIpc } = require('./ipc');

const PARTITION = 'persist:green-net';
const isDev = process.argv.includes('--dev');
const forceKiosk = process.argv.includes('--kiosk');
const isSmoke = process.argv.includes('--smoke');
// 全域联动联调模式：等链路在线 → 打印 ready → 观察窗口内由外部"教师端模拟器"
// 按序下发指令 → 校验「指令 → 状态 → UI」整条链是否真的走通（见 scripts/qy-integration.js）
const isQySmoke = process.argv.includes('--smoke-qy');

// 联调时序记录：只记录事件与锁定跃迁，用来证明"收到了"并且"落地了"。
// 为什么不只看最终快照：最终快照相等 ≠ 中途真的锁过（例如实现成"直接跳过锁定"也能得到终态）。
const qyTrace = [];
function trace(entry) {
  if (isQySmoke) qyTrace.push(Object.assign({ t: Date.now() }, entry));
}

// ---- 自定义协议必须在 app ready 之前登记 ----
protocolMod.registerSchemes(protocol);

// ---- 单实例：机房一台机器只允许一个绿网 ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !isSmoke && !isQySmoke) {
  app.quit();
}

let mainWindow = null;
let logger = null;
let config = createConfig(APP_ROOT); // 启动早期就要读配置（代理注入在 app ready 之前）
let tabs = null;
let qy = null;
let blockStore = null;
let auth = null;

// ---- 锁定状态（全域 cmd policy / 教师手动）----
let locked = false;
let lockReason = '';
const preLockUrl = new Map(); // tabId -> 锁前地址，解锁后原地恢复

function push(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send(channel, payload); } catch (_e) { /* noop */ }
}

function setLocked(next, reason) {
  const v = !!next;
  if (v === locked) return locked;
  locked = v;
  lockReason = String(reason || '');
  if (logger) logger.info(`课堂锁定 → ${locked ? '开启' : '解除'}（${lockReason || '手动'}）`);
  if (tabs) {
    if (locked) {
      for (const t of tabs.state().tabs) {
        if (!/^gnet:\/\//i.test(t.url || '')) preLockUrl.set(t.id, t.url);
      }
      tabs.navigateInternal(null, 'locked', {});
    } else {
      const act = tabs.active();
      const back = act ? preLockUrl.get(act.id) : null;
      preLockUrl.clear();
      if (act && /^gnet:\/\/(locked|blocked)\//i.test(act.url || '')) {
        if (back) tabs.navigate(act.id, back);
        else tabs.navigateInternal(act.id, 'home', {});
      }
    }
  }
  push('gnet:lock', { locked, reason: lockReason });
  push('gnet:task', currentTaskPayload());
  // 只在真正发生跃迁时记录（上面有 v === locked 的提前返回）
  trace({ kind: 'lock', locked });
  return locked;
}

function currentTaskPayload() {
  const snap = qy ? qy.snapshot() : null;
  return {
    locked, reason: lockReason,
    phase: snap ? snap.phase : null,
    policy: snap ? snap.policy : null,
    task: snap ? snap.task : null,
  };
}

// ---- L3 兜底拦截：子资源（图片/脚本/iframe）与漏网的主框架请求 ----
// 说明：主框架的常规导航已在 tabs.js 的 L1/L2 拦掉；这一层专治
//       ① 页面里嵌的第三方资源 ② 服务器 302 跳到被屏蔽站点 ③ 锁定期间的后台请求
function attachRequestGuard(ses) {
  const memo = new Map(); // URL → 判定结果（上限 2000，防内存无界）
  const MEMO_MAX = 2000;

  function cachedCheck(url) {
    if (memo.has(url)) return memo.get(url);
    const r = blockStore.check(url);
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(url, r);
    return r;
  }

  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    // 只处理 http(s)：gnet:// 内置页与 devtools 必须放行，否则锁定时会把自己的锁定页也拦掉
    if (!/^https?:\/\//i.test(String(details.url || ''))) return callback({});

    // 锁定期间不走缓存（解锁后同一 URL 应恢复放行）
    const r = locked ? { blocked: true, reason: 'locked', rule: null } : cachedCheck(details.url);
    if (!r.blocked) return callback({});

    if (details.resourceType === 'mainFrame') {
      const tab = tabs.findByWebContentsId(details.webContentsId);
      if (tab) tabs.showBlocked(tab, details.url, r);
      if (logger) logger.warn(`拦下主框架请求 ${details.url}（${r.reason}）`);
    }
    return callback({ cancel: true });
  });
}

function createWindow() {
  // 注意：窗口创建本身要读配置（标题/kiosk/开发者工具），所以必须先跑 initBase()
  const cfg = config ? config.get() : { windowTitle: '绿网', kiosk: false, allowDevTools: false };
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: cfg.windowTitle,
    backgroundColor: '#f6fbf7',
    autoHideMenuBar: true,
    show: false,
    kiosk: forceKiosk || cfg.kiosk,
    webPreferences: {
      preload: path.join(SRC_DIR, 'preload', 'shell.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
      devTools: cfg.allowDevTools || isDev,
    },
  });

  mainWindow.once('ready-to-show', () => { if (!isSmoke && !isQySmoke) mainWindow.show(); });
  mainWindow.on('closed', () => { mainWindow = null; });

  // 外壳自身不允许导航到任何外网，也不允许弹窗
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!String(url).startsWith('file://')) e.preventDefault();
  });

  mainWindow.loadFile(path.join(SRC_DIR, 'renderer', 'chrome.html'));
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  return mainWindow;
}

// ---- 阶段一：日志 + 配置（不依赖窗口）----
function initBase() {
  logger = createLogger({ file: path.join(DATA_DIR, 'audit.log'), tag: 'green-net' });
  logger.info(`启动 green-net v1.0.0（electron ${process.versions.electron} / chrome ${process.versions.chrome}）`);
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_e) { /* noop */ }
  if (!config) config = createConfig(APP_ROOT);
  return config.ensureMachineId();
}

// ---- 代理注入：必须在 app ready 之前完成（Chromium 启动时才读命令行代理）----
// 解决 Windows 上 Chromium 不读 HTTPS_PROXY / 不认系统代理（ProxyEnable=0）时
// 公网站 ERR_FAILED(-2) 打不开的问题。详见 src/main/proxy.js。
function setupProxy() {
  const p = (config && config.get && config.get().proxy) || null;
  const { rules, bypass, source } = resolveProxy(p);
  if (!rules) {
    try { console.log('[proxy] 未启用代理（source=' + (source || '?') + '），直连模式'); } catch (_e) { /* noop */ }
    return;
  }
  // 自动把非本机的 SIoT / 全域服务器地址加入绕过列表，避免被代理拦截
  let bypassFinal = (bypass && bypass.trim()) ? bypass.trim() : '<local>';
  try {
    const cfg = config.get();
    const extra = [];
    if (cfg.siot && cfg.siot.host && !/^(127\.0\.0\.1|localhost)$/i.test(cfg.siot.host)) extra.push(cfg.siot.host);
    if (cfg.qy && cfg.qy.host && !/^(127\.0\.0\.1|localhost)$/i.test(cfg.qy.host)) extra.push(cfg.qy.host);
    if (extra.length) {
      const set = new Set(bypassFinal.split(/[;\s]+/).filter(Boolean));
      extra.forEach((e) => set.add(e));
      bypassFinal = Array.from(set).join(';');
    }
  } catch (_e) { /* noop */ }
  try {
    app.commandLine.appendSwitch('proxy-server', rules);
    app.commandLine.appendSwitch('proxy-bypass-list', bypassFinal);
    try { console.log('[proxy] 已注入代理 server=' + rules + ' bypass=' + bypassFinal + '（source=' + source + '）'); } catch (_e) { /* noop */ }
  } catch (err) {
    try { console.error('[proxy] 注入失败:', err && err.message); } catch (_e) { /* noop */ }
  }
}

// ---- 阶段二：窗口建好之后装配其余模块 ----
async function initModules(machineId) {
  blockStore = blocklistMod.createStore(path.join(DATA_DIR, 'blocklist.json'), logger);
  const navStore = navMod.createStore(path.join(DATA_DIR, 'nav-config.json'), logger, SEED_NAV);
  auth = createAuth(path.join(DATA_DIR, 'admin.json'), logger);

  // 网页分区（与外壳隔离：内核钩子只影响这一分区）
  const ses = session.fromPartition(PARTITION);
  protocolMod.createProtocolHandler({ pagesDir: PAGES_DIR, logger })(ses);
  attachSessionPolicy(ses, {
    getConfig: () => config.get(),
    logger,
    downloadsDir: app.getPath('downloads'),
    onNotice: (n) => push('gnet:notice', n),
  });

  tabs = createTabs({
    host: mainWindow, // 窗口已在 app.whenReady 里建好，这里只是把它作为视图宿主
    session: ses,
    logger,
    blocklist: blockStore,
    getConfig: () => config.get(),
    pagePreloadPath: path.join(SRC_DIR, 'preload', 'page.js'),
    isLocked: () => locked,
    onState: (st) => push('gnet:tabs', st),
    onBlocked: (info) => push('gnet:blocked', info),
    onExternal: (url) => logger.info(`导航 → ${url}`),
  });

  attachRequestGuard(ses);

  qy = createQyBridge({
    getConfig: () => config.get(),
    logger,
    onEvent: (ev) => {
      trace({
        kind: 'ev', type: ev.type, locked: ev.locked, action: ev.action,
        phase: ev.phase, taskId: ev.task ? ev.task.taskId : null,
      });
      switch (ev.type) {
        case 'policy':
          if (config.get().qy.lockOnPolicy) setLocked(!!ev.locked, `policy:${ev.reason || ev.mode || ''}`);
          else push('gnet:lock', { locked, reason: 'policy(未启用锁定)', policy: ev });
          push('gnet:task', currentTaskPayload());
          break;
        case 'task':
        case 'timer':
          push('gnet:task', currentTaskPayload());
          if (ev.type === 'timer' && ev.action === 'expired') {
            push('gnet:notice', { kind: 'warn', text: '活动时间到！请停下操作，听老师讲评。' });
          }
          break;
        case 'phase':
        case 'reset':
          push('gnet:task', currentTaskPayload());
          break;
        case 'end':
          setLocked(false, 'end');
          if (config.get().qy.closeOnEnd) {
            push('gnet:notice', { kind: 'info', text: '本节课已结束，绿网将在 5 秒后关闭。' });
            setTimeout(() => { try { app.quit(); } catch (_e) { /* noop */ } }, 5000);
          }
          break;
        case 'shutdown':
          push('gnet:notice', { kind: 'warn', text: '课堂即将结束，请及时保存你的作品。' });
          break;
        case 'state':
        case 'connected':
          push('gnet:qy', qy.snapshot());
          break;
        default:
          break;
      }
    },
  });

  createIpc({
    ipcMain, config, blocklist: blockStore, nav: navStore, auth, tabs,
    siot: siotMod, qy, logger,
    getWindow: () => mainWindow,
    getLocked: () => locked,
    setLocked,
    seedNavPath: SEED_NAV,
  });

  // 首屏：默认首页（或教师配置的外网站点）
  const cfg = config.get();
  const homeUrl = /^internal:/i.test(cfg.homeUrl) ? 'gnet://home/' : cfg.homeUrl;
  tabs.createTab(homeUrl, { activate: true });

  // 全域联动：配置开启时启动（连接失败不影响浏览器基本功能，状态见 gnet://qy）
  try { qy.start(); } catch (e) { logger.warn('全域链路启动失败：' + (e && e.message)); }

  logger.info(`机器 ${machineId} 就绪；屏蔽=${blockStore.get().enabled ? blockStore.get().mode : 'off'}；全域=${cfg.qy.enabled ? 'on' : 'off'}`);
}

// ---- 全域联动联调（--smoke-qy）：验证「教师指令 → 桥接状态 → 界面行为」整条链 ----
//
// 与 test/qy-mqtt.integration.js 的分工：
//   那边测协议正确性（话题、字段、座位过滤、心跳）——纯 Node，快、细。
//   这边测**落地**：指令到了之后，浏览器有没有真的锁屏、真的把标签切到锁定页、
//   解锁后有没有回到原来的网页。这类"收到了但没反应"的问题只有真起 Electron 才能发现。
//
// 时序约定：本进程打印 [qy-smoke] ready 之后，外部脚本才开始下发指令。
async function runQySmokeCheck() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = (s) => {
    // eslint-disable-next-line no-console
    console.log('[qy-smoke] ' + s);
  };

  const t0 = Date.now();
  while (!qy.isOnline() && Date.now() - t0 < 15000) await sleep(200);
  const s0 = qy.snapshot();
  out('link=' + s0.state + ' broker=' + s0.brokerUrl + ' clientId=' + s0.clientId);
  if (!qy.isOnline()) {
    // eslint-disable-next-line no-console
    console.error('[qy-smoke] ✗ 全域链路未上线，无法联调（请确认 SIoT 正在 ' + s0.brokerUrl + ' 运行）');
    setTimeout(() => app.exit(1), 200);
    return;
  }

  // 锁屏会覆盖地址栏显示，所以先记下锁之前的地址，解锁后要能回到它
  const urlBeforeLock = tabs.active() ? tabs.active().url : '';
  out('beforeLock=' + urlBeforeLock);
  out('ready');

  // 观察窗口：外部教师端模拟器在此期间按序下发
  //   policy(锁定) → task(带计时) → task_timer(pause) → policy(解锁)
  // 同时采样活动标签地址，捕捉「锁定页是否真的出现过」。
  const seenUrls = new Set();
  const SAMPLES = 40;
  for (let i = 0; i < SAMPLES; i += 1) {
    const act = tabs.active();
    if (act) seenUrls.add(act.url);
    await sleep(250);
  }

  const snap = qy.snapshot();
  const act = tabs.active();
  const seq = qyTrace.map((e) => (e.kind === 'lock'
    ? 'lock:' + (e.locked ? 'on' : 'off')
    : e.type
      + (e.locked === true ? ':lock' : (e.locked === false ? ':unlock' : ''))
      + (e.action ? ':' + e.action : '')));
  const finalState = {
    locked,
    lockReason,
    activeUrl: act ? act.url : null,
    policyLocked: snap.policy.locked,
    policyMode: snap.policy.mode,
    policyReason: snap.policy.reason,
    phase: snap.phase,
    taskTitle: snap.task ? snap.task.title : null,
    taskTimerState: snap.task ? snap.task.timerState : null,
    msgCount: snap.msgCount,
  };
  out('trace=' + JSON.stringify(seq));
  out('seenUrls=' + JSON.stringify([...seenUrls]));
  out('final=' + JSON.stringify(finalState));

  // ---- 断言 ----
  const problems = [];
  const hasTrace = (fn) => qyTrace.some(fn);
  if (!hasTrace((e) => e.kind === 'ev' && e.type === 'policy' && e.locked === true)) {
    problems.push('未收到 policy 锁定指令（下行链路不通？）');
  }
  if (!hasTrace((e) => e.kind === 'lock' && e.locked === true)) {
    problems.push('锁定指令未落地：setLocked(true) 从未被调用（检查 qy.lockOnPolicy 配置与事件接线）');
  }
  if (![...seenUrls].some((u) => /^gnet:\/\/locked\//i.test(u))) {
    problems.push('锁定期间界面未切到锁定页 gnet://locked/（学生仍能继续上网 → 锁定形同虚设）');
  }
  if (!hasTrace((e) => e.kind === 'ev' && e.type === 'task')) {
    problems.push('未收到 task 活动指令（顶部活动条不会显示）');
  }
  if (!hasTrace((e) => e.kind === 'ev' && e.type === 'timer' && e.action === 'pause')) {
    problems.push('未收到 task_timer(pause)（倒计时暂停会失效——注意子动作字段是 payload.timerAction）');
  }
  if (!hasTrace((e) => e.kind === 'lock' && e.locked === false)) {
    problems.push('解锁未落地：setLocked(false) 从未被调用');
  }
  if (locked !== false) problems.push('联调结束时仍处于锁定态');
  if (snap.msgCount < 4) {
    problems.push('下行消息数偏少（msgCount=' + snap.msgCount + '，期望 ≥4）');
  }

  if (problems.length) {
    problems.forEach((p) => {
      // eslint-disable-next-line no-console
      console.error('[qy-smoke] ✗ ' + p);
    });
    process.exitCode = 1;
  } else {
    out('PASS 全链路通过：锁定 → 活动 → 计时暂停 → 解锁，且界面状态确实同步落地');
  }
  setTimeout(() => app.exit(process.exitCode || 0), 400);
}

// ---- 冒烟自检（--smoke）：打印关键状态后退出，供 CI / 本地验证用 ----
async function runSmokeCheck() {
  await new Promise((r) => setTimeout(r, 2500));
  try {
    const st = tabs.state();
    const act = st.tabs.find((t) => t.id === st.activeId) || {};
    // eslint-disable-next-line no-console
    console.log('[smoke] tabs=' + st.tabs.length + ' active=' + act.url);
    // eslint-disable-next-line no-console
    console.log('[smoke] blocklist=' + JSON.stringify({
      enabled: blockStore.get().enabled,
      rules: blockStore.get().rules.length,
      check: blockStore.check('https://www.douyin.com/').blocked,
      allow: blockStore.check('https://mindplus.cc/').reason,
      local: blockStore.check('http://127.0.0.1:8080/').reason,
    }));
    // eslint-disable-next-line no-console
    console.log('[smoke] netinfo primary=' + ((netinfoMod.summarize({}).primary || {}).address || '-'));
    const snap = qy.snapshot();
    // eslint-disable-next-line no-console
    console.log('[smoke] qy state=' + snap.state + ' clientId=' + snap.clientId);

    // ★ 网络可达性快测：让活动 webContents 真去加载 example.com，定位"公网站打不开"。
    //   - ERR_FAILED code=-2：Chromium 没拿到网络出口（缺代理 / 沙箱限制）
    //   - 超时：很可能是课堂锁定把所有 http(s) L3 拦截了
    //   注意：代理已在启动时（setupProxy）按 proxy.mode 注入，这里只观测结果。
    const pCfg = config.get().proxy;
    const pRes = resolveProxy(pCfg);
    // eslint-disable-next-line no-console
    console.log('[smoke] proxy mode=' + pCfg.mode + ' resolved=' + (pRes.rules || '(直连)')
      + ' source=' + pRes.source + (pRes.bypass ? ' bypass=' + pRes.bypass : ''));
    // eslint-disable-next-line no-console
    console.log('[smoke] proxy-cmdline server=' + (app.commandLine.getSwitchValue('proxy-server') || '(无)')
      + ' bypass=' + (app.commandLine.getSwitchValue('proxy-bypass-list') || '(无)'));
    const envProxyRaw = process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy;
    // eslint-disable-next-line no-console
    console.log('[smoke] env-proxy raw=' + JSON.stringify(envProxyRaw)
      + '（smoke 会清理代理类变量；真实运行时通常可见）');

    const probeTab = tabs.active();
    if (probeTab && probeTab.view && probeTab.view.webContents) {
      const wc = probeTab.view.webContents;
      const probeUrl = 'https://example.com/';
      const r = await new Promise((resolve) => {
        let done = false;
        const finish = (info) => { if (done) return; done = true; resolve(info); };
        const timer = setTimeout(() => finish({ ok: false, err: '超时 4s（很可能是 L3 拦截或锁定态挡掉）' }), 4000);
        wc.once('did-finish-load', () => {
          clearTimeout(timer);
          finish({ ok: true, url: wc.getURL(), title: wc.getTitle() });
        });
        wc.once('did-fail-load', (_e, code, desc) => {
          clearTimeout(timer);
          finish({ ok: false, err: 'did-fail-load code=' + code + ' desc=' + desc });
        });
        try { wc.loadURL(probeUrl); } catch (e) {
          clearTimeout(timer);
          finish({ ok: false, err: 'loadURL 抛 ' + e.message });
        }
      });
      // eslint-disable-next-line no-console
      console.log('[smoke] net-probe=' + (r.ok ? '✓ ' + r.url + ' / ' + r.title : '✗ ' + r.err));
      // eslint-disable-next-line no-console
      console.log('[smoke] state locked=' + locked + ' reason=' + lockReason + ' activeUrl=' + (tabs.active() ? tabs.active().url : '-'));
      // 把活动标签拉回首页，避免残留 example.com
      tabs.navigateInternal(null, 'home', {});
    }

    // ★ 端到端断言：去首页 DOM 里数一数导航内容。
    // 这一条同时验证了四件事：gnet 协议能取到静态资源、页面脚本真的执行了、
    // preload 桥可用、IPC 鉴权放行了内置页。任何一环断了这里都会是 0。
    // 选择器对应 home.js 的渲染结果：快捷按钮 .quick-item、分组 .group、站点卡 .site
    const actTab = tabs.active();
    let domInfo = { groups: 0, cards: 0, quick: 0, title: '' };
    if (actTab && actTab.view && actTab.view.webContents) {
      const probe = 'JSON.stringify({'
        + ' groups: document.querySelectorAll("#groups .group").length,'
        + ' cards: document.querySelectorAll("#groups .site").length,'
        + ' quick: document.querySelectorAll("#quick .quick-item").length,'
        + ' title: ((document.querySelector("#title") || {}).textContent || "").trim()'
        + '})';
      try {
        domInfo = await actTab.view.webContents.executeJavaScript(probe, true)
          .then((s) => JSON.parse(s))
          .catch((e) => ({ groups: -1, cards: -1, quick: -1, title: 'exec-failed:' + (e && e.message) }));
      } catch (e) {
        domInfo = { groups: -1, cards: -1, quick: -1, title: 'exec-threw:' + (e && e.message) };
      }
    }
    // eslint-disable-next-line no-console
    console.log('[smoke] home-dom=' + JSON.stringify(domInfo));
    // eslint-disable-next-line no-console
    console.log('[smoke] pageErrors=' + pageErrors.length
      + (pageErrors.length ? ' ' + JSON.stringify(pageErrors.slice(0, 3)) : ''));

    if (pageErrors.length) {
      // eslint-disable-next-line no-console
      console.error('[smoke] 渲染进程存在未捕获错误，页面可能静默失效');
      process.exitCode = 1;
    }
    if (!(domInfo.groups > 0 && domInfo.cards > 0 && domInfo.quick > 0)) {
      // eslint-disable-next-line no-console
      console.error('[smoke] 导航首页未渲染出内容（groups/cards/quick = '
        + domInfo.groups + '/' + domInfo.cards + '/' + domInfo.quick
        + '），页面脚本可能没跑起来或 IPC 未通');
      process.exitCode = 1;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[smoke] 自检异常：' + (e && e.message));
    process.exitCode = 1;
  }
  setTimeout(() => app.exit(process.exitCode || 0), 400);
}

// ---- 渲染进程错误收集（冒烟 + 日常诊断都靠它）----
// 为什么需要：页面脚本加载失败（比如协议层把 .js 回成了 HTML）时，
// 主进程一切"正常"，标签也 loading 完成，只有渲染进程在 console 里报错。
// 这类"静默失效"必须被显式捕获，否则就成了"首页按钮点了没反应"的悬案。
const pageErrors = [];
app.on('web-contents-created', (_e, wc) => {
  try {
    wc.on('console-message', (event) => {
      // Electron 37+ 用事件对象；旧版是 (event, level, message, line, sourceId)
      const level = typeof event === 'object' && event ? event.level : undefined;
      const message = typeof event === 'object' && event ? event.message : undefined;
      const source = typeof event === 'object' && event ? event.sourceId : undefined;
      const isError = level === 'error' || level === 3;
      if (isError && message) pageErrors.push({ message: String(message), source: String(source || '') });
    });
    wc.on('render-process-gone', (_ev, details) => {
      pageErrors.push({ message: 'render-process-gone: ' + (details && details.reason), source: '' });
    });
  } catch (_e2) { /* 事件 API 差异不影响启动 */ }
});

// 全局快捷键（外壳与网页都生效）：
//   键盘焦点通常落在网页（WebContentsView）里，外壳收不到 keydown，所以统一在主进程
//   的 before-input-event 里截获，再以 gnet:shortcut 通知外壳执行。
app.on('web-contents-created', (_e, wc) => {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    const ctrl = input.control || input.meta;
    let name = '';
    if (ctrl && input.shift && key === 'a') name = 'admin';
    else if (ctrl && key === 't') name = 'new-tab';
    else if (ctrl && key === 'w') name = 'close-tab';
    else if (ctrl && key === 'l') name = 'focus-address';
    else if (ctrl && key === 'r') name = 'reload';
    else if (key === 'f5') name = 'reload';
    else if (input.alt && key === 'left') name = 'back';
    else if (input.alt && key === 'right') name = 'forward';
    if (!name) return;
    event.preventDefault();
    push('gnet:shortcut', { name });
  });
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// 启动早期注入代理（Chromium 网络栈在 app ready 时才读命令行代理设置）
setupProxy();

app.whenReady().then(async () => {
  try { Menu.setApplicationMenu(null); } catch (_e) { /* noop */ }

  let machineId = '';
  try {
    machineId = initBase();
  } catch (err) {
    // 配置层就失败 → 后面什么都做不了，必须把原因写清楚
    try {
      // eslint-disable-next-line no-console
      console.error('[boot] 配置初始化失败:', err);
    } catch (_e) { /* noop */ }
    app.exit(1);
    return;
  }

  createWindow(); // 窗口先建（tabs 需要它作为视图宿主），此时配置已就绪

  try {
    await initModules(machineId);
    if (isSmoke) await runSmokeCheck();
    else if (isQySmoke) await runQySmokeCheck();
  } catch (err) {
    // 启动全链路兜底：异常必须可见，不能"无窗口静默失败"
    try {
      // eslint-disable-next-line no-console
      console.error('[boot] 启动失败:', err);
      logger.error('启动失败：' + ((err && err.stack) || err));
      fs.appendFileSync(path.join(DATA_DIR, 'boot-fail.log'),
        new Date().toISOString() + ' ' + ((err && err.stack) || err) + '\n\n');
    } catch (_e) { /* noop */ }
    if (isSmoke || isQySmoke) app.exit(1);
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  try { if (qy) qy.stop(); } catch (_e) { /* noop */ }
  try { if (logger) logger.close(); } catch (_e) { /* noop */ }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { try { if (qy) qy.stop(); } catch (_e) { /* noop */ } });
