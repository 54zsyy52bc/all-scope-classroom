/* =============================================================================
   置顶浮窗渲染层（float.html 专用）。
   职责：挂载活动状态面板（复用 activity-panel.js，alwaysVisible）+ 注入「退出课堂」区
   + 悬停点击穿透管理。MQTT/业务全部在课堂页（app.js），这里只收快照、发动作。
   退出课堂口令：主进程 shell:verify-local 校验（modeExit 域）；未启用口令则二次确认。
   ============================================================================= */
(function () {
  'use strict';

  var bb = window.floatBridge || null;
  var needPwd = false; // modeExit 口令是否启用（getShellConfig 异步回填）
  var exitMode = 'idle'; // idle | ask | pwd
  var root = null;

  function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }

  // ---- 退出区样式：只加一次，复用全局 Token，不写死颜色 ----
  function injectStyle() {
    if (document.getElementById('float-exit-style')) return;
    var s = document.createElement('style'); s.id = 'float-exit-style';
    s.textContent = '' +
      '.fe-bar{display:flex;flex-direction:column;gap:8px;margin-top:2px;padding-top:10px;' +
      'border-top:1px dashed var(--border);}' +
      '.fe-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:44px;' +
      'border:2px solid var(--border);border-radius:12px;background:var(--surface);color:var(--muted);' +
      'font-size:16px;font-weight:700;cursor:pointer;}' +
      '.fe-btn:hover{border-color:var(--help);color:var(--help);}' +
      '.fe-ask{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;color:var(--fg);}' +
      '.fe-ask .fe-yes{margin-left:auto;}' +
      '.fe-mini{border:2px solid var(--border);border-radius:10px;background:var(--surface);color:var(--fg);' +
      'min-height:38px;padding:0 12px;font-size:15px;font-weight:700;cursor:pointer;}' +
      '.fe-mini:hover{border-color:var(--accent);}' +
      '.fe-pwd{display:flex;gap:8px;}' +
      '.fe-pwd input{flex:1;min-height:38px;border:2px solid var(--border);border-radius:10px;' +
      'background:var(--surface);color:var(--fg);font-size:15px;padding:0 10px;}' +
      '.fe-err{font-size:14px;font-weight:700;color:var(--help);}' +
      '.fe-note{font-size:13px;color:var(--muted);line-height:1.4;}';
    document.head.appendChild(s);
  }

  // ---- 退出区 DOM（注入面板 body 尾部；panel.render 只改自己的节点，不会碰这里）----
  var fe = {};
  function buildExitBar(body) {
    fe.bar = el('div', 'fe-bar');
    fe.main = el('button', 'fe-btn'); fe.main.type = 'button';
    fe.main.innerHTML = window.Icons ? window.Icons.svg('power-off', 20) + '<span>退出课堂</span>' : '<span>退出课堂</span>';
    fe.ask = el('div', 'fe-ask'); fe.ask.hidden = true;
    fe.askTxt = el('span', ''); fe.askTxt.textContent = '确定退出本节课？';
    fe.yes = el('button', 'fe-mini fe-yes'); fe.yes.type = 'button'; fe.yes.textContent = '确定退出';
    fe.no = el('button', 'fe-mini'); fe.no.type = 'button'; fe.no.textContent = '取消';
    fe.ask.appendChild(fe.askTxt); fe.ask.appendChild(fe.yes); fe.ask.appendChild(fe.no);
    fe.pwd = el('div', 'fe-pwd'); fe.pwd.hidden = true;
    fe.input = el('input', ''); fe.input.type = 'password'; fe.input.placeholder = '输入老师设置的口令';
    fe.ok = el('button', 'fe-mini'); fe.ok.type = 'button'; fe.ok.textContent = '确认退出';
    fe.pwd.appendChild(fe.input); fe.pwd.appendChild(fe.ok);
    fe.err = el('div', 'fe-err'); fe.err.hidden = true;
    fe.note = el('div', 'fe-note');
    fe.note.textContent = '退出后回到待课状态，老师下发新活动时自动回归；退出会上报到教师大屏。';
    fe.bar.appendChild(fe.main); fe.bar.appendChild(fe.ask); fe.bar.appendChild(fe.pwd);
    fe.bar.appendChild(fe.err); fe.bar.appendChild(fe.note);
    body.appendChild(fe.bar);

    fe.main.addEventListener('click', function () { setMode(needPwd ? 'pwd' : 'ask'); });
    fe.no.addEventListener('click', function () { setMode('idle'); });
    fe.yes.addEventListener('click', function () { doExit(); });
    fe.ok.addEventListener('click', function () { verifyPwd(); });
    fe.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') verifyPwd(); });
  }

  function setMode(m) {
    exitMode = m;
    fe.ask.hidden = (m !== 'ask');
    fe.pwd.hidden = (m !== 'pwd');
    fe.err.hidden = true;
    fe.main.hidden = (m !== 'idle');
    if (m === 'pwd') { fe.input.value = ''; try { fe.input.focus(); } catch (_e) { /* noop */ } }
  }

  function fail(msg) { fe.err.textContent = msg; fe.err.hidden = false; }

  function doExit() {
    setMode('idle');
    if (bb) bb.sendAction({ type: 'exit' });
  }

  function verifyPwd() {
    var pwd = fe.input.value || '';
    if (!pwd) { fail('请输入口令'); return; }
    if (bb) {
      bb.verifyLocal('modeExit', pwd).then(function (r) {
        if (r && r.ok) doExit();
        else fail('口令不对，请再试');
      }).catch(function () { fail('校验失败，请重试'); });
    }
  }

  // ---- 挂载面板 + 注入退出区 + 点击穿透 ----
  function boot() {
    injectStyle();
    if (typeof window.ActivityPanel === 'undefined') return;
    window.ActivityPanel.mount({
      icon: window.Icons ? window.Icons.svg : function () { return ''; },
      alwaysVisible: true, // 独立窗口不再遮挡页面内容，所有课堂阶段都显示
      onStatus: function (k) { if (bb) bb.sendAction({ type: 'status', status: k }); },
      onJump: function (k) { if (bb) bb.sendAction({ type: 'jump', to: k }); },
      decorate: function (refs) {
        root = refs.root;
        buildExitBar(refs.body);
        // 悬停接管输入 / 离开恢复穿透：透明窗口区域不挡底下课程应用的点击
        root.addEventListener('mouseenter', function () { if (bb) bb.setClickthrough(false); });
        root.addEventListener('mouseleave', function () { if (bb) bb.setClickthrough(true); });
      },
    });
    if (root && bb) bb.setClickthrough(true);
    if (bb) {
      bb.getShellConfig().then(function (cfg) {
        needPwd = !!(cfg && cfg.modeExit && cfg.modeExit.enabled);
        if (!needPwd) {
          fe.note.textContent = '未设置退出口令，退出仅二次确认。可在学生端「管理」里配置。';
        }
      }).catch(function () { /* 配置不可得则默认口令模式，验证时兜底提示 */ });
      bb.onState(function (state) { window.ActivityPanel.render(state); });
      bb.sendAction({ type: 'sync-request' }); // 向课堂页要一份当前状态快照
    } else {
      var p = el('div', 'ap-sub');
      p.textContent = '浮窗桥接不可用（调试模式）';
      p.style.cssText = 'padding:14px;color:#b00;';
      document.body.appendChild(p);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
