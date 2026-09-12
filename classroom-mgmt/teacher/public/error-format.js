'use strict';
// =============================================================================
// 错误格式化：把服务端返回的 { code, errorCode, message, data } 转成中文
//「原因 + 下一步」，**绝不**把 E-XXX-NN 错误码或服务端英文消息原文抛给老师。
//
// 设计取舍：
//   - 所有错误码中文是固定的、可被单测逐条锁定（见 test/error-format.test.js）；
//     动态数据（如「5 个未归还」）当前阶段不进 toast，避免回归性 UI 闪烁，
//     后续若需要可走 j.data 扩展。
//   - 调试信息（errorCode / 原始 message）写到 console.warn，方便真机排查。
//   - 这是渲染层公共工具，被 app.js / manage.js / activity.js / command.js 等复用。
// =============================================================================
(function (global) {
  // 错误码 → 「原因 / 下一步」。漏掉的码用 _default 兜底，永远不会给老师看英文或错误码。
  const MAP = {
    'E-VAL-01':      { title: '请求参数不合法',       hint: '请检查输入后重试' },
    'E-AUTH-01':     { title: '身份验证失败',         hint: '请重新打开大屏或联系管理员核对令牌' },
    'E-CONN-01':     { title: '教师服务暂不可用',     hint: '请稍后重试；若持续不可用检查教师机进程' },
    'E-SESSION-01':  { title: '当前没有进行中的课堂', hint: '请先点【开始上课】' },
    'E-SESSION-02':  { title: '课堂状态冲突',         hint: '请刷新页面或先【下课】当前课堂' },
    'E-PHASE-01':    { title: '当前阶段不允许此操作', hint: '请切换到合适的阶段后再试' },
    'E-OFF-01':      { title: '仅在课后归还阶段可关机', hint: '请先完成归还或下课后重试' },
    'E-RETURN-01':   { title: '尚有座位未确认归还',   hint: '可【强制关机】继续；或提醒对应同学归还' },
    'E-NOTFOUND':    { title: '资源不存在',           hint: '可能已过期，请刷新页面' },
    'E-INTERNAL':    { title: '教师服务内部错误',     hint: '请稍后重试；必要时查看教师机日志' },
    'E-DUP-01':      { title: '操作重复',             hint: '请刷新后重试' },
    'E-REF-01':      { title: '关联数据缺失',         hint: '请检查相关项是否仍存在' },
    'E-TIMER-01':    { title: '计时器状态不允许此操作', hint: '请刷新计时状态后重试' },
    'E-PKG-01':      { title: '预设包格式错误',       hint: '请确认是预设编辑器导出的备份文件' },
  };
  const DEFAULT = { title: '操作失败，请稍后重试', hint: '若反复失败请联系管理员' };

  function format(j) {
    if (!j || typeof j !== 'object') return DEFAULT;
    if (j.code === 0) return null; // 成功路径不返错误信息
    const hit = (j.errorCode && MAP[j.errorCode]) || DEFAULT;
    // 调试输出：errorCode + 原始 message，便于真机排查时直接抄进搜索框
    // 直接引用 console 标识符，浏览器 / Node vm 都会解析到对应环境的全局 console。
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn('[ErrorFmt] code=' + j.code +
        ' errorCode=' + (j.errorCode || '(none)') +
        ' message=' + (j.message || ''));
    }
    return hit;
  }

  // 方便渲染层一行调用：toast(fmt.title + (fmt.hint ? ' · ' + fmt.hint : ''), true)
  function toastFormatted(j, toastFn) {
    const f = format(j);
    if (!f) return false;
    if (typeof toastFn !== 'function') return true; // 仅返回「这是错误」语义
    toastFn(f.title + (f.hint ? ' · ' + f.hint : ''), true);
    return true;
  }

  global.ErrorFmt = { format, toastFormatted, MAP, DEFAULT };
})(typeof window !== 'undefined' ? window : globalThis);