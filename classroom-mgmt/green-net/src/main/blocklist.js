'use strict';
// =============================================================================
// 屏蔽引擎（纯函数，可单测）
//
// 判定优先级（从高到低）：
//   1. 非 http/https / 内部页     → 放行（协议层已在 normalizeUrl 拦掉）
//   2. 白名单例外 allowDomains    → 放行（老师给的"必用站点"，最高优先级）
//   3. 本机回环（可选）           → 放行（SIoT 控制台是本浏览器核心功能）
//   4. 模式 = whitelist           → 不在 allowDomains 内一律拦截
//   5. 模式 = blacklist           → 命中任一启用规则则拦截
//
// 规则类型：
//   domain  值 = 域名，按「自身 + 子域」匹配（game.com 命中 www.game.com / a.b.game.com）
//   keyword 值 = 关键词，对完整 URL 做不区分大小写的包含匹配
//   url     值 = URL 前缀，对完整 URL 做不区分大小写的 startsWith
//   regex   值 = 正则（i 标志）；非法正则视为永不命中，并在 check 结果里标记 invalid
// =============================================================================
const U = require('./util');

const RULE_TYPES = ['domain', 'keyword', 'url', 'regex'];

function hostSuffixMatch(host, ruleHost) {
  const h = String(host || '').toLowerCase().replace(/^\*\./, '');
  let r = String(ruleHost || '').toLowerCase().trim();
  if (!h || !r) return false;
  r = r.replace(/^\*\./, '').replace(/\/.*$/, '').replace(/^\.+|\.+$/g, '');
  if (!r) return false;
  return h === r || h.endsWith('.' + r);
}

function normalizeRule(raw, index) {
  const r = U.isPlainObject(raw) ? raw : {};
  const type = RULE_TYPES.includes(r.type) ? r.type : 'keyword';
  let value = U.str(r.value, 512);
  if (type === 'regex') {
    // 老师常按 /pattern/i 的写法粘贴，这里把包裹的斜杠去掉（否则会当成字面量，永远不命中）
    value = value.replace(/^\/(.*)\/[a-z]*$/i, '$1');
    try { new RegExp(value, 'i'); } catch (_e) { /* 保留原文，编译失败时不命中 */ }
  }
  return {
    id: U.str(r.id, 64) || U.genId('r' + (index + 1)),
    type,
    value,
    note: U.str(r.note, 60),
    enabled: r.enabled === undefined ? true : U.bool(r.enabled, true),
  };
}

function normalize(raw) {
  const b = U.isPlainObject(raw) ? raw : {};
  const allow = Array.isArray(b.allowDomains) ? b.allowDomains : [];
  return {
    version: 1,
    enabled: b.enabled === undefined ? true : U.bool(b.enabled, true),
    mode: b.mode === 'whitelist' ? 'whitelist' : 'blacklist',
    updatedAt: U.num(b.updatedAt, 0),
    updatedBy: U.str(b.updatedBy, 40) || 'unknown',
    alwaysAllowLocal: b.alwaysAllowLocal === undefined ? true : U.bool(b.alwaysAllowLocal, true),
    allowDomains: allow
      .map((x) => U.str(x, 200).toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // 去协议（老师常整段粘贴 URL）
        .replace(/^\*\./, '')                   // 去通配前缀
        .replace(/\/.*$/, '')                   // 去路径
        .replace(/:\d+$/, '')                   // 去端口
        .replace(/^\.+|\.+$/g, '')              // 去首尾点
        .trim())
      // 只保留像域名的条目：含点（或 localhost / IPv4），且只由合法字符组成
      .filter((h) => h && /^[a-z0-9.-]+$/.test(h) && (h.includes('.') || h === 'localhost'))
      .slice(0, 500),
    rules: (Array.isArray(b.rules) ? b.rules : [])
      .map((r, i) => normalizeRule(r, i))
      .filter((r) => !!r.value)
      .slice(0, 1000),
  };
}

// 编入口罩：normalize + 预编译正则，check 时不重复编译
function compile(raw) {
  const cfg = normalize(raw);
  const compiled = cfg.rules.map((r) => {
    let re = null;
    let invalid = false;
    if (r.type === 'regex') {
      try { re = new RegExp(r.value, 'i'); } catch (_e) { invalid = true; }
    }
    return { rule: r, re, invalid };
  });
  return { cfg, compiled };
}

// 单条规则命中判定
function matchEntry(entry, url, host) {
  const { rule, re, invalid } = entry;
  if (invalid) return false;
  switch (rule.type) {
    case 'domain':
      return hostSuffixMatch(host, rule.value);
    case 'url': {
      const v = rule.value.toLowerCase();
      const u = url.toLowerCase();
      if (u.startsWith(v)) return true;
      // 「域名+路径」写法（如 baidu.com/s）走包含匹配，老师输入更省事
      return v.includes('/') && u.includes(v);
    }
    case 'regex':
      return re ? re.test(url) : false;
    case 'keyword':
    default:
      return url.toLowerCase().includes(rule.value.toLowerCase());
  }
}

// 判定单个 URL
// 返回：{ blocked, reason, rule, host }
//   reason: 'off'           屏蔽未启用
//         | 'allow-list'    命中白名单例外
//         | 'local'         本机回环放行
//         | 'rule'          命中规则
//         | 'not-allowlisted' 白名单模式下不在允许清单
//         | 'none'          未命中，放行
function check(engine, url) {
  const cfg = engine.cfg;
  const u = String(url || '');
  const host = U.hostOfUrl(u);
  const out = { blocked: false, reason: 'none', rule: null, host };

  if (U.isInternalUrl(u) || !/^https?:\/\//i.test(u)) { out.reason = 'allow-list'; return out; }
  if (!cfg.enabled) { out.reason = 'off'; return out; }

  for (const d of cfg.allowDomains) {
    if (hostSuffixMatch(host, d)) { out.reason = 'allow-list'; return out; }
  }
  if (cfg.alwaysAllowLocal && U.isLocalHost(host)) { out.reason = 'local'; return out; }

  if (cfg.mode === 'whitelist') {
    out.blocked = true;
    out.reason = 'not-allowlisted';
    return out;
  }
  for (const e of engine.compiled) {
    if (!e.rule.enabled) continue;
    if (matchEntry(e, u, host)) {
      out.blocked = true;
      out.reason = 'rule';
      out.rule = e.rule;
      return out;
    }
  }
  return out;
}

// 给管理界面用的自检：返回每条规则的命中样例说明（不做真实请求）
function explain(engine, url) {
  const r = check(engine, url);
  const human = {
    off: '屏蔽功能已关闭，全部放行',
    'allow-list': '在白名单例外中，允许访问',
    local: '本机地址（SIoT / 本地服务），允许访问',
    rule: r.rule ? `命中规则「${r.rule.type} = ${r.rule.value}」` : '命中规则',
    'not-allowlisted': '当前为「只允许白名单」模式，该站点不在允许清单内',
    none: '未命中任何规则，允许访问',
  };
  return { ...r, message: human[r.reason] || '未命中' };
}

function createStore(file, logger) {
  let engine = compile(U.readJsonSafe(file, {}));
  function reload() { engine = compile(U.readJsonSafe(file, {})); return engine; }
  function get() { return JSON.parse(JSON.stringify(engine.cfg)); }
  function save(patch, by) {
    const cur = engine.cfg;
    const next = normalize(Object.assign({}, cur, U.pick(patch || {}, [
      'enabled', 'mode', 'allowDomains', 'rules', 'alwaysAllowLocal',
    ]), { updatedAt: Date.now(), updatedBy: U.str(by, 40) || 'teacher' }));
    U.writeJsonAtomic(file, next);
    engine = compile(next);
    if (logger) logger.info(`屏蔽配置已更新：模式=${next.mode} 规则=${next.rules.length} 白名单=${next.allowDomains.length}`);
    return get();
  }
  return {
    file,
    get,
    save,
    reload,
    check: (url) => check(engine, url),
    explain: (url) => explain(engine, url),
    engine: () => engine,
  };
}

module.exports = {
  RULE_TYPES,
  hostSuffixMatch,
  normalizeRule,
  normalize,
  compile,
  matchEntry,
  check,
  explain,
  createStore,
};
