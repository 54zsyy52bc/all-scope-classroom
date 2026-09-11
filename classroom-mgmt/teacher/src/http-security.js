'use strict';
// HTTP 层安全：CORS 允许来源判定 + 请求来源（回环 / 本机网卡）判定。
//
// 单独成模块的原因：
//   1) server.js 的职责是「仅装配」，鉴权/CORS 策略属于安全逻辑，不应写死在入口；
//   2) 这两处策略需要单元测试覆盖（test/auth-cors.test.js）——尤其是
//      「学生机跨机探活 health 必须通」与「跨机写操作必须 401」这一对相反要求。
const os = require('os');

// 教师机所有网卡地址（含内部回环）。用于识别「请求来自本机」。
const OWN_ADDRS = (function collect() {
  const out = new Set();
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        if (ni && ni.address) out.add(ni.address);
      }
    }
  } catch (_e) { /* 取不到网卡列表时退化为「仅回环免鉴权」 */ }
  return out;
})();

function isLoopback(ip) {
  if (typeof ip !== 'string') return false;
  if (ip === '::1') return true;
  const norm = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  // RFC 1122：127.0.0.0/8 整段都是回环，不只 127.0.0.1。
  // 只认 127.0.0.1 会让本机从 127.0.0.2 之类地址发起的请求被误判为跨机而 401。
  return norm.startsWith('127.');
}

// 请求是否发自教师机本机。两种命中情形：
//   1) 回环地址——大屏/编辑器默认用 http://127.0.0.1:3000 打开（start-teacher.bat）；
//   2) 本机网卡地址——老师可能用局域网 IP 打开大屏，本机自测也常走 LAN IP。
// 安全性：远程主机把源 IP 伪造成教师机地址，SYN-ACK 会被送回教师机自身而无法完成
// 三次握手，故「源 IP == 本机网卡地址」只可能由教师机自己发起请求，可安全免鉴权。
function isLocalRequest(req) {
  const ip = req && req.socket && req.socket.remoteAddress;
  if (!ip) return false;
  if (isLoopback(ip)) return true;
  const norm = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return OWN_ADDRS.has(ip) || OWN_ADDRS.has(norm);
}

// 同源判定：Origin 的主机端口与请求 Host 一致
function isSameOrigin(req, origin) {
  try {
    const o = new URL(origin);
    return o.host === (req.headers.host || '');
  } catch (_e) {
    return false;
  }
}

// 允许的 Origin：
//   - 无 Origin：curl / Node fetch / 测试脚本 / MQTT 工具；
//   - 'null'：Electron 渲染进程以 file:// 加载页面时发出的 Origin。
//     学生端桌面 desktop.js 会用教师机 IP 探活 /api/v1/system/health 显示「教室在线」，
//     该请求正属于此类，必须放行（旧实现 cors() 通配为 *，同样放行）。
//   - 同源：大屏/编辑器页面由教师端自身静态托管；
//   - CORS_ORIGINS：显式配置的额外来源。
function isAllowedOrigin(req, origin, extraOrigins) {
  if (!origin) return true;
  if (origin === 'null') return true;
  if (isSameOrigin(req, origin)) return true;
  return (extraOrigins || []).includes(origin);
}

function makeCorsMiddleware(extraOrigins) {
  const list = Array.isArray(extraOrigins) ? extraOrigins : [];
  return function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(req, origin, list)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Teacher-Token');
    }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  };
}

module.exports = {
  isLoopback, isLocalRequest, isSameOrigin, isAllowedOrigin, makeCorsMiddleware,
  ownAddresses: () => Array.from(OWN_ADDRS),
};
