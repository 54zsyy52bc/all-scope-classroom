'use strict';
// =============================================================================
// 内置页协议 gnet://
//
// 为什么用自定义协议而不是"渲染层叠面板"：
//   - 内置页是真正的导航目标 → 前进/后退、地址栏、标签标题都天然正确
//   - 学生从 gnet://home 点外网链接、再按后退，能正常回到首页
//
// 路由规则（host 即页面名，standard 协议下 host 可解析）：
//   gnet://home/            导航首页
//   gnet://ip/              本机 IP
//   gnet://siot/            SIoT 控制台引导
//   gnet://admin/           教师管理（进入前必须过口令）
//   gnet://blocked/?url=…   网页已屏蔽提示
//   gnet://locked/          课堂锁定
//   gnet://error/?code=…    打不开这个网页
//   gnet://qy/              全域课堂连接状态
//   gnet://help/            使用帮助
//   gnet://<host>/assets/*  同源静态资源（共享样式/工具）
//   gnet://<host>/<x>.js    页面同级脚本（如 gnet://home/home.js）
//
// 踩坑记录：曾经只把 /assets/* 当静态资源，其余路径一律落到"按 host 取页面"分支。
//   于是 ./home.js 解析出的 gnet://home/home.js 被当成页面请求，
//   返回了一份 text/html —— 浏览器按 JS 解析就报
//   "Uncaught SyntaxError: Unexpected token '<'"，页面脚本整段不执行，
//   表现为「首页按钮点了没反应」这种不像 bug 的 bug。
//   修正：凡不是页面根路径的请求，统一按「pagesDir 下的静态文件」处理。
// =============================================================================
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

// 允许通过 gnet:// 读取的扩展名白名单。
// 故意不含 .json / .map：内置页不需要，少一类可被探测的文件就少一类风险。
const SERVABLE_EXT = new Set(['.html', '.css', '.js', '.svg', '.png', '.webp', '.woff2']);

const PAGES = ['home', 'ip', 'siot', 'admin', 'blocked', 'locked', 'error', 'qy', 'help'];

function registerSchemes(protocol) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'gnet',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

// 返回 (session) => void，把 gnet 处理器挂到指定 session（网页用的独立分区）
function createProtocolHandler(opts) {
  const pagesDir = opts.pagesDir;
  const logger = opts.logger;

  function notFound(what) {
    return new Response(`<!doctype html><meta charset="utf-8"><title>绿网</title>
<body style="font-family:'Microsoft YaHei UI',sans-serif;padding:40px">
<h2>找不到内置页面</h2><p>${String(what).replace(/[<>&]/g, '')}</p>
<p><a href="gnet://home/">返回导航首页</a></p></body>`, {
      status: 404, headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  function readPage(name) {
    const f = path.join(pagesDir, name + '.html');
    if (!fs.existsSync(f)) return null;
    return fs.readFileSync(f, 'utf8');
  }

  // 读取 pagesDir 下的静态文件（含 assets/ 子目录）。
  // 安全约束：
  //   ① 目录穿越防护——解析后的绝对路径必须仍在 pagesDir 内；
  //   ② 扩展名白名单——挡掉 .json/.map/.log 等无关文件；
  //   ③ 拒绝以点开头的路径段（.git / .. 之类）。
  function readStatic(rel) {
    const clean = path.posix.normalize('/' + String(rel || '').replace(/\\/g, '/'));
    if (clean.includes('\0')) return null;
    const segs = clean.split('/').filter(Boolean);
    if (segs.some((s) => s.startsWith('.'))) return null;

    const ext = path.extname(clean).toLowerCase();
    if (!SERVABLE_EXT.has(ext)) return null;

    const base = path.resolve(pagesDir);
    const abs = path.resolve(base, '.' + clean);
    // 再次确认没有跳出 pagesDir（normalize 已处理 '..'，这里是兜底断言）
    if (abs !== base && !abs.startsWith(base + path.sep)) return null;

    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
      return { buf: fs.readFileSync(abs), mime: MIME[ext] || 'application/octet-stream' };
    } catch (_e) {
      return null;
    }
  }

  async function handle(request) {
    let u;
    try { u = new URL(request.url); } catch (_e) { return notFound('URL 解析失败'); }
    const host = String(u.hostname || '').toLowerCase();
    const pathname = decodeURIComponent(u.pathname || '/');

    // 非页面根路径 → 静态文件（./assets/pages.css 与 ./home.js 都走这里）
    if (pathname !== '/' && pathname !== '') {
      const a = readStatic(pathname);
      if (!a) return notFound(pathname);
      return new Response(a.buf, {
        status: 200,
        headers: { 'content-type': a.mime, 'cache-control': 'no-store' },
      });
    }

    if (!PAGES.includes(host)) return notFound(u.hostname);
    const html = readPage(host);
    if (html === null) return notFound(host + '.html');
    if (logger && host === 'admin') logger.info('打开教师管理页');
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  return function attach(session) {
    try {
      session.protocol.handle('gnet', handle);
    } catch (e) {
      if (logger) logger.error('注册 gnet 协议失败：' + (e && e.message));
    }
  };
}

module.exports = { registerSchemes, createProtocolHandler, PAGES };
