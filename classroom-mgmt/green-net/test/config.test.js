'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { suite, test, eq, assert } = require('./harness');
const C = require('../src/main/config');

function tmpAppRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnet-cfg-'));
  return dir;
}

suite('config · 默认值与规范化', () => {
  test('空配置得到完整默认结构', () => {
    const n = C.normalize({});
    eq(n.blockMode, 'blacklist');
    eq(n.maxTabs, 8);
    eq(n.siot.httpPort, 8080);
    eq(n.siot.mqttPort, 1883);
    eq(n.siot.wsPort, 1888);
    eq(n.qy.port, 1883);
    eq(n.qy.projectPrefix, 'ICTClass');
    eq(n.qy.reportHeartbeat, false, '心跳默认关闭，避免影响教师端考勤统计');
  });
  test('未知模式回落 blacklist', () => {
    eq(C.normalize({ blockMode: 'whatever' }).blockMode, 'blacklist');
    eq(C.normalize({ blockMode: 'whitelist' }).blockMode, 'whitelist');
  });
  test('端口越界被夹取', () => {
    const n = C.normalize({ siot: { httpPort: 999999, mqttPort: -1, wsPort: 'x' } });
    eq(n.siot.httpPort, 65535);
    eq(n.siot.mqttPort, 1);
    eq(n.siot.wsPort, 1888, '非法值回落默认');
  });
  test('座位号规范化（补零、越界清空）', () => {
    eq(C.normSeat('7'), '07');
    eq(C.normSeat('07'), '07');
    eq(C.normSeat('abc'), '');
    eq(C.normSeat('1000'), '');
  });
});

suite('config · 读写与 patch', () => {
  test('patch 只接受白名单键', () => {
    const dir = tmpAppRoot();
    const cfg = C.createConfig(dir);
    cfg.patch({ allowDownload: true, // 白名单内
      siot: { httpPort: 9090 }, qy: { enabled: false }, // 白名单内（嵌套）
      __evil: 'x', machineId: 'HACKED' }); // 白名单外：machineId 不允许直接改
    const g = cfg.get();
    eq(g.allowDownload, true);
    eq(g.siot.httpPort, 9090);
    eq(g.siot.mqttPort, 1883, '未提供的嵌套字段应保留');
    eq(g.qy.enabled, false);
    eq(g.__evil, undefined);
    assert(!JSON.stringify(g).includes('HACKED'), 'machineId 不应被 patch 改写');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('patch 落盘后重建实例仍能读到', () => {
    const dir = tmpAppRoot();
    C.createConfig(dir).patch({ maxTabs: 3 });
    eq(C.createConfig(dir).get().maxTabs, 3);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('损坏的配置文件回落默认值而不是崩溃', () => {
    const dir = tmpAppRoot();
    fs.writeFileSync(path.join(dir, 'app-config.json'), '{坏掉的 json');
    const cfg = C.createConfig(dir);
    eq(cfg.get().maxTabs, 8);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

suite('config · 机器编号', () => {
  test('ensureMachineId 生成 M-xxxxxxxx 并持久化', () => {
    const dir = tmpAppRoot();
    const cfg = C.createConfig(dir);
    const id = cfg.ensureMachineId();
    assert(/^M-[0-9a-f]{8}$/.test(id), 'machineId 形态应为 M- + 8 位 hex，实际=' + id);
    eq(C.createConfig(dir).get().machineId, id, '应落盘，重启不变');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('deriveMachineId 与全域学生端算法一致（同机同值）', () => {
    const a = C.deriveMachineId();
    const b = C.deriveMachineId();
    eq(a, b);
    assert(/^M-[0-9a-f]{8}$/.test(a));
  });
  test('已存在的合法 machineId 不会被覆盖', () => {
    const dir = tmpAppRoot();
    C.createConfig(dir).patch({}); // 先建文件
    const f = path.join(dir, 'app-config.json');
    const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
    obj.machineId = 'M-deadbeef';
    fs.writeFileSync(f, JSON.stringify(obj));
    eq(C.createConfig(dir).ensureMachineId(), 'M-deadbeef');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

suite('config · 敏感值', () => {
  test('secret 占位值被保留以便判定"未部署"', () => {
    const dir = tmpAppRoot();
    const cfg = C.createConfig(dir);
    eq(cfg.get().secret, C.PLACEHOLDER);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
