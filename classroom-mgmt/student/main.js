'use strict';
// 学生机 Electron 主进程：窗口生命周期+单实例锁；app-config/machineId；
// 关机指令 HMAC 校验与实际执行（HMAC secret 只存在于主进程，渲染层不可信）。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');

const APP_ROOT = __dirname;
const CONFIG_PATH = path.join(APP_ROOT, 'app-config.json');

const HMAC_WINDOW_MS = 60000; // 与教师端 config.HMAC_WINDOW_MS 一致
const PLACEHOLDER_SECRET = 'change-me-before-deploy';
const MIN_SHUTDOWN_DELAY = 0;
const MAX_SHUTDOWN_DELAY = 600;

const DEFAULTS = {
  siotIp: '127.0.0.1',
  siotWsPort: 1888,
  username: 'siot',
  password: 'dfrobot',
  secret: PLACEHOLDER_SECRET,
  machineId: '',
  seat: '',
  name: '',
  studentNo: '',
  shutdownDelaySec: 60,
  dryRun: true,
};

// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------
function readConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_e) {
    file = {};
  }
  if (!file || typeof file !== 'object') file = {};
  return Object.assign({}, DEFAULTS, file);
}

function writeConfig(patch) {
  const next = Object.assign(readConfig(), patch || {});
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
  return next;
}

// ---------------------------------------------------------------------------
// machineId：克隆镜像环境下也要尽量唯一（seat 冲突检测依赖它）
// 取「主机名 + 首选物理网卡 MAC」做 sha256 前 8 位，碰撞概率可忽略。
// ---------------------------------------------------------------------------
function pickMac() {
  const ifaces = os.networkInterfaces();
  const names = Object.keys(ifaces).sort();
  for (const n of names) {
    for (const it of ifaces[n] || []) {
      if (it.internal) continue;
      if (!it.mac || it.mac === '00:00:00:00:00:00') continue;
      return it.mac;
    }
  }
  return '';
}

function deriveMachineId() {
  const raw = [os.hostname(), pickMac(), os.cpus()[0] && os.cpus()[0].model, os.arch()]
    .filter(Boolean).join('|');
  return 'M-' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
}

function ensureMachineId() {
  const cfg = readConfig();
  if (cfg.machineId && /^M-[0-9a-f]{8}$/i.test(String(cfg.machineId))) {
    return cfg.machineId;
  }
  const id = cfg.machineId && String(cfg.machineId).trim() ? String(cfg.machineId).trim() : deriveMachineId();
  writeConfig({ machineId: id });
  return id;
}

// ---------------------------------------------------------------------------
// 关机：三重校验中的后两重（签名 + 时间窗）在主进程；dry-run 兜底防误伤。
// ---------------------------------------------------------------------------
function hmac(secret, sessionId, ts) {
  return crypto.createHmac('sha256', secret).update(`${sessionId}:${ts}`).digest('hex');
}

function verifyShutdownToken(ticket) {
  const t = ticket || {};
  const cfg = readConfig();
  const sessionId = String(t.sessionId == null ? '' : t.sessionId);
  const token = String(t.token == null ? '' : t.token);
  const ts = Number(t.ts);
  if (!sessionId || !token || !Number.isFinite(ts)) {
    return { verified: false, reason: '票据字段不完整（sessionId / ts / token 缺一不可）' };
  }
  if (cfg.secret === PLACEHOLDER_SECRET) {
    return { verified: false, reason: '本机 HMAC secret 仍是占位默认值，拒绝执行关机' };
  }
  const expected = hmac(cfg.secret, sessionId, ts);
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { verified: false, reason: 'HMAC 签名不匹配' };
  }
  if (Math.abs(Date.now() - ts) > HMAC_WINDOW_MS) {
    return { verified: false, reason: '票据超出 60 秒时间窗' };
  }
  return { verified: true, reason: '', sessionId, ts };
}

function isDryRun(cfg) {
  // secret 仍是占位值 = 未授权部署，强制 dry-run（交付前必须改 secret 并置 dryRun=false）
  return cfg.dryRun === true || cfg.secret === PLACEHOLDER_SECRET;
}

function executeShutdown(opts) {
  const cfg = readConfig();
  const o = opts || {};
  const requested = Number(o.delaySec != null ? o.delaySec : cfg.shutdownDelaySec);
  const delay = Math.min(MAX_SHUTDOWN_DELAY, Math.max(MIN_SHUTDOWN_DELAY,
    Number.isFinite(requested) ? Math.round(requested) : 60));
  const comment = `课堂结束，计算机将在 ${delay} 秒后关机。请及时保存作品。`;

  if (isDryRun(cfg)) {
    // eslint-disable-next-line no-console
    console.log(`[shutdown][dry-run] shutdown /s /t ${delay} /c "${comment}"`);
    return Promise.resolve({ executed: false, dryRun: true, delaySec: delay, comment });
  }

  return new Promise((resolve) => {
    execFile('shutdown', ['/s', '/t', String(delay), '/c', comment],
      { windowsHide: true, timeout: 5000 },
      (err, stdout, stderr) => {
        if (err) {
          // eslint-disable-next-line no-console
          console.error('[shutdown] 执行失败:', err.message, String(stderr || '').trim());
          resolve({ executed: false, dryRun: false, error: err.message, delaySec: delay });
          return;
        }
        // eslint-disable-next-line no-console
        console.log(`[shutdown] 已下发：${delay} 秒后关机`);
        resolve({ executed: true, dryRun: false, delaySec: delay, comment });
      });
  });
}

// ---------------------------------------------------------------------------
// 输入净化（渲染层任何输入都不可信）
// ---------------------------------------------------------------------------
function normSeat(v) {
  const m = String(v == null ? '' : v).trim().match(/^\d{1,2}$/);
  if (!m) return '';
  const n = parseInt(m[0], 10);
  if (n < 1 || n > 99) return '';
  return String(n).padStart(2, '0');
}

function normText(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// IPC：白名单通道，参数在主进程侧二次净化
// ---------------------------------------------------------------------------
function registerIpc(getMachineId) {
  ipcMain.handle('app:getRuntime', () => {
    const cfg = readConfig();
    return {
      machineId: getMachineId(),
      siotIp: cfg.siotIp,
      siotWsPort: Number(cfg.siotWsPort) || 1888,
      username: cfg.username,
      password: cfg.password,
      seat: normSeat(cfg.seat),
      name: normText(cfg.name, 20),
      studentNo: normText(cfg.studentNo, 24),
      shutdownDelaySec: Number(cfg.shutdownDelaySec) || 60,
      dryRun: isDryRun(cfg),
      secretConfigured: cfg.secret !== PLACEHOLDER_SECRET,
    };
  });

  ipcMain.handle('app:saveProfile', (_e, profile) => {
    const p = profile || {};
    const patch = {};
    const seat = normSeat(p.seat);
    if (seat) patch.seat = seat;
    if (p.name !== undefined) patch.name = normText(p.name, 20);
    if (p.studentNo !== undefined) patch.studentNo = normText(p.studentNo, 24);
    const cfg = writeConfig(patch);
    return { seat: normSeat(cfg.seat), name: cfg.name, studentNo: cfg.studentNo };
  });

  ipcMain.handle('shutdown:verify', (_e, ticket) => verifyShutdownToken(ticket));
  ipcMain.handle('shutdown:execute', (_e, opts) => executeShutdown(opts));
  // 撤销关机：教师端"撤销关机"指令 → shutdown /a 中止倒计时（学生归还后仍需继续使用）
  ipcMain.handle('shutdown:cancel', async () => {
    const cfg = readConfig();
    if (isDryRun(cfg)) {
      // eslint-disable-next-line no-console
      console.log('[shutdown][dry-run] shutdown /a（撤销关机，演练不执行）');
      return { canceled: false, dryRun: true };
    }
    return new Promise((resolve) => {
      execFile('shutdown', ['/a'], { windowsHide: true, timeout: 5000 }, (err) => {
        if (err) {
          // eslint-disable-next-line no-console
          console.error('[shutdown] 撤销失败:', err.message);
          resolve({ canceled: false, error: err.message });
          return;
        }
        // eslint-disable-next-line no-console
        console.log('[shutdown] 已撤销关机（shutdown /a）');
        resolve({ canceled: true });
      });
    });
  });
  ipcMain.handle('app:log', (_e, line) => {
    // eslint-disable-next-line no-console
    console.log('[renderer]', String(line == null ? '' : line).slice(0, 500));
    return true;
  });
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    title: '课堂管理系统 · 学生机',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(APP_ROOT, 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
  return mainWindow;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const machineId = ensureMachineId();
    registerIpc(() => machineId);
    // eslint-disable-next-line no-console
    console.log(`[boot] machineId=${machineId} config=${CONFIG_PATH}`);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
