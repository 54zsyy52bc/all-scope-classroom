'use strict';
// =============================================================================
// Preset Studio · Electron 主进程
// 办公电脑独立应用：预设维护（零外部依赖——不连 broker、不起 HTTP 服务）。
//
// 职责边界：
//   - 窗口生命周期 + 单实例锁
//   - 本地 JSON 库读写（createStore，userData 目录）
//   - IPC 桥接渲染层（CRUD / 器材字典 / 预设包导出导入，含文件对话框）
//   - 渲染层不可信：所有数据操作经主进程 store，预演/合并逻辑在主进程执行
// =============================================================================
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createStore } = require('../src/store');

let mainWindow = null;
let store = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // 数据文件：打包后用 userData（可写）；开发环境同样落 userData，不污染仓库
  function dataFile() {
    if (process.env.PRESET_STUDIO_DATA) return process.env.PRESET_STUDIO_DATA;
    return path.join(app.getPath('userData'), 'presets.json');
  }

  // ---------------- IPC：预设 CRUD / 字典 ----------------
  function wrap(handler) {
    return async (_e, ...args) => {
      try {
        return { ok: true, data: await handler(...args) };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    };
  }

  function registerIpc() {
    ipcMain.handle('presets:list', wrap(() => ({
      classes: store.listClasses(),
      activities: store.listActivities(),
      dict: store.listDict(),
    })));

    ipcMain.handle('class:save', wrap((row) => {
      const r = row || {};
      const id = r.preset_id || store.genId('CP');
      return store.upsertClass(Object.assign({}, r, { preset_id: id }));
    }));
    ipcMain.handle('class:remove', wrap((id) => { store.removeClass(id); return { presetId: id }; }));

    ipcMain.handle('activity:save', wrap((row) => {
      const r = row || {};
      const id = r.preset_id || store.genId('AP');
      return store.upsertActivity(Object.assign({}, r, { preset_id: id }));
    }));
    ipcMain.handle('activity:remove', wrap((id) => { store.removeActivity(id); return { presetId: id }; }));

    ipcMain.handle('dict:save', wrap((item) => store.upsertDictItem(item)));
    ipcMain.handle('dict:remove', wrap((eqId) => { store.removeDictItem(eqId); return { eqId }; }));

    // 预设包：导出（filter={classes:[],activities:[]} 可选，只导出勾选如"单活动包"；缺省全量）/ 预演 / 提交
    ipcMain.handle('pkg:export', wrap((filter) => store.exportPackage(filter)));

    ipcMain.handle('pkg:preview', wrap((pkg) => store.previewImport(pkg)));

    ipcMain.handle('pkg:commit', wrap((pkg) => {
      const ret = store.commitImport(pkg);
      return ret;
    }));

    // 文件落盘 / 打开（U盘、网盘传递）
    ipcMain.handle('pkg:save-file', wrap(async (pkg) => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const defName = '预设备份_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + '.kctpreset';
      const res = await dialog.showSaveDialog(mainWindow, {
        title: '导出预设包',
        defaultPath: defName,
        filters: [{ name: '预设包', extensions: ['kctpreset', 'json'] }],
      });
      if (res.canceled || !res.filePath) return null;
      fs.writeFileSync(res.filePath, JSON.stringify(pkg, null, 2), 'utf8');
      return res.filePath;
    }));

    ipcMain.handle('pkg:open-file', wrap(async () => {
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '导入预设包',
        properties: ['openFile'],
        filters: [{ name: '预设包 / JSON', extensions: ['kctpreset', 'json'] }],
      });
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
      const raw = fs.readFileSync(res.filePaths[0], 'utf8');
      return { pkg: JSON.parse(raw), fileName: path.basename(res.filePaths[0]) };
    }));
  }

  app.whenReady().then(() => {
    store = createStore(dataFile());
    registerIpc();

    mainWindow = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 1000,
      minHeight: 680,
      title: '课堂管理系统 · 预设编辑器（Preset Studio）',
      backgroundColor: '#0C1018',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    mainWindow.on('closed', () => { mainWindow = null; });
  });

  app.on('window-all-closed', () => { app.quit(); });
}
