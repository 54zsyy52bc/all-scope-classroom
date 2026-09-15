'use strict';
// =============================================================================
// 教师管理口令（scrypt + 随机 salt，只存哈希）
//
// 设计对齐《10_全域学生桌面v5_设计方案》§三「口令体系」：
//   - 口令仅存哈希（salt + hash），库/文件里没有明文
//   - 连续错误 3 次锁定 60 秒（防课堂上的暴力试错）
//   - 首次使用（data/admin.json 不存在）视为「初始化」，允许直接设置口令
//
// 存储：data/admin.json = { algo:'scrypt', salt, hash, updatedAt }
// =============================================================================
const crypto = require('node:crypto');
const U = require('./util');

const MAX_FAILS = 3;
const LOCK_MS = 60 * 1000;
const KEY_LEN = 64;

function derive(pwd, salt) {
  return crypto.scryptSync(String(pwd), String(salt), KEY_LEN).toString('hex');
}

function createAuth(file, logger) {
  let store = U.readJsonSafe(file, null);
  let fails = 0;
  let lockedUntil = 0;

  function initialized() {
    return !!(store && store.hash && store.salt);
  }

  function state() {
    const now = Date.now();
    return {
      initialized: initialized(),
      locked: now < lockedUntil,
      lockedRemainSec: now < lockedUntil ? Math.ceil((lockedUntil - now) / 1000) : 0,
      fails,
      maxFails: MAX_FAILS,
    };
  }

  // 初始化 / 修改口令。改口令需要旧口令（除首次初始化外）
  function setPassword(newPwd, oldPwd) {
    const np = U.str(newPwd, 128);
    if (np.length < 4) return { ok: false, err: '口令至少 4 位' };
    if (np.length > 128) return { ok: false, err: '口令过长' };
    const wasInitialized = initialized();
    if (wasInitialized) {
      const v = verify(oldPwd, { skipLock: true });
      if (!v.ok) return { ok: false, err: v.err || '原口令不正确' };
    }
    const salt = crypto.randomBytes(16).toString('hex');
    store = { algo: 'scrypt', salt, hash: derive(np, salt), updatedAt: Date.now() };
    U.writeJsonAtomic(file, store);
    fails = 0;
    lockedUntil = 0;
    if (logger) logger.info(wasInitialized ? '管理口令已更新' : '管理口令已初始化');
    return { ok: true };
  }

  // 校验。skipLock=true 用于「改口令时校验原口令」，不再叠加锁定计数
  function verify(pwd, opts) {
    const o = opts || {};
    const now = Date.now();
    if (!o.skipLock && now < lockedUntil) {
      return { ok: false, err: `尝试次数过多，请 ${Math.ceil((lockedUntil - now) / 1000)} 秒后再试`, locked: true };
    }
    if (!initialized()) return { ok: false, err: '尚未设置管理口令，请先初始化' };
    const p = U.str(pwd, 128);
    if (!p) return { ok: false, err: '请输入口令' };
    const got = Buffer.from(derive(p, store.salt), 'hex');
    const want = Buffer.from(store.hash, 'hex');
    const same = got.length === want.length && crypto.timingSafeEqual(got, want);
    if (same) {
      fails = 0;
      return { ok: true };
    }
    if (o.skipLock) return { ok: false, err: '原口令不正确' };
    fails += 1;
    if (fails >= MAX_FAILS) {
      lockedUntil = Date.now() + LOCK_MS;
      fails = 0;
      if (logger) logger.warn('管理口令连续错误 3 次，已锁定 60 秒');
      return { ok: false, err: '口令错误，已锁定 60 秒', locked: true };
    }
    if (logger) logger.warn(`管理口令校验失败（第 ${fails} 次）`);
    return { ok: false, err: `口令错误，还可尝试 ${MAX_FAILS - fails} 次`, remain: MAX_FAILS - fails };
  }

  return { file, initialized, state, setPassword, verify, MAX_FAILS, LOCK_MS };
}

module.exports = { createAuth, derive, MAX_FAILS, LOCK_MS };
