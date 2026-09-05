'use strict';
// 统一响应与错误处理。成功：{code:0,data,message:''}；失败带 errorCode。
const { BusinessError } = require('./errors');
const cfg = require('./config');

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
  const token = req.headers['x-teacher-token'];
  if (token && token === cfg.TEACHER_TOKEN) return next();
  return res.status(401).json({ code: 40100, message: '无效的教师端令牌', errorCode: 'E-AUTH-01', data: null });
}

module.exports = { ok, error, asyncHandler, requireAuth };
