'use strict';
// =============================================================================
// 内置页公共工具（以普通 <script> 引入，挂在 window.GN 上）
// 说明：内置页运行在 gnet:// 协议下，preload 已注入 window.greenNet。
//       若在纯浏览器里直接打开这些 HTML 预览，window.greenNet 不存在 —— 本文件
//       提供一组空实现，让页面仍能渲染出来（便于老师/开发预览排版）。
// =============================================================================
(function (global) {
  const noop = async () => ({ ok: false, err: '当前环境未接入主进程' });

  const FALLBACK = {
    getRuntime: async () => ({ ok: true, machineId: '(预览)', seat: '', blockEnabled: true, blockMode: 'blacklist', maxTabs: 8, siot: { host: '127.0.0.1', httpPort: 8080, mqttPort: 1883 }, qy: { enabled: true, host: '127.0.0.1', port: 1883 } }),
    getNavConfig: async () => ({ ok: false, config: { title: '绿网 · 学生导航', subtitle: '预览模式', quickActions: [], groups: [] } }),
    getBlocklist: async () => ({ ok: false, config: { enabled: true, mode: 'blacklist', rules: [], allowDomains: [] } }),
    getNetInfo: async () => ({ ok: false, info: { hostname: '(预览)', platform: '', interfaces: [], hints: ['预览模式没有真实网卡数据'] } }),
    getQy: async () => ({ ok: true, qy: { state: 'off', brokerUrl: '-', clientId: '-', enabled: false, topics: {} } }),
    probeSiot: async () => ({ ok: false, result: { running: false, hint: '预览模式无法探测' } }),
    getSettings: async () => ({ ok: false, settings: {} }),
    adminState: async () => ({ ok: true, initialized: true, locked: false }),
    adminVerify: noop, adminSetup: noop, saveBlocklist: noop, saveNavConfig: noop,
    saveSettings: noop, copyText: noop, go: noop, createTab: noop, openInternal: noop,
    checkUrl: async () => ({ ok: false }), resetNavConfig: noop, restartQy: noop,
    log: async () => true,
  };

  const gn = global.greenNet || null;

  // 用 Proxy 兜底：页面用到的任何方法若不存在，都返回"环境不支持"而不是抛错
  const api = gn || new Proxy(FALLBACK, {
    get(t, k) {
      if (k in t) return t[k];
      return noop;
    },
  });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function el(tag, attrs, html) {
    const n = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
    if (html !== undefined) n.innerHTML = html;
    return n;
  }

  function toast(text, kind, ms) {
    const t = el('div', { class: 'toast-mini' + (kind ? ' ' + kind : '') }, esc(text));
    document.body.appendChild(t);
    setTimeout(() => { try { t.remove(); } catch (_e) { /* noop */ } }, ms || 2600);
  }

  async function copy(text) {
    try {
      const r = await api.copyText(text);
      if (r && r.ok) { toast('已复制到剪贴板'); return true; }
    } catch (_e) { /* 走下面的兜底 */ }
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板');
      return true;
    } catch (_e) {
      toast('复制失败，请手动选中复制', 'warn');
      return false;
    }
  }

  // 地址栏/URL 参数
  function param(name) {
    try { return new URLSearchParams(location.search).get(name) || ''; } catch (_e) { return ''; }
  }

  function log(m) { try { api.log('[page] ' + m); } catch (_e) { /* noop */ } }

  function isPreview() { return !gn; }

  global.GN = { api, esc, el, toast, copy, param, log, isPreview };
})(window);
