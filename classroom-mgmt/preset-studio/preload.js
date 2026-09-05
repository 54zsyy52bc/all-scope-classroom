'use strict';
// Preset Studio · preload：以最小面暴露安全 IPC 桥。
// contextIsolation 开启：渲染层只能拿到这里显式暴露的 StudioApi，无 Node 能力。
const { contextBridge, ipcRenderer } = require('electron');

function call(channel, payload) {
  return ipcRenderer.invoke(channel, payload).then((r) => {
    if (r && r.ok === false) throw new Error(r.error || '操作失败');
    return r ? r.data : undefined;
  });
}

contextBridge.exposeInMainWorld('StudioApi', {
  listAll: () => call('presets:list'),
  saveClass: (row) => call('class:save', row),
  removeClass: (id) => call('class:remove', id),
  saveActivity: (row) => call('activity:save', row),
  removeActivity: (id) => call('activity:remove', id),
  saveDict: (item) => call('dict:save', item),
  removeDict: (eqId) => call('dict:remove', eqId),
  pkgExport: (filter) => call('pkg:export', filter),
  pkgPreview: (pkg) => call('pkg:preview', pkg),
  pkgCommit: (pkg) => call('pkg:commit', pkg),
  pkgSaveFile: (pkg) => call('pkg:save-file', pkg),
  pkgOpenFile: () => call('pkg:open-file'),
});
