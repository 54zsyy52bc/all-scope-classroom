'use strict';
// 全域课堂连接状态页：链路 + 课堂阶段 + 协议对照
(function () {
  const { api, esc, toast, log } = window.GN;

  const STATE_MAP = {
    online: ['已连接', 'ok', '和老师的课堂系统连上了'],
    connecting: ['连接中…', 'info', '正在连接 SIoT 物联网服务'],
    backoff: ['重连中…', 'warn', '连接断开，正在自动重试（最长 30 秒一次）'],
    off: ['未启用', 'info', '当前没有开启全域联动，可在管理页打开'],
    'no-mqtt': ['缺少依赖', 'err', '没有找到 mqtt 依赖，请重新执行 npm install'],
    error: ['连接异常', 'err', '连接出错，请检查 SIoT 地址与账号'],
  };

  const PHASE_MAP = { waiting: '等待上课', checkin: '课前登记', task: '活动进行中', return: '器材归还', closed: '已下课' };
  const TIMER_MAP = { idle: '未开始计时', running: '计时进行中', paused: '已暂停', expired: '已截止', closed: '已结束' };

  function fmt(ms) {
    if (ms == null) return '--';
    const s = Math.max(0, Math.round(Number(ms) / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  async function refresh() {
    try {
      const r = await api.getQy();
      if (!r || !r.ok) { toast((r && r.err) || '读取失败', 'warn'); return; }
      paint(r.qy, r.lock);
    } catch (e) { log('getQy 异常：' + (e && e.message)); }
  }

  function paint(q, locked) {
    if (!q) return;
    const m = STATE_MAP[q.state] || ['未知', 'info', ''];
    const box = document.getElementById('status');
    box.className = 'state ' + m[1];
    document.getElementById('status-text').textContent = m[0] + '　·　' + m[2] + (q.detail ? '（' + q.detail + '）' : '');

    document.getElementById('kv').innerHTML = ''
      + '<dt>开关</dt><dd>' + (q.enabled ? '已启用' : '未启用') + '</dd>'
      + '<dt>服务器</dt><dd class="mono">' + esc(q.brokerUrl) + '</dd>'
      + '<dt>客户端 ID</dt><dd class="mono">' + esc(q.clientId) + '</dd>'
      + '<dt>座位号</dt><dd>' + (q.seat ? esc(q.seat) : '<span class="muted">未设置（心跳不会上报）</span>') + '</dd>'
      + '<dt>心跳上报</dt><dd>' + (q.reportHeartbeat ? '开启' : '关闭') + '</dd>'
      + '<dt>收到消息</dt><dd>' + (q.msgCount || 0) + ' 条' + (q.lastMsgAt ? '　（最近 ' + new Date(q.lastMsgAt).toLocaleTimeString() + '）' : '') + '</dd>';

    document.getElementById('v-phase').textContent = PHASE_MAP[q.phase] || (q.phase || '未上课');
    document.getElementById('v-policy').textContent = (q.policy && q.policy.mode)
      ? (q.policy.mode === 'activity' ? '活动模式（非活动时间自动锁定）' : '开放模式（全课可用）')
      : '--';
    document.getElementById('v-lock').textContent = locked ? '🔒 锁定中' : '未锁定';
    const t = q.task;
    document.getElementById('v-task').textContent = t
      ? (t.title || t.taskId || '课堂活动') + '　' + (TIMER_MAP[t.timerState] || '') + (t.timed ? '　剩余 ' + fmt(t.remainingMs) : '')
      : '暂无活动';

    if (q.topics) {
      document.getElementById('t-cmd').textContent = q.topics.cmd || 'siot/ict_cmd';
      document.getElementById('t-sync').textContent = q.topics.sync || 'siot/ict_sync';
      document.getElementById('t-hb').textContent = q.topics.hb || 'siot/ict_hb';
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-refresh').onclick = refresh;
    document.getElementById('btn-reconnect').onclick = async () => {
      const r = await api.restartQy();
      if (r && r.ok) { toast('正在重新连接…'); setTimeout(refresh, 900); }
    };
    if (api.onQy) api.onQy(refresh);
    refresh();
    setInterval(refresh, 5000); // 页面开着时保持刷新（链路状态是异步变化的）
  });
})();
