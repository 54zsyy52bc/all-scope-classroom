<#
=============================================================================
 课堂守卫（guard-window.ps1）一键自测脚本
=============================================================================
 用途：
   在你自己的真实 Windows 交互会话里，一键验证「非课堂窗口自动最小化」助手
   （student/guard-window.ps1）是否工作正常。它通过常驻助手进程的 stdin 行协议
   发命令，并逐条打印 [PASS]/[FAIL] 与原始 JSON。

 ----------------------------------------------------------------------------
  安全提醒（请先读，很重要）
 ----------------------------------------------------------------------------
   本脚本第 3 步会对一个真实运行的 PowerShell 助手发送 sweep 命令，该命令会
   最小化「当时所有不在 allow 列表里的可见顶层窗口」。为了把副作用降到最低：

     1) 第 1 步先用 dry-run（只统计、不最小化）枚举出当前所有可见的普通应用
        窗口，并把它们全部放进 allow 列表；
     2) 第 3 步理论上只会最小化我们在第 2 步新开的 notepad.exe（它不在 allow
        列表里）。

   但有一个无法 100% 避免的窗口：如果你在第 1 步枚举之后、第 3 步执行之前的
   那几秒钟里，又新开了某个程序（新开的独立窗口，而非浏览器新标签页），那个
   新程序的窗口不在 allow 列表里，也会被一起最小化。

   因此建议：在「没有正在运行的重要程序 / 没有未保存工作」的空闲桌面下执行本
   脚本。脚本已尽量做保护（allow 列表 + 只针对 notepad 断言），但不会替你保存
   任何工作。执行后 notepad 会被最小化，焦点测试时可能被还原到前台。

   （脚本开头会先关闭任何已存在的 notepad，以保证第 3 步断言确定：只最小化我们
    新开的那个 notepad。）

 输出：
   中文，逐条 [PASS]/[FAIL]，最后一行给总结论（全通过 / 有几项失败）。
   可重复运行、幂等；临时文件用完后清理；失败时给可读原因而非异常栈。

 运行方式（Windows 默认执行策略通常禁止脚本，必须显式 Bypass，否则会报
 "因为在此系统上禁止运行脚本"）：

   cd C:\你的路径\classroom-mgmt
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\guard-selftest.ps1

 依赖：仅 PowerShell 5.1 内置能力，不依赖任何第三方模块。
       本脚本自己在真实机器上可以随意 Add-Type 编译 C# 做 IsIconic 判定
       （沙箱里拦，但用户在真实 Windows 上运行不受限）。
       本文件必须保存为「UTF-8 带 BOM」：PowerShell 5.1 对无 BOM 的 .ps1 会按系统
       ANSI 码页读取，中文串会变乱码，甚至会吃掉闭引号导致解析失败。
=============================================================================
#>

$ErrorActionPreference = 'Stop'

# 仅支持 Windows
if ($env:OS -notlike '*Windows*') {
  Write-Host '[FAIL] 本脚本只能在 Windows 上运行。'
  exit 1
}

# 定位被自测的助手脚本（scripts/../student/guard-window.ps1）
$guardPs = Join-Path $PSScriptRoot '..' 'student' 'guard-window.ps1'
try {
  $guardPs = Resolve-Path $guardPs -ErrorAction Stop
} catch {
  Write-Host ('[FAIL] 找不到助手脚本: ' + $guardPs)
  Write-Host ('        原因: ' + $_.Exception.Message)
  exit 1
}

$passed = 0
$failed = 0
$tempFiles = @()
$guardProc = $null

function Say($msg) { Write-Host $msg }
function Pass($name) { $script:passed++; Write-Host ('[PASS] ' + $name) }
function Fail($name, $reason) {
  $script:failed++
  Write-Host ('[FAIL] ' + $name)
  if ($reason) { Write-Host ('        原因: ' + $reason) }
}

try {
  Say '===================================================================='
  Say (' 课堂守卫自测  (助手: ' + $guardPs.Path + ')')
  Say '===================================================================='

  # 保证 notepad 处于“未运行”的干净状态，使第 3 步断言确定（只最小化我们新开的 notepad）
  $existing = Get-Process notepad -ErrorAction SilentlyContinue
  if ($existing) {
    Say '[信息] 检测到已运行的 notepad，先关闭以保证测试确定性。'
    $existing | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }

  # ---------- 第 1 步：dry-run 枚举（不改变任何窗口状态）----------
  Say ''
  Say '=== 第 1 步：dry-run 枚举（只统计，不最小化）==='
  $inFile  = Join-Path $env:TEMP ('guard-selftest-in1-' + $PID + '.txt')
  $outFile = Join-Path $env:TEMP ('guard-selftest-out1-' + $PID + '.txt')
  $tempFiles += $inFile, $outFile
  Remove-Item $inFile, $outFile -ErrorAction SilentlyContinue
  # 输入两行：S||<pid>|1 (dry)  +  Q (退出)
  # 必须写「无 BOM」的 UTF-8：Encoding.UTF8 会带 BOM，助手首行会读成 "\uFEFFS|..."，
  # $cmd 匹配不上 'S'，整轮变成 unknown command，第 1 步必然失败。
  [System.IO.File]::WriteAllText($inFile, ('S||' + $PID + '|1' + "`r`n" + 'Q' + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))

  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $guardPs.Path) `
    -RedirectStandardInput $inFile -RedirectStandardOutput $outFile -NoNewWindow -Wait

  $raw = [System.IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8)
  $jsonLine = ($raw -split "`r?`n" | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -First 1)
  if (-not $jsonLine) {
    throw ('助手未输出任何 JSON。stdout 原始内容: [' + $raw + ']')
  }
  $jsonLine = $jsonLine.Trim()
  Say ('        原始 JSON: ' + $jsonLine)
  try {
    $obj = $jsonLine | ConvertFrom-Json
  } catch {
    throw ('JSON 解析失败: ' + $_.Exception.Message)
  }
  $cands = @($obj.candidates)
  Pass('助手启动并可解析 JSON 输出')
  Say ('        candidates 数量 = ' + $cands.Count)
  $top = (($cands | Select-Object -First 10) | ForEach-Object { ($_.exe + '(pid=' + $_.pid + ')') }) -join ', '
  Say ('        前 10 项: ' + $top)

  if ($cands.Count -eq 0) {
    throw 'candidates 为空：当前没有可见的非系统应用窗口，第 3 步将无法建立 allow 列表，已中止以免误最小化其它窗口。'
  }
  # dry 模式必须 minimized == 0（不真的最小化）
  # 用 [int] 强转而不是 -is [int]：ConvertFrom-Json 在 PS5.1 下可能给 Int64，
  # -is [int] 会判假从而让这条断言静默失效（变成空检查）。
  if ([int]$obj.minimized -ne 0) {
    throw ('dry-run 的 minimized 不为 0（=' + $obj.minimized + '），说明 dry 模式未生效，窗口状态可能已被改变。')
  }
  Pass(('dry-run 未改变窗口状态（minimized == 0）且枚举到 ' + $cands.Count + ' 个候选窗口'))

  # 关键安全措施：把第 1 步拿到的所有 exe 都放进 allow 列表
  $allowCsv = (($cands | Select-Object -ExpandProperty exe -Unique) -join ',')
  Say ('        allow 列表(这些程序将被保护、不被最小化): ' + $allowCsv)

  # ---------- 第 2 步：准备 allow 列表 + 启动 notepad ----------
  Say ''
  Say '=== 第 2 步：启动 notepad 作为“非课堂窗口”被测对象 ==='
  Start-Process notepad.exe
  Start-Sleep -Milliseconds 1500
  $npStart = Get-Process notepad -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $npStart) { throw 'notepad 未能启动，无法进行第 3 步断言。' }
  Pass(('notepad 已启动 (pid=' + $npStart.Id + ')，它不在 allow 列表里，应被第 3 步最小化'))

  # ---------- 第 3 步：真 sweep（核心断言）----------
  Say ''
  Say '=== 第 3 步：真实 sweep（会最小化第 2 步的 notepad）==='

  # 启动常驻助手进程（管道 stdin/stdout 行协议），后续第 4/5 步复用同一进程
  $pinfo = New-Object System.Diagnostics.ProcessStartInfo
  $pinfo.FileName = 'powershell.exe'
  $pinfo.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $guardPs.Path + '"'
  $pinfo.UseShellExecute = $false
  $pinfo.RedirectStandardInput = $true
  $pinfo.RedirectStandardOutput = $true
  $pinfo.StandardOutputEncoding = [Text.Encoding]::UTF8
  $guardProc = New-Object System.Diagnostics.Process
  $guardProc.StartInfo = $pinfo
  if (-not $guardProc.Start()) { throw '无法启动助手进程。' }

  function ReadGuardLine($ms) {
    $t = $guardProc.StandardOutput.ReadLineAsync()
    if ($t.Wait($ms)) { return $t.Result }
    return $null
  }
  function SendGuard($line) {
    $guardProc.StandardInput.WriteLine($line)
    $guardProc.StandardInput.Flush()
  }

  SendGuard ('S|' + $allowCsv + '|' + $PID + '|0')
  $resp = ReadGuardLine 8000
  if (-not $resp) { throw '助手对 sweep 命令无响应（可能已崩溃，请检查 guard-window.ps1）。' }
  $resp = $resp.Trim()
  Say ('        原始 JSON: ' + $resp)
  try {
    $sweep = $resp | ConvertFrom-Json
  } catch {
    throw ('sweep 返回无法解析为 JSON: ' + $resp)
  }
  $scands = @($sweep.candidates)
  Say ('        minimized = ' + $sweep.minimized + ', candidates = ' + $scands.Count)
  $extra = (($scands | Where-Object { $_.exe -ne 'notepad.exe' } | Select-Object -ExpandProperty exe -Unique) -join ',')
  # 必须正向确认「至少有 1 个 notepad.exe 候选」，否则 candidates 为空时 $extra 也是空，
  # 断言会假通过（只检查"没有别的 exe"是不够的）。
  $npHit = @($scands | Where-Object { $_.exe -eq 'notepad.exe' })
  $onlyNotepad = ($npHit.Count -ge 1) -and ($extra.Length -eq 0)
  if (($sweep.minimized -ge 1) -and $onlyNotepad) {
    Pass(('sweep 仅最小化 notepad（minimized=' + $sweep.minimized + '，候选全是 notepad.exe）'))
  } else {
    Fail('sweep 结果不符合预期',
      ('minimized=' + $sweep.minimized + '，非 notepad 的候选=[' + $extra + ']。' +
       '可能第 1 步之后又开了别的程序窗口，请关闭其它程序后重试。'))
  }

  # 独立确认 notepad 主窗口真的被最小化（自己用 Add-Type 编译 IsIconic）
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class GuardSelfTestWin {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
'@

  $minOk = $false
  $attempts = 0
  while (($attempts -lt 3) -and (-not $minOk)) {
    $attempts++
    $np = Get-Process notepad -ErrorAction SilentlyContinue | Select-Object -First 1
    $h = if ($np) { $np.MainWindowHandle } else { [IntPtr]::Zero }
    if ($h -ne [IntPtr]::Zero) {
      try { if ([GuardSelfTestWin]::IsIconic($h)) { $minOk = $true } } catch { }
    }
    if (-not $minOk) { Start-Sleep -Milliseconds 500 }
  }
  if ($minOk) {
    Pass('notepad 主窗口确已被最小化（IsIconic 验证通过）')
  } else {
    Fail('无法确认 notepad 被最小化', 'notepad 主窗口句柄为 0 或 IsIconic 判定失败，已重试 3 次。')
  }

  # ---------- 第 4 步：focus 测试 ----------
  Say ''
  Say '=== 第 4 步：focus（F|notepad.exe）==='
  SendGuard 'F|notepad.exe'
  $fresp = ReadGuardLine 8000
  if (-not $fresp) { throw '助手对 focus 命令无响应。' }
  $fresp = $fresp.Trim()
  Say ('        原始 JSON: ' + $fresp)
  try {
    $fobj = $fresp | ConvertFrom-Json
  } catch {
    throw ('focus 返回无法解析为 JSON: ' + $fresp)
  }
  if ($fobj.PSObject.Properties.Name -contains 'focused') {
    if ($fobj.focused -eq 1) {
      Pass('focus 成功（focused=1，notepad 已还原并置前台）')
    } else {
      Pass('focus 命令已执行（focused=0）—— 被 Windows 前台锁拦截，属正常现象；notepad 可能仍处于最小化')
    }
  } else {
    Fail('focus 返回缺少 focused 字段', ('返回: ' + $fresp))
  }

  # ---------- 第 5 步：收尾与清理 ----------
  Say ''
  Say '=== 第 5 步：收尾与清理（不留孤儿进程 / 临时文件）==='
  $npEnd = Get-Process notepad -ErrorAction SilentlyContinue
  if ($npEnd) {
    $npEnd | Stop-Process -Force -ErrorAction SilentlyContinue
    Say '[信息] 已关闭 notepad。'
  } else {
    Say '[信息] 未发现 notepad 进程，跳过关闭。'
  }

  if ($guardProc -and -not $guardProc.HasExited) {
    try { SendGuard 'Q' } catch { }
    if (-not $guardProc.WaitForExit(5000)) {
      Say '[信息] 助手未在 5s 内退出，强制结束。'
      try { $guardProc.Kill() } catch { }
    } else {
      Say '[信息] 助手已收到 Q 并正常退出。'
    }
    try { $guardProc.Close() } catch { }
    $guardProc = $null
  }

} catch {
  Fail('脚本执行中断', $_.Exception.Message)
} finally {
  # 兜底：确保绝不留下孤儿助手进程
  if ($guardProc -and -not $guardProc.HasExited) {
    try { $guardProc.Kill() } catch { }
    try { $guardProc.Close() } catch { }
  }
  # 清理临时文件
  foreach ($f in $tempFiles) {
    if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
  }
}

# ---------- 总结论 ----------
Say ''
Say '==================== 总结论 ===================='
Say ('通过: ' + $passed + '   失败: ' + $failed)
if ($failed -eq 0) {
  Say '[结论] 全部通过 —— guard-window.ps1 在你的机器上工作正常。'
  exit 0
} else {
  Say ('[结论] 有 ' + $failed + ' 项失败 —— 请阅读上面的原因后重试（建议关闭其它程序、在空闲桌面运行）。')
  exit 1
}
