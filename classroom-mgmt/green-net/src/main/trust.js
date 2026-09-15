'use strict';
// =============================================================================
// 调用方可信判定（纯函数，可单测）
//
// 背景：page preload 会被注入到**不可信的网页**里，所以"预加载暴露了哪些方法"
//       不构成安全边界。唯一可靠的信号是**主进程看到的发送方 URL**
//       （event.senderFrame.url），它对页面脚本不可伪造。
//
// 分级：
//   · shell —— 本机外壳页面（src/renderer/chrome.html，file://），完全可信
//   · 内置页 —— gnet://<host>/，按能力分级
//       READ_HOSTS  ：可读运行信息、导航、探活
//       WRITE_HOSTS ：可改配置 / 改口令（仅教师管理页）
//   · 其它（http/https 网页、subframe、未知来源）—— 一律拒绝并记日志
// =============================================================================
const READ_HOSTS = ['home', 'ip', 'siot', 'admin', 'qy', 'help', 'error', 'blocked', 'locked'];
const WRITE_HOSTS = ['admin'];

function senderInfo(event) {
  try {
    const frame = event && event.senderFrame;
    const url = String((frame && frame.url) || (event && event.sender && event.sender.getURL && event.sender.getURL()) || '');
    // 空 URL 绝不能当作"外壳"放行 —— 取不到来源时必须是"不可信"。
    if (!url) return { url: '', host: '', isShell: false, kind: 'unknown' };
    const m = url.match(/^gnet:\/\/([a-z0-9-]+)/i);
    if (m) return { url, host: m[1].toLowerCase(), isShell: false, kind: 'internal' };
    // 外壳是本机文件，只认 file://（loadFile 加载）
    if (/^file:\/\//i.test(url)) return { url, host: '', isShell: true, kind: 'shell' };
    return { url, host: '', isShell: false, kind: 'web' };
  } catch (_e) {
    return { url: '', host: '', isShell: false, kind: 'unknown' };
  }
}

// level: 'read' | 'write'
function authorize(level, info) {
  const i = info || {};
  if (i.isShell) return { ok: true };
  if (level === 'write') {
    if (WRITE_HOSTS.includes(i.host)) return { ok: true };
    return { ok: false, err: '当前页面没有权限执行这个操作', code: 'E-PERM-WRITE' };
  }
  if (READ_HOSTS.includes(i.host)) return { ok: true };
  return { ok: false, err: '当前页面没有权限读取这项信息', code: 'E-PERM-READ' };
}

module.exports = { READ_HOSTS, WRITE_HOSTS, senderInfo, authorize };
