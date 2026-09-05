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
  log: 'app:log',
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

  // 关机票据校验：主进程用本地 secret 做 HMAC + 60s 时间窗比对
  verifyShutdown: (ticket) => ipcRenderer.invoke(CH.verify, cleanTicket(ticket)),

  // 执行关机。delaySec 超出范围由主进程裁剪；dry-run 时只打日志
  executeShutdown: (opts) => ipcRenderer.invoke(CH.execute, {
    delaySec: num(opts && opts.delaySec, undefined),
    reason: str(opts && opts.reason, 200),
  }),

  // 渲染层日志回传主进程 stdout（排障用，截断 500 字符）
  log: (line) => ipcRenderer.invoke(CH.log, str(line, 500)),
});
