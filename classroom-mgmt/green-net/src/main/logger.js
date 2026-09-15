'use strict';
// =============================================================================
// 审计日志：既打 stdout（便于开机脚本抓取），也落盘 data/audit.log。
// 屏蔽命中、口令校验失败、导航事件都会记一笔 —— 课后可回传定位。
// =============================================================================
const fs = require('node:fs');
const path = require('node:path');

function createLogger(opts) {
  const o = opts || {};
  const file = o.file || '';
  const tag = o.tag || 'green-net';
  let stream = null;

  function ensure() {
    if (stream || !file) return stream;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      stream = fs.createWriteStream(file, { flags: 'a' });
    } catch (_e) {
      stream = null;
    }
    return stream;
  }

  function stamp() {
    const d = new Date();
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function line(level, msg) {
    const text = `${stamp()} [${level}] [${tag}] ${msg}`;
    try {
      // eslint-disable-next-line no-console
      (level === 'ERROR' ? console.error : console.log)(text);
    } catch (_e) { /* noop */ }
    const s = ensure();
    if (s) { try { s.write(text + '\n'); } catch (_e) { /* noop */ } }
    return text;
  }

  return {
    info: (m) => line('INFO', m),
    warn: (m) => line('WARN', m),
    error: (m) => line('ERROR', m),
    file,
    close: () => { try { if (stream) stream.end(); } catch (_e) { /* noop */ } },
  };
}

module.exports = { createLogger };
