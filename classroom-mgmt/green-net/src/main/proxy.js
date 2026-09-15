'use strict';
// =============================================================================
// 代理解析 —— 解决「公网站打不开 / ERR_FAILED -2」问题。
//
// 根因：Chromium 在 Windows 上不读 HTTPS_PROXY 这类环境变量，也只认
//   WinHTTP（系统代理）配置。当机器靠环境变量或第三方代理软件出网、
//   而系统代理（ProxyEnable）为 0 时，Chromium 会以为「无需代理」，
//   于是所有 https 请求以 ERR_FAILED(-2) 失败；但同机的 Node / curl 能通
//   （它们读环境变量），造成「命令行能上网、浏览器打不开」的错觉。
//
// 策略（app-config.json 的 proxy.mode）：
//   off    —— 强制直连，不使用任何代理
//   manual —— 用 proxy.server（如 127.0.0.1:7897）
//   auto   —— 依次尝试 ① 环境变量 HTTPS_PROXY/HTTP_PROXY
//                         ② Windows 系统代理（仅 ProxyEnable=1）
//                         ③ 都没有则直连
//
// 返回 { rules, bypass, source }：rules 为空串＝直连；否则为 Chromium 的
//   --proxy-server 语法（host:port 或分协议形式）。bypass 默认含 <local>，
//   保证本机 SIoT 控制台（127.0.0.1:8080）不被代理拦截。
// =============================================================================
const { execFileSync } = require('node:child_process');

function isHost(s) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s) || s === 'localhost';
}

// 从环境变量解析（Node 子进程会继承父 shell 的 HTTPS_PROXY/HTTP_PROXY）
function envProxyRules() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!raw) return null;
  // 形如 http://127.0.0.1:65487 或 127.0.0.1:65487
  const m = String(raw).match(/^(?:https?:\/\/)?([^:/@\s]+)(?::(\d+))?/);
  if (!m || !isHost(m[1])) return null;
  const host = m[1];
  const port = m[2] || '8080';
  return `${host}:${port}`;
}

// 读 Windows 系统代理设置（仅 ProxyEnable=1 时返回）
function winSystemProxy() {
  if (process.platform !== 'win32') return null;
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const en = execFileSync('reg', ['query', key, '/v', 'ProxyEnable'],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(en)) return null;
    const sv = execFileSync('reg', ['query', key, '/v', 'ProxyServer'],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const srv = ((sv.match(/ProxyServer\s+REG_SZ\s+(.+?)\r?$/im) || [])[1] || '').trim();
    if (!srv) return null;
    // 分协议形式 "http=127.0.0.1:7897;https=127.0.0.1:7897" → 取第一个 host:port
    if (srv.includes('=')) {
      for (const part of srv.split(';')) {
        const mm = part.trim().match(/:\s*([^=:\s]+:\d+)$/) || part.trim().match(/=\s*([^=:\s]+:\d+)$/);
        if (mm) return mm[1];
      }
      return null;
    }
    return srv;
  } catch (_e) {
    return null;
  }
}

function resolveProxy(proxyCfg) {
  const cfg = proxyCfg || { mode: 'auto', server: '', bypass: '<local>' };
  if (cfg.mode === 'off') {
    return { rules: '', bypass: '', source: 'off' };
  }
  if (cfg.mode === 'manual') {
    const server = (cfg.server || '').trim();
    if (!server) return { rules: '', bypass: '', source: 'manual(empty)' };
    return { rules: server, bypass: cfg.bypass || '<local>', source: 'manual' };
  }
  // auto
  const env = envProxyRules();
  if (env) return { rules: env, bypass: cfg.bypass || '<local>', source: 'env' };
  const w = winSystemProxy();
  if (w) return { rules: w, bypass: cfg.bypass || '<local>', source: 'win-reg' };
  return { rules: '', bypass: '', source: 'none' };
}

module.exports = { resolveProxy, envProxyRules, winSystemProxy };
