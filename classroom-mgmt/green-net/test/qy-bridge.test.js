'use strict';
const { suite, test, eq, assert } = require('./harness');
const Q = require('../src/main/qy-bridge');

suite('qy-bridge · 主题契约', () => {
  test('物理主题与 classroom-mgmt/shared/topics.js 完全一致', () => {
    const t = Q.loadTopics();
    const shared = require('../src/shared/topics');
    eq(t.CMD_BROADCAST, shared.CMD_BROADCAST);
    eq(t.STU_UP, shared.STU_UP);
    eq(t.STU_HB, shared.STU_HB);
    eq(t.SYNC, shared.SYNC);
  });
  test('主题字面值与《接口设计文档》一致', () => {
    const t = Q.loadTopics();
    eq(t.CMD_BROADCAST, 'siot/ict_cmd');
    eq(t.STU_UP, 'siot/ict_up');
    eq(t.STU_HB, 'siot/ict_hb');
    eq(t.SYNC, 'siot/ict_sync');
  });
  test('重连退避为 1s→30s 封顶（架构文档 §3.3）', () => {
    assert(Q.BACKOFF[0] === 1000, '首档 1 秒');
    assert(Q.BACKOFF[Q.BACKOFF.length - 1] === 30000, '封顶 30 秒');
    for (let i = 1; i < Q.BACKOFF.length; i += 1) {
      assert(Q.BACKOFF[i] >= Q.BACKOFF[i - 1], '退避必须单调不减');
    }
  });
});

suite('qy-bridge · 指令解析', () => {
  // 与教师端 bridge.publishCommand 的真实形态一致：payload.action 是"指令名"，
  // makeCommand 会把它合并进 payload。task_timer 的子动作放在 timerAction。
  const cmd = (action, payload) => ({ type: 'cmd', payload: Object.assign({ action }, payload || {}) });

  test('非 cmd 信封返回 null', () => {
    eq(Q.interpretCommand({ type: 'sync', payload: {} }), null);
    eq(Q.interpretCommand(null), null);
  });
  test('policy：锁定策略（字段与 student/renderer/control.js applyPolicy 一致）', () => {
    const r = Q.interpretCommand(cmd('policy', { mode: 'activity', locked: true, reason: 'no-activity', phase: 'task' }));
    eq(r.kind, 'policy');
    eq(r.locked, true);
    eq(r.mode, 'activity');
    eq(r.reason, 'no-activity');
  });
  test('task：活动发布，带计时字段', () => {
    const r = Q.interpretCommand(cmd('task', {
      taskId: 'T-001', title: '点亮 LED', desc: '', timed: true, durationSec: 600, timerState: 'running', remainingMs: 599000,
    }));
    eq(r.kind, 'task');
    eq(r.task.taskId, 'T-001');
    eq(r.task.timed, true);
    eq(r.task.durationSec, 600);
    eq(r.task.remainingMs, 599000);
    eq(r.task.timerState, 'running');
  });
  test('task_timer：暂停/恢复/调时长/到期（子动作在 timerAction）', () => {
    eq(Q.interpretCommand(cmd('task_timer', { timerAction: 'pause' })).kind, 'timer');
    eq(Q.interpretCommand(cmd('task_timer', { timerAction: 'pause' })).action, 'pause');
    eq(Q.interpretCommand(cmd('task_timer', { timerAction: 'resume', remainingMs: 120000 })).remainingMs, 120000);
    eq(Q.interpretCommand(cmd('task_timer', { timerAction: 'adjust', durationSec: 300 })).durationSec, 300);
    eq(Q.interpretCommand(cmd('task_timer', { timerAction: 'expired' })).action, 'expired');
    eq(Q.interpretCommand(cmd('task_timer', { timerAction: 'stop' })).action, 'stop');
  });
  test('start / end / reset / shutdown', () => {
    eq(Q.interpretCommand(cmd('start')).phase, 'checkin');
    eq(Q.interpretCommand(cmd('end')).kind, 'end');
    eq(Q.interpretCommand(cmd('reset')).kind, 'reset');
    eq(Q.interpretCommand(cmd('shutdown', { delaySec: 10 })).delaySec, 10);
    eq(Q.interpretCommand(cmd('shutdown', {})).delaySec, 10, '缺省延迟应为 10 秒');
  });
  test('未知 action 不抛错，归入 ignore', () => {
    const r = Q.interpretCommand(cmd('something_new'));
    eq(r.kind, 'ignore');
    eq(r.action, 'something_new');
  });
  test('payload 缺失也能解析（坏报文不打断消息流）', () => {
    const r = Q.interpretCommand({ type: 'cmd' });
    eq(r.kind, 'ignore');
  });
});

suite('qy-bridge · 计时器状态机', () => {
  const base = { taskId: 'T', timed: true, timerState: 'running', remainingMs: 300000, durationSec: 300 };

  test('pause → paused，剩余固化', () => {
    const t = Q.applyTimerAction(base, 'pause', 240000);
    eq(t.timerState, 'paused');
    eq(t.remainingMs, 240000);
    eq(base.timerState, 'running', '不应修改原对象');
  });
  test('resume / adjust / restart → running', () => {
    eq(Q.applyTimerAction(base, 'resume', 240000).timerState, 'running');
    eq(Q.applyTimerAction(base, 'adjust', 600000).timerState, 'running');
    eq(Q.applyTimerAction(base, 'restart', 300000).timerState, 'running');
  });
  test('expired → 归零', () => {
    const t = Q.applyTimerAction(base, 'expired', 0);
    eq(t.timerState, 'expired');
    eq(t.remainingMs, 0);
  });
  test('stop → closed', () => {
    eq(Q.applyTimerAction(base, 'stop').timerState, 'closed');
  });
  test('无活动时不抛错', () => {
    eq(Q.applyTimerAction(null, 'pause', 1000), null);
  });
});

suite('qy-bridge · 链路快照', () => {
  test('未启用时 start 后状态为 off，且不抛错', () => {
    const cfg = { qy: { enabled: false, host: '127.0.0.1', port: 1883, username: 'siot', password: 'x', reportHeartbeat: false, heartbeatSec: 15 }, machineId: 'M-12345678', seat: '' };
    const b = Q.createQyBridge({ getConfig: () => cfg, logger: null, onEvent: () => {} });
    b.start();
    const s = b.snapshot();
    eq(s.state, 'off');
    eq(s.enabled, false);
    eq(s.clientId, 'RNET_M-12345678');
    b.stop();
  });
});
