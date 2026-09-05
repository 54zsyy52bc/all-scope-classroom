'use strict';
// 业务错误：携带 errorCode（对齐 04 文档）/ 业务 code / HTTP 状态码 / 可选 data。
// 路由层统一捕获并包装为标准信封。

const MAP = {
  'E-VAL-01': { code: 40001, httpStatus: 400 },
  'E-AUTH-01': { code: 40100, httpStatus: 401 },
  'E-CONN-01': { code: 50301, httpStatus: 503 },
  'E-SESSION-01': { code: 40401, httpStatus: 404 },
  'E-SESSION-02': { code: 40902, httpStatus: 409 },
  'E-PHASE-01': { code: 40901, httpStatus: 409 },
  'E-OFF-01': { code: 40903, httpStatus: 409 },
  'E-RETURN-01': { code: 40904, httpStatus: 409 },
  'E-NOTFOUND': { code: 40400, httpStatus: 404 },
  'E-INTERNAL': { code: 50000, httpStatus: 500 },
  'E-DUP-01': { code: 40900, httpStatus: 409 },
  // 参照完整性：外键目标不存在。由存储层把 SQLITE_CONSTRAINT_FOREIGNKEY 映射而来，
  // 禁止原生 SQLite 异常穿透到 service / 路由层。
  'E-REF-01': { code: 40905, httpStatus: 409 },
  // 计时状态机违规（如对非 running 的计时执行暂停/继续）→ 冲突
  'E-TIMER-01': { code: 40906, httpStatus: 409 },
  // 预设包结构校验失败（坏包/非 .kctpreset）→ 客户端错误
  'E-PKG-01': { code: 40002, httpStatus: 400 },
};

class BusinessError extends Error {
  constructor(errorCode, message, data = null) {
    super(message);
    const m = MAP[errorCode] || MAP['E-INTERNAL'];
    this.errorCode = errorCode;
    this.code = m.code;
    this.httpStatus = m.httpStatus;
    this.data = data;
  }
}

function fail(errorCode, message, data = null) {
  throw new BusinessError(errorCode, message, data);
}

module.exports = { BusinessError, fail, MAP };
