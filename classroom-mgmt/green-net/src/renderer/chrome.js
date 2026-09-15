'use strict';
// =============================================================================
// 浏览器外壳渲染层：标签栏 / 工具栏 / 活动条 / 锁定条 / 提示
//
// 与主进程的分工：
//   · 外壳负责「画」和「量」——量出内容区矩形交给主进程摆放 WebContentsView
//   · 一切导航、屏蔽、口令校验都在主进程；外壳不自己做安全判断
// =============================================================================
(function () {
  const net = window.greenNet || null;
  const $ = (id) => document.getElementById(id);

  let tabState = { tabs: [], activeId: null, visible: true };
  let dbg = null;

  function log(m) { try { if (net && net.log) net.log(m); } catch (_e) { /* noop */ } }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 内容区尺寸同步（关键：WebContentsView 不参与 DOM 布局，必须手动摆）----------
  function syncBounds() {
    const el = $('content');
    if (!el || !net) return;
    const r = el.getBoundingClientRect();
    net.setContentBounds({
      x: Math.round(r.left), y: Math.round(r.top),
      width: Math.round(r.width), height: Math.round(r.height),
    });
  }

  // ---------- 提示 ----------
  function toast(text, kind) {
    const wrap = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = String(text || '');
    wrap.appendChild(el);
    setTimeout(() => { try { wrap.removeChild(el); } catch (_e) { /* noop */ } }, 3200);
  }

  // ---------- 标签 ----------
  function faviconOf(t) {
    if (t.favicon) return '<img class="tab-fav" src="' + esc(t.favicon) + '" alt="" onerror="this.replaceWith(document.createTextNode(\'🔗\'))" />';
    if (t.internal) return '<span class="tab-fav">🌿</span>';
    return '<span class="tab-fav">🔗</span>';
  }

  function renderTabs() {
    const box = $('tabs');
    box.innerHTML = tabState.tabs.map((t) => {
      const active = t.id === tabState.activeId ? ' active' : '';
      const spin = t.loading ? ' tab-spin' : '';
      const title = esc(t.title || t.displayUrl || '新标签页');
      return '<button class="tab' + active + '" data-id="' + esc(t.id) + '" title="' + title + '">'
        + faviconOf(t)
        + '<span class="tab-ttl">' + title + '</span>'
        + '<span class="tab-x" data-close="' + esc(t.id) + '" title="关闭标签">✕</span>'
        + '</button>';
    }).join('');

    box.querySelectorAll('.tab').forEach((el) => {
      el.onclick = (e) => {
        if (e.target && e.target.dataset && e.target.dataset.close) {
          e.stopPropagation();
          if (net) net.closeTab(e.target.dataset.close);
          return;
        }
        if (net) net.activateTab(el.dataset.id);
      };
      el.onauxclick = (e) => { if (e.button === 1 && net) net.closeTab(el.dataset.id); };
    });

    const act = tabState.tabs.find((t) => t.id === tabState.activeId);
    $('btn-back').disabled = !(act && act.canGoBack);
    $('btn-forward').disabled = !(act && act.canGoForward);
    $('btn-reload').textContent = (act && act.loading) ? '✕' : '⟳';
    $('btn-reload').title = (act && act.loading) ? '停止加载' : '刷新 (F5)';

    // 地址栏：只有在输入框没有焦点时才回写，否则会打断学生正在敲的地址
    const addr = $('addr');
    if (document.activeElement !== addr) {
      addr.value = (act && act.displayUrl) || '';
    }
    $('addr-scheme').textContent = (act && act.internal) ? '🌿' : '🔒';
    if (act && act.crashed) showCrashHint();
  }

  let crashHinted = '';
  function showCrashHint() {
    const act = tabState.tabs.find((t) => t.id === tabState.activeId);
    if (!act || !act.crashed || crashHinted === act.id) return;
    crashHinted = act.id;
    toast('这个网页出了问题，点 ⟳ 重新加载试试', 'warn');
  }

  // ---------- 地址栏 ----------
  function submitAddress() {
    const v = $('addr').value.trim();
    if (!v || !net) return;
    net.go(v).then((r) => {
      if (r && r.ok === false) toast(r.err || '打不开这个地址', 'warn');
      else $('addr').blur();
    });
  }

  // ---------- 状态胶囊 ----------
  function renderRuntime(rt) {
    if (!rt || !rt.ok) return;
    dbg = rt;
    $('pill-machine').textContent = '机器 ' + (rt.machineId || '--');
    $('pill-block').textContent = rt.blockEnabled ? ('屏蔽：' + (rt.blockMode === 'whitelist' ? '仅白名单' : '已开启')) : '屏蔽：已关闭';
    $('pill-block').className = 'pill ' + (rt.blockEnabled ? 'on' : 'off');
  }

  function renderQy(snap) {
    const el = $('pill-qy');
    if (!snap) { el.textContent = '全域：未启用'; el.className = 'pill off'; return; }
    const map = {
      online: ['全域：已连接', 'on'], connecting: ['全域：连接中', 'warn'],
      backoff: ['全域：重连中', 'warn'], off: ['全域：未启用', 'off'],
      'no-mqtt': ['全域：缺少依赖', 'off'], error: ['全域：连接异常', 'warn'],
    };
    const m = map[snap.state] || ['全域：未知', 'off'];
    el.textContent = m[0];
    el.className = 'pill ' + m[1];
    el.title = 'broker ' + snap.brokerUrl + '\nclientId ' + snap.clientId + (snap.detail ? '\n' + snap.detail : '');
  }

  // ---------- 全域活动条 + 倒计时 ----------
  let activity = { task: null, baseRemain: null, gotAt: 0, state: '', lock: false };
  let ticker = null;

  function renderTask(p) {
    if (!p) return;
    activity.task = p.task || null;
    activity.lock = !!p.locked;
    const bar = $('taskbar');
    const t = activity.task;
    if (!t) { bar.hidden = true; return; }
    bar.hidden = false;
    $('tb-title').textContent = t.title || '课堂活动';
    const timerEl = $('tb-timer');
    if (t.timed && t.timerState !== 'closed') {
      timerEl.hidden = false;
      activity.baseRemain = t.remainingMs != null ? Number(t.remainingMs) : (t.durationSec != null ? t.durationSec * 1000 : null);
      activity.gotAt = Date.now();
      activity.state = t.timerState || 'idle';
    } else {
      timerEl.hidden = true;
      activity.baseRemain = null;
    }
    const label = { running: '进行中', paused: '已暂停', expired: '已截止', idle: '', closed: '' };
    $('tb-state').textContent = label[t.timerState] || '';
    startTicker();
    paintTimer();
  }

  function paintTimer() {
    const el = $('tb-timer');
    if (!el || el.hidden) return;
    let ms = activity.baseRemain;
    if (ms == null) return;
    if (activity.state === 'running') ms = Math.max(0, ms - (Date.now() - activity.gotAt));
    const s = Math.max(0, Math.round(ms / 1000));
    el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    el.className = 'tb-timer' + (activity.state === 'expired' || s === 0 ? ' done' : (s <= 60 ? ' urgent' : ''));
  }

  function startTicker() {
    if (ticker) return;
    ticker = setInterval(paintTimer, 500);
  }

  // ---------- 锁定 ----------
  function renderLock(p) {
    const locked = !!(p && p.locked);
    $('lockbar').hidden = !locked;
    $('address-wrap').classList.toggle('locked', locked);
    $('addr').disabled = locked;
    $('addr').placeholder = locked ? '课堂锁定中…' : '输入网址，或点上面的按钮找我 →';
    ['btn-siot', 'btn-ip'].forEach((id) => { const b = $(id); if (b) b.disabled = locked; });
  }

  // ---------- 口令弹窗 ----------
  function askPassword(title, hint) {
    return new Promise((resolve) => {
      $('pwd-title').textContent = title;
      $('pwd-hint').textContent = hint;
      $('pwd-input').value = '';
      $('pwd-err').textContent = '';
      $('pwd-modal').hidden = false;
      const finish = (ok) => { $('pwd-modal').hidden = true; resolve(ok); };
      const confirm = async () => {
        const pwd = $('pwd-input').value;
        if (!pwd) { $('pwd-err').textContent = '请输入口令'; return; }
        const r = net ? await net.adminVerify(pwd) : { ok: false, err: '环境不支持' };
        if (r && r.ok) { finish(true); return; }
        $('pwd-err').textContent = (r && r.err) || '口令错误';
        $('pwd-input').value = '';
        if (r && r.locked) setTimeout(() => finish(false), 900);
      };
      $('pwd-ok').onclick = confirm;
      $('pwd-cancel').onclick = () => finish(false);
      $('pwd-input').onkeydown = (e) => {
        if (e.key === 'Enter') confirm();
        if (e.key === 'Escape') finish(false);
      };
      setTimeout(() => { try { $('pwd-input').focus(); } catch (_e) { /* noop */ } }, 30);
    });
  }

  async function openAdmin() {
    if (!net) return;
    const st = await net.adminState();
    if (st && st.ok && !st.initialized) {
      // 首次使用：不需要旧口令，直接进管理页设置
      toast('首次使用，请先设置教师管理口令');
      await net.openInternal('settings');
      return;
    }
    if (st && st.locked) { toast('尝试次数过多，请稍后再试（已锁定）', 'warn'); return; }
    const ok = await askPassword('教师管理', '请输入管理口令（老师设置）');
    if (!ok) return;
    log('admin 口令校验通过，进入管理页');
    await net.openInternal('settings');
  }

  // ---------- 快捷按钮 ----------
  async function clickSiot() {
    if (!net) return;
    const r = await net.probeSiot();
    const res = r && r.result;
    if (res && res.running) {
      toast('SIoT 服务已启动，正在打开控制台…');
      await net.openSiotConsole(true);
      return;
    }
    // 未启动 → 打开引导页（页面内有"仍然尝试打开"的按钮）
    toast('没有检测到本机 SIoT 服务，先看启动步骤', 'warn');
    await net.openInternal('siot');
  }

  // ---------- 绑定 ----------
  function bind() {
    $('btn-new').onclick = () => { if (net) net.createTab('internal:home'); };
    $('btn-back').onclick = () => net && net.back();
    $('btn-forward').onclick = () => net && net.forward();
    $('btn-reload').onclick = () => {
      if (!net) return;
      const act = tabState.tabs.find((t) => t.id === tabState.activeId);
      if (act && act.loading) net.stop(); else net.reload();
    };
    $('btn-home').onclick = () => { if (net) net.openInternal('home'); };
    $('btn-siot').onclick = clickSiot;
    $('btn-ip').onclick = () => { if (net) net.openInternal('ip'); };
    $('btn-admin').onclick = () => { openAdmin(); };

    const addr = $('addr');
    addr.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitAddress(); }
      if (e.key === 'Escape') { addr.blur(); renderTabs(); }
    };
    addr.onfocus = () => addr.select();

    // 快捷键（主进程在任意焦点位置截获后推过来）
    if (net && net.onShortcut) {
      net.onShortcut((p) => {
        const n = p && p.name;
        if (n === 'admin') openAdmin();
        else if (n === 'new-tab') net.createTab('internal:home');
        else if (n === 'close-tab') net.closeTab(tabState.activeId);
        else if (n === 'focus-address') { addr.focus(); addr.select(); }
        else if (n === 'reload') net.reload();
        else if (n === 'back') net.back();
        else if (n === 'forward') net.forward();
      });
    }

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); addr.focus(); addr.select(); }
    });

    if (net) {
      net.onTabs((st) => { if (st) { tabState = st; renderTabs(); } });
      net.onTask((p) => renderTask(p));
      net.onLock((p) => renderLock(p));
      net.onNotice((n) => { if (n) toast(n.text, n.kind === 'warn' ? 'warn' : (n.kind === 'err' ? 'err' : '')); });
      net.onBlocked((b) => {
        if (!b) return;
        if (b.reason === 'locked') toast('课堂锁定中，暂时不能上网', 'warn');
        else if (b.reason === 'too-many-tabs') toast('标签开得太多啦，先关掉几个吧', 'warn');
        else toast('这个网页被老师屏蔽了', 'warn');
      });
      net.onQy((s) => renderQy(s));
    }
  }

  async function boot() {
    bind();
    if (!net) { toast('当前环境未接入主进程，仅供界面预览'); return; }
    try { renderRuntime(await net.getRuntime()); } catch (_e) { /* noop */ }
    try { const t = await net.listTabs(); if (t && t.ok) { tabState = t.state; renderTabs(); } } catch (_e) { /* noop */ }
    try { const q = await net.getQy(); if (q && q.ok) renderQy(q.qy); } catch (_e) { /* noop */ }
    try { const l = await net.getLock(); if (l && l.ok) renderLock(l); } catch (_e) { /* noop */ }

    // 内容区尺寸：ResizeObserver 覆盖窗口缩放 / 活动条出现 / 分屏等所有布局变化
    const content = $('content');
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => syncBounds());
      ro.observe(content);
    }
    window.addEventListener('resize', syncBounds);
    window.addEventListener('load', syncBounds);
    requestAnimationFrame(syncBounds);
    setTimeout(syncBounds, 120); // 活动条/锁定条首次展开后再量一次
    log('shell ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
