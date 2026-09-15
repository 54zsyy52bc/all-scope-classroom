'use strict';
// =============================================================================
// 课堂应用 ↔ 进程 注册表（主进程内存态）
//
// 职责：把「每个课堂应用对应哪些进程」这件事内存化，供悬浮窗实时显示运行态。
//   - setApps：推导 exe（.exe 直接取文件名；.lnk 异步解析目标后缓存）
//   - observe：用 tasklist 得到的进程名集合判断每个 app 是否运行（状态变化回调）
//   - bindLaunch：启动 app 前记录进程表，启动后 0.4/1.2/2.5s 各取一次，
//     把新增进程并入 observedExes（解决 .lnk / 启动器 / cmd start 拿不到 pid 的情况）
// 不修改任何配置结构，exe 解析结果只放内存。
// =============================================================================
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

// 启动窗口内新出现的进程里，这些是系统/宿主噪声，绝不能算成「课堂应用的进程」。
// 否则悬浮坞会显示「运行中 5 进程」这类离谱状态（进程显示异常的元凶之一）。
const NOISE = new Set(['conhost.exe', 'cmd.exe', 'powershell.exe', 'wscript.exe', 'cscript.exe',
  'svchost.exe', 'dllhost.exe', 'runtimebroker.exe', 'applicationframehost.exe',
  'startmenuexperiencehost.exe', 'shellexperiencehost.exe', 'searchhost.exe', 'searchapp.exe',
  'textinputhost.exe', 'ctfmon.exe', 'taskhostw.exe', 'wmiprvse.exe', 'wudfhost.exe',
  'spoolsv.exe', 'explorer.exe', 'werfault.exe', 'backgroundtaskhost.exe', 'systemsettings.exe',
  'sihost.exe', 'userinit.exe', 'dwm.exe', 'winlogon.exe', 'fontdrvhost.exe', 'audiodg.exe',
  'msedgewebview2.exe', 'elevation_service.exe', 'sihclient.exe', 'trustedinstaller.exe',
  'tiworker.exe', 'compattelrunner.exe', 'musnotificationux.exe', 'useroobebroker.exe']);

module.exports = function createAppRegistry({ onRunningChange, log }) {
  let apps = []; // {id,name,path,exe,observedExes:Set,running,procNames:[]}

  function doLog(m) { try { if (log) log(m); } catch (_e) { /* noop */ } }

  // 一次性 PowerShell 解析 .lnk 目标 exe（仅取 .exe）
  function resolveLnk(lpath) {
    try {
      const ps = "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('"
        + String(lpath).replace(/'/g, "''") + "');$s.TargetPath";
      execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps],
        { windowsHide: true, timeout: 8000 },
        (err, out) => {
          if (err || !out) return;
          const p = String(out).trim().replace(/^"|"$/g, '');
          // 目标必须真实存在：COM 解析失败时 out 可能是错误文本，若不校验会把垃圾
          // 当成 exe 塞进 allow 列表，反而让真正的课堂应用被误最小化。
          if (!/\.exe$/i.test(p) || !fs.existsSync(p)) return;
          const ex = path.basename(p).toLowerCase();
          const a = apps.find((x) => x.path === lpath);
          if (a && !a.exe) { a.exe = ex; doLog('lnk 解析 ' + a.id + ' -> ' + ex); if (onRunningChange) onRunningChange(); }
        });
    } catch (_e) { /* noop */ }
  }

  function setApps(list) {
    apps = (list || []).map((a) => {
      const obj = { id: String(a.id), name: String(a.name || ''), path: String(a.path || ''),
        exe: null, observedExes: new Set(), running: false, procNames: [] };
      if (/\.exe$/i.test(obj.path)) obj.exe = path.basename(obj.path).toLowerCase();
      else if (/\.lnk$/i.test(obj.path)) resolveLnk(obj.path);
      return obj;
    });
  }

  function observe(procNames) {
    const set = new Set((procNames || []).map((x) => String(x).toLowerCase()));
    let changed = false;
    for (const a of apps) {
      const hits = [];
      if (a.exe && set.has(a.exe)) hits.push(a.exe);
      for (const oe of a.observedExes) if (set.has(oe) && !hits.includes(oe)) hits.push(oe);
      const running = hits.length > 0;
      if (a.running !== running || a.procNames.join(',') !== hits.join(',')) {
        a.running = running; a.procNames = hits; changed = true;
      }
    }
    if (changed && onRunningChange) onRunningChange();
  }

  function bindLaunch(appId, beforeNames) {
    const a = apps.find((x) => x.id === appId);
    if (!a) return;
    const before = new Set((beforeNames || []).map((x) => String(x).toLowerCase()));
    [400, 1200, 2500].forEach((t) => {
      setTimeout(() => {
        execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 },
          (err, out) => {
            if (err) return;
            const cur = new Set();
            const re = /"([^"]+\.exe)"/gi; let m;
            while ((m = re.exec(out))) { if (m[1]) cur.add(m[1].toLowerCase()); }
            // 过滤噪声：不能用「所有新进程」当该应用的进程，否则系统弹个宿主就会被算进去。
            // 另外要排除已被别的课堂应用认领的进程，避免一个进程挂在两个应用名下。
            const claimed = new Set();
            for (const o of apps) if (o !== a) for (const oe of o.observedExes) claimed.add(oe);
            const added = [...cur].filter((x) => !before.has(x) && !NOISE.has(x) && !claimed.has(x));
            if (!added.length) return;
            let changed = false;
            added.forEach((x) => { if (!a.observedExes.has(x)) { a.observedExes.add(x); changed = true; doLog('bindLaunch ' + a.id + ' 新增进程 ' + x); } });
            if (!a.running) { a.running = true; a.procNames = [a.exe && cur.has(a.exe) ? a.exe : added[0]]; changed = true; }
            if (changed && onRunningChange) onRunningChange();
          });
      }, t);
    });
  }

  function state() {
    return apps.map((a) => ({ id: a.id, name: a.name, path: a.path, exe: a.exe,
      running: a.running, procNames: a.procNames.slice() }));
  }

  function exeOf(appId) {
    const a = apps.find((x) => x.id === appId);
    if (!a) return null;
    if (a.exe) return a.exe;
    const arr = [...a.observedExes];
    return arr.length ? arr[0] : null;
  }

  function allowExeList() {
    const set = new Set();
    for (const a of apps) {
      if (a.exe) set.add(a.exe);
      for (const oe of a.observedExes) set.add(oe);
    }
    return [...set];
  }

  return { setApps, observe, bindLaunch, state, exeOf, allowExeList };
};
