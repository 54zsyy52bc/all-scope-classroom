'use strict';
// ===== v5 全域桌面守卫模块（主进程）：应用白名单启动 + 黑名单进程轮询强杀 =====
// 应用层防护边界：课堂模式启用 kiosk 全屏 + 仅白名单磁贴可开应用 + 禁用进程(浏览器等)
// 每 3s 轮询 tasklist，命中 denyExe 即 taskkill 并通知渲染层；能防住课堂常见绕过。
const { execFile, spawn } = require('node:child_process');

module.exports = function registerGuard(deps) {
  const { app, ipcMain, readConfig, saveConfig } = deps;
  let mainWindow = null;
  let allowMap = {};      // appId -> exe 名（白名单，主进程权威解析，不信任渲染层路径）
  let denyList = [];
  let timer = null;
  let busy = false;
  const isKiosk = !process.argv.includes('--no-kiosk') && !process.argv.includes('--dev');

  function setWindow(win) { mainWindow = win; }

  function procList() {
    return new Promise((resolve) => {
      execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, out) => {
        if (err) { resolve([]); return; }
        const names = [];
        const re = /"([^"]+\.exe)"/gi;
        let m = null;
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
    for (const p of new Set(procs)) {
      if (denyList.includes(p)) killProc(p);
    }
    busy = false;
  }
  function start(cfg) {
    allowMap = {};
    for (const a of (cfg && cfg.apps) || []) if (a && a.exe) allowMap[a.id] = { label: a.label || a.exe, exe: String(a.exe).toLowerCase() };
    denyList = ((cfg && cfg.denyExe) || []).map((x) => String(x).toLowerCase());
    if (timer) clearInterval(timer);
    if (denyList.length) { timer = setInterval(sweep, 3000); sweep(); }
  }
  function stop() { if (timer) clearInterval(timer); timer = null; denyList = []; allowMap = {}; }
  function launch(appId) {
    const a = allowMap[appId];
    if (!a || !a.exe) return false;
    spawn(a.exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  }

  // ---- IPC（renderer ↔ guard）----
  ipcMain.handle('guard:start', (_e, cfg) => { start(cfg || {}); return true; });
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
  ipcMain.handle('shell:back', () => { // 课堂 → 回全域首屏（renderer 先验 admin 口令）
    stop();
    if (mainWindow) mainWindow.loadFile(require('node:path').join(app.getAppPath(), 'renderer', 'shell.html'));
    return true;
  });

  return { setWindow, launch, start, stop };
};
