'use strict';
// postinstall 附属：把 classroom-mgmt/shared 的浏览器侧契约复制到 student/shared/，
// 供 renderer 页面相对引用（../shared/topics.js、../shared/icons.js）。
// 打包前也需执行本脚本（electron-builder files 只收集 student 目录内的文件）。
const fs = require('node:fs');
const path = require('node:path');

const FILES = ['topics.js', 'icons.js', 'preset-package.js'];
const srcDir = path.join(__dirname, '..', '..', 'shared');
const destDir = path.join(__dirname, '..', 'shared');

try {
  fs.mkdirSync(destDir, { recursive: true });
  let copied = 0;
  for (const f of FILES) {
    const src = path.join(srcDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(destDir, f));
      copied += 1;
    } else {
      // eslint-disable-next-line no-console
      console.warn('[copy-shared] 源缺失（忽略）:', src);
    }
  }
  // eslint-disable-next-line no-console
  console.log('[copy-shared] 已复制', copied, '/', FILES.length, '个共享契约到 student/shared/');
} catch (e) {
  // eslint-disable-next-line no-console
  console.warn('[copy-shared] 复制失败（可忽略）:', e.message);
}
