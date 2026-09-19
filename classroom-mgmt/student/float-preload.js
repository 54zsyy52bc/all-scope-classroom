'use strict';
// =============================================================================
// 置顶浮窗专用预加载脚本（float.html 专用，与主窗口 preload.js 职责分离）。
// 只暴露：状态接收 / 动作上报 / 口令校验（复用主进程 shell:verify-local 通道）/
// 点击穿透开关 / 日志。不暴露任何配置写通道。
// =============================================================================
const { contextBridge, ipcRenderer } = require('electron');

function str(v, max) { return String(v == null ? '' : v).slice(0, max); }

contextBridge.exposeInMainWorld('floatBridge', {
  // 课堂页状态快照（主进程转发 float:status → float:state）
  onState: (cb) => ipcRenderer.on('float:state', (_e, p) => { try { cb(p); } catch (_err) { /* noop */ } }),
  // 学生操作上报（status / jump / exit / sync-request），主进程转发给课堂页处理
  sendAction: (p) => {
    const o = p && typeof p === 'object' ? p : {};
    const clean = { type: str(o.type, 24) };
    if (o.status !== undefined) clean.status = str(o.status, 16);
    if (o.to !== undefined) clean.to = str(o.to, 16);
    ipcRenderer.send('float:action', clean);
  },
  // 退出课堂口令：哈希校验在主进程（shell:verify-local），浮窗拿不到哈希本体
  getShellConfig: () => ipcRenderer.invoke('shell:get-config'),
  verifyLocal: (scope, pwd) => ipcRenderer.invoke('shell:verify-local', str(scope, 16), str(pwd, 64)),
  // 点击穿透开关：悬停面板=接管输入；离开=穿透（透明区域不挡课程应用）
  setClickthrough: (flag) => ipcRenderer.send('float:clickthrough', !!flag),
  log: (line) => ipcRenderer.invoke('app:log', str(line, 500)),
});
