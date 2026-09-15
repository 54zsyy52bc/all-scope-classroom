'use strict';
// =============================================================================
// 本地 SIoT 服务探测与一键打开
//
// SIoT_V2 的默认端口（来自 SIoT_V2_Win_2618/conf/config.json）：
//   httpPort 8080  ← 网页控制台（一键打开的目标）
//   port     1883  ← MQTT
//   wsPort   1888  ← MQTT over WebSocket
//
// 探测两件事：TCP 1883 是否在监听（判断服务是否真的起来了）、
// HTTP 8080 是否返回内容（判断控制台页面是否可用）。
// 未启动时不硬报错，而是返回可读的启动指引（交给渲染层展示）。
// =============================================================================
const net = require('node:net');
const http = require('node:http');
const U = require('./util');

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_e) { /* noop */ }
      resolve({ ok, port, err: err || '', ms: Date.now() - started });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false, '连接超时'));
    sock.once('error', (e) => finish(false, e.code || e.message));
    try { sock.connect(port, host); } catch (e) { finish(false, String(e.message || e)); }
  });
}

function httpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (ok, status, err) => {
      if (done) return;
      done = true;
      resolve({ ok, status: status || 0, err: err || '', ms: Date.now() - started });
    };
    let req = null;
    try {
      req = http.get({ host, port, path: '/', timeout: timeoutMs, headers: { Connection: 'close' } }, (res) => {
        res.resume();
        finish(res.statusCode >= 200 && res.statusCode < 500, res.statusCode);
      });
    } catch (e) {
      finish(false, 0, String(e.message || e));
      return;
    }
    req.on('timeout', () => { try { req.destroy(); } catch (_e) { /* noop */ } finish(false, 0, 'HTTP 超时'); });
    req.on('error', (e) => finish(false, 0, e.code || e.message));
  });
}

// 依次探测：HTTP 控制台 → MQTT 端口；任一通则认为服务在运行
async function probe(siotCfg, timeoutMs) {
  const cfg = U.isPlainObject(siotCfg) ? siotCfg : {};
  const host = U.str(cfg.host, 64) || '127.0.0.1';
  const httpPort = U.int(cfg.httpPort, 8080, 1, 65535);
  const mqttPort = U.int(cfg.mqttPort, 1883, 1, 65535);
  const t = U.int(timeoutMs, 1500, 200, 10000);

  const [httpRes, mqttRes] = await Promise.all([
    httpProbe(host, httpPort, t),
    tcpProbe(host, mqttPort, t),
  ]);

  const running = httpRes.ok || mqttRes.ok;
  return {
    host,
    httpPort,
    mqttPort,
    consoleUrl: `http://${host}:${httpPort}`,
    running,
    http: httpRes,
    mqtt: mqttRes,
    hint: running
      ? (httpRes.ok ? 'SIoT 服务已启动，控制台可直接打开' : 'SIoT 的 MQTT 端口在监听，但网页控制台无响应，可稍后重试')
      : '未检测到本机 SIoT 服务。请到 SIoT 目录双击「start SIoT.bat」启动，或联系老师。',
    guidance: running ? [] : [
      '① 打开 SIoT 文件夹（通常为 SIoT_V2_Win_2618）',
      '② 双击 start SIoT.bat（不要直接双击 main.exe）',
      '③ 首次运行弹出网络提示时，勾选「专用网络」和「公用网络」后点允许',
      '④ 回到绿网，再点一次「SIoT 控制台」',
    ],
  };
}

module.exports = { probe, tcpProbe, httpProbe };
