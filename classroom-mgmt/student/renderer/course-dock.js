'use strict';
// ===== v5 课堂侧扩展：课程应用磁贴（白名单启动器）+ 管理员返回入口 =====
// 依赖 window.classroom（preload）；本模块独立 boot，不动 app.js（控行数）。
(function () {
  let httpBase = 'http://127.0.0.1:3000';

  function $el(id) { return document.getElementById(id); }
  function bridge() { return window.classroom || null; }
  function toast(text) {
    const t = $el('toast');
    if (t) { t.textContent = text; t.hidden = false; setTimeout(() => { t.hidden = true; }, 2800); }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function readCourse() {
    try { const c = JSON.parse(localStorage.getItem('qy.course') || 'null'); return c; } catch (_e) { return null; }
  }
  async function cfgRemote() {
    const b = bridge();
    if (b && b.getRuntime) {
      try { const rt = await b.getRuntime(); if (rt && rt.siotIp) httpBase = 'http://' + rt.siotIp + ':3000'; } catch (_e) { /* noop */ }
    }
    try {
      const res = await fetch(httpBase + '/api/v1/shell/config');
      const j = await res.json();
      return j && j.code === 0 ? j.data : null;
    } catch (_e) { return null; }
  }
  function showDock(course) {
    const apps = (course && course.apps) || [];
    const dock = $el('course-dock');
    if (!dock || !apps.length) return;
    dock.hidden = false;
    dock.innerHTML = '<span class="dock-label">课程应用</span>'
      + apps.map((a) => '<button type="button" class="dock-app" data-id="' + esc(a.id)
        + '" title="' + esc(a.exe) + '">' + esc(a.label) + '</button>').join('');
    dock.querySelectorAll('.dock-app').forEach((btn) => {
      btn.onclick = () => {
        const b = bridge();
        if (b && b.launchApp) b.launchApp(btn.dataset.id);
      };
    });
  }

  // ---- 管理员（齿轮/返回入口）：先验 admin 口令 ----
  function pwdOverlay() {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:90;';
      ov.innerHTML = '<div style="background:#fff;width:380px;max-width:90vw;padding:24px;font-family:inherit">'
        + '<h3 style="margin:0 0 12px;font-size:19px">管理员验证</h3>'
        + '<input type="password" id="cd-pwd" style="width:100%;box-sizing:border-box;padding:9px 10px;font-size:15px;border:1px solid #ddd" placeholder="系统口令（老师设置）" />'
        + '<p id="cd-err" style="color:#c42b1c;font-size:13px;min-height:18px;margin:6px 0 0"></p>'
        + '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:14px">'
        + '<button id="cd-no" style="padding:8px 16px;border:1px solid #ddd;background:#fff;cursor:pointer">取消</button>'
        + '<button id="cd-yes" style="padding:8px 16px;border:0;background:#0078d7;color:#fff;cursor:pointer">确认</button></div></div>';
      document.body.appendChild(ov);
      const close = () => { document.body.removeChild(ov); resolve(false); };
      const go = async () => {
        const pwd = document.getElementById('cd-pwd').value;
        const err = document.getElementById('cd-err');
        try {
          const res = await fetch(httpBase + '/api/v1/shell/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope: 'admin', pwd }),
          });
          const j = await res.json();
          const d = j && j.code === 0 ? j.data : null;
          if (d && (d.disabled || d.ok)) { document.body.removeChild(ov); resolve(true); return; }
          err.textContent = '口令错误';
        } catch (_e) { err.textContent = '无法连接教师机校验'; }
      };
      document.getElementById('cd-no').onclick = close;
      document.getElementById('cd-yes').onclick = go;
      document.getElementById('cd-pwd').onkeydown = (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') close(); };
      setTimeout(() => { const i = document.getElementById('cd-pwd'); if (i) i.focus(); }, 20);
    });
  }
  async function onAdmin() {
    if (!(await pwdOverlay())) return;
    const b = bridge();
    if (b && b.backToShell) { try { await b.backToShell(); } catch (_e) { /* noop */ } }
  }

  async function boot() {
    const b = bridge();
    if (!b) return; // 无桥接（浏览器预览）不启用桌面扩展
    const remote = await cfgRemote();
    if (remote) showDock(readCourse());
    const admin = $el('btn-admin');
    if (admin) admin.onclick = onAdmin;
    if (b.onKill) b.onKill((name) => toast('已阻止应用：' + name));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
