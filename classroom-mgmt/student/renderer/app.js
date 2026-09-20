'use strict';
// 学生端控制器：状态机 + MQTT 收发语义 + DOM 事件委托。上行 checkin/task/return/hello，
// 心跳 status，下行 cmd/sync 由 Downlink 处理；上行无回执，靠 1.5s 后补发 hello + sync 回传校正。
(function () {
  const T = window.ClassroomTopics;
  const Views = window.Views;
  const HB_INTERVAL_MS = 15000;
  const LS_KEY = 'classroom.student.v1';

  const els = {};
  const state = {
    machineId: '', seat: '', name: '', studentNo: '',
    phase: 'idle', currentTask: null, taskStatus: null,
    checkinDone: false, returnDone: false, role: 'member',
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
  let homeCtx = null; // 桌面配置：课程名 + 应用列表（viewHome 渲染磁贴主屏用）
  let uiForce = null; // 浮窗跳转强制阶段（自清除，见 renderStage）
  let floatLink = null; // 置顶独立浮窗联动（状态推送 + 动作接收，见 float-link.js）

  // 审计：关键操作打 [audit]（stdout + userData/audit.log 落盘）
  function audit(type, detail) { try { const line = '[audit][' + type + '] ' + (detail == null ? '' : String(detail)); console.log(line); if (window.classroom && window.classroom.log) window.classroom.log(line); } catch (_e) { /* 审计不阻断 */ } }

  function bridge() { return window.classroom || null; }

  function log(msg) { console.log('[student]', msg); const b = bridge(); if (b && b.log) b.log(String(msg)); }

  function pad2(v) { const m = String(v == null ? '' : v).trim().match(/^\d{1,2}$/); if (!m) return ''; const n = parseInt(m[0], 10); return n >= 1 && n <= 99 ? String(n).padStart(2, '0') : ''; }

  // ---------------------------------------------------------------------------
  // 本地会话快照：localStorage 尽力而为，失败不阻断主流程（座位/姓名另由主进程持久化）
  // ---------------------------------------------------------------------------
  function saveLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify({ seat: state.seat, name: state.name, studentNo: state.studentNo, borrowed: state.borrowed, taskStatus: state.taskStatus, equipQty: state.equipQty, checkinDone: state.checkinDone, returnDone: state.returnDone, returnChecked: state.returnChecked })); } catch (_e) { /* 隐私模式/配额满，忽略 */ } }

  function loadLocal() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (_e) { return {}; } }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------
  function renderStage() {
    // 登记/归还回归整屏独立页：阶段切换完全由教师端指令（sync/cmd）驱动，不再有浮窗强制跳转。
    const phase = state.phase;
    els.stage.innerHTML = Views.render(Object.assign({}, state, { phase: phase }))
      + '<button type="button" class="sync-foot" data-act="sync-status">↻ 同步状态（手动刷新）</button>';
    saveLocal();
    // 必须用 window. 而非裸 global（渲染层没有 global 变量，裸引用抛错会中断 boot → MQTT 永连不上）。
    if (window.StageFx) window.StageFx.onPhase(phase);
    if (floatLink) floatLink.push(); // 状态快照推给置顶浮窗（独立 BrowserWindow，经主进程转发）
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
    audit('up:' + type, 'seat=' + (state.seat || '') + ' ' + JSON.stringify(payload || {}).slice(0, 200));
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
    // 磁贴主屏：点磁贴启动应用（沿用 desktop.js 的 launchApp 语义，失败也要提示）。
    // 用类选择器而不是 #home-grid：课堂页的磁贴网格由 views.viewHome 渲染，只有 class 没有 id，
    // 写成 #home-grid 会永远不匹配 —— 症状是"点磁贴完全没反应"，且不报错，极难查。
    const t = e.target.closest ? e.target.closest('.home-grid [data-id]') : null;
    if (t) { launchApp(t.dataset.id); return; }
    if (actions) actions.onStageClick(e);
  }

  // 启动课程应用：复用主进程 bridge.launchApp，成功/失败都不静默（桌面端曾因静默 return 无反馈）
  async function launchApp(id) {
    const b = bridge();
    if (!b || !b.launchApp) { toast('当前环境不支持启动应用', 'error'); return; }
    let r = null;
    try { r = await b.launchApp(id); } catch (_e) { r = null; }
    const app = ((homeCtx && homeCtx.apps) || []).find((a) => a.id === id);
    if (!r) toast('启动失败：未收到主进程回应', 'error');
    else if (r.ok === false) toast((r.err || '启动失败') + '，请先保存设置', 'error');
    else toast('已打开：' + (app ? app.name : id), 'info');
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
      state, toast, renderStage, renderShutdown, bridge, log, pad2, audit,
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
    // 置顶独立浮窗（float-window.js 创建的 BrowserWindow）：本页是 MQTT 真源，
    // 状态快照经主进程转发；浮窗按钮动作回流 onAction（状态三键/跳转/退出课堂）。
    // 口令校验在浮窗内走主进程 shell:verify-local，通过后才发 exit 动作。
    if (typeof window.FloatLink !== 'undefined') {
      floatLink = window.FloatLink.create({
        state, els, toast, renderStage, saveLocal, sendUp, audit, bridge,
        actions,
        resetEquipQty: () => actions.resetEquipQty(),
        onJump: (k) => { uiForce = (k === 'checkin' || k === 'return') ? k : null; renderStage(); },
      });
      const fb = bridge();
      if (fb && fb.onFloatAction) fb.onFloatAction((p) => { if (floatLink) floatLink.onAction(p); });
    }
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
      // 取一次桌面配置（课程名 + 应用列表）供 viewHome 渲染磁贴主屏；失败不阻断，用空主屏（引导文案）
      try {
        const d = await bridge().getDesktopConfig();
        homeCtx = {
          courseName: (d.course && d.course.name) || '信息技术课',
          apps: (d.course && d.course.apps) || [],
          homeApps: (d.course && d.course.homeApps) || [],
        };
        Views.setHomeContext(homeCtx);
      } catch (_e) { /* 桌面配置不可得则空主屏 */ }
    } else {
      runtime = { machineId: 'M-WEBPREVIEW', siotIp: '127.0.0.1', siotWsPort: 1888, username: 'siot', password: 'dfrobot', shutdownDelaySec: 60 };
      log('未检测到 preload 桥接，以浏览器预览模式运行（不执行真实关机）');
    }
    audit('boot', 'machineId=' + runtime.machineId + ' app=' + (local ? local.name || local.seat : '') + ' 桥接=' + (bridge() ? 'yes' : 'no'));
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