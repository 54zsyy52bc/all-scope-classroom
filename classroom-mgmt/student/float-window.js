'use strict';
// =============================================================================
// 置顶状态浮窗（独立 BrowserWindow，主进程）。
//
// 为什么是独立窗口：课堂应用以独立 OS 窗口全屏运行，页面内的 DOM 浮窗（z-index 45）
// 会被盖住，学生看不到"进行中/计时/求助"等状态。独立 alwaysOnTop 窗口永远可见。
//
// 通信（唯一真源仍是课堂页的 MQTT，浮窗绝不自带第二套 MQTT——见 MEMORY 约定）：
//   课堂页 --float:status(send)--> 本模块 --float:state--> 浮窗渲染层
//   浮窗   --float:action(send)--> 本模块 --float:action--> 课堂页处理
//
// 点击穿透：窗口 transparent + 默认 setIgnoreMouseEvents(true,{forward:true})，
// 只有鼠标悬停在面板本体上时才接管输入（否则 340x560 的透明区域会挡住底下课程应用的点击）。
// =============================================================================
const path = require('node:path');
const { BrowserWindow, ipcMain, screen } = require('electron');

const FLOAT_W = 340;
const FLOAT_H = 560;
const MARGIN = 12;

module.exports = function createFloatWindow() {
  let win = null;
  let wired = false;

  function ensure() {
    if (win && !win.isDestroyed()) return win;
    const wa = screen.getPrimaryDisplay().workArea;
    win = new BrowserWindow({
      width: FLOAT_W,
      height: FLOAT_H,
      x: wa.x + MARGIN,
      y: wa.y + wa.height - FLOAT_H - MARGIN, // 左下角，与原 DOM 浮窗位置一致
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: true,
      show: false,
      transparent: true,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'float-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });
    // screen-saver 级：压过普通应用窗口与 kiosk 主窗口，任务管理器/系统弹窗之上不保证
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile(path.join(__dirname, 'renderer', 'float.html'));
    win.on('closed', () => { win = null; });
    return win;
  }

  function show() {
    const w = ensure();
    if (!w.isVisible()) w.showInactive(); // showInactive：不抢课程应用/主窗口焦点
    // 分辨率/投影切换后位置可能出屏，每次 show 前校正
    try {
      const wa = screen.getPrimaryDisplay().workArea;
      w.setBounds({ x: wa.x + MARGIN, y: wa.y + wa.height - FLOAT_H - MARGIN, width: FLOAT_W, height: FLOAT_H });
    } catch (_e) { /* noop */ }
  }

  function hide() { try { if (win && !win.isDestroyed()) win.hide(); } catch (_e) { /* noop */ } }
  function send(ch, payload) { try { if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send(ch, payload); } catch (_e) { /* noop */ } }

  // 主窗口导航联动：课堂页(index.html)=显示浮窗；桌面/自由创作页=隐藏
  function onMainNav(url) {
    if (/index\.html([?#]|$)/.test(String(url || ''))) show();
    else hide();
  }

  // 中继通道只注册一次（app 生命周期级）
  function relay(getMainWindow) {
    if (wired) return;
    wired = true;
    ipcMain.on('float:status', (_e, p) => send('float:state', p));
    ipcMain.on('float:action', (_e, p) => {
      const m = getMainWindow();
      try { if (m && !m.isDestroyed()) m.webContents.send('float:action', p); } catch (_err) { /* noop */ }
    });
    ipcMain.on('float:clickthrough', (_e, flag) => {
      try {
        if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!flag, { forward: true });
      } catch (_err) { /* noop */ }
    });
  }

  return { ensure, show, hide, onMainNav, relay };
};
