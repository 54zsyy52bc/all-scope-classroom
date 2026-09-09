'use strict';
// ===== v5 课堂侧扩展：课程应用磁贴（白名单启动器，本机配置）+ 管理员返回入口 =====
(function () {
  function $el(id) { return document.getElementById(id); }
  function bridge() { return window.classroom || null; }
  function toast(text) {
    const t = $el('toast');
    if (t) { t.textContent = text; t.hidden = false; setTimeout(() => { t.hidden = true; }, 2800); }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  async function localCfg() {
    const bb = bridge();
    if (!bb || !bb.getDesktopConfig) return null;
    try { return await bb.getDesktopConfig(); } catch (_e) { return null; }
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
      btn.onclick = () => { const b2 = bridge(); if (b2 && b2.launchApp) b2.launchApp(btn.dataset.id); };
    });
  }

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
        const bb = bridge();
        if (!bb || !bb.verifyLocal) { err.textContent = '环境不支持口令校验'; return; }
        try { const r = await bb.verifyLocal('admin', pwd); if (r && r.ok) { document.body.removeChild(ov); resolve(true); return; } } catch (_e) { /* noop */ }
        err.textContent = '口令错误';
      };
      document.getElementById('cd-no').onclick = close;
      document.getElementById('cd-yes').onclick = go;
      document.getElementById('cd-pwd').onkeydown = (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') close(); };
      setTimeout(() => { const i = document.getElementById('cd-pwd'); if (i) i.focus(); }, 20);
    });
  }
  async function onAdmin() {
    if (!(await pwdOverlay())) return;
    const b2 = bridge();
    if (b2 && b2.backToDesktop) { try { await b2.backToDesktop(); } catch (_e) { /* noop */ } }
  }

  async function boot() {
    const b2 = bridge();
    if (!b2) return; // 无桥接（浏览器预览）不启用桌面扩展
    const cfg = await localCfg();
    if (cfg) showDock(cfg.course);
    const admin = $el('btn-admin');
    if (admin) admin.onclick = onAdmin;
    if (b2.onKill) b2.onKill((name) => toast('已阻止应用：' + name));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
