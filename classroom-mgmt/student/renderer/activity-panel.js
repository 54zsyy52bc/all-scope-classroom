/* =============================================================================
   活动状态报告浮窗（学生端）。替代整页课中状态屏，低水平用户友好。
   关键坑：render() 每秒被调用一次，所以——
   1) 入场动画只在 mount() 创建根节点时挂一次 class，render 永不碰它，绝不重播；
   2) render() 只改文本/选中态/显隐，不重建 DOM，便宜且幂等；
   3) 面板用 <div>，绝不给 <span> 设宽高（行内元素塌成 0x0 的坑）。
   自包含 IIFE，挂 window.ActivityPanel，不依赖 app.js/desktop.js。
   ============================================================================= */
(function () {
  'use strict';

  var root = null, styleDone = false, iconFn = function () { return ''; };
  var opts = { onStatus: function () {}, onJump: function () {}, alwaysVisible: false, decorate: null };
  var collapsed = false, lastState = null;
  var override = null, flashUntil = 0; // 乐观选中 + “已记下”瞬时反馈

  var PHASE = { idle: '待课', checkin: '登记中', task: '课中', return: '归还中', closed: '已结束' };
  var STATUS_ICON = { doing: 'loader-circle', done: 'check-square', help: 'hand-helping' };
  var TIMER_LABEL = { running: '计时中', paused: '已暂停', expired: '时间到' };
  var els = {};

  function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(ms) { var t = Math.max(0, Math.ceil(ms / 1000)); return pad2(Math.floor(t / 60)) + ':' + pad2(t % 60); }

  // ---- 注入样式：只加一次，复用全局 Token，不写死颜色 ----
  function injectStyle() {
    if (styleDone) return;
    var css = '' +
      '.activity-panel{position:fixed;left:18px;bottom:18px;z-index:45;width:320px;max-width:calc(100vw - 36px);' +
      'background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:var(--radius,14px);' +
      'box-shadow:var(--elev-raised);font-family:var(--font-body);overflow:hidden;' +
      'transition:opacity var(--motion-slow) var(--ease),transform var(--motion-slow) var(--ease);}' +
      '.activity-panel.ap-enter{animation:apRise var(--motion-slow) var(--ease) both;}' +
      '@keyframes apRise{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:none;}}' +
      '.ap-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border);}' +
      '.ap-phase{font-size:14px;color:var(--muted);background:var(--surface-2);padding:3px 9px;border-radius:999px;}' +
      '.ap-toggle{margin-left:auto;border:none;background:transparent;color:var(--accent);font-size:15px;' +
      'cursor:pointer;padding:6px 8px;border-radius:8px;}' +
      '.ap-toggle:hover{background:var(--accent-soft);}' +
      '.ap-body{display:flex;flex-direction:column;gap:10px;padding:12px 14px 14px;}' +
      '.ap-title{margin:0;font-size:20px;line-height:1.3;font-weight:700;}' +
      '.ap-sub{margin:0;font-size:16px;color:var(--muted);line-height:1.45;}' +
      '.ap-help-note{font-size:16px;font-weight:700;color:var(--help);background:var(--surface-2);' +
      'border-left:4px solid var(--help);padding:8px 10px;border-radius:8px;}' +
      '.ap-timer{display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--surface-2);border-radius:10px;}' +
      '.ap-time{font-family:var(--font-mono);font-size:30px;font-weight:800;letter-spacing:1px;}' +
      '.ap-time-label{font-size:15px;color:var(--muted);margin-left:auto;}' +
      '.ap-timer[data-state="expired"] .ap-time{color:var(--help);}' +
      '.ap-timer[data-state="paused"] .ap-time{color:var(--muted);}' +
      '.ap-actions{display:flex;}' +
      '.ap-btn-primary{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:64px;' +
      'border:none;border-radius:12px;background:var(--accent);color:var(--accent-on);font-size:20px;' +
      'font-weight:800;cursor:pointer;}' +
      '.ap-btn-primary:hover{background:var(--accent-hover);}' +
      '.ap-btn-primary:active{background:var(--accent-active);}' +
      '.ap-status{display:flex;flex-direction:column;gap:10px;}' +
      '.ap-status-btn{display:flex;align-items:center;gap:10px;min-height:56px;padding:0 14px;' +
      'border:2px solid var(--border);border-radius:12px;background:var(--surface);color:var(--fg);' +
      'font-size:18px;font-weight:600;cursor:pointer;text-align:left;}' +
      '.ap-status-btn:hover{border-color:var(--accent);}' +
      '.ap-status-btn.is-on{font-weight:800;color:#fff;border-color:transparent;}' +
      '.ap-status-btn[data-status="doing"].is-on{background:var(--doing);}' +
      '.ap-status-btn[data-status="done"].is-on{background:var(--done);}' +
      '.ap-status-btn[data-status="help"].is-on{background:var(--help);}' +
      '.ap-cap{display:flex;align-items:center;gap:10px;padding:12px 14px;}' +
      '.ap-cap-time{font-family:var(--font-mono);font-size:24px;font-weight:800;}' +
      '.ap-cap-label{font-size:15px;color:var(--muted);}';
    var s = document.createElement('style'); s.id = 'activity-panel-style'; s.textContent = css;
    document.head.appendChild(s); styleDone = true;
  }

  function build() {
    root = el('div', 'activity-panel ap-enter'); root.id = 'activity-panel';
    // 初始隐藏：登记/归还/待课/结束都是整屏独立页，浮窗只在课中（task）出现，
    // 否则会盖住登记表单输入框（fixed 定位 z-index 45 压在表单上）。第一次 task render 时再显示。
    root.style.display = 'none';
    var head = el('div', 'ap-head');
    els.phase = el('span', 'ap-phase');
    els.toggle = el('button', 'ap-toggle'); els.toggle.type = 'button'; els.toggle.textContent = '收起';
    head.appendChild(els.phase); head.appendChild(els.toggle);

    var body = el('div', 'ap-body');
    els.body = body; // 必须挂到 els 上：applyCollapse() 要读写 els.body.hidden，
                     // 只留局部变量会让 mount() 在 applyCollapse() 里抛
                     // "Cannot set properties of undefined"，浮窗挂不上且中断调用方后续初始化。
    els.title = el('h2', 'ap-title');
    els.sub = el('p', 'ap-sub');
    els.help = el('div', 'ap-help-note'); els.help.textContent = '已通知老师，请举手等待'; els.help.hidden = true;
    els.timer = el('div', 'ap-timer'); els.timer.hidden = true;
    els.timerIco = el('span', 'ap-ico');
    els.time = el('span', 'ap-time');
    els.timeLab = el('span', 'ap-time-label');
    els.timer.appendChild(els.timerIco); els.timer.appendChild(els.time); els.timer.appendChild(els.timeLab);
    els.actions = el('div', 'ap-actions');
    els.primary = el('button', 'ap-btn-primary'); els.primary.type = 'button'; els.primary.hidden = true;
    els.actions.appendChild(els.primary);
    els.status = el('div', 'ap-status'); els.status.hidden = true;
    els.btns = {};
    ['doing', 'done', 'help'].forEach(function (k) {
      var b = el('button', 'ap-status-btn'); b.type = 'button'; b.dataset.status = k;
      var ico = el('span', 'ap-ico'), lab = el('span', 'ap-status-label');
      b.appendChild(ico); b.appendChild(lab); els.status.appendChild(b); els.btns[k] = { b: b, ico: ico, lab: lab };
    });
    body.appendChild(els.title); body.appendChild(els.sub); body.appendChild(els.help);
    body.appendChild(els.timer); body.appendChild(els.actions); body.appendChild(els.status);

    els.cap = el('div', 'ap-cap'); els.cap.hidden = true;
    els.capTime = el('span', 'ap-cap-time'); els.capLab = el('span', 'ap-cap-label');
    els.cap.appendChild(els.capTime); els.cap.appendChild(els.capLab);

    root.appendChild(head); root.appendChild(body); root.appendChild(els.cap);
    document.body.appendChild(root);

    root.addEventListener('click', onClick);
  }

  function onClick(e) {
    var t = e.target.closest('[data-status],[data-jump],.ap-toggle');
    if (!t) return;
    if (t === els.toggle) { collapsed = !collapsed; applyCollapse(); return; }
    if (t.dataset.jump) { opts.onJump(t.dataset.jump); return; }
    if (t.dataset.status) {
      var k = t.dataset.status;
      override = k; flashUntil = Date.now() + 1200; // 乐观选中 + 瞬时“已记下”
      opts.onStatus(k);
      render(lastState);
      setTimeout(function () { render(lastState); }, 1300); // 回落瞬时文案
    }
  }

  function applyCollapse() {
    if (!root) return;
    els.body.hidden = collapsed;
    els.cap.hidden = !collapsed;
    els.phase.hidden = collapsed;
    els.toggle.textContent = collapsed ? '展开' : '收起';
    // 立刻回填一次：否则点「收起」后到下一次 render 之间胶囊是空白的
    // （计时没在跑时 render 不是每秒都来，学生可能盯着一个空胶囊）。
    if (lastState) render(lastState);
  }

  function statusLabel(k, on, flashing) {
    if (flashing) return '已记下';
    if (!on) return { doing: '进行中', done: '已完成', help: '求助' }[k];
    return { doing: '进行中（已选）', done: '已完成（已确认）', help: '已求助（请举手）' }[k];
  }

  function timerStateOf(t) {
    // 只认 running/paused/expired 三种。idle（未开始）与 closed（教师提前结束）都不显示计时区：
    // closed 时 remainingMs=0 不为 null，若放行会渲染出「00:00 + undefined」
    // （views.js 的 timerBlock 同样把 closed 排除在外，两处口径必须一致）。
    if (!t || !t.timed || t.remainingMs == null) return null;
    return TIMER_LABEL[t.timerState] ? t.timerState : null;
  }

  function render(state) {
    if (!root || !state) return; // 未 mount / 元素不存在时安全返回
    lastState = state;

    var phase = state.phase || 'idle';
    // 非课中阶段整窗隐藏（登记/归还/待课/结束都是整屏独立页，浮窗只会挡内容、
    // 挡住磁贴和表单点击 —— 这是"应用打不开/表单点不到"的直接原因）。
    // 用 style.display 而不是 hidden：display:none→显示会重播 ap-enter 入场动画，只在此阶段切换时发生一次，可接受。
    // 独立置顶浮窗（alwaysVisible）是另一个 OS 窗口，不存在遮挡页面的问题，全程显示。
    root.style.display = (phase === 'task' || opts.alwaysVisible) ? '' : 'none';
    var t = state.currentTask;
    var timed = !!(t && t.timed);
    var tState = timerStateOf(t);
    var effStatus = (phase === 'task' && t && override != null) ? override : state.taskStatus;

    if (phase !== 'task' || !t) override = null; // 离开课中/无活动则放弃乐观态
    else if (override != null && state.taskStatus === override) override = null; // 服务端回显即收尾

    // 阶段文案
    var title = '', sub = '', showHelp = false;
    if (phase === 'idle') { title = '等老师开始上课'; sub = '老师点「开始上课」后，这里会出现要做的活动'; }
    else if (phase === 'checkin') {
      if (state.checkinDone) { title = '本组已登记'; sub = '等老师发布活动'; }
      else { title = '现在要登记'; sub = '点一下就能登记，只要填自己的名字'; }
    } else if (phase === 'task') {
      if (t) { title = t.title; sub = t.desc || ''; }
      else { title = '等老师发布活动'; sub = '老师发布后，这里会出现活动名和计时'; }
    } else if (phase === 'return') { title = '老师要收器材了'; sub = '点下面的按钮，把借的器材勾一下再交回'; }
    else if (phase === 'closed') { title = '本课已结束'; sub = '听老师安排'; }
    els.title.textContent = title;
    if (sub) { els.sub.textContent = sub; els.sub.hidden = false; } else { els.sub.hidden = true; }

    // 计时
    if (tState) {
      els.timerIco.innerHTML = iconFn('timer', 26);
      els.time.textContent = fmt(t.remainingMs);
      els.timeLab.textContent = TIMER_LABEL[tState];
      els.timer.dataset.state = tState;
      els.timer.hidden = false;
    } else { els.timer.hidden = true; }

    // 主按钮（同一时刻最多一个实心强调按钮）
    var jump = null, jumpLabel = '', jumpIcon = '';
    if (phase === 'checkin' && !state.checkinDone) { jump = 'checkin'; jumpLabel = '去登记'; jumpIcon = 'log-in'; }
    else if (phase === 'return' && !state.returnDone) { jump = 'return'; jumpLabel = '去归还'; jumpIcon = 'package-check'; }
    if (jump) {
      els.primary.dataset.jump = jump;
      els.primary.innerHTML = iconFn(jumpIcon, 24) + '<span>' + jumpLabel + '</span>';
      els.primary.hidden = false;
    } else { els.primary.hidden = true; }

    // 三个状态按钮（仅课中且有活动）
    var showStatus = (phase === 'task' && !!t);
    els.status.hidden = !showStatus;
    if (showStatus) {
      var flashing = Date.now() < flashUntil && override != null;
      ['doing', 'done', 'help'].forEach(function (k) {
        var ref = els.btns[k], on = (effStatus === k);
        ref.b.classList.toggle('is-on', on);
        ref.b.setAttribute('aria-pressed', on ? 'true' : 'false');
        ref.ico.innerHTML = iconFn(on ? 'circle-check' : STATUS_ICON[k], 26); // 选中加勾，不只靠颜色
        ref.lab.textContent = statusLabel(k, on, flashing && on);
      });
      showHelp = (effStatus === 'help'); // 选中求助时给明显提示
    }
    els.help.hidden = !showHelp;

    // 折叠胶囊：始终能看到剩余时间
    if (collapsed) {
      if (tState) { els.capTime.textContent = fmt(t.remainingMs); els.capTime.hidden = false; els.capLab.hidden = true; }
      else { els.capTime.hidden = true; els.capLab.textContent = title; els.capLab.hidden = false; }
    }
  }

  // ---- 冻结的对外接口 ----
  window.ActivityPanel = {
    mount: function (o) {
      if (root) return; // 幂等：不产生第二份 DOM
      opts = o || opts;
      if (typeof o.icon === 'function') iconFn = o.icon;
      if (typeof o.onStatus === 'function') opts.onStatus = o.onStatus;
      if (typeof o.onJump === 'function') opts.onJump = o.onJump;
      if (typeof o.alwaysVisible === 'boolean') opts.alwaysVisible = o.alwaysVisible;
      injectStyle();
      build();
      // 扩展点：宿主（置顶浮窗）在面板 body 尾部注入自己的区块（如「退出课堂」）。
      // 只传 root/body 引用，宿主自己管理 DOM 与事件；装饰失败不影响面板本体。
      if (typeof o.decorate === 'function') { try { o.decorate({ root: root, body: els.body }); } catch (_e) { /* noop */ } }
      applyCollapse();
    },
    render: render,
    setCollapsed: function (flag) { collapsed = !!flag; applyCollapse(); },
    isMounted: function () { return !!root; }
  };
})();
