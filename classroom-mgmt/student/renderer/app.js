'use strict';
// =============================================================================
// 学生端控制器：状态机 + MQTT 收发语义 + DOM 事件委托。
//
// 上行（siot/ict_up QoS1）：checkin / task / return / hello
// 心跳（siot/ict_hb QoS0）：status  —— 教师端以此判定在线（15s 发、45s 判离线）
// 下行（siot/ict_cmd）：cmd{start|task|end|shutdown|reset}   → Downlink（downlink.js）
// 同步（siot/ict_sync）：sync{phase,currentTask,checkinDone,returnDone}
//
// 无 ACK 补偿：上行没有回执，因此提交后延迟 1.5s 补发 hello，靠 sync 回传的
// checkinDone / returnDone 做服务端真值校正——教师端没写进去就回滚并提示学生。
//
// 职责划分：
//   app.js      控制器装配：状态、渲染、上行、连接生命周期
//   downlink.js 下行指令处理（cmd/sync 语义、阶段机、关机倒计时）
//   actions.js  业务动作（登记/任务状态/归还、器材区块交互、事件委托）
// =============================================================================
(function () {
  const T = window.ClassroomTopics;
  const Views = window.Views;
  const HB_INTERVAL_MS = 15000;
  const LS_KEY = 'classroom.student.v1';

  const els = {};
  const state = {
    machineId: '', seat: '', name: '', studentNo: '',
    phase: 'idle', currentTask: null, taskStatus: null,
    checkinDone: false, returnDone: false,
    equipQty: {}, borrowed: [], returnChecked: {}, note: '',
    conn: 'offline',
    shutdownIn: null, shutdownDryRun: false,
    locked: false,
  };

  let net = null;
  let runtime = null;
  let hbTimer = null;
  let toastTimer = null;
  let downlink = null;
  let actions = null;

  function bridge() {
    return window.classroom || null;
  }

  function log(msg) {
    // eslint-disable-next-line no-console
    console.log('[student]', msg);
    const b = bridge();
    if (b && b.log) b.log(String(msg));
  }

  function pad2(v) {
    const m = String(v == null ? '' : v).trim().match(/^\d{1,2}$/);
    if (!m) return '';
    const n = parseInt(m[0], 10);
    return n >= 1 && n <= 99 ? String(n).padStart(2, '0') : '';
  }

  // ---------------------------------------------------------------------------
  // 本地会话快照：localStorage 尽力而为，失败不阻断主流程（座位/姓名另由主进程持久化）
  // ---------------------------------------------------------------------------
  function saveLocal() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        seat: state.seat, name: state.name, studentNo: state.studentNo,
        borrowed: state.borrowed, taskStatus: state.taskStatus,
        equipQty: state.equipQty, checkinDone: state.checkinDone,
        returnDone: state.returnDone, returnChecked: state.returnChecked,
      }));
    } catch (_e) { /* 隐私模式/配额满，忽略 */ }
  }

  function loadLocal() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
    } catch (_e) {
      return {};
    }
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------
  function renderStage() {
    els.stage.innerHTML = Views.render(state);
    saveLocal();
  }

  function renderConn() {
    const map = {
      online: { name: 'wifi', text: '已连接' },
      reconnecting: { name: 'loader-circle', text: '重连中' },
      offline: { name: 'wifi-off', text: '未连接' },
    };
    const m = map[state.conn] || map.offline;
    els.conn.dataset.state = state.conn;
    els.connIcon.innerHTML = window.Icons.svg(m.name, 20, state.conn === 'reconnecting' ? 'spin' : '');
    els.connText.textContent = m.text;
  }

  function renderMeta() {
    els.seatChip.innerHTML = window.Icons.svg('hash', 16)
      + '<span>' + Views.esc(state.seat || '未设置') + '</span>';
    els.machineChip.innerHTML = window.Icons.svg('monitor', 16)
      + '<span>' + Views.esc(state.machineId) + '</span>';
  }

  function renderShutdown() {
    if (state.shutdownIn == null) {
      els.shutdown.hidden = true;
      return;
    }
    els.shutdown.hidden = false;
    els.shutdown.dataset.dry = state.shutdownDryRun ? 'true' : 'false';
    els.shutdownText.textContent = state.shutdownDryRun
      ? '关机演练：真实环境将在 ' + state.shutdownIn + ' 秒后关机（当前为演练，不会执行）'
      : '计算机将在 ' + state.shutdownIn + ' 秒后关机，请及时保存作品';
  }

  function toast(msg, kind) {
    els.toast.textContent = msg;
    els.toast.dataset.kind = kind || 'info';
    els.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3600);
  }

  // ---------------------------------------------------------------------------
  // 上行
  // ---------------------------------------------------------------------------
  function sendUp(type, payload) {
    const env = T.makeEnvelope({
      type,
      seat: state.seat || '*',
      group: '*', // 让教师端按 GROUP_SIZE 自行推导，避免两端配置不同步
      machineId: state.machineId,
      payload: payload || {},
    });
    const sent = net.publishUp(env);
    if (!sent) toast('当前与教师机未连接，操作暂未送出', 'warn');
    return sent;
  }

  function sendHeartbeat() {
    if (!state.seat || !net.isOnline()) return;
    net.publishHeartbeat(T.makeEnvelope({
      type: 'status',
      seat: state.seat,
      group: '*',
      machineId: state.machineId,
      payload: { online: true, phase: state.phase },
    }));
  }

  function sendHello() {
    if (!state.seat || !net.isOnline()) return false;
    return sendUp('hello', { phase: state.phase });
  }

  function startHeartbeat() {
    if (hbTimer) clearInterval(hbTimer);
    sendHeartbeat();
    hbTimer = setInterval(sendHeartbeat, HB_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // 连接状态
  // ---------------------------------------------------------------------------
  function onNetState(s) {
    state.conn = s.state;
    renderConn();
    if (s.state === 'online') {
      startHeartbeat();
      sendHello(); // cleanSession=true，每次连上都靠 hello 换 sync 恢复阶段
    } else if (hbTimer) {
      clearInterval(hbTimer);
      hbTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // 事件委托
  // ---------------------------------------------------------------------------
  function onStageClick(e) {
    if (actions) actions.onStageClick(e);
  }

  function onStageKeydown(e) {
    if (actions) actions.onStageKeydown(e);
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------
  function bindDom() {
    els.stage = document.getElementById('stage');
    els.toast = document.getElementById('toast');
    els.conn = document.getElementById('conn');
    els.connIcon = document.getElementById('conn-icon');
    els.connText = document.getElementById('conn-text');
    els.seatChip = document.getElementById('seat-chip');
    els.machineChip = document.getElementById('machine-chip');
    els.shutdown = document.getElementById('shutdown');
    els.shutdownText = document.getElementById('shutdown-text');
    els.lock = document.getElementById('lock-overlay');
    els.stage.addEventListener('click', onStageClick);
    els.stage.addEventListener('keydown', onStageKeydown);
  }

  function hydrate(local, rt) {
    state.machineId = rt.machineId || '';
    state.seat = pad2(local.seat || rt.seat || '');
    state.name = local.name || rt.name || '';
    state.studentNo = local.studentNo || rt.studentNo || '';
    state.borrowed = Array.isArray(local.borrowed) ? local.borrowed : [];
    state.returnChecked = local.returnChecked && typeof local.returnChecked === 'object' ? local.returnChecked : {};
    state.taskStatus = ['doing', 'done', 'help'].includes(local.taskStatus) ? local.taskStatus : null;
    if (local.equipQty && typeof local.equipQty === 'object') state.equipQty = local.equipQty;
    else actions.resetEquipQty();
    // 座位/姓名以主进程配置为准时，localStorage 可能是上一堂课的残留，仅作预填
    renderMeta();
    renderConn();
    renderStage();
  }

  function wire() {
    // 活动计时器 + 锁定遮罩（control.js）
    const control = window.StudentControl.create({ state, els, toast, renderStage });
    // 下行指令 → Downlink（cmd/sync 语义）
    downlink = window.Downlink.create({
      state, toast, renderStage, renderShutdown, bridge, log, pad2,
      resetEquipQty: () => actions.resetEquipQty(),
      getRuntime: () => runtime,
      onEquipment: (p) => {
        // 教师端下发器材清单：原地替换 → 重置勾选 → 重渲染登记页
        if (Array.isArray(p.equipment) && p.equipment.length) {
          globalThis.applyEquipmentList(p.equipment);
          if (state.phase === 'checkin') actions.resetEquipQty();
          renderStage();
          toast(p.activityName ? '本节课活动：' + p.activityName : '器材清单已更新', 'info');
        }
      },
      onTimer: control.applyTimer,
      onPolicy: control.applyPolicy,
    });
    // 业务动作 → Actions（登记/任务状态/归还/器材交互）
    actions = window.Actions.create({
      state, els, sendUp, sendHello, renderStage, renderMeta, bridge, log, pad2,
      saveLocal, toast,
    });
    control.startTicker();
  }

  function connect() {
    net = window.Net.create({
      url: 'ws://' + runtime.siotIp + ':' + runtime.siotWsPort + '/ws',
      clientId: 'stu_' + state.machineId,
      username: runtime.username,
      password: runtime.password,
    });
    net.on('state', onNetState);
    net.on('message', (m) => {
      if (m.env.type === 'cmd') downlink.onCommand(m.env);
      else if (m.env.type === 'sync') downlink.onSync(m.env);
    });
    net.start();
  }

  async function boot() {
    bindDom();
    const local = loadLocal();
    if (bridge()) {
      runtime = await bridge().getRuntime();
    } else {
      runtime = { machineId: 'M-WEBPREVIEW', siotIp: '127.0.0.1', siotWsPort: 1888, username: 'siot', password: 'dfrobot', shutdownDelaySec: 60 };
      log('未检测到 preload 桥接，以浏览器预览模式运行（不执行真实关机）');
    }
    wire();
    hydrate(local, runtime);
    if (!window.mqtt || !window.mqtt.connect) {
      toast('MQTT 客户端未加载，请执行 npm install 后重启', 'error');
      return;
    }
    connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
