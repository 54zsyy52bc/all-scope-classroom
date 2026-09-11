'use strict';
// 统一响应与错误处理。成功：{code:0,data,message:''}；失败带 errorCode。
const crypto = require('crypto');
const { BusinessError } = require('./errors');
const cfg = require('./config');
const { isLoopback, isLocalRequest } = require('./http-security');

function ok(res, data, httpStatus = 200) {
  return res.status(httpStatus).json({ code: 0, data, message: '' });
}

function error(res, err) {
  if (err instanceof BusinessError) {
    return res.status(err.httpStatus).json({
      code: err.code, message: err.message, errorCode: err.errorCode, data: err.data,
    });
  }
  // 未预期异常：记录日志，返回 E-INTERNAL
  // eslint-disable-next-line no-console
  console.error('[UNHANDLED]', err && err.stack ? err.stack : err);
  return res.status(500).json({ code: 50000, message: err.message || '服务器内部错误', errorCode: 'E-INTERNAL', data: null });
}

function asyncHandler(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((e) => error(res, e));
  };
}

function requireAuth(req, res, next) {
  if (!cfg.ENABLE_AUTH) return next();
  // 探活接口免鉴权：学生端桌面（desktop.js）跨机轮询它显示「教室在线/离线」，
  // 且该接口只返回运行状态，不含业务数据与身份信息，故保持公开。
  if (req.originalUrl && req.originalUrl.endsWith('/system/health')) return next();
  // 本机（教师机）免鉴权：大屏就在教师机上访问，既满足"默认开启鉴权"又不改变现场使用方式。
  // 注意必须同时覆盖「回环」与「本机网卡地址」——老师用局域网 IP 打开大屏也要能用。
  if (isLocalRequest(req)) return next();
  // 跨机请求需 X-Teacher-Token，且按恒定时间比较，避免令牌可枚举
  const token = req.headers['x-teacher-token'];
  if (token && cfg.TEACHER_TOKEN && safeEqual(token, cfg.TEACHER_TOKEN)) return next();
  return res.status(401).json({ code: 40100, message: '无效的教师端令牌', errorCode: 'E-AUTH-01', data: null });
}

// 恒定时间字符串比较：长度不等直接返回 false（避免 timingSafeEqual 因长度不一致抛错）
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { ok, error, asyncHandler, requireAuth, isLoopback, isLocalRequest, safeEqual };
