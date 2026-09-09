'use strict';
// ===== v5 全域桌面守卫模块（主进程）：应用白名单启动 + 黑名单进程轮询强杀 =====
// 应用层防护边界：课堂模式启用 kiosk 全屏 + 仅白名单磁贴可开应用 + 禁用进程(浏览器等)
// 每 3s 轮询 tasklist，命中 denyExe 即 taskkill 并通知渲染层；能防住课堂常见绕过。
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const SHELL_SALT = 'qy-local-shell-v5'; // 本地口令哈希盐

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

  // ---- 本地配置管理（口令哈希只经主进程；renderer 不可信） ----
  function cfgDefault() { return { admin: { enabled: false, hash: '' }, modeExit: { enabled: false, hash: '' },
    course: { name: '信息技术·硬件实践课', apps: [] }, guard: { enabled: false, denyExe: ['chrome.exe', 'msedge.exe', 'firefox.exe'] } }; }
  function cfgRead() {
    const cur = readConfig() || {}; const sc = cur.shell || {}; const d = cfgDefault();
    return { admin: Object.assign(d.admin, sc.admin || {}), modeExit: Object.assign(d.modeExit, sc.modeExit || {}),
      course: Object.assign(d.course, sc.course || {}), guard: Object.assign(d.guard, sc.guard || {}) };
  }
  function hashOf(scope, pwd) { return crypto.createHash('sha256').update(SHELL_SALT + ':' + scope + ':' + pwd).digest('hex'); }
  function cfgPublic(sc) { return { admin: { enabled: !!sc.admin.enabled }, modeExit: { enabled: !!sc.modeExit.enabled }, course: sc.course, guard: sc.guard }; }
  function guardPayload(sc) {
    const deny = sc.guard.enabled ? (sc.guard.denyExe || []) : [];
    return { apps: (sc.course.apps || []).map((a) => ({ id: a.id, label: a.label, exe: String(a.exe).toLowerCase() })), denyExe: deny };
  }
  function autoStartGuard(sc) { start(guardPayload(sc)); }

  function launch(appId) {
    const a = allowMap[appId];
    if (!a || !a.exe) return false;
    spawn(a.exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  }

  // ---- IPC（renderer ↔ guard）----
  ipcMain.handle('guard:start', (_e, cfg) => { start(cfg || guardPayload(cfgRead())); return true; });
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
    const key = scope === 'admin' ? 'admin' : 'modeExit'; // 外部 scope: admin | mode-exit
    const slot = (cfgRead() || {})[key] || {};
    if (!slot.enabled || !slot.hash) return { ok: true };
    return { ok: hashOf(key, String(pwd || '')) === slot.hash };
  });
  ipcMain.handle('shell:set-config', (_e, patch) => {
    const sc = cfgRead(); const err = [];
    const pw = patch && patch.pwd ? String(patch.pwd) : '';
    if (patch && patch.scope && ['admin', 'mode-exit'].includes(patch.scope)) {
      const key = patch.scope === 'admin' ? 'admin' : 'modeExit'; // 外部 scope 映射内部键
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
    if (patch && patch.course) {
      sc.course = { name: String(patch.course.name || '信息技术·硬件实践课').slice(0, 30),
        apps: (Array.isArray(patch.course.apps) ? patch.course.apps : []).map((a, i) => ({
          id: 'a' + (i + 1), label: String(a.label || a.exe || '应用').slice(0, 20),
          exe: String(a.exe || '').toLowerCase().slice(0, 40) })).filter((a) => a.exe) };
    }
    if (patch && patch.guard) {
      sc.guard = { enabled: !!patch.guard.enabled,
        denyExe: (Array.isArray(patch.guard.denyExe) ? patch.guard.denyExe : []).map((x) => String(x).toLowerCase().slice(0, 40)).filter(Boolean) };
    }
    if (!err.length) { try { saveConfig({ shell: sc }); } catch (_e) { err.push('写入配置失败'); } }
    return { ok: !err.length, err: err.join('；') };
  });
  ipcMain.handle('shell:back', () => { // 课堂 → 回全域首屏（renderer 先验 admin 口令）
    stop();
    if (mainWindow) mainWindow.loadFile(require('node:path').join(app.getAppPath(), 'renderer', 'shell.html'));
    return true;
  });

  return { setWindow, launch, start, stop, autoStartGuard, cfgRead, guardPayload };
};
