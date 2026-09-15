'use strict';
// =============================================================================
// IPC 注册：渲染层与 gnet:// 内置页 ↔ 主进程的唯一通道
//
// ★ 可信边界（本文件最关键的安全设计）★
//   page preload 会被注入到**不可信的网页**里，所以预加载脚本暴露了多少方法并不重要，
//   重要的是**主进程按发送方 URL 逐通道鉴权**（见 trust.js）：
//     - 来自 BrowserWindow（本机 shell.html，file://）  → 完全可信
//     - 来自 gnet://<信任页>/                            → 按页面能力分级
//     - 来自 http(s):// 网页或其他来源                   → 只读 / 一律拒绝
//   http(s) 页面无法把自己伪装成 gnet://（协议处理器 + 导航守卫双重限制），
//   因此这套判定是可靠的。
// =============================================================================
const { clipboard, shell } = require('electron');
const trust = require('./trust');
const { READ_HOSTS, WRITE_HOSTS, senderInfo } = trust;

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
  navReset: 'gnet:nav-config:reset',
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

function createIpc(ctx) {
  const { ipcMain, config, blocklist, nav, auth, tabs, siot, qy, logger } = ctx;
  const getWindow = ctx.getWindow;
  const getLocked = ctx.getLocked;
  const setLocked = ctx.setLocked;
  const notify = (channel, payload) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send(channel, payload); } catch (_e) { /* noop */ }
  };

  // 统一包装：鉴权 → 执行 → 异常兜底（任何 handler 抛错都不会静默失效）
  function handle(channel, level, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
      const info = senderInfo(event);
      const verdict = trust.authorize(level, info);
      if (!verdict.ok) {
        if (logger) logger.warn(`拒绝调用 ${channel}（${level}）← ${info.kind}:${info.url || '未知来源'}`);
        return { ok: false, err: verdict.err };
      }
      try {
        return await fn(...args);
      } catch (e) {
        if (logger) logger.error(`${channel} 处理异常：${(e && e.message) || e}`);
        return { ok: false, err: String((e && e.message) || e) };
      }
    });
  }

  // ---- 运行时信息 ----
  handle(CH.runtime, 'read', () => {
    const cfg = config.get();
    return {
      ok: true,
      machineId: cfg.machineId, seat: cfg.seat, name: cfg.name, studentNo: cfg.studentNo,
      windowTitle: cfg.windowTitle, homeUrl: cfg.homeUrl, maxTabs: cfg.maxTabs,
      allowDownload: cfg.allowDownload, allowDevTools: cfg.allowDevTools,
      blockEnabled: cfg.blockEnabled, blockMode: cfg.blockMode,
      siot: cfg.siot, qy: { enabled: cfg.qy.enabled, host: cfg.qy.host, port: cfg.qy.port, prefix: cfg.qy.projectPrefix },
      locked: getLocked(),
      versions: {
        electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
      },
    };
  });

  // ---- 标签 ----
  handle(CH.tabsList, 'read', () => ({ ok: true, state: tabs.state() }));
  handle(CH.tabsCreate, 'write', (url) => {
    const t = tabs.createTab(url || tabs.internalUrl('home'), { activate: true });
    return t ? { ok: true, id: t.id } : { ok: false, err: '标签数量已达上限' };
  });
  handle(CH.tabsClose, 'write', (id) => ({ ok: tabs.closeTab(String(id || '')) }));
  handle(CH.tabsActivate, 'write', (id) => ({ ok: tabs.activateTab(String(id || '')) }));
  handle(CH.navGo, 'write', (payload) => {
    const p = payload || {};
    if (getLocked()) return { ok: false, err: '课堂锁定中，暂时不能上网' };
    const id = p.tabId || (tabs.active() && tabs.active().id);
    return tabs.navigate(id, p.url);
  });
  handle(CH.navBack, 'read', () => ({ ok: tabs.goBack() }));
  handle(CH.navForward, 'read', () => ({ ok: tabs.goForward() }));
  handle(CH.navReload, 'read', () => ({ ok: tabs.reload() }));
  handle(CH.navStop, 'read', () => ({ ok: tabs.stop() }));
  handle(CH.navInternal, 'read', (action) => {
    // 内置页跳转：白名单动作 → gnet://<host>
    const a = String(action || 'home').toLowerCase();
    const map = { home: 'home', ip: 'ip', siot: 'siot', qy: 'qy', help: 'help', settings: 'admin' };
    const hostName = map[a];
    if (!hostName) return { ok: false, err: '未知的内置页面' };
    return tabs.navigateInternal(null, hostName, {});
  });
  // 内容区布局：只有外壳（受信任的本地页）能改，防止网页把内容区藏起来
  handle(CH.layoutSet, 'write', (rect) => { tabs.setBounds(rect || {}); return { ok: true }; });
  handle(CH.layoutVisible, 'write', (v) => { tabs.setVisible(!!v); return { ok: true }; });

  // ---- 导航首页内容 ----
  handle(CH.navGet, 'read', () => ({ ok: true, config: nav.get() }));
  handle(CH.navSave, 'write', (payload) => {
    const body = payload || {};
    if (body.action === 'reset') return { ok: true, config: nav.reset(ctx.seedNavPath) };
    return { ok: true, config: nav.save(body.config || {}, body.by) };
  });

  // ---- 屏蔽列表 ----
  handle(CH.blockGet, 'read', () => ({ ok: true, config: blocklist.get() }));
  handle(CH.blockSave, 'write', (payload) => ({ ok: true, config: blocklist.save(payload || {}, (payload || {}).by) }));
  // 试算：老师改规则时可以立刻验证某网址会不会被拦
  handle(CH.blockCheck, 'read', (url) => ({ ok: true, result: blocklist.explain(String(url || '')) }));

  // ---- 教师口令 ----
  handle(CH.adminState, 'read', () => ({ ok: true, ...auth.state() }));
  handle(CH.adminSetup, 'write', (pwd) => ({ ...auth.setPassword(String(pwd || ''), '') }));
  handle(CH.adminVerify, 'write', (pwd) => {
    const r = auth.verify(String(pwd || ''));
    if (logger) logger.info(`管理口令校验：${r.ok ? '通过' : '失败'}`);
    return r;
  });
  handle(CH.adminChange, 'write', (payload) => {
    const p = payload || {};
    return auth.setPassword(String(p.newPwd || ''), String(p.oldPwd || ''));
  });

  // ---- 系统设置 ----
  handle(CH.settingsGet, 'read', () => {
    const cfg = config.get();
    return {
      ok: true,
      settings: {
        homeUrl: cfg.homeUrl, kiosk: cfg.kiosk, allowDownload: cfg.allowDownload,
        allowDevTools: cfg.allowDevTools, maxTabs: cfg.maxTabs,
        seat: cfg.seat, name: cfg.name, studentNo: cfg.studentNo,
        siot: cfg.siot, qy: cfg.qy, proxy: cfg.proxy, secretConfigured: cfg.secret !== config.PLACEHOLDER,
      },
    };
  });
  handle(CH.settingsSave, 'write', (patch) => {
    const p = patch || {};
    // 首页地址若填了外网 URL，同步写回 homeUrl（教师可把首页换成校内站点）
    if (p.homeUrl !== undefined) {
      const n = require('./util').normalizeUrl(p.homeUrl);
      if (!n.ok) return { ok: false, err: '首页地址无效：' + n.err };
      p.homeUrl = n.url;
    }
    const cfg = config.patch(p);
    if (p.qy) { try { qy.restart(); } catch (_e) { /* noop */ } }
    return { ok: true, settings: { seat: cfg.seat, siot: cfg.siot, qy: cfg.qy, homeUrl: cfg.homeUrl } };
  });

  // ---- 本机 IP ----
  handle(CH.netInfo, 'read', () => {
    const cfg = config.get();
    return { ok: true, info: require('./netinfo').summarize({ siot: cfg.siot, qy: cfg.qy }) };
  });
  handle(CH.netCopy, 'read', (text) => {
    try { clipboard.writeText(String(text == null ? '' : text).slice(0, 4000)); return { ok: true }; } catch (e) { return { ok: false, err: String(e.message || e) }; }
  });

  // ---- SIoT ----
  handle(CH.siotProbe, 'read', async () => ({ ok: true, result: await siot.probe(config.get().siot, 1500) }));
  handle(CH.siotOpen, 'write', (opts) => {
    const cfg = config.get();
    const force = !!(opts && opts.force);
    const host = cfg.siot.host === '0.0.0.0' ? '127.0.0.1' : cfg.siot.host;
    const url = `http://${host}:${cfg.siot.httpPort}`;
    if (force) {
      tabs.createTab(url, { activate: true });
      return { ok: true, opened: true, url };
    }
    return { ok: true, opened: false, url };
  });

  // ---- 全域联动 ----
  handle(CH.qyGet, 'read', () => ({ ok: true, qy: qy.snapshot(), lock: getLocked() }));
  handle(CH.qyRestart, 'write', () => { qy.restart(); return { ok: true }; });

  // ---- 锁定 ----
  handle(CH.lockGet, 'read', () => ({ ok: true, locked: getLocked() }));
  handle(CH.lockSet, 'write', (v) => {
    setLocked(!!v, 'manual');
    return { ok: true, locked: !!v };
  });

  // ---- 日志 ----
  handle(CH.log, 'read', (line) => {
    if (logger) logger.info('[renderer] ' + String(line == null ? '' : line).slice(0, 400));
    return true;
  });

  // 打开外部链接（mailto 等）
  handle('gnet:shell:open-external', 'read', (url) => {
    try { if (/^https?:\/\//i.test(String(url))) return { ok: false, err: '网页请直接在浏览器内打开' }; shell.openExternal(String(url)); return { ok: true }; } catch (e) { return { ok: false, err: String(e.message || e) }; }
  });

  return { CH };
}

module.exports = { createIpc, CH, READ_HOSTS, WRITE_HOSTS, senderInfo };
