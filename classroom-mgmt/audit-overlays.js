'use strict';
// 遮罩层彻查：三端 styles.css 中所有 position:fixed 规则块 → 逐选择器核对
//   1) 是否已有 [hidden] CSS 覆盖（或全局 [hidden]!important 兜底）
//   2) HTML 中对应元素初始是否带 hidden（不带=初始可见，可能是 bug）
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const roots = ['student/renderer', 'teacher/public', 'preset-studio/renderer'];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const r of roots) {
  const cssPath = path.join(ROOT, r, 'styles.css');
  const htmlPath = path.join(ROOT, r, 'index.html');
  const css = fs.readFileSync(cssPath, 'utf8');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const globalImportant = /\[hidden\]\s*\{[^}]*!important/.test(css);
  const blocks = css.split('}').filter((b) => /position\s*:\s*fixed/.test(b));
  console.log('### ' + r + '  fixed 层数=' + blocks.length + '  全局[hidden]!important=' + (globalImportant ? 'Y' : 'N'));
  const seen = new Set();
  for (const b of blocks) {
    const head = b.split('{')[0];
    for (let raw of head.split(',')) {
      raw = raw.replace(/\n/g, ' ').trim();
      if (!raw) continue;
      const clsMatch = raw.match(/^\.([A-Za-z0-9_-]+)/);
      const idMatch = raw.match(/^#([A-Za-z0-9_-]+)/);
      const key = raw;
      if (seen.has(key)) continue;
      seen.add(key);
      let cls = null;
      if (clsMatch) cls = clsMatch[1];
      const hasOwn = cls ? new RegExp('\\.' + esc(cls) + '\\[hidden\\]').test(css) : false;
      // HTML 初始 hidden（只对 #id 或 class 名出现在元素上时判断）
      const probe = cls ? ('class="' + cls) : (idMatch ? ('id="' + idMatch[1] + '"') : null);
      let htmlTag = null;
      if (probe && html.includes(probe)) {
        // 找出该元素的完整开标签
        const re = new RegExp('<[a-z]+[^>]*' + esc(probe.replace(/"/g, '')) + '[^>]*>');
        const m = html.match(re);
        htmlTag = m ? (/hidden/.test(m[0]) ? 'Y(初始hidden)' : '**N(初始可见)**') : '?';
      }
      console.log('  ' + raw
        + '  | 自身[hidden]css:' + (cls ? (hasOwn ? 'Y' : 'N') : '-')
        + ' | HTML初始:' + (htmlTag || '-(未在HTML)'));
    }
  }
  console.log('');
}
