'use strict';
// ===== v5.1 全域桌面：Android 式主屏 + 应用抽屉（Metro 磁贴）=====
(function () {
  const $ = (id) => document.getElementById(id);
  const b = () => window.classroom || null;
  let dcfg = { course: { id: 'c1', name: '信息技术·硬件实践课', homeApps: [], apps: [] },
    guard: { enabled: false, denyExe: [] } };
  let draft = null; // 编辑草稿 { course:{...}, guard:{...} }
  let firstPinHint = false;
  let failCount = 0;   // 设置口令连续错误次数（模块级，跨弹窗累计）
  let lockedUntil = 0; // 锁定解除时间戳（ms），0 表示未锁

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function audit(type, detail) {
    try { const line = '[desktop][' + type + '] ' + (detail == null ? '' : String(detail)); console.log(line);
      if (b() && b().log) b().log(line); } catch (_e) { /* noop */ }
  }
  function toast(text, err) {
    const el = $('set-msg');
    if (el) { el.className = err ? 'err' : 'ok'; el.textContent = text; }
    if (!el || err) floatToast(text, err);
  }
  function floatToast(text, err) {
    const e = document.createElement('div');
    e.className = 'float-toast';
    e.textContent = text;
    e.style.cssText = 'position:fixed;bottom:74px;left:50%;transform:translateX(-50%);background:' + (err ? '#c42b1c' : '#107c10') + ';color:#fff;padding:9px 18px;z-index:99;font-size:13px;';
    document.body.appendChild(e);
    setTimeout(() => e.remove(), 3000);
  }
  function clock() {
    const el = $('sb-clock');
    if (el) el.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  // 教室互联状态：轮询教师机健康接口（学生桌面可直观察到大屏/服务在线）
  let roomHost = 'http://127.0.0.1:3000';
  function pollRoom() {
    const chip = $('sb-room');
    fetch(roomHost + '/api/v1/system/health').then((r) => r.json()).then((j) => {
      const on = j && j.code === 0 && j.data && j.data.status === 'ok';
      if (chip) { chip.textContent = on ? '教室在线' : '教室离线'; chip.style.color = on ? '#107c10' : '#c42b1c'; }
    }).catch(() => { if (chip) { chip.textContent = '教室离线'; chip.style.color = '#c42b1c'; } });
  }
  async function roomInit() {
    const bb = b();
    if (bb && bb.getRuntime) {
      try { const rt = await bb.getRuntime(); if (rt && rt.siotIp) roomHost = 'http://' + rt.siotIp + ':3000'; } catch (_e) { /* noop */ }
    }
    pollRoom(); setInterval(pollRoom, 4000);
  }
  async function loadState() {
    const bb = b();
    if (bb) {
      try {
        const st = await bb.getShellState();
        $('sb-machine').textContent = '机器 ' + (st.machineId || '-');
        const el = $('sb-elev');
        if (el) { el.hidden = !(st && st.elevated === false); el.textContent = '未用管理员运行'; el.style.color = '#d35d0a'; el.title = '右键以管理员身份运行学生端，需要权限的应用才能打开'; }
      } catch (_e) { /* noop */ }
      try { dcfg = await bb.getDesktopConfig(); } catch (_e) { /* noop */ }
    }
    $('course-name').textContent = (dcfg.course && dcfg.course.name) || '全域课堂';
    renderHome(); renderState();
  }
  function renderState() {
    $('sb-guard').textContent = dcfg.guard && dcfg.guard.enabled ? '防护中' : '防护未启用';
  }
  function apps() { return (dcfg.course && dcfg.course.apps) || []; }
  function tileHtml(a, big) {
    const initial = String(a.name || '?').slice(0, 1).toUpperCase();
    const cls = big ? 'tile' : 'd-app';
    const tip = big ? '点击打开' : '课程应用';
    // 双面结构：front 显示图标+名称，hover 时 inner 翻转露出 back（名称+状态提示）
    return '<button type="button" class="' + cls + '" data-id="' + esc(a.id) + '" title="' + esc(a.name) + '">'
      + '<span class="tile-inner">'
      + '<span class="tile-front"><span class="ico">' + esc(initial) + '</span><span class="nm">' + esc(a.name) + '</span></span>'
      + '<span class="tile-back"><span class="bk-nm">' + esc(a.name) + '</span><span class="bk-tip">' + tip + '</span></span>'
      + '</span></button>';
  }
  function renderHome() {
    const grid = $('home-grid');
    const list = apps();
    const home = list.filter((a) => (dcfg.course.homeApps || []).includes(a.id));
    const shown = home.length ? home : list;
    grid.innerHTML = list.length ? shown.map((a) => tileHtml(a, true)).join('')
      : '<div class="empty-guide">还没有课程应用：点右上「设置」→ 添加应用（选 exe）<br/>或从 U 盘/教师机导入课程桌面包</div>';
    grid.querySelectorAll('[data-id]').forEach((el) => { el.onclick = () => openApp(el.dataset.id); });
    // 错落入场：磁贴按序号延时，呈现 Win8 应用逐一浮现的节奏
    grid.querySelectorAll('.tile').forEach((el, i) => { el.style.animationDelay = (i * 35) + 'ms'; });
  }
  function renderDrawer() {
    const body = $('drawer-body');
    const list = apps();
    body.innerHTML = list.map((a) => tileHtml(a, false)).join('')
      + '<button type="button" class="d-app sys" data-sys="class"><span class="ico">课</span><span class="nm">上课登记</span></button>'
      + '<button type="button" class="d-app sys" data-sys="settings"><span class="ico">设</span><span class="nm">设置</span></button>';
    body.querySelectorAll('[data-id]').forEach((el) => { el.onclick = () => openApp(el.dataset.id); });
    body.querySelectorAll('[data-sys]').forEach((el) => {
      el.onclick = () => { closeDrawer(); const s = el.dataset.sys; if (s === 'class') enterClass(); else if (s === 'settings') openSettings(); };
    });
    // 错落入场：抽屉内应用按序号延时（含上课登记 / 设置两个系统项）
    body.querySelectorAll('.d-app').forEach((el, i) => { el.style.animationDelay = (i * 30) + 'ms'; });
  }
  async function openApp(id) {
    audit('app-open', id);
    const a = apps().find((x) => x.id === id);
    if (!a) { toast('应用不存在，请重新打开设置', true); return; }
    if (!a.path) { toast('应用路径缺失，请在设置中重新添加', true); return; }
    const bb = b();
    if (!bb || !bb.launchApp) { toast('当前环境不支持启动应用', true); return; }
    let r = null;
    try { r = await bb.launchApp(id); } catch (e) { r = null; }
    // 主进程现在回传失败原因（未注册 / 路径缺失）。以前 launch 静默 return false，
    // 表现就是「点了磁贴毫无反应」，老师既不知道没保存也不知道路径丢了。
    if (r && r.ok === false) toast((r.err || '启动失败') + '，请先保存设置', true);
    else if (!r) toast('启动失败：未收到主进程回应', true);
  }
  function enterClass() { audit('open-class', ''); if (b() && b().openClass) b().openClass(); }
  function openDrawer() { renderDrawer(); $('drawer').hidden = false; $('drawer-mask').hidden = false; }
  function closeDrawer() { $('drawer').hidden = true; $('drawer-mask').hidden = true; }

  // ---- 设置 ----
  function draftFromCfg() {
    draft = { course: { name: dcfg.course.name, homeApps: (dcfg.course.homeApps || []).slice(), apps: apps().map((a) => Object.assign({}, a)) }, guard: { enabled: !!dcfg.guard.enabled, denyExe: (dcfg.guard.denyExe || []).slice(), minimizeOthers: dcfg.guard.minimizeOthers !== false } };
  }
  function renderAppList() {
    const box = $('app-list');
    const list = draft.course.apps || [];
    box.innerHTML = list.length ? list.map((a, i) =>
      '<div class="row" data-i="' + i + '">'
      + '<input type="text" value="' + esc(a.name) + '" style="width:150px" data-f="name" />'
      + '<span class="path" title="' + esc(a.path) + '">' + esc(a.path) + '</span>'
      + '<button class="mini" data-a="pin">' + ((draft.course.homeApps || []).includes(a.id) ? '移出主屏' : '固定主屏') + '</button>'
      + '<button class="mini danger" data-a="del">删除</button></div>').join('')
      : '<div class="row">暂无应用</div>';
    box.querySelectorAll('.row').forEach((row) => {
      const nameEl = row.querySelector('[data-f="name"]');
      if (!nameEl) return; // 暂无应用占位行无输入框，跳过绑定，否则 null.oninput 抛错会阻断设置弹窗显示
      const i = Number(row.dataset.i);
      nameEl.oninput = (e) => { draft.course.apps[i].name = e.target.value; };
      row.querySelector('[data-a="pin"]').onclick = () => {
        const id = draft.course.apps[i].id;
        const hs = draft.course.homeApps;
        const pos = hs.indexOf(id);
        if (pos >= 0) hs.splice(pos, 1); else hs.push(id);
        renderAppList();
      };
      row.querySelector('[data-a="del"]').onclick = () => {
        const id = draft.course.apps[i].id;
        draft.course.apps.splice(i, 1);
        draft.course.homeApps = draft.course.homeApps.filter((x) => x !== id);
        renderAppList();
      };
    });
  }
  async function pickAndAdd() {
    const bb = b();
    if (!bb || !bb.pickApp) { toast('环境不支持文件选择', true); return; }
    const r = await bb.pickApp();
    if (!r || r.canceled || !r.path) return;
    const name = String(r.path).split(/[\\/]/).pop().replace(/\.(exe|lnk)$/i, '') || '应用';
    draft.course.apps.push({ id: 'a' + Date.now(), name, path: r.path });
    if (!firstPinHint) { firstPinHint = true; toast('已添加：' + name + '（可点「固定主屏」放桌面）'); }
    renderAppList();
  }
  async function openSettings() {
    // 管理员口令（未启用则直进）
    const bb = b();
    if (bb) {
      try { const pwdCfg = await bb.getShellConfig();
        if (pwdCfg && pwdCfg.admin && pwdCfg.admin.enabled) {
          const ok = await askPwd();
          if (!ok) { floatToast('已取消：需要管理员口令才能打开设置', true); return; }
        } } catch (_e) { floatToast('读取口令配置失败，已按无口令进入', true); }
    }
    draftFromCfg();
    $('f-course-name').value = draft.course.name;
    $('f-deny').value = draft.guard.denyExe.join(',');
    $('f-guard-en').checked = draft.guard.enabled;
    $('f-min').checked = !!draft.guard.minimizeOthers;
    renderAppList();
    toast('');
    $('set-overlay').hidden = false;
  }
  function askPwd() {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'overlay';
      ov.style.cssText = 'z-index:99';
      ov.innerHTML = '<div class="modal" style="width:360px"><h3>管理员验证</h3>'
        + '<input type="password" id="ap-pwd" style="width:100%" placeholder="系统口令" />'
        + '<div class="err" id="ap-err"></div>'
        + '<div class="modal-actions"><button class="big-btn ghost" id="ap-no">取消</button>'
        + '<button class="big-btn" id="ap-yes">确认</button></div></div>';
      document.body.appendChild(ov);
      const fin = (ok) => { document.body.removeChild(ov); resolve(ok); };
      const go = async () => {
        const now = Date.now();
        if (now < lockedUntil) { $('ap-err').textContent = '口令错误，已锁定 30 秒'; return; }
        const pwd = $('ap-pwd').value;
        const bb = b();
        try { const r = bb ? await bb.verifyLocal('admin', pwd) : null; if (r && r.ok) { failCount = 0; fin(true); return; } } catch (_e) { /* noop */ }
        failCount += 1;
        if (failCount >= 3) { lockedUntil = now + 30000; failCount = 0; $('ap-err').textContent = '口令错误，已锁定 30 秒'; return; }
        $('ap-err').textContent = '口令错误，还可尝试 ' + (3 - failCount) + ' 次';
      };
      $('ap-no').onclick = () => fin(false);
      $('ap-yes').onclick = go;
      $('ap-pwd').onkeydown = (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') fin(false); };
      setTimeout(() => { try { $('ap-pwd').focus(); } catch (_e) { /* noop */ } }, 20);
    });
  }
  async function saveSet() {
    const bb = b();
    if (!bb || !bb.setDesktopConfig) { toast('环境不支持保存', true); return; }
    draft.course.name = $('f-course-name').value.trim() || '信息技术·硬件实践课';
    draft.guard.denyExe = ($('f-deny').value || '').split(',').map((x) => x.trim()).filter(Boolean);
    draft.guard.enabled = $('f-guard-en').checked;
    draft.guard.minimizeOthers = $('f-min').checked;
    const r = await bb.setDesktopConfig({ course: draft.course, guard: draft.guard });
    if (r && r.ok) {
      dcfg = { course: draft.course, guard: draft.guard };
      $('course-name').textContent = dcfg.course.name;
      renderHome(); renderState(); toast('桌面配置已保存');
      audit('save-desktop', dcfg.course.name + ' apps=' + draft.course.apps.length);
    } else { toast((r && r.err) || '保存失败', true); }
  }
  async function doImport() {
    const bb = b();
    if (!bb || !bb.importConfig) { toast('环境不支持导入', true); return; }
    const r = await bb.importConfig();
    if (r && r.ok) { await loadState(); toast('课程桌面包导入成功'); audit('import-ok', ''); }
    else if (r && r.canceled) { /* 取消 */ }
    else toast((r && r.err) || '导入失败', true);
  }
  function backShell() { // 桌面 → 模式选择屏（guard 'shell:go-shell'）
    const bb = b();
    if (bb && bb.goShell) bb.goShell();
  }

  function bind() {
    $('btn-class').onclick = enterClass;
    $('btn-drawer').onclick = openDrawer;
    $('btn-drawer-close').onclick = closeDrawer;
    $('drawer-mask').onclick = closeDrawer;
    $('sb-settings').onclick = openSettings;
    $('btn-close-set').onclick = () => { $('set-overlay').hidden = true; };
    $('btn-save-set').onclick = saveSet;
    $('btn-add-app').onclick = pickAndAdd;
    $('btn-import').onclick = doImport;
    $('btn-back-shell').onclick = backShell;
    setInterval(clock, 10000); clock();
    roomInit();
    const bb = b();
    if (bb && bb.guardStart) bb.guardStart(); // 守卫（deny 由桌面配置）
    if (bb && bb.onKill) bb.onKill((name) => floatToast('已阻止应用：' + name, true));
  }

  async function boot() {
    bind();
    await loadState();
    audit('boot', 'desktop ready');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
