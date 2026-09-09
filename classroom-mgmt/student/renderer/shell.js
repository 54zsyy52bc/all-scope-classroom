'use strict';
// ===== v5 全域学生桌面 · 模式/课程/口令首屏（shell）=====
(function () {
  const $ = (id) => document.getElementById(id);
  let cfg = { courses: [], modeExit: { enabled: false }, admin: { enabled: false } };
  let curCourse = null;
  let failCount = 0;
  let lockedUntil = 0;

  function audit(type, detail) {
    try {
      const line = '[shell][' + type + '] ' + (detail == null ? '' : String(detail));
      console.log(line);
      if (global.classroom && global.classroom.log) global.classroom.log(line);
    } catch (_e) { /* noop */ }
  }

  function httpBase() {
    return new Promise((resolve) => {
      if (global.classroom && global.classroom.getRuntime) {
        global.classroom.getRuntime().then((rt) => {
          const host = (rt && rt.siotIp) || '127.0.0.1';
          const port = 3000;
          resolve('http://' + host + ':' + port);
        }).catch(() => resolve('http://127.0.0.1:3000'));
      } else resolve('http://127.0.0.1:3000');
    });
  }

  async function api(method, url, body) {
    try {
      const base = await httpBase();
      const opt = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opt.body = JSON.stringify(body);
      const res = await fetch(base + url, opt);
      const j = await res.json();
      return j && j.code === 0 ? j.data : null;
    } catch (_e) { return null; }
  }

  async function refreshShellState() {
    try {
      const st = global.classroom ? await global.classroom.getShellState() : { machineId: '', kiosk: false, autoStart: false };
      const mid = st.machineId || '-';
      $('h-machine').textContent = '机器 ' + mid;
      $('f-machine').textContent = mid;
      $('a-machine').textContent = mid;
      const kiosk = st.kiosk ? '守卫中' : '普通(调试)';
      $('f-kiosk').textContent = kiosk;
      $('a-kiosk').textContent = kiosk + (st.autoStart ? ' · 自启开' : ' · 自启关');
      $('f-autostart').textContent = st.autoStart ? '开' : '关';
      audit('boot', 'machine=' + mid + ' kiosk=' + st.kiosk);
    } catch (_e) { /* noop */ }
  }

  async function loadCourses() {
    const data = await api('GET', '/api/v1/shell/config');
    if (data && data.courses && data.courses.length) {
      cfg = data;
      if (cfg.courses.length && !curCourse) curCourse = cfg.courses[0].id;
      renderCourses();
    } else {
      cfg = { courses: [{ id: 'c1', name: '信息技术·硬件实践课', active: true }], modeExit: { enabled: false }, admin: { enabled: false } };
      curCourse = 'c1';
      renderCourses();
    }
  }

  function renderCourses() {
    const box = $('course-list');
    box.innerHTML = (cfg.courses || []).map((c) =>
      '<div class="course-item' + (curCourse === c.id ? ' sel' : '') + '" data-id="' + c.id + '">'
      + '<span>' + String(c.name || '').replace(/[<>&]/g, '') + '</span>'
      + (c.active ? '<span class="tag">当前可选</span>' : '') + '</div>'
    ).join('') || '<div class="course-item">暂无课程</div>';
    box.querySelectorAll('.course-item[data-id]').forEach((el) => {
      el.onclick = () => { curCourse = el.dataset.id; renderCourses(); };
    });
  }

  // ---- 口令 ----
  function askPwd(title, hint, scope) {
    return new Promise((resolve) => {
      $('pwd-title').textContent = title;
      $('pwd-hint').textContent = hint || '口令（由老师设置）';
      $('pwd-input').value = '';
      $('pwd-err').textContent = '';
      $('pwd-overlay').hidden = false;
      const done = (ok) => { $('pwd-overlay').hidden = true; resolve(ok); };
      const confirmFn = async () => {
        const now = Date.now();
        if (now < lockedUntil) { $('pwd-err').textContent = '尝试过多，请稍候再试'; return; }
        const pwd = $('pwd-input').value;
        const r = await api('POST', '/api/v1/shell/verify', { scope, pwd });
        if (!r) { $('pwd-err').textContent = '无法连接教师机校验口令'; return; }
        if (r.disabled || r.ok) { failCount = 0; done(true); return; }
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
    const course = (cfg.courses || []).find((c) => c.id === curCourse) || null;
    audit('mode:class', 'course=' + (course ? course.id : '-'));
    try { localStorage.setItem('qy.course', JSON.stringify(course || { id: 'c1', name: '信息技术·硬件实践课', apps: [] })); } catch (_e) { /* noop */ }
    // 主进程守卫：白名单应用 + 老师启用的禁用进程轮询
    if (global.classroom && global.classroom.guardStart) {
      try {
        const deny = (cfg.guard && cfg.guard.enabled) ? cfg.guard.denyExe : [];
        await global.classroom.guardStart({ apps: (course && course.apps) || [], denyExe: deny });
      } catch (_e) { /* 守卫启动失败不阻断 */ }
    }
    if (global.classroom && global.classroom.enterClassroom) {
      try { await global.classroom.enterClassroom(); } catch (_e) { /* noop */ }
    }
  }

  async function goFree() {
    audit('mode:free-request', '');
    if (cfg.modeExit && cfg.modeExit.enabled) {
      const ok = await askPwd('自由创作', '请输入自由创作口令（老师设置）', 'mode-exit');
      if (!ok) return;
    }
    if (global.classroom && global.classroom.unlockExit) {
      try { await global.classroom.unlockExit(); } catch (_e) { /* noop */ }
    } else {
      window.close();
    }
  }

  async function openAdmin() {
    if (cfg.admin && cfg.admin.enabled) {
      const ok = await askPwd('系统设置', '请输入管理员口令（与课程/自由创作口令不同）', 'admin');
      if (!ok) return;
    }
    await refreshShellState();
    $('admin-overlay').hidden = false;
  }

  function bind() {
    $('btn-class').onclick = enterClassroom;
    $('btn-free').onclick = goFree;
    $('btn-gear').onclick = openAdmin;
    $('admin-close').onclick = () => { $('admin-overlay').hidden = true; };
    $('a-autostart').onclick = async () => {
      try {
        const st = global.classroom ? await global.classroom.getShellState() : null;
        if (global.classroom && global.classroom.setAutoStart) await global.classroom.setAutoStart(!(st && st.autoStart));
        await refreshShellState();
      } catch (_e) { /* noop */ }
    };
    $('a-free').onclick = async () => { $('admin-overlay').hidden = true; await goFree(); };
    // 主进程守卫拦截（如 Alt+F4）时给个提示
    try {
      if (global.classroom && global.classroom.onGuard) global.classroom.onGuard(() => {
        const e = document.createElement('div');
        e.textContent = '课堂桌面已锁定，无法直接退出（请在老师口令下操作）';
        e.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#c42b1c;color:#fff;padding:10px 18px;z-index:99;';
        document.body.appendChild(e);
        setTimeout(() => e.remove(), 2600);
      });
    } catch (_e) { /* noop */ }
  }

  async function boot() {
    bind();
    await refreshShellState();
    await loadCourses();
    audit('ready', 'courses=' + (cfg.courses || []).length);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
