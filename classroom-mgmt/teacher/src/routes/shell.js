'use strict';
// ===== v5 全域学生桌面：教师端下发课程 / 口令校验 =====
// 口令只存 sha256(salt:scope:pwd) 哈希；scope: mode-exit | admin
// 数据落 teacher/data/shell.json（可被大屏管理 UI 读写）。
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ok, error, asyncHandler } = require('../response');

const router = express.Router();
const FILE = path.join(__dirname, '..', '..', 'data', 'shell.json');

function defaults() {
  return {
    salt: 'qy-shell-v5',
    modeExit: { enabled: false, hash: '' },
    admin: { enabled: false, hash: '' },
    courses: [{ id: 'c1', name: '信息技术·硬件实践课', active: true }],
  };
}
function load() {
  try { return Object.assign(defaults(), JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (_e) { return defaults(); }
}
function save(cfg) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), 'utf8');
}
function hashOf(cfg, scope, pwd) {
  return crypto.createHash('sha256').update(`${cfg.salt}:${scope}:${pwd}`).digest('hex');
}
function publicCfg(cfg) {
  return {
    courses: cfg.courses || [],
    modeExit: { enabled: !!cfg.modeExit.enabled },
    admin: { enabled: !!cfg.admin.enabled },
  };
}

// 学生端启动拉取：课程列表 + 各口令是否启用（不下发哈希）
router.get('/config', (req, res) => ok(res, publicCfg(load())));

// 学生端口令校验（防明文存储，仅比对哈希）
router.post('/verify', asyncHandler(async (req, res) => {
  const { scope, pwd } = req.body || {};
  if (!['mode-exit', 'admin'].includes(scope)) return error(res, 'E-VAL-01', 'scope 非法');
  if (!pwd || String(pwd).length > 32) return error(res, 'E-VAL-01', '口令格式非法');
  const cfg = load();
  const slot = cfg[scope] || {};
  if (!slot.enabled || !slot.hash) { ok(res, { ok: true, disabled: true }); return; } // 未启用=免口令
  const hash = hashOf(cfg, scope, String(pwd));
  ok(res, { ok: hash === slot.hash });
}));

// 教师设置（大屏/Studio 管理页 M4 对接）：启用+设口令，或仅设课程
router.post('/config', asyncHandler(async (req, res) => {
  const { scope, enabled, pwd, courses } = req.body || {};
  const cfg = load();
  if (scope && ['mode-exit', 'admin'].includes(scope)) {
    const slot = cfg[scope];
    if (enabled != null) slot.enabled = !!enabled;
    if (pwd) {
      if (String(pwd).length < 4 || String(pwd).length > 32) return error(res, 'E-VAL-01', '口令须 4-32 位');
      const other = scope === 'admin' ? cfg.modeExit : cfg.admin;
      if (other.hash && other.hash === hashOf(cfg, other === cfg.admin ? 'admin' : 'mode-exit', String(pwd))) {
        return error(res, 'E-VAL-01', '两种口令不可相同（系统口令与课程口令须相互独立）');
      }
      slot.hash = hashOf(cfg, scope, String(pwd));
      slot.enabled = true;
    }
  }
  if (Array.isArray(courses)) {
    cfg.courses = courses.map((c, i) => ({
      id: c.id || 'c' + (i + 1), name: String(c.name || '').slice(0, 30),
      active: c.active !== false,
    })).filter((c) => c.name);
  }
  save(cfg);
  ok(res, publicCfg(cfg));
}));

module.exports = router;
