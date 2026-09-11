'use strict';
// 鉴权与 CORS 策略单测（v5.2 R-1 修复的回归防线）。
//
// 要同时守住两个方向相反的要求，任何一边被改坏都必须在这里失败：
//   A) 学生机（跨机）必须能探活 /api/v1/system/health —— 否则 84 台学生机状态灯全灭；
//   B) 学生机（跨机）不得调用业务接口与关机接口 —— 否则局域网内任何人可操作课堂。
// 运行：node test/auth-cors.test.js
const cfg = require('../src/config');
const { requireAuth, isLocalRequest, isLoopback, safeEqual } = require('../src/response');
const { isAllowedOrigin, isSameOrigin, makeCorsMiddleware, ownAddresses } = require('../src/http-security');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra !== undefined ? (' -> ' + extra) : '')); }
}

const FOREIGN = '203.0.113.7'; // TEST-NET-3，保证不是本机地址
const OWN_LAN = ownAddresses().filter((ip) => !isLoopback(ip) && ip.indexOf(':') < 0);

function reqOf(ip, url, headers, method) {
  return {
    socket: ip === null ? {} : { remoteAddress: ip },
    originalUrl: url || '/api/v1/sessions',
    headers: Object.assign({}, headers || {}),
    method: method || 'GET',
  };
}
function resOf() {
  const r = { statusCode: 0, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
// 跑一次 requireAuth，返回 'next'（放行）或 HTTP 状态码
function runAuth(req) {
  let nexted = false;
  requireAuth(req, resOf(), () => { nexted = true; });
  return nexted ? 'next' : 'blocked';
}
function resHeaderOf() {
  const h = {};
  const r = { headers: h, code: 0, ended: false };
  r.setHeader = (k, v) => { h[k] = v; return r; };
  r.status = (c) => { r.code = c; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}

// ---------- 1. 来源判定 ----------
check('回环 127.0.0.1 视为本机', isLoopback('127.0.0.1') === true);
check('IPv6 回环 ::1 视为本机', isLoopback('::1') === true);
check('IPv4-mapped 回环视为本机', isLoopback('::ffff:127.0.0.1') === true);
check('回环网段 127.0.0.2 也视为本机（RFC 1122）', isLoopback('127.0.0.2') === true);
check('非字符串入参不抛异常', isLoopback(undefined) === false && isLoopback(null) === false);
check('外网 IP 不视为本机', isLoopback(FOREIGN) === false);
check('本机请求：127.0.0.1 命中', isLocalRequest(reqOf('127.0.0.1')) === true);
check('本机请求：::ffff:127.0.0.1 命中', isLocalRequest(reqOf('::ffff:127.0.0.1')) === true);
check('本机请求：学生机 IP 不命中', isLocalRequest(reqOf(FOREIGN)) === false);
check('本机请求：无 socket 信息时不放行', isLocalRequest(reqOf(null)) === false);
if (OWN_LAN.length) {
  check('本机请求：教师机自身局域网地址命中（老师用 LAN IP 打开大屏）', isLocalRequest(reqOf(OWN_LAN[0])) === true, OWN_LAN[0]);
} else {
  console.log('  [SKIP] 本机无局域网网卡（仅回环），跳过 LAN 地址判定用例');
}

// ---------- 2. requireAuth：跨机 health 放行 / 跨机业务接口拦截 ----------
cfg.ENABLE_AUTH = true;
cfg.TEACHER_TOKEN = 'unit-test-token-0123456789';
check('跨机 GET /system/health 放行（学生端状态灯依赖）', runAuth(reqOf(FOREIGN, '/api/v1/system/health')) === 'next');
check('本机 GET /system/health 放行', runAuth(reqOf('127.0.0.1', '/api/v1/system/health')) === 'next');
check('跨机无令牌调业务接口被拒', runAuth(reqOf(FOREIGN, '/api/v1/sessions')) === 'blocked');
{
  const res = resOf();
  requireAuth(reqOf(FOREIGN, '/api/v1/sessions'), res, () => {});
  check('被拒时返回 401 且错误码为 E-AUTH-01', res.statusCode === 401 && res.body.errorCode === 'E-AUTH-01', res.statusCode + '/' + (res.body && res.body.errorCode));
}
check('跨机带正确令牌放行', runAuth(reqOf(FOREIGN, '/api/v1/sessions', { 'x-teacher-token': 'unit-test-token-0123456789' })) === 'next');
check('跨机带等长错误令牌被拒', runAuth(reqOf(FOREIGN, '/api/v1/sessions', { 'x-teacher-token': 'unit-test-token-9876543210' })) === 'blocked');
check('跨机带不等长令牌被拒且不抛异常', runAuth(reqOf(FOREIGN, '/api/v1/sessions', { 'x-teacher-token': 'x' })) === 'blocked');
check('本机无令牌调业务接口放行（大屏同源使用不受影响）', runAuth(reqOf('127.0.0.1', '/api/v1/sessions')) === 'next');
check('本机 IPv4-mapped 回环无令牌放行', runAuth(reqOf('::ffff:127.0.0.1', '/api/v1/command/shutdown')) === 'next');
check('显式关闭鉴权时全部放行', (function () {
  cfg.ENABLE_AUTH = false;
  const r = runAuth(reqOf(FOREIGN, '/api/v1/command/shutdown'));
  cfg.ENABLE_AUTH = true;
  return r === 'next';
})());
cfg.TEACHER_TOKEN = '';

// ---------- 3. 令牌比较 ----------
check('safeEqual 相同返回 true', safeEqual('abc', 'abc') === true);
check('safeEqual 等长不同返回 false', safeEqual('abc', 'abd') === false);
check('safeEqual 长度不同返回 false 且不抛异常', safeEqual('abc', 'abcd') === false);
check('safeEqual 非字符串返回 false', safeEqual(null, 'abc') === false && safeEqual('abc', undefined) === false);

// ---------- 4. CORS 允许来源 ----------
const anyReq = reqOf('127.0.0.1', '/api/v1/system/health', { host: '192.168.1.10:3000' });
check('无 Origin（curl/测试）放行', isAllowedOrigin(anyReq, undefined, []) === true);
check('Origin: null（Electron file:// 渲染进程）放行', isAllowedOrigin(anyReq, 'null', []) === true);
check('同源放行', isSameOrigin(anyReq, 'http://192.168.1.10:3000') === true && isAllowedOrigin(anyReq, 'http://192.168.1.10:3000', []) === true);
check('不同端口不算同源', isSameOrigin(anyReq, 'http://192.168.1.10:8080') === false);
check('非法 Origin 不抛异常且不放行', isAllowedOrigin(anyReq, 'not-a-url', []) === false);
check('陌生站点默认不放行', isAllowedOrigin(anyReq, 'http://evil.example.com', []) === false);
check('CORS_ORIGINS 白名单放行', isAllowedOrigin(anyReq, 'http://evil.example.com', ['http://evil.example.com']) === true);

// ---------- 5. CORS 中间件行为 ----------
{
  const mw = makeCorsMiddleware([]);
  const res = resHeaderOf();
  let nexted = false;
  mw(reqOf('127.0.0.1', '/api/v1/system/health', { origin: 'null' }), res, () => { nexted = true; });
  check('中间件对 Origin: null 回写 ACAO', res.headers['Access-Control-Allow-Origin'] === 'null', JSON.stringify(res.headers));
  check('中间件回写 Vary: Origin', res.headers.Vary === 'Origin');
  check('非 OPTIONS 请求继续后续处理', nexted === true);
}
{
  const mw = makeCorsMiddleware([]);
  const res = resHeaderOf();
  mw(reqOf('127.0.0.1', '/api/v1/system/health', { origin: 'http://evil.example.com' }), res, () => {});
  check('陌生站点不回写 ACAO', res.headers['Access-Control-Allow-Origin'] === undefined, JSON.stringify(res.headers));
}
{
  const mw = makeCorsMiddleware([]);
  const res = resHeaderOf();
  let nexted = false;
  mw(reqOf('203.0.113.7', '/api/v1/command/shutdown', { origin: 'null' }, 'OPTIONS'), res, () => { nexted = true; });
  check('OPTIONS 预检返回 204 且不再向后传递', res.code === 204 && res.ended === true && nexted === false);
}
{
  const mw = makeCorsMiddleware([]);
  const res = resHeaderOf();
  mw(reqOf('127.0.0.1', '/api/v1/system/health'), res, () => {});
  check('无 Origin 时不写 ACAO（避免无谓的 CORS 头）', res.headers['Access-Control-Allow-Origin'] === undefined);
}

console.log('\n鉴权/CORS 策略验证：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);
