'use strict';
// ===== v5.2 全域桌面守卫（主进程）：白名单启动 + 禁用强杀 + 非课堂窗口自动最小化 + 应用运行态注册表 =====
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { dialog } = require('electron');
const createWinGuard = require('./guard-win');
const createAppRegistry = require('./guard-apps');
const SHELL_SALT = 'qy-local-shell-v5';

module.exports = function registerGuard(deps) {
  const { app, ipcMain, readConfig, saveConfig } = deps;
  let mainWindow = null;
  let allowMap = {};
  let denyList = [];
  let minimizeOthers = true;
  let timer = null;
  let busy = false;
  let lastLaunchAt = 0; const LAUNCH_GRACE_MS = 8000; // 启动宽限：新应用进 allow 前不最小化（见 tick）
  const isKiosk = !process.argv.includes('--no-kiosk') && !process.argv.includes('--dev');
  const DESKTOP_FILE = path.join(__dirname, 'desktop-config.json');
  const GUARD_PS = path.join(__dirname, 'guard-window.ps1');
  const RENDERER = (f) => path.join(app.getAppPath(), 'renderer', f);

  function log(m) { try { console.log('[guard] ' + m); } catch (_e) { /* noop */ } }
  const registry = createAppRegistry({ onRunningChange: () => pushApps(), log });
  const winGuard = createWinGuard({ scriptPath: GUARD_PS, onReport, log });

  function setWindow(win) { mainWindow = win; }
  function dDefault() {
    return { course: { id: 'c1', name: '信息技术·硬件实践课', homeApps: [], apps: [] },
      guard: { enabled: false, denyExe: ['chrome.exe', 'msedge.exe', 'firefox.exe'], minimizeOthers: true } };
  }
  // ---- 桌面配置（独立 json，主进程唯一读写）----
  function dRead() {
    const d = dDefault();
    try { const cur = JSON.parse(fs.readFileSync(DESKTOP_FILE, 'utf8')) || {};
      return { course: Object.assign(d.course, cur.course || {}), guard: Object.assign(d.guard, cur.guard || {}) };
    } catch (_e) { return d; }
  }
  function dWrite(desktop) {
    fs.mkdirSync(path.dirname(DESKTOP_FILE), { recursive: true });
    fs.writeFileSync(DESKTOP_FILE, JSON.stringify(desktop, null, 2), 'utf8');
  }
  function migrateLegacy() {
    const sc = (readConfig() || {}).shell || {};
    if ((sc.course && (sc.course.apps || []).length) || sc.guard) {
      const d = dRead();
      if (sc.course) d.course = Object.assign(d.course, sc.course);
      if (sc.guard) d.guard = Object.assign(d.guard, sc.guard);
      try { dWrite(d); const next = Object.assign({}, sc); delete next.course; delete next.guard; saveConfig({ shell: next }); } catch (_e) { /* noop */ }
    }
  }
  function procList() {
    return new Promise((resolve) => {
      execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, out) => {
        if (err) { resolve([]); return; }
        const names = []; const re = /"([^"]+\.exe)"/gi; let m = null;
        while ((m = re.exec(out))) { if (m[1]) names.push(m[1].toLowerCase()); }
        resolve(names);
      });
    });
  }
  function killProc(name) {
    execFile('taskkill', ['/F', '/IM', name], { windowsHide: true }, () => { /* best-effort */ });
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('guard:kill', name); } catch (_e) { /* noop */ }
  }
  async function tick() { // 每轮：运行态推导 + 强杀禁用 + 最小化非课堂窗口
    if (busy) return;
    busy = true;
    try {
      const names = await procList();
      registry.observe(names);
      if (denyList.length) for (const p of new Set(names)) if (denyList.includes(p)) killProc(p);
      // 启动宽限：刚点开的应用还没被 bindLaunch 记进 allow（.lnk 异步解析/启动器要几秒），
      // 此时 sweep 会把它最小化，现场就是「点磁贴窗口一闪就没」。宽限期内只观察、不最小化。
      if (minimizeOthers && Date.now() - lastLaunchAt > LAUNCH_GRACE_MS) {
        const allow = registry.allowExeList();
        allow.push(path.basename(process.execPath).toLowerCase()); // 自己（kiosk）必须进 allow，否则被自己最小化
        winGuard.sweep(allow, false);
      }
    } catch (_e) { /* noop */ }
    busy = false;
  }
  function start(desktop) {
    allowMap = {};
    for (const a of (desktop && desktop.course && desktop.course.apps) || []) {
      if (a && a.path) allowMap[a.id] = { name: a.name || path.basename(a.path), path: a.path };
    }
    denyList = (desktop && desktop.guard && desktop.guard.enabled ? desktop.guard.denyExe : []).map((x) => String(x).toLowerCase());
    minimizeOthers = desktop && desktop.guard && desktop.guard.minimizeOthers !== false;
    registry.setApps((desktop && desktop.course && desktop.course.apps) || []);
    if (timer) clearInterval(timer); timer = null;
    const hasApps = Object.keys(allowMap).length > 0;
    // 有课堂应用（推运行态/最小化）或启用强杀才轮询；否则不轮询省资源
    if (hasApps || denyList.length) {
      // 只要开了「非课堂窗口自动最小化」就必须起助手进程 —— 曾经只在 hasApps 时起，
      // 导致「班级还没配课程应用但开了最小化」时 sweep 静默发不出去（助手没起来）。
      if (minimizeOthers) winGuard.start();
      timer = setInterval(tick, 3000); tick();
    }
  }
  function stop() {
    if (timer) clearInterval(timer); timer = null;
    denyList = []; allowMap = {}; minimizeOthers = true;
    registry.setApps([]);
    try { winGuard.stop(); } catch (_e) { /* noop */ }
  }
  function shellStart(p) { // cmd start 可解析 .lnk / UWP / 注册表关联
    try { spawn('cmd', ['/c', 'start', '""', '"' + p + '"'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (_e) { /* noop */ }
  }
  function searchStart(name) { // 第 3 级兜底：模拟人手在开始菜单搜索启动（Ctrl+Esc → 输入 → 回车）
    try {
      const base = String(name || '').replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '') || '应用';
      const safe = base.replace(/[{}()\[\]+^%~]/g, (m) => '{' + m + '}');
      const ps = "$w=New-Object -ComObject WScript.Shell;Start-Sleep -Milliseconds 250;"
        + "$w.SendKeys('^{ESC}');Start-Sleep -Milliseconds 900;"
        + "$w.SendKeys('" + safe + "');Start-Sleep -Milliseconds 700;$w.SendKeys('{ENTER}');";
      execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps],
        { windowsHide: true, timeout: 12000 }, () => { /* best-effort */ });
    } catch (_e) { /* noop */ }
  }
  let elevatedCache = null; // 进程是否已提权（学生端以管理员身份运行时子进程自动继承）
  function detectElevated() {
    return new Promise((resolve) => {
      if (elevatedCache != null) { resolve(elevatedCache); return; }
      execFile('net', ['session'], { windowsHide: true }, (err) => { elevatedCache = !err; resolve(elevatedCache); });
    });
  }
  function runAsAdmin(p) { // 应用需管理员权限 → 提权启动（学生端已提权时不弹 UAC）
    try {
      const cmd = 'Start-Process -FilePath \'' + String(p).replace(/'/g, "''") + '\' -Verb RunAs';
      execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', cmd],
        { windowsHide: true }, () => { /* best-effort */ });
    } catch (_e) { /* noop */ }
  }
  function launch(appId) {
    const a = allowMap[appId];
    // 以前静默 return false：渲染层拿不到原因，「点了磁贴毫无反应」且无从排查 —— 现回传结构化结果。
    if (!a) return { ok: false, err: '应用未注册（保存设置后即可打开）' };
    if (!a.path) return { ok: false, err: '应用路径缺失' };
    lastLaunchAt = Date.now();
    procList().then((names) => { try { registry.bindLaunch(appId, names); } catch (_e) {} }).catch(() => {});
    if (/\.lnk$/i.test(a.path)) { shellStart(a.path); return { ok: true }; } // 快捷方式必须走 shell
    const child = spawn(a.path, [], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {
      detectElevated().then((elev) => {
        if (!elev) runAsAdmin(a.path);
        shellStart(a.path);
        setTimeout(() => searchStart(a.path), 2200);
      });
    });
    child.unref();
    return { ok: true };
  }

  // ---- 运行态上报（PowerShell 助手每行 JSON 回传）----
  let lastReport = null, lastMinReport = 0, lastAppsPush = 0;
  function onReport(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.error) { log('ps: ' + obj.error); return; }
    lastReport = obj;
    // minimized 数变化才通知（避免刷屏）；归零时复位以便下次变化再提醒
    if (obj.minimized > 0 && obj.minimized !== lastMinReport) {
      lastMinReport = obj.minimized;
      const exes = (obj.candidates || []).map((c) => c.exe).filter(Boolean);
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('guard:minimize', { exes }); } catch (_e) {}
    } else if (obj.minimized === 0) lastMinReport = 0;
    pushApps();
  }
  function pushApps() { // 节流 guard:apps ≤ 1 次/秒
    const now = Date.now();
    if (now - lastAppsPush < 1000) return;
    lastAppsPush = now;
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('guard:apps', appsState()); } catch (_e) {}
  }
  function appsState() {
    return { ok: true, guardEnabled: denyList.length > 0, minimizeOthers,
      apps: registry.state(), minimized: lastReport && typeof lastReport.minimized === 'number' ? lastReport.minimized : 0 };
  }

  // ---- 口令（app-config.shell，同 v5.0）----
  function cfgDefault() { return { admin: { enabled: false, hash: '' }, modeExit: { enabled: false, hash: '' } }; }
  function cfgRead() {
    const sc = (readConfig() || {}).shell || {}; const d = cfgDefault();
    return { admin: Object.assign(d.admin, sc.admin || {}), modeExit: Object.assign(d.modeExit, sc.modeExit || {}) };
  }
  function hashOf(scope, pwd) { return crypto.createHash('sha256').update(SHELL_SALT + ':' + scope + ':' + pwd).digest('hex'); }
  function cfgPublic(sc) { return { admin: { enabled: !!sc.admin.enabled }, modeExit: { enabled: !!sc.modeExit.enabled } }; }

  // ---- IPC ----
  ipcMain.handle('guard:start', () => { start(dRead()); return true; });
  ipcMain.handle('guard:stop', () => { stop(); return true; });
  ipcMain.handle('guard:launch', (_e, appId) => launch(String(appId || '')));
  ipcMain.handle('guard:apps-state', () => appsState());
  ipcMain.handle('guard:app-focus', (_e, appId) => {
    const id = String(appId || '');
    const st = registry.state().find((a) => a.id === id);
    if (!st) return { ok: false, err: '应用不存在' };
    if (st.running) {
      const ex = registry.exeOf(id);
      if (!ex) return { ok: false, err: '进程未知' };
      winGuard.focus(ex); // 前台锁可能拦，返回 focused:0 属正常，渲染层容错
      return { ok: true, focused: true };
    }
    const r = launch(id); // launch 内部已 bindLaunch
    return { ok: !!(r && r.ok), launched: !!(r && r.ok), err: (r && r.err) || '' };
  });
  ipcMain.handle('shell:get-state', async () => {
    const cfg = readConfig();
    return { machineId: cfg.machineId || '', kiosk: isKiosk, autoStart: !!cfg.autoStart, elevated: await detectElevated() };
  });
  ipcMain.handle('shell:set-autostart', (_e, on) => {
    try { saveConfig({ autoStart: !!on }); app.setLoginItemSettings({ openAtLogin: !!on }); } catch (_err) { /* noop */ }
    return true;
  });
  ipcMain.handle('shell:get-config', () => cfgPublic(cfgRead()));
  ipcMain.handle('shell:verify-local', (_e, scope, pwd) => {
    const key = scope === 'admin' ? 'admin' : 'modeExit';
    const slot = (cfgRead() || {})[key] || {};
    if (!slot.enabled || !slot.hash) return { ok: true };
    return { ok: hashOf(key, String(pwd || '')) === slot.hash };
  });
  ipcMain.handle('shell:set-config', (_e, patch) => {
    const sc = cfgRead(); const err = [];
    const pw = patch && patch.pwd ? String(patch.pwd) : '';
    if (patch && patch.scope && ['admin', 'mode-exit'].includes(patch.scope)) {
      const key = patch.scope === 'admin' ? 'admin' : 'modeExit';
      const slot = sc[key];
      const other = key === 'admin' ? sc.modeExit : sc.admin;
      if (patch.enabled != null) slot.enabled = !!patch.enabled;
      if (pw) {
        if (pw.length < 4 || pw.length > 32) { err.push('口令须 4-32 位'); }
        else if (other.hash && other.hash === hashOf(other === sc.admin ? 'admin' : 'modeExit', pw)) { err.push('管理员口令与自由创作口令不可相同'); }
        else { slot.hash = hashOf(key, pw); slot.enabled = true; }
      } else if (slot.enabled && !slot.hash) {
        err.push(patch.scope === 'admin' ? '启用管理员口令需先输入新口令' : '启用自由创作口令需先输入新口令');
      }
    }
    if (!err.length) { try { saveConfig({ shell: sc }); } catch (_e) { err.push('写入配置失败'); } }
    return { ok: !err.length, err: err.join('；') };
  });
  // ---- v5.1 桌面（desktop-config.json + 文件选择 + 页面切换）----
  ipcMain.handle('desktop:get', () => dRead());
  ipcMain.handle('desktop:set', (_e, patch) => {
    const d = dRead(); const err = [];
    if (patch && patch.course) {
      const apps = (Array.isArray(patch.course.apps) ? patch.course.apps : [])
        .map((a, i) => ({ id: 'a' + (i + 1), name: String(a.name || path.basename(a.path || '')).slice(0, 24),
          path: String(a.path || '').slice(0, 260) })).filter((a) => a.path);
      d.course = { id: 'c1', name: String(patch.course.name || '信息技术·硬件实践课').slice(0, 30),
        homeApps: Array.isArray(patch.course.homeApps) ? patch.course.homeApps.map(String) : [], apps };
    }
    if (patch && patch.guard) {
      d.guard = { enabled: !!patch.guard.enabled,
        denyExe: (Array.isArray(patch.guard.denyExe) ? patch.guard.denyExe : []).map((x) => String(x).toLowerCase().slice(0, 40)).filter(Boolean),
        minimizeOthers: patch.guard.minimizeOthers !== false }; // 缺省视为 true
    }
    // 必须重装备守卫：allowMap/registry 是启动时的快照，不刷新则刚添加的应用点不开
    // （launch 里 allowMap[appId] 为 undefined），悬浮坞进程状态也停在旧列表。
    try { dWrite(d); start(dRead()); } catch (_e) { err.push('写入桌面配置失败'); }
    return { ok: !err.length, err: err.join('；') };
  });
  ipcMain.handle('desktop:pick-app', async () => {
    if (!mainWindow) return { canceled: true };
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择课程应用', properties: ['openFile'],
      filters: [{ name: '应用程序', extensions: ['exe', 'lnk'] }, { name: '所有文件', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { canceled: true };
    return { canceled: false, path: r.filePaths[0] };
  });
  ipcMain.handle('desktop:import-config', async () => {
    if (!mainWindow) return { ok: false, err: '窗口未就绪' };
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '导入课程桌面包(.json)', properties: ['openFile'],
      filters: [{ name: '课程桌面包', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    try {
      const obj = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      if (!obj || !obj.course) return { ok: false, err: '文件不是有效课程桌面包' };
      const d = dRead();
      if (obj.course) d.course = Object.assign(d.course, obj.course);
      if (obj.guard) d.guard = Object.assign(d.guard, obj.guard);
      dWrite(d); start(dRead()); // 同 desktop:set：导入后必须重装备守卫，否则新应用点不开
      return { ok: true };
    } catch (e) { return { ok: false, err: '导入失败：' + (e.message || e) }; }
  });
  ipcMain.handle('shell:open-desktop', () => { stop(); start(dRead()); if (mainWindow) mainWindow.loadFile(RENDERER('desktop.html')); return true; });
  ipcMain.handle('shell:open-class', () => { if (mainWindow) mainWindow.loadFile(RENDERER('index.html')); return true; });
  ipcMain.handle('shell:back', () => { stop(); if (mainWindow) mainWindow.loadFile(RENDERER('desktop.html')); return true; });
  ipcMain.handle('shell:go-shell', () => { stop(); if (mainWindow) mainWindow.loadFile(RENDERER('shell.html')); return true; });
  try { app.on('before-quit', () => { try { winGuard.stop(); } catch (_e) {} }); } catch (_e) {} // 退出前停助手，否则主进程挂住

  migrateLegacy();
  return { setWindow, launch, start, stop, dRead, winGuard, registry };
};
