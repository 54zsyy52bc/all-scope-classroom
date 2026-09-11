'use strict';
// =============================================================================
// PowerShell 常驻助手管理器（主进程）
//
// 为什么需要它：把「最小化非课堂窗口」这件重活交给一个常驻 PowerShell 进程
// （C# 只编译一次，见 guard-window.ps1）。每轮 sweep 只通过 stdin 发一行命令、
// 读回一行 JSON，避免每次都重编译烧 CPU。
//
// 设计要点：
//   - spawn 后用累积 stdout 缓冲按 \n 切行，只处理以 { 开头的行 → JSON.parse → onReport
//   - 进程意外退出时 5 秒后自动重启；重启失败静默，绝不能阻断主流程
//   - stop() 写 Q 并 kill()，必须在 app before-quit 时调用，否则 Electron 退出会挂住
//   - 所有 stdin 写操作包 try/catch（管道可能已断）
// =============================================================================
const { spawn } = require('node:child_process');

module.exports = function createWinGuard({ scriptPath, onReport, log }) {
  let proc = null;
  let alive = false;
  let stopping = false;
  let buf = '';
  let restartTimer = null;

  function doLog(msg) { try { if (log) log(msg); } catch (_e) { /* noop */ } }

  function spawnProc() {
    try {
      proc = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      doLog('winGuard spawn 失败: ' + e.message);
      scheduleRestart();
      return;
    }
    alive = true;
    buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const t = line.trim();
        if (!t.startsWith('{')) continue; // 只认 JSON 行
        try { const obj = JSON.parse(t); if (onReport) onReport(obj); }
        catch (_e) { doLog('winGuard 解析失败: ' + t.slice(0, 120)); }
      }
    });
    proc.stderr.on('data', (d) => { doLog('winGuard stderr: ' + String(d).slice(0, 200)); });
    // 必须挂 stdin 的 error 监听：子进程死掉后管道断裂，写操作是「异步 emit error」
    // 而不是同步 throw，没有监听器会变成 uncaughtException 直接把学生端主进程干掉。
    proc.stdin.on('error', (e) => { doLog('winGuard stdin 异常: ' + e.message); });
    proc.on('error', (e) => { alive = false; doLog('winGuard error: ' + e.message); scheduleRestart(); });
    proc.on('exit', (code) => { alive = false; doLog('winGuard exit: ' + code); scheduleRestart(); });
  }

  function scheduleRestart() {
    if (stopping || restartTimer) return; // 防止连发
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!stopping && !alive) spawnProc();
    }, 5000);
  }

  function writeStdin(s) {
    if (!proc || !alive) return false;
    try { proc.stdin.write(s); return true; } catch (e) { doLog('winGuard 写入失败: ' + e.message); return false; }
  }

  function start() {
    if (alive && proc) return; // 幂等
    stopping = false;
    spawnProc();
  }

  function stop() {
    stopping = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    writeStdin('Q\n');
    try { if (proc) proc.kill(); } catch (_e) { /* noop */ }
    alive = false;
  }

  function isAlive() { return alive; }

  function sweep(allowExes, dry) {
    const csv = (allowExes || []).join(',');
    // selfPid 用主进程 pid，脚本据此跳过我们自己的窗口，否则 kiosk 会被自己最小化
    return writeStdin('S|' + csv + '|' + process.pid + '|' + (dry ? '1' : '0') + '\n');
  }

  function focus(exeName) {
    return writeStdin('F|' + String(exeName || '') + '\n');
  }

  return { start, stop, isAlive, sweep, focus };
};
