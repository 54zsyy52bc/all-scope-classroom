'use strict';
// 入口：仅装配，不含业务逻辑。顺序：初始化存储 → 接线路由/桥接/监控 → 启动监听。
//
// 双模式：
//   1) 命令行启动（node server.js）：自动初始化 + 监听 + 注册 SIGINT/SIGTERM 优雅退出。
//   2) Electron 主进程内嵌（require('./server') 后调 start()）：复用同一份装配，窗口加载
//      编辑器/大屏页面。stop() 用于退出时清理。
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const cfg = require('./src/config');
const db = require('./src/db');
const { makeLogger } = require('./src/utils');

const log = makeLogger(cfg.LOG_LEVEL);
const sse = require('./src/sse');
const bridge = require('./src/mqtt/bridge');
const handlers = require('./src/mqtt/handlers');
const monitor = require('./src/monitor');
const dashboardSvc = require('./src/services/dashboard.service');

const systemRouter = require('./src/routes/system');
const sessionRouter = require('./src/routes/session');
const taskRouter = require('./src/routes/task');
const equipmentRouter = require('./src/routes/equipment');
const commandRouter = require('./src/routes/command');
const dashboardRouter = require('./src/routes/dashboard');
const exportRouter = require('./src/routes/export');
const presetRouter = require('./src/routes/preset');
const shellRouter = require('./src/routes/shell'); // v5 全域学生桌面：课程/口令
const activityRouter = require('./src/routes/activity');
const legacyRouter = require('./src/routes/legacy');
const { requireAuth } = require('./src/response');

// 0) 兜底：单条坏消息 / 未处理的 Promise 拒绝不得拖垮教师端进程。
// 上课途中大屏断流比"进程崩溃并打印堆栈"代价大得多，故记录 error 后继续服务。
process.on('unhandledRejection', (reason) => {
  log.error('未处理的 Promise 拒绝:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  log.error('未捕获异常:', err && err.stack ? err.stack : err);
});

let initResult = { mode: 'none' };

// 存储初始化（better-sqlite3 失败自动降级 JSON）
function initStorage() {
  initResult = db.init();
  if (initResult.mode === 'json') {
    // eslint-disable-next-line no-console
    console.warn('[storage] better-sqlite3 不可用，已降级为内存+JSON 存储（功能完整，重启后数据不持久于 SQLite）。原因:', initResult.reason || 'unknown');
  }
  // 启动载入器材种子，使 /equipment 在开课前可用
  try {
    const equip = JSON.parse(fs.readFileSync(cfg.EQUIP_FILE, 'utf8'));
    if (Array.isArray(equip) && equip.length) db.upsertEquipment(equip);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[seed] 器材种子载入失败:', e.message);
  }
  return initResult;
}

// 审计中间件：写请求记终端 + 节流异步落盘 logs/audit.log（请求路径零同步 IO，避免拖慢响应）
const auditBuf = [];
let auditFlushTimer = null;
function flushAudit() {
  if (!auditBuf.length) return;
  const chunk = auditBuf.splice(0).join('');
  try {
    const fsa = require('fs');
    const pa = require('path');
    fsa.mkdirSync(pa.join(__dirname, 'logs'), { recursive: true });
    fsa.appendFileSync(pa.join(__dirname, 'logs', 'audit.log'), chunk, { flag: 'a' });
  } catch (_e) { /* 审计落盘失败不阻断 */ }
}
function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  // 测试期操作审计：所有写请求（POST/PUT/DELETE）记一条 audit 日志到终端与文件，便于回传定位
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const line = '[audit] ' + new Date().toISOString().slice(0, 19) + ' ' + req.method + ' ' + req.originalUrl
        + ' body=' + JSON.stringify(req.body || {}).slice(0, 200);
      console.log(line);
      auditBuf.push(line.replace('[audit] ', '') + '\n');
      if (!auditFlushTimer) auditFlushTimer = setTimeout(() => { auditFlushTimer = null; flushAudit(); }, 500);
    }
    next();
  });
  app.use('/api/v1', requireAuth);
  // 挂载点：各资源路由内部路径已自带资源前缀（如 /sessions、/dashboard、/exports），
  // 故统一挂在 /api/v1 之下。systemRouter 内部无 /system 前缀，单独挂载。
  app.use('/api/v1/system', systemRouter);
  app.use('/api/v1/shell', shellRouter);
  app.use('/api/v1', sessionRouter);
  app.use('/api/v1', taskRouter);
  app.use('/api/v1', equipmentRouter);
  app.use('/api/v1', commandRouter);
  app.use('/api/v1', dashboardRouter);
  app.use('/api/v1', exportRouter);
  app.use('/api/v1', presetRouter);
  app.use('/api/v1', activityRouter);
  app.use('/api/v1', legacyRouter);
  app.use(express.static(cfg.PUBLIC_DIR));
  return app;
}

function wire() {
  // 接线：快照供给 / MQTT 状态广播 / 消息分发
  sse.setSnapshotProvider(() => dashboardSvc.getSnapshot());
  bridge.setOnStateChange((state) => sse.publish('connection.changed', state));
  bridge.setMessageHandler((topic, buf) => handlers.dispatch(topic, buf));
  // 启动监控、连接
  monitor.start(cfg.OFFLINE_THRESHOLD_MS > 0 ? Math.min(5000, cfg.OFFLINE_THRESHOLD_MS / 3) : 5000);
  bridge.connect();
}

function start() {
  initStorage();
  const app = createApp();
  wire();
  const server = app.listen(cfg.HTTP_PORT, cfg.HTTP_HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`课堂管理系统教师端已启动: http://${cfg.HTTP_HOST}:${cfg.HTTP_PORT}  (存储模式: ${initResult.mode})`);
  });
  return server;
}

function stop() {
  // eslint-disable-next-line no-console
  console.log('\n正在关闭...');
  bridge.shutdown();
  monitor.stop();
  try { db.close(); } catch (_e) { /* ignore */ }
}

// 命令行直跑模式
if (require.main === module) {
  const server = start();
  function shutdown() {
    stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { start, stop, createApp, getMode: () => initResult.mode };
