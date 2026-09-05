'use strict';
// SSE 实时事件总线：内存 revision 计数器 + 环形缓冲（容量 500）+ 已连接客户端集合。
// 业务层通过 publish() 广播；看板通过 GET /dashboard/stream 订阅。
// 首帧发 stream.ready（携带当前 revision + 全量快照），后续发增量 SseEvent。
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0);

let revision = 0;
const RING_CAP = 500;
const ring = []; // { id, event, payload }
const clients = new Set();

let snapshotProvider = null; // (reqCtx) => DashboardSnapshot
let keepaliveTimer = null;

function setSnapshotProvider(fn) {
  snapshotProvider = fn;
}

function bump() {
  revision += 1;
  return revision;
}

function frameToSse(frame) {
  return `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.payload)}\n\n`;
}

// 广播事件。返回该事件的 revision。
function publish(event, payload) {
  const rev = bump();
  const frame = {
    id: rev,
    event,
    payload: { revision: rev, ts: Date.now(), payload },
  };
  ring.push(frame);
  if (ring.length > RING_CAP) ring.shift();
  const chunk = frameToSse(frame);
  for (const res of clients) {
    try { res.write(chunk); } catch (_e) { /* 写失败由 close 事件清理 */ }
  }
  bus.emit(event, payload);
  return rev;
}

function startKeepalive(intervalMs = 15000) {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    const chunk = `:keepalive ${Date.now()}\n\n`;
    for (const res of clients) {
      try { res.write(chunk); } catch (_e) { /* ignore */ }
    }
  }, intervalMs);
  if (keepaliveTimer.unref) keepaliveTimer.unref();
}

function buildReadyFrame() {
  const rev = revision;
  let snapshot = null;
  if (snapshotProvider) {
    try { snapshot = snapshotProvider(); } catch (_e) { snapshot = null; }
  }
  return {
    id: rev,
    event: 'stream.ready',
    payload: { revision: rev, ts: Date.now(), payload: { revision: rev, snapshot } },
  };
}

function addClient(res, lastEventId) {
  clients.add(res);
  startKeepalive();
  // 1) 首帧：stream.ready + 全量快照
  res.write(frameToSse(buildReadyFrame()));
  // 2) 若浏览器重连携带 Last-Event-ID，尽力补发增量
  if (lastEventId != null && lastEventId !== '') {
    const from = parseInt(lastEventId, 10);
    if (!Number.isNaN(from)) {
      const missed = ring.filter((f) => f.id > from);
      if (missed.length === 0 && ring.length === RING_CAP) {
        // 缓冲已淘汰，无法续接
        res.write(frameToSse({ id: revision, event: 'stream.reset', payload: { revision, ts: Date.now(), payload: { reason: `revision ${from} 已超出缓冲，请重新拉取快照` } } }));
      } else {
        for (const f of missed) res.write(frameToSse(f));
      }
    }
  }
}

function removeClient(res) {
  clients.delete(res);
}

function getState() {
  return { revision, clientCount: clients.size };
}

module.exports = {
  bus,
  publish,
  addClient,
  removeClient,
  setSnapshotProvider,
  getState,
  startKeepalive,
};
