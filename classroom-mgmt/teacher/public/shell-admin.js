'use strict';
// ===== v5 全域桌面设置（教师大屏）：口令/课程白名单/禁用进程 =====
(function () {
  function $el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  async function cfgGet() {
    try {
      const r = await fetch('/api/v1/shell/config');
      const j = await r.json();
      return j && j.code === 0 ? j.data : null;
    } catch (_e) { return null; }
  }
  async function cfgPost(body) {
    try {
      const r = await fetch('/api/v1/shell/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      return j && j.code === 0;
    } catch (_e) { return false; }
  }
  function msg(t, err) {
    const m = $el('sf-msg');
    if (!m) return;
    m.textContent = t;
    m.style.color = err ? '#c42b1c' : '#107c10';
    setTimeout(() => { m.textContent = ''; }, 3000);
  }

  async function openModal() {
    const ov = $el('overlay-shell');
    if (!ov) return;
    ov.hidden = false;
    const cfg = await cfgGet();
    if (!cfg) { msg('无法读取桌面配置（教师服务未连接）', true); return; }
    const course = (cfg.courses || [])[0] || {};
    $el('sf-course-name').value = course.name || '';
    const apps = course.apps || [];
    $el('sf-apps').value = apps.map((a) => (a.label || a.exe) + '|' + a.exe).join('\n');
    const g = cfg.guard || {};
    $el('sf-deny').value = (g.denyExe || []).join(',');
    $el('sf-guard-enable').checked = !!g.enabled;
    $el('sf-admin-enable').checked = !!(cfg.admin && cfg.admin.enabled);
    $el('sf-exit-enable').checked = !!(cfg.modeExit && cfg.modeExit.enabled);
    $el('sf-admin-pwd').value = '';
    $el('sf-exit-pwd').value = '';
  }

  async function saveScope(scope) {
    const pwd = $el(scope === 'admin' ? 'sf-admin-pwd' : 'sf-exit-pwd').value.trim();
    const enabled = $el(scope === 'admin' ? 'sf-admin-enable' : 'sf-exit-enable').checked;
    const body = { scope, enabled };
    if (pwd) body.pwd = pwd;
    const okB = await cfgPost(body);
    msg(okB ? (scope === 'admin' ? '管理员口令已保存' : '自由创作口令已保存') : '保存失败（注意两口令不可相同）', !okB);
  }

  async function saveAll() {
    const apps = ($el('sf-apps').value || '').split('\n')
      .map((ln) => ln.trim()).filter(Boolean)
      .map((ln) => {
        const i = ln.indexOf('|');
        const label = (i >= 0 ? ln.slice(0, i) : ln).trim();
        const exe = (i >= 0 ? ln.slice(i + 1) : ln).trim();
        return { label: label || exe, exe };
      }).filter((a) => a.exe);
    const denyExe = ($el('sf-deny').value || '').split(',').map((x) => x.trim()).filter(Boolean);
    const name = $el('sf-course-name').value.trim() || '信息技术·硬件实践课';
    const okB = await cfgPost({
      courses: [{ id: 'c1', name, active: true, apps }],
      guard: { enabled: $el('sf-guard-enable').checked, denyExe },
    });
    msg(okB ? '课程与白名单已保存（学生重启桌面后生效）' : '保存失败', !okB);
  }

  function bind() {
    const btn = $el('btn-shell-admin');
    if (btn) btn.onclick = openModal;
    const o1 = $el('sf-admin-save'); if (o1) o1.onclick = () => saveScope('admin');
    const o2 = $el('sf-exit-save'); if (o2) o2.onclick = () => saveScope('mode-exit');
    const o3 = $el('sf-save-all'); if (o3) o3.onclick = saveAll;
    const ov = $el('overlay-shell');
    if (ov) ov.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { ov.hidden = true; }; });
    if (ov) ov.addEventListener('click', (e) => { if (e.target === ov) ov.hidden = true; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
