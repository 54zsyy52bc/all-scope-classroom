'use strict';
// =============================================================================
// 导航首页内容（data/nav-config.json）
//
// 结构：{ title, subtitle, quickActions[], groups[{ id,name,icon,color,sites[] }] }
// 站点 url 支持两种形态：
//   - http(s)://…      普通网页
//   - internal:<action> 内置动作（home / siot / ip / qy / admin）
//
// 老师可在管理面板里增删分组与站点；主进程负责净化与原子落盘。
// =============================================================================
const U = require('./util');

const INTERNAL_ACTIONS = ['home', 'siot', 'ip', 'qy', 'admin'];

const DEFAULT_CONFIG = {
  version: 1,
  title: '绿网 · 学生导航',
  subtitle: '创客与物联网实践课堂',
  updatedAt: 0,
  quickActions: [
    { id: 'qa-siot', type: 'internal', action: 'siot', name: 'SIoT 控制台', icon: '🛰️', desc: '打开本机物联网服务' },
    { id: 'qa-ip', type: 'internal', action: 'ip', name: '查看本机 IP', icon: '🌐', desc: '给设备填写地址' },
    { id: 'qa-home', type: 'internal', action: 'home', name: '回到首页', icon: '🏠', desc: '返回导航页' },
  ],
  groups: [],
};

function normSite(raw, idx, groupId) {
  const s = U.isPlainObject(raw) ? raw : {};
  let url = U.str(s.url, 512);
  if (U.isInternalUrl(url)) {
    const a = U.internalAction(url);
    url = INTERNAL_ACTIONS.includes(a) ? `internal:${a}` : 'internal:home';
  }
  return {
    id: U.str(s.id, 64) || U.genId(`s-${groupId}-${idx}`),
    name: U.str(s.name, 40) || '未命名',
    url,
    icon: U.str(s.icon, 4) || '🔗',
    desc: U.str(s.desc, 60),
    color: /^#[0-9a-f]{3,8}$/i.test(String(s.color || '')) ? String(s.color) : '#16a34a',
  };
}

function normGroup(raw, idx) {
  const g = U.isPlainObject(raw) ? raw : {};
  const id = U.str(g.id, 64) || U.genId(`g${idx + 1}`);
  const sites = (Array.isArray(g.sites) ? g.sites : [])
    .slice(0, 40)
    .map((s, i) => normSite(s, i, id))
    .filter((s) => !!s.url);
  return {
    id,
    name: U.str(g.name, 30) || `分组 ${idx + 1}`,
    icon: U.str(g.icon, 4) || '📁',
    color: /^#[0-9a-f]{3,8}$/i.test(String(g.color || '')) ? String(g.color) : '#16a34a',
    sites,
  };
}

function normQuick(raw, idx) {
  const q = U.isPlainObject(raw) ? raw : {};
  const action = U.str(q.action, 24).toLowerCase();
  return {
    id: U.str(q.id, 64) || U.genId(`qa${idx + 1}`),
    type: 'internal',
    action: INTERNAL_ACTIONS.includes(action) ? action : 'home',
    name: U.str(q.name, 30) || '快捷操作',
    icon: U.str(q.icon, 4) || '⚡',
    desc: U.str(q.desc, 60),
  };
}

function normalize(raw) {
  const r = U.isPlainObject(raw) ? raw : {};
  const groups = (Array.isArray(r.groups) ? r.groups : []).slice(0, 12).map((g, i) => normGroup(g, i));
  const quick = (Array.isArray(r.quickActions) ? r.quickActions : DEFAULT_CONFIG.quickActions)
    .slice(0, 8).map((q, i) => normQuick(q, i));
  return {
    version: 1,
    title: U.str(r.title, 40) || DEFAULT_CONFIG.title,
    subtitle: U.str(r.subtitle, 60) || DEFAULT_CONFIG.subtitle,
    updatedAt: U.num(r.updatedAt, 0),
    quickActions: quick,
    groups,
  };
}

function createStore(file, logger, seedFile) {
  let cache = null;

  function load() {
    const raw = U.readJsonSafe(file, null);
    if (raw === null && seedFile) {
      // data/nav-config.json 丢失时从仓库内置种子恢复，避免学生开机看到空白首页
      const seed = U.readJsonSafe(seedFile, null);
      if (seed) {
        cache = normalize(seed);
        try { U.writeJsonAtomic(file, cache); } catch (_e) { /* noop */ }
        if (logger) logger.warn(`导航配置缺失，已从种子恢复：${seedFile}`);
        return cache;
      }
    }
    cache = normalize(raw === null ? DEFAULT_CONFIG : raw);
    return cache;
  }

  load();

  function get() { return JSON.parse(JSON.stringify(cache)); }

  function save(next, by) {
    const merged = normalize(Object.assign({}, cache, U.pick(next || {}, [
      'title', 'subtitle', 'groups', 'quickActions',
    ]), { updatedAt: Date.now() }));
    U.writeJsonAtomic(file, merged);
    cache = merged;
    if (logger) {
      const n = merged.groups.reduce((a, g) => a + g.sites.length, 0);
      logger.info(`导航配置已更新（操作人=${U.str(by, 40) || 'teacher'}）：分组=${merged.groups.length} 站点=${n}`);
    }
    return get();
  }

  function reset(seedPath) {
    const seed = U.readJsonSafe(seedPath, null);
    cache = normalize(seed || U.readJsonSafe(file, DEFAULT_CONFIG));
    U.writeJsonAtomic(file, cache);
    if (logger) logger.warn('导航配置已恢复默认');
    return get();
  }

  // 统计所有站点的 URL（供屏蔽预览 / 冲突检查）
  function allUrls() {
    const out = [];
    for (const g of cache.groups) for (const s of g.sites) out.push({ group: g.name, ...s });
    return out;
  }

  return { file, load, get, save, reset, allUrls };
}

module.exports = {
  INTERNAL_ACTIONS,
  DEFAULT_CONFIG,
  normalize,
  normSite,
  normGroup,
  createStore,
};
