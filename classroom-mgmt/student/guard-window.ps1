# ===== 课堂守卫 PowerShell 助手（常驻进程 + C# P/Invoke）=====
# 为什么常驻：每轮 sweep 如果都重新编译 C# 会吃掉大量 CPU（实测 ~30%）。
# 这里只在进程启动时用 Add-Type 编译一次 C#，之后每一轮只通过 stdin 收发一行命令。
# 启动参数（由 guard-win.js 负责）：
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <本脚本>
# stdin 行协议：
#   S|<allowCsv>|<selfPid>|0或1   sweep（1=dry，只统计不真最小化）
#   F|<exeName>                   把该 exe 的一个可见顶层窗口 restore + 置前台
#   Q                              退出
# stdout 每行一条 JSON（UTF-8，无中文），异常也输出 {"error":"..."} 绝不静默。
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Diagnostics;

public class WinGuard {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] private static extern int GetWindowLongW(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);

  private const int GWL_EXSTYLE = -20;
  private const int WS_EX_TOOLWINDOW = 0x80;
  private const uint GW_OWNER = 4;
  private const int SW_MINIMIZE = 6;
  private const int SW_RESTORE = 9;

  // 系统进程白名单（小写，写死）：这些窗口永远不碰，避免把桌面/输入法/外壳最小化。
  private static HashSet<string> SYS_WHITE = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
    "explorer.exe","dwm.exe","csrss.exe","winlogon.exe","services.exe","wininit.exe","lsass.exe","smss.exe",
    "svchost.exe","taskhostw.exe","sihost.exe","ctfmon.exe","runtimebroker.exe","startmenuexperiencehost.exe",
    "searchhost.exe","shellexperiencehost.exe","textinputhost.exe","applicationframehost.exe","systemsettings.exe",
    "lockapp.exe","conhost.exe","powershell.exe","pwsh.exe","cmd.exe","dllhost.exe","audiodg.exe",
    "securityhealthsystray.exe","securityhealthservice.exe","smartscreen.exe","unsecapp.exe","wmiprvse.exe",
    "backgroundtaskhost.exe"
  };

  private static string ExeOf(uint pid) {
    try { return Process.GetProcessById((int)pid).ProcessName.ToLower() + ".exe"; }
    catch { return ""; }
  }

  public static string Sweep(string allowCsv, int selfPid, bool dry) {
    HashSet<string> allow = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    if (!string.IsNullOrEmpty(allowCsv)) {
      foreach (var s in allowCsv.Split(',')) {
        var t = s.Trim().ToLower();
        if (t.Length > 0) allow.Add(t);
      }
    }
    List<string> cExe = new List<string>();
    List<int> cPid = new List<int>();
    HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    int minimized = 0;
    IntPtr shell = GetShellWindow();
    EnumWindows((hWnd, lParam) => {
      try {
        if (!IsWindowVisible(hWnd)) return true;            // 1 可见
        if (hWnd == shell) return true;                     // 2 不是外壳窗口
        if (GetWindow(hWnd, GW_OWNER) != IntPtr.Zero) return true; // 3 无属主（顶层）
        StringBuilder tb = new StringBuilder(1024);
        GetWindowTextW(hWnd, tb, tb.Capacity);
        if (tb.ToString().Length == 0) return true;         // 4 标题非空
        StringBuilder cb = new StringBuilder(256);
        GetClassNameW(hWnd, cb, cb.Capacity);
        string cls = cb.ToString();
        if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") return true; // 5 系统类
        if ((GetWindowLongW(hWnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true; // 6 非工具窗口
        uint pid = 0;
        GetWindowThreadProcessId(hWnd, out pid);
        if (pid == 0) return true;
        if ((int)pid == selfPid) return true;               // 7 不是自己
        string exe = ExeOf(pid);
        if (exe.Length == 0) return true;                   // 8 取不到进程名就跳过
        if (allow.Contains(exe) || SYS_WHITE.Contains(exe)) return true; // 8 命中白名单/系统
        if (!seen.Contains(exe)) { seen.Add(exe); cExe.Add(exe); cPid.Add((int)pid); } // candidates 去重
        if (!dry) { ShowWindowAsync(hWnd, SW_MINIMIZE); minimized++; } // 9 最小化
      } catch { /* 单个窗口异常不阻断整轮 */ }
      return true;
    }, IntPtr.Zero);
    StringBuilder outp = new StringBuilder();
    outp.Append("{\"minimized\":");
    outp.Append(dry ? 0 : minimized);
    outp.Append(",\"candidates\":[");
    for (int i = 0; i < cExe.Count; i++) {
      if (i > 0) outp.Append(',');
      outp.Append("{\"exe\":\"").Append(cExe[i]).Append("\",\"pid\":").Append(cPid[i]).Append("}");
    }
    outp.Append("],\"mismatch\":0}");
    return outp.ToString();
  }

  public static string Focus(string exe) {
    string target = (exe == null ? "" : exe.Trim().ToLower());
    if (target.Length == 0) return "{\"focused\":0}";
    int focused = 0;
    EnumWindows((hWnd, lParam) => {
      try {
        if (!IsWindowVisible(hWnd)) return true;
        uint pid = 0;
        GetWindowThreadProcessId(hWnd, out pid);
        if (pid == 0) return true;
        if (ExeOf(pid) != target) return true;
        if (IsIconic(hWnd)) ShowWindowAsync(hWnd, SW_RESTORE);
        SetForegroundWindow(hWnd); // 常被前台锁拦截，返回 0 即可，JS 侧容错
        focused = 1;
      } catch { /* noop */ }
      return true;
    }, IntPtr.Zero);
    return "{\"focused\":" + focused + "}";
  }
}
'@ -Language CSharp

function Emit([string]$line) {
  try { [Console]::Out.WriteLine($line); [Console]::Out.Flush(); } catch { }
}

while ($true) {
  $raw = [Console]::In.ReadLine()
  if ($raw -eq $null) { break }       # EOF（管道关闭）→ 退出
  # 剥掉可能的 UTF-8 BOM：调用方若用 WriteAllText + Encoding.UTF8 写 stdin 文件会带 BOM，
  # 首行就变成 "\uFEFFS|..."，$cmd 匹配不上 'S'，整轮静默退化成 unknown command。
  $line = $raw.Trim().TrimStart([char]0xFEFF).Trim()
  if ($line.Length -eq 0) { continue }
  $parts = $line -split '\|'
  $cmd = $parts[0]
  try {
    if ($cmd -eq 'S') {
      $allow = if ($parts.Length -gt 1) { $parts[1] } else { '' }
      # 注意：绝不能用 $pid —— PowerShell 的 $PID 是只读自动变量，赋值会抛
      # "无法覆盖变量 PID"，被外层 catch 吞成 {"error":...}，功能静默失效。
      $selfPid = 0
      if ($parts.Length -gt 2) { [int]::TryParse($parts[2], [ref]$selfPid) | Out-Null }
      $dry = ($parts.Length -gt 3 -and $parts[3] -eq '1')
      Emit([WinGuard]::Sweep($allow, $selfPid, $dry))
    } elseif ($cmd -eq 'F') {
      $exe = if ($parts.Length -gt 1) { $parts[1] } else { '' }
      Emit([WinGuard]::Focus($exe))
    } elseif ($cmd -eq 'Q') {
      break
    } else {
      Emit('{"error":"unknown command"}')
    }
  } catch {
    Emit('{"error":"' + $_.Exception.Message.Replace('"', '\\"') + '"}')
  }
}
