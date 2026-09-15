'use strict';
// =============================================================================
// 下载管控 + 权限请求管控 + 证书错误处理
//
// 机房场景：学生作品走"共享盘/教学盘"，浏览器下载默认关闭，避免下到桌面后再也找不着、
// 或者误下携带风险的文件。教师可在管理面板里打开。
// =============================================================================
const { shell } = require('electron');
const path = require('node:path');

function attachSessionPolicy(session, deps) {
  const { getConfig, logger, onNotice, downloadsDir } = deps;

  // ---- 下载 ----
  session.on('will-download', (event, item) => {
    const cfg = getConfig();
    if (!cfg.allowDownload) {
      item.cancel();
      if (logger) logger.warn(`下载被阻止：${item.getURL()}`);
      if (onNotice) onNotice({ kind: 'warn', text: '老师已关闭下载功能，这个文件不能保存到电脑上。' });
      return;
    }
    try {
      const name = path.basename(item.getFilename() || 'download');
      item.setSavePath(path.join(downloadsDir, name));
    } catch (_e) { /* 用系统默认路径 */ }
    item.once('done', (_e, state) => {
      if (logger) logger.info(`下载完成：${item.getURL()} → ${state}`);
    });
  });

  // ---- 权限请求：一律拒绝（摄像头/麦克风/定位/通知）----
  try {
    session.setPermissionRequestHandler((wc, permission, callback) => {
      if (logger) logger.warn(`权限请求被拒绝：${permission}`);
      callback(false);
    });
    session.setPermissionCheckHandler(() => false);
  } catch (_e) { /* 老版本无此 API 时忽略 */ }

  // ---- 证书错误：不允许"继续访问"（避免学生点过危险的站点）----
  try {
    session.setCertificateVerifyProc((request, callback) => {
      if (logger && request.errorCode !== 0) logger.warn(`证书校验失败：${request.hostname} code=${request.errorCode}`);
      callback(-2); // -2 = 使用 Chromium 默认校验结果（即失败就失败）
    });
  } catch (_e) { /* noop */ }
}

// http(s) 之外的外链（如 mailto:）用系统默认程序打开
function openExternalIfNeeded(url) {
  try {
    if (/^https?:/i.test(url)) return false;
    shell.openExternal(url);
    return true;
  } catch (_e) {
    return false;
  }
}

module.exports = { attachSessionPolicy, openExternalIfNeeded };
