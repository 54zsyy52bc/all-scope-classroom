'use strict';
// =============================================================================
// 教师端器材补录接口单测（L1）：
//   POST /api/v1/sessions/:sessionId/borrows
//   覆盖：参数校验（座位/eqId/qty）、会话不存在、未知器材、合法补登、插入后查得到。
//
// 设计：不启服务、不连 broker；用 supertest + 临时 sqlite 库直接挂载 router。
// =============================================================================
const os = require('os');
const path = require('path');
const express = require('express');

// 隔离数据库
process.env.DB_PATH = path.join(os.tmpdir(), `borrow-create-${Date.now()}-${process.pid}.db`);
process.env.LOG_LEVEL = 'silent';

const db = require('../src/db');
const { BusinessError } = require('../src/errors');
const router = require('../src/routes/equipment');
const { upsertEquipment } = require('../src/db');

let pass = 0;
let failCount = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { failCount += 1; console.log(`  [FAIL] ${name}${extra ? ' -> ' + extra : ''}`); }
}

// 必须先初始化存储
db.init();

(async () => {
  // 准备：1 个会话 + 1 个座位 + 2 个器材
  const S = db.createSession({
    session_id: 'S-L1-TEST', teacher: '测试老师', class_name: 'L1班',
    start_time: Date.now(), end_time: null, phase: 'checkin',
    total_seats: 50, export_flag: 0, topic_plan: 'B',
  });
  const sessionId = 'S-L1-TEST';
  db.upsertStudent({ sessionId, seat: '01', groupId: 'G1', patch: { name: '小A', checkin_status: 'done' } });
  upsertEquipment([
    { eq_id: 'E-RESISTOR', eq_name: '电阻包', category: '电子', total: 50 },
    { eq_id: 'E-LED', eq_name: 'LED 灯', category: '电子', total: 100 },
  ]);

  // 用 supertest（已存在依赖）；若不存在则退化到直接 fetch + supertest 替代品
  let request;
  try { request = require('supertest'); }
  catch (_e) {
    // fallback: 自己手写最小 server（监听临时端口 + http.request）
    const http = require('http');
    const app = express();
    app.use(express.json());
    app.use('/api/v1', router);
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, r));
    const port = srv.address().port;
    // 签名与 supertest 一致：request(base).post(path).send(body)
    request = function () {
      return {
        post: (p) => ({
          send: (b) => new Promise((resolve, reject) => {
            const req = http.request({ method: 'POST', port, path: p, headers: { 'content-type': 'application/json' } }, (res) => {
              let buf = '';
              res.on('data', (c) => { buf += c; });
              res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }));
            });
            req.on('error', reject);
            req.write(JSON.stringify(b));
            req.end();
          }),
        }),
      };
    };
  }

  console.log('-- 教师端器材补录（L1）');

  // 1. 合法补登：座位 01 + E-RESISTOR × 2
  let res = await request('http://x').post('/api/v1/sessions/' + sessionId + '/borrows').send({ seat: 1, eqId: 'E-RESISTOR', qty: 2 });
  check('合法补登 → 200', res.status === 200);
  check('合法补登 → code=0', res.body.code === 0);
  check('合法补登 → data.borrowed.eq_id 正确', res.body.data && res.body.data.borrowed && res.body.data.borrowed.eq_id === 'E-RESISTOR');
  check('合法补登 → 消息含器材名', /电阻包/.test(res.body.data && res.body.data.message || ''));
  // 后续查询能看到（queryBorrows 用 toBorrowDTO 转 camelCase）
  const after = db.queryBorrows(sessionId, { limit: 10 }).items;
  check('补登后查得到记录', after.some((b) => b.seat === '01' && b.eqId === 'E-RESISTOR' && b.qty === 2 && b.status === 'borrowed'));

  // 2. 座位非法（0 / 100 / 字符串）
  res = await request('http://x').post('/api/v1/sessions/' + sessionId + '/borrows').send({ seat: 0, eqId: 'E-RESISTOR', qty: 1 });
  check('座位=0 → 业务错误 E-VAL-01', res.body && res.body.errorCode === 'E-VAL-01');
  res = await request('http://x').post('/api/v1/sessions/' + sessionId + '/borrows').send({ seat: 100, eqId: 'E-RESISTOR', qty: 1 });
  check('座位=100 → 业务错误 E-VAL-01', res.body && res.body.errorCode === 'E-VAL-01');
  res = await request('http://x').post('/api/v1/sessions/' + sessionId + '/borrows').send({ seat: 'abc', eqId: 'E-RESISTOR', qty: 1 });
  check('座位=abc → 业务错误 E-VAL-01', res.body && res.body.errorCode === 'E-VAL-01');

  // 3. eqId 缺失 / 未知
  res = await request('http://x').post('/api/v1/sessions/' + sessionId + '/borrows').send({ seat: 1, eqId: '', qty: 1 });
  check('eqId 空 → E-VAL-01', res.body && res.body.errorCode === 'E-VAL-01');
  res = await request('http://x').post('/api/v1/sessions/' + sessionId + '/borrows').send({ seat: 1, eqId: 'E-NOT-EXIST', qty: 1 });
  check('eqId 未知 → E-VAL-01（提示器材名）', res.body && res.body.errorCode === 'E-VAL-01' && /未知器材/.test(res.body.message));

  // 4. qty 非法
  res = await request('http://x').post('/api/v1/sessions/' + sessionId + '/borrows').send({ seat: 1, eqId: 'E-LED', qty: 0 });
  check('qty=0 → E-VAL-01', res.body && res.body.errorCode === 'E-VAL-01');
  res = await request('http://x').post('/api/v1/sessions/' + sessionId + '/borrows').send({ seat: 1, eqId: 'E-LED', qty: 100 });
  check('qty=100 → E-VAL-01', res.body && res.body.errorCode === 'E-VAL-01');
  res = await request('http://x').post('/api/v1/sessions/' + sessionId + '/borrows').send({ seat: 1, eqId: 'E-LED', qty: 'five' });
  check('qty=字符串 → E-VAL-01', res.body && res.body.errorCode === 'E-VAL-01');

  // 5. 会话不存在
  res = await request('http://x').post('/api/v1/sessions/NOT-A-SESSION/borrows').send({ seat: 1, eqId: 'E-LED', qty: 1 });
  check('会话不存在 → E-NOTFOUND', res.body && res.body.errorCode === 'E-NOTFOUND');

  // 6. 座位在会话中未登记：仍允许补登（教师补登场景，组号 G? 兜底）
  res = await request('http://x').post('/api/v1/sessions/' + sessionId + '/borrows').send({ seat: 5, eqId: 'E-LED', qty: 1 });
  check('未登记座位补登 → 200', res.status === 200);
  check('未登记座位组号兜底 G?', res.body.data && res.body.data.borrowed && /^G\?$/.test(res.body.data.borrowed.group_id));

  // 7. 异常路径绝不外泄 SQLite 原生异常
  let threwRaw = false;
  try {
    await request('http://x').post('/api/v1/sessions/' + sessionId + '/borrows').send({ seat: '1; DROP TABLE t_equipment_borrow;--', eqId: 'E-LED', qty: 1 });
  } catch (_e) { threwRaw = true; }
  check('恶意 seat 不会泄漏原异常', !threwRaw);

  console.log('-- 教师端器材补录 总结: ' + pass + ' pass / ' + failCount + ' fail');
  // 清理临时库
  try { db.close && db.close(); } catch (_e) { /* noop */ }
  try { require('fs').unlinkSync(process.env.DB_PATH); } catch (_e) { /* noop */ }
  process.exit(failCount === 0 ? 0 : 1);
})();