'use strict';
// ===== v5 全域学生桌面 · 模式/课程/本机配置（配置本地化：设置存 app-config.json）=====
(function () {
  const $ = (id) => document.getElementById(id);
  const b = () => window.classroom || null;
  let sc = null; // { admin, modeExit, course, guard }（主进程读/存）
  let failCount = 0;
  let lockedUntil = 0;

  function audit(type, detail) {
    try {
      const line = '[shell][' + type + '] ' + (detail == null ? '' : String(detail));
      console.log(line);
      if (b() && b().log) b().log(line);
    } catch (_e) { /* noop */ }
  }

  async function loadLocal() {
    if (!b()) return;
    try {
      const cfg = await b().getShellConfig();
      if (cfg) sc = cfg;
    } catch (_e) { /* noop */ }
    try { // 课程来自桌面配置（独立 json）
      const dc = await b().getDesktopConfig();
      if (dc && dc.course) sc = Object.assign(sc || {}, { course: dc.course });
    } catch (_e) { /* noop */ }
  }

  function renderCourse() {
    const c = (sc && sc.course) || { name: '信息技术·硬件实践课', apps: [] };
    const box = $('course-list');
    if (!box) return;
    const appsN = (c.apps || []).length;
    box.innerHTML = '<div class="course-item sel"><span>' + c.name.replace(/[<>&]/g, '')
      + '</span><span class="tag">' + (appsN ? appsN + ' 个课程应用' : '未配应用') + '</span></div>';
  }

  async function refreshShellState() {
    try {
      const st = b() ? await b().getShellState() : { machineId: '', kiosk: false, autoStart: false };
      const mid = st.machineId || '-';
      $('h-machine').textContent = '机器 ' + mid;
      $('f-machine').textContent = mid;
      $('a-machine').textContent = mid;
      $('f-kiosk').textContent = st.kiosk ? '守卫中' : '普通(调试)';
      $('a-kiosk').textContent = (st.kiosk ? '守卫中' : '普通') + (st.autoStart ? ' · 自启开' : ' · 自启关');
      $('f-autostart').textContent = st.autoStart ? '开' : '关';
    } catch (_e) { /* noop */ }
  }

  // ---- 口令（本地校验，主进程哈希比对）----
  function askPwd(title, hint, scope) {
    return new Promise((resolve) => {
      $('pwd-title').textContent = title;
      $('pwd-hint').textContent = hint;
      $('pwd-input').value = '';
      $('pwd-err').textContent = '';
      $('pwd-overlay').hidden = false;
      const done = (ok) => { $('pwd-overlay').hidden = true; resolve(ok); };
      const confirmFn = async () => {
        const now = Date.now();
        if (now < lockedUntil) { $('pwd-err').textContent = '尝试过多，请 30 秒后再试'; return; }
        const pwd = $('pwd-input').value;
        let ok = false;
        if (b() && b().verifyLocal) { try { const r = await b().verifyLocal(scope, pwd); ok = !!(r && r.ok); } catch (_e) { ok = false; } }
        if (ok) { failCount = 0; done(true); return; }
        failCount += 1;
        if (failCount >= 3) { lockedUntil = now + 30000; failCount = 0; $('pwd-err').textContent = '口令错误，已锁定 30 秒'; return; }
        $('pwd-err').textContent = '口令错误，还可尝试 ' + (3 - failCount) + ' 次';
      };
      $('pwd-ok').onclick = confirmFn;
      $('pwd-cancel').onclick = () => done(false);
      $('pwd-input').onkeydown = (e) => { if (e.key === 'Enter') confirmFn(); if (e.key === 'Escape') done(false); };
      setTimeout(() => { try { $('pwd-input').focus(); } catch (_e) { /* noop */ } }, 30);
    });
  }

  async function enterClassroom() {
    audit('mode:class', 'course=' + ((sc && sc.course && sc.course.name) || '-'));
    if (b() && b().openDesktop) { try { await b().openDesktop(); } catch (_e) { /* noop */ } }
  }

  async function goFree() {
    audit('mode:free-request', '');
    if (sc && sc.modeExit && sc.modeExit.enabled) {
      const ok = await askPwd('自由创作', '请输入自由创作口令（老师设置）', 'mode-exit');
      if (!ok) return;
    }
    if (b() && b().unlockExit) { try { await b().unlockExit(); } catch (_e) { /* noop */ } }
    else window.close();
  }

  function fillAdmin() {
    if (!sc) return;
    $('c-exit-en').checked = !!(sc.modeExit && sc.modeExit.enabled);
    $('c-admin-en').checked = !!(sc.admin && sc.admin.enabled);
    $('c-exit-pwd').value = '';
    $('c-admin-pwd').value = '';
    $('admin-err').textContent = '';
  }

  async function openAdmin() {
    if (sc && sc.admin && sc.admin.enabled) {
      const ok = await askPwd('系统设置', '请输入管理员口令', 'admin');
      if (!ok) return;
    }
    await loadLocal(); await refreshShellState(); fillAdmin();
    $('admin-overlay').hidden = false;
  }

  async function saveAll() {
    const errEl = $('admin-err');
    const msg = (t, err) => { errEl.textContent = t; errEl.style.color = err ? '#c42b1c' : '#107c10'; };
    if (!b() || !b().setShellConfig) { msg('当前运行环境不支持保存', true); return; }
    if ($('c-exit-pwd').value) {
      const r = await b().setShellConfig({ scope: 'mode-exit', pwd: $('c-exit-pwd').value, enabled: $('c-exit-en').checked });
      if (r && r.ok) msg('自由创作口令已保存'); else if (r) msg('口令保存失败：' + (r.err || '未知'), true);
    } else {
      const r = await b().setShellConfig({ scope: 'mode-exit', enabled: $('c-exit-en').checked });
      if (r && !r.ok) { msg('自由创作：' + (r.err || '保存失败'), true); return; }
    }
    if ($('c-admin-pwd').value) {
      const r = await b().setShellConfig({ scope: 'admin', pwd: $('c-admin-pwd').value, enabled: $('c-admin-en').checked });
      if (r && r.ok) msg('管理员口令已保存（两口令不可相同）'); else if (r) msg('口令保存失败：' + (r.err || '未知'), true);
    } else {
      const r = await b().setShellConfig({ scope: 'admin', enabled: $('c-admin-en').checked });
      if (r && !r.ok) { msg('管理员：' + (r.err || '保存失败'), true); return; }
    }
    msg('口令已保存。课程/应用白名单请在【桌面模式 → 设置】中添加（选 exe 路径）。');
  }

  function bind() {
    $('btn-class').onclick = enterClassroom;
    $('btn-free').onclick = goFree;
    $('btn-gear').onclick = openAdmin;
    $('admin-close').onclick = () => { $('admin-overlay').hidden = true; };
    $('a-autostart').onclick = async () => {
      try {
        const st = b() ? await b().getShellState() : null;
        if (b() && b().setAutoStart) await b().setAutoStart(!(st && st.autoStart));
        await refreshShellState();
      } catch (_e) { /* noop */ }
    };
    $('a-free').onclick = async () => { $('admin-overlay').hidden = true; await goFree(); };
    // 保存按钮：任何异步异常都要在面板内可见，不再静默
    $('c-save').onclick = () => {
      audit('save-click', '');
      saveAll().catch((e) => {
        try {
          audit('save-error', (e && e.message) || String(e));
          const el = $('admin-err');
          if (el) { el.textContent = '保存出错：' + ((e && e.message) || e); el.style.color = '#c42b1c'; }
        } catch (_e2) { /* noop */ }
      });
    };
    if (b() && b().onGuard) b().onGuard(() => {
      const e = document.createElement('div');
      e.textContent = '课堂桌面已锁定，无法直接退出（需老师口令）';
      e.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#c42b1c;color:#fff;padding:10px 18px;z-index:99;';
      document.body.appendChild(e);
      setTimeout(() => e.remove(), 2600);
    });
  }

  async function boot() {
    bind();
    await loadLocal();
    renderCourse();
    await refreshShellState();
    audit('ready', 'course=' + ((sc && sc.course && sc.course.name) || '-') + ' 本地配置=' + (sc ? 'on' : 'off'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
