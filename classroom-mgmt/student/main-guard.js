'use strict';
// ===== v5.1 全域桌面守卫模块（主进程）=====
// 应用白名单（完整路径）启动 + 禁用进程轮询强杀；桌面配置存独立 desktop-config.json；
// 口令仍存 app-config.shell（哈希，主进程比对）。应用层防护边界同 v5 文档。
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { dialog } = require('electron');
const SHELL_SALT = 'qy-local-shell-v5';

module.exports = function registerGuard(deps) {
  const { app, ipcMain, readConfig, saveConfig } = deps;
  let mainWindow = null;
  let allowMap = {};
  let denyList = [];
  let timer = null;
  let busy = false;
  const isKiosk = !process.argv.includes('--no-kiosk') && !process.argv.includes('--dev');
  const DESKTOP_FILE = path.join(__dirname, 'desktop-config.json');
  const RENDERER = (f) => path.join(app.getAppPath(), 'renderer', f);

  function setWindow(win) { mainWindow = win; }
  function dDefault() {
    return { course: { id: 'c1', name: '信息技术·硬件实践课', homeApps: [], apps: [] },
      guard: { enabled: false, denyExe: ['chrome.exe', 'msedge.exe', 'firefox.exe'] } };
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
    // v5.0 曾把 course/guard 放 app-config.shell → 迁移到 desktop-config.json 并从 shell 移除
    const sc = (readConfig() || {}).shell || {};
    if ((sc.course && (sc.course.apps || []).length) || sc.guard) {
      const d = dRead();
      if (sc.course) d.course = Object.assign(d.course, sc.course);
      if (sc.guard) d.guard = Object.assign(d.guard, sc.guard);
      try { dWrite(d); const next = Object.assign({}, sc); delete next.course; delete next.guard; saveConfig({ shell: next }); } catch (_e) { /* noop */ }
    }
  }
  function appsPayload(desktop) { return (desktop.course.apps || []).map((a) => ({ id: a.id, name: a.name, path: a.path })); }

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
  async function sweep() {
    if (busy || !denyList.length) return;
    busy = true;
    const procs = await procList();
    for (const p of new Set(procs)) { if (denyList.includes(p)) killProc(p); }
    busy = false;
  }
  function start(desktop) {
    allowMap = {};
    for (const a of (desktop && desktop.course && desktop.course.apps) || []) {
      if (a && a.path) allowMap[a.id] = { name: a.name || path.basename(a.path), path: a.path };
    }
    denyList = (desktop && desktop.guard && desktop.guard.enabled ? desktop.guard.denyExe : []).map((x) => String(x).toLowerCase());
    if (timer) clearInterval(timer);
    if (denyList.length) { timer = setInterval(sweep, 3000); sweep(); }
  }
  function stop() { if (timer) clearInterval(timer); timer = null; denyList = []; allowMap = {}; }
  function launch(appId) {
    const a = allowMap[appId];
    if (!a || !a.path) return false;
    spawn(a.path, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
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
  ipcMain.handle('shell:get-state', () => {
    const cfg = readConfig();
    return { machineId: cfg.machineId || '', kiosk: isKiosk, autoStart: !!cfg.autoStart };
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
        homeApps: Array.isArray(patch.course.homeApps) ? patch.course.homeApps.map(String) : [],
        apps };
    }
    if (patch && patch.guard) {
      d.guard = { enabled: !!patch.guard.enabled,
        denyExe: (Array.isArray(patch.guard.denyExe) ? patch.guard.denyExe : []).map((x) => String(x).toLowerCase().slice(0, 40)).filter(Boolean) };
    }
    try { dWrite(d); } catch (_e) { err.push('写入桌面配置失败'); }
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
  ipcMain.handle('desktop:import-config', async () => { // 课程包 json（U 盘/大屏导出）导入
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
      dWrite(d);
      return { ok: true };
    } catch (e) { return { ok: false, err: '导入失败：' + (e.message || e) }; }
  });
  ipcMain.handle('shell:open-desktop', () => { // 上课模式 → 桌面主屏
    stop(); start(dRead());
    if (mainWindow) mainWindow.loadFile(RENDERER('desktop.html'));
    return true;
  });
  ipcMain.handle('shell:open-class', () => { // 桌面 → 课堂登记/任务
    if (mainWindow) mainWindow.loadFile(RENDERER('index.html'));
    return true;
  });
  ipcMain.handle('shell:back', () => { // 课堂 → 回桌面主屏
    stop();
    if (mainWindow) mainWindow.loadFile(RENDERER('desktop.html'));
    return true;
  });
  ipcMain.handle('shell:go-shell', () => { // 桌面 → 模式选择屏
    stop();
    if (mainWindow) mainWindow.loadFile(RENDERER('shell.html'));
    return true;
  });

  migrateLegacy();
  return { setWindow, launch, start, stop, dRead };
};
