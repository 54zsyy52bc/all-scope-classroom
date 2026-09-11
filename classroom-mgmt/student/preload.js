'use strict';
// =============================================================================
// 预加载脚本：渲染层 ↔ 主进程的唯一通道。
//
// 安全约束（不可为了省事而放宽）：
//   - contextIsolation: true，渲染层拿不到 ipcRenderer 本体
//   - 只暴露固定方法，不暴露任意 channel 调用能力
//   - 所有入参在跨进程前做形状收敛，主进程侧还会再净化一次（双重校验）
//   - 不暴露 secret、不暴露 fs / child_process / shell
// 渲染层通过 window.classroom.* 调用。
// =============================================================================
const { contextBridge, ipcRenderer } = require('electron');

const CH = {
  runtime: 'app:getRuntime',
  profile: 'app:saveProfile',
  verify: 'shutdown:verify',
  execute: 'shutdown:execute',
  cancel: 'shutdown:cancel',
  log: 'app:log',
  // v5 全域桌面 shell / 桌面
  unlockExit: 'shell:unlock-exit',
  getShellState: 'shell:get-state',
  setAutoStart: 'shell:set-autostart',
  guardStart: 'guard:start',
  guardStop: 'guard:stop',
  launchApp: 'guard:launch',
  appsState: 'guard:apps-state',
  appFocus: 'guard:app-focus',
  openDesktop: 'shell:open-desktop',
  openClass: 'shell:open-class',
  backToDesktop: 'shell:back',
  goShell: 'shell:go-shell',
  getShellConfig: 'shell:get-config',
  setShellConfig: 'shell:set-config',
  verifyLocal: 'shell:verify-local',
  getDesktopConfig: 'desktop:get',
  setDesktopConfig: 'desktop:set',
  pickApp: 'desktop:pick-app',
  importConfig: 'desktop:import-config',
};

function str(v, max) {
  return String(v == null ? '' : v).slice(0, max);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// 只允许这几个字段过桥，其余一律丢弃（防渲染层塞脏数据到配置文件）
function cleanProfile(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const out = {};
  if (p.seat !== undefined) out.seat = str(p.seat, 4);
  if (p.name !== undefined) out.name = str(p.name, 40);
  if (p.studentNo !== undefined) out.studentNo = str(p.studentNo, 48);
  return out;
}

function cleanTicket(ticket) {
  const t = ticket && typeof ticket === 'object' ? ticket : {};
  return {
    sessionId: str(t.sessionId, 128),
    ts: num(t.ts, NaN),
    token: str(t.token, 256),
  };
}

contextBridge.exposeInMainWorld('classroom', {
  // 读取运行期信息（含 broker 地址、已存座位/姓名、是否 dry-run）
  getRuntime: () => ipcRenderer.invoke(CH.runtime),

  // 持久化座位号 / 姓名 / 学号，返回主进程净化后的结果
  saveProfile: (profile) => ipcRenderer.invoke(CH.profile, cleanProfile(profile)),
  // v5 全域桌面 shell / 桌面
  openDesktop: () => ipcRenderer.invoke(CH.openDesktop),
  openClass: () => ipcRenderer.invoke(CH.openClass),
  backToDesktop: () => ipcRenderer.invoke(CH.backToDesktop),
  goShell: () => ipcRenderer.invoke(CH.goShell),
  unlockExit: () => ipcRenderer.invoke(CH.unlockExit),
  getShellState: () => ipcRenderer.invoke(CH.getShellState),
  setAutoStart: (on) => ipcRenderer.invoke(CH.setAutoStart, !!on),
  // 主进程守卫拦截通知（如 Alt+F4 / 非授权关闭）
  onGuard: (cb) => ipcRenderer.on('shell:guard-blocked', () => { try { cb(); } catch (_e) { /* noop */ } }),
  // v5 进程守卫：白名单启动 / 禁用进程强杀通知
  guardStart: (cfg) => ipcRenderer.invoke(CH.guardStart, cfg),
  guardStop: () => ipcRenderer.invoke(CH.guardStop),
  launchApp: (appId) => ipcRenderer.invoke(CH.launchApp, appId),
  getAppsState: () => ipcRenderer.invoke(CH.appsState),
  focusApp: (appId) => ipcRenderer.invoke(CH.appFocus, str(appId, 24)),
  onApps: (cb) => ipcRenderer.on('guard:apps', (_e, p) => { try { cb(p); } catch (_e2) { /* noop */ } }),
  onMinimize: (cb) => ipcRenderer.on('guard:minimize', (_e, p) => { try { cb(p); } catch (_e2) { /* noop */ } }),
  onKill: (cb) => ipcRenderer.on('guard:kill', (_e, name) => { try { cb(name); } catch (_err) { /* noop */ } }),
  // v5 口令（哈希在主进程校验与存储）
  getShellConfig: () => ipcRenderer.invoke(CH.getShellConfig),
  setShellConfig: (patch) => ipcRenderer.invoke(CH.setShellConfig, patch),
  verifyLocal: (scope, pwd) => ipcRenderer.invoke(CH.verifyLocal, scope, pwd),
  // v5.1 桌面配置（独立 desktop-config.json）
  getDesktopConfig: () => ipcRenderer.invoke(CH.getDesktopConfig),
  setDesktopConfig: (patch) => ipcRenderer.invoke(CH.setDesktopConfig, patch),
  pickApp: () => ipcRenderer.invoke(CH.pickApp),
  importConfig: () => ipcRenderer.invoke(CH.importConfig),

  // 关机票据校验：主进程用本地 secret 做 HMAC + 60s 时间窗比对
  verifyShutdown: (ticket) => ipcRenderer.invoke(CH.verify, cleanTicket(ticket)),

  // 执行关机。delaySec 超出范围由主进程裁剪；dry-run 时只打日志
  executeShutdown: (opts) => ipcRenderer.invoke(CH.execute, {
    delaySec: num(opts && opts.delaySec, undefined),
    reason: str(opts && opts.reason, 200),
  }),

  // 撤销关机：中止本机已排定的关机倒计时（shutdown /a）；dry-run 时只打日志
  cancelShutdown: () => ipcRenderer.invoke(CH.cancel),

  // 渲染层日志回传主进程 stdout（排障用，截断 500 字符）
  log: (line) => ipcRenderer.invoke(CH.log, str(line, 500)),
});
