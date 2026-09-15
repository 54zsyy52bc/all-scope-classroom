'use strict';
// =============================================================================
// 通用净化 / 规范化工具（主进程）
//
// 原则：**渲染层传来的任何值都不可信**。所有跨进程入参先在 preload 收敛形状，
// 到主进程再在这里做二次净化与类型收敛，避免脏数据落盘。
// =============================================================================
const fs = require('node:fs');
const path = require('node:path');

function str(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max && s.length > max ? s.slice(0, max) : s;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function int(v, fallback, min, max) {
  const n = Math.round(num(v, fallback));
  if (typeof min === 'number' && n < min) return min;
  if (typeof max === 'number' && n > max) return max;
  return n;
}

function bool(v, fallback) {
  if (v === undefined || v === null || v === '') return !!fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'on', 'yes', 'y'].includes(s)) return true;
  if (['0', 'false', 'off', 'no', 'n'].includes(s)) return false;
  return !!fallback;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// 只保留 allowed 里列出的键（用于 patch 收敛）
function pick(obj, allowed) {
  const o = isPlainObject(obj) ? obj : {};
  const out = {};
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
  return out;
}

function readJsonSafe(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    return obj === null || obj === undefined ? fallback : obj;
  } catch (_e) {
    return fallback;
  }
}

// 原子写：先写 .tmp 再 rename，避免掉电/并发把配置文件写坏
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return obj;
}

// ---- URL 处理 -------------------------------------------------------------
const INTERNAL_PREFIX = 'internal:';

function isInternalUrl(u) {
  return String(u || '').startsWith(INTERNAL_PREFIX);
}

function internalAction(u) {
  return isInternalUrl(u) ? String(u).slice(INTERNAL_PREFIX.length).trim().toLowerCase() : '';
}

// 只放行 http / https（内部页另行判断），挡掉 file: / javascript: / data: 等危险协议
function normalizeUrl(input, opts) {
  const o = opts || {};
  let s = str(input, 2048);
  if (!s) return { ok: false, url: '', err: '地址为空' };
  if (isInternalUrl(s)) return { ok: true, url: s, err: '' };
  // 地址栏手输「mindplus.cc」→ 补 https://
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = (o.defaultScheme || 'https://') + s;
  let u = null;
  try {
    u = new URL(s);
  } catch (_e) {
    return { ok: false, url: '', err: '地址格式不正确' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, url: '', err: '只允许访问 http / https 网页' };
  }
  return { ok: true, url: u.toString(), err: '' };
}

function hostOfUrl(u) {
  try {
    return new URL(String(u)).hostname.toLowerCase();
  } catch (_e) {
    return '';
  }
}

function isLocalHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

// 私有地址判断（用于在 IP 列表里挑「设备应该填哪个」）
function isPrivateIPv4(ip) {
  const m = String(ip || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isIPv4(ip) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || ''));
}

// 生成短 ID（规则/站点/分组新增时用）
let seq = 0;
function genId(prefix) {
  seq = (seq + 1) % 100000;
  return `${prefix || 'id'}-${Date.now().toString(36)}${seq.toString(36)}`;
}

module.exports = {
  str,
  num,
  int,
  bool,
  isPlainObject,
  pick,
  readJsonSafe,
  writeJsonAtomic,
  INTERNAL_PREFIX,
  isInternalUrl,
  internalAction,
  normalizeUrl,
  hostOfUrl,
  isLocalHost,
  isPrivateIPv4,
  isIPv4,
  genId,
};
