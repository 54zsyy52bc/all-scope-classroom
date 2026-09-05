'use strict';
// =============================================================================
// 唯一图标源：Lucide SVG 内联（统一描边 2px，统一 viewBox 0 0 24 24）。
// 全项目（学生机 + 教师端）共用，禁止 emoji / Unicode 字形作功能图标。
//
// 用法（classic <script> 加载后挂到 window.Icons）：
//   Icons.svg('wifi', 24, 'cls') -> <svg ...>...</svg>
//   Icons.svg(name)             -> 默认 24px
// 颜色由 CSS 的 currentColor 决定（stroke="currentColor"）。
// =============================================================================
(function (global) {
  // 每个图标仅保存内部 path 片段；外层 <svg> 由 svg() 统一包裹。
  const PATHS = {
    wifi:
      '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/>',
    'wifi-off':
      '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 5.17 2.37"/><path d="M10.66 5.19A15 15 0 0 1 22 8.82"/><path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"/><path d="M5 12.859a10 10 0 0 1 5.24 1.8"/><line x1="2" x2="22" y1="2" y2="22"/>',
    'loader-circle':
      '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    monitor:
      '<rect width="16" height="12" x="4" y="2" rx="2"/><path d="M9 22v-4"/><path d="M15 22v-4"/><path d="M8 22h8"/>',
    user:
      '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    hash:
      '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
    users:
      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    package:
      '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    square:
      '<rect width="18" height="18" x="3" y="3" rx="2"/>',
    'check-square':
      '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
    'clipboard-check':
      '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
    play:
      '<polygon points="6 3 20 12 6 21 6 3"/>',
    circle:
      '<circle cx="12" cy="12" r="10"/>',
    'circle-check':
      '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    'circle-help':
      '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    'circle-dashed':
      '<path d="M10.1 2.18a10 10 0 0 1 3.8 0"/><path d="M17.6 4.6a10 10 0 0 1 2.81 2.81"/><path d="M21.82 10.1a10 10 0 0 1 0 3.8"/><path d="M19.4 17.6a10 10 0 0 1-2.81 2.81"/><path d="M13.9 21.82a10 10 0 0 1-3.8 0"/><path d="M6.4 19.4a10 10 0 0 1-2.81-2.81"/><path d="M2.18 13.9a10 10 0 0 1 0-3.8"/><path d="M4.6 6.4a10 10 0 0 1 2.81-2.81"/>',
    'package-check':
      '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/><path d="m9 12 2 2 4-4"/>',
    power:
      '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
    presentation:
      '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/>',
    clock:
      '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    'log-in':
      '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
    'hand-helping':
      '<path d="M11 14h2a2 2 0 0 0 0-4h-3.7a2 2 0 0 1-1.4-.6L6 9"/><path d="m2 21 1.6-1.6A2 2 0 0 0 2 18V8a2 2 0 0 0-2-2"/><path d="M4.6 13a2 2 0 0 1-1.6-.8L2 10"/><path d="m9 9.5 1.4 1.4a2 2 0 0 1-1.4 3.4H5"/><path d="M12 21a2 2 0 0 1-2-2v-1a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2Z"/><path d="M18 21a2 2 0 0 1-2-2v-1a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2Z"/><path d="M19 9.5 20.4 8a2 2 0 0 1 1.6.8l.4.6"/><path d="m21 3 1 1a2 2 0 0 1-1.4 3.4H18"/><path d="M22 12a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-.5"/>',
    activity:
      '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    megaphone:
      '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    'file-down':
      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>',
    'bell-ring':
      '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/><path d="M2 8l3.155-3.155A1 1 0 0 0 4.52 3.49l3.155 3.155"/><path d="M21.99 8l-3.155-3.155a1 1 0 0 1 .326-1.655l3.155 3.155"/>',
    'power-off':
      '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/><line x1="2" x2="22" y1="2" y2="22"/>',
  };

  function svg(name, size, cls) {
    const inner = PATHS[name];
    if (!inner) return '';
    const s = size || 24;
    const c = cls ? ' class="' + cls + '"' : '';
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + s + '" height="' + s +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"' + c +
      ' role="img" aria-hidden="true">' + inner + '</svg>'
    );
  }

  global.Icons = {
    svg: svg,
    has: function (name) { return Object.prototype.hasOwnProperty.call(PATHS, name); },
    names: Object.keys(PATHS),
  };
})(typeof self !== 'undefined' ? self : this);
