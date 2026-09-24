# teacher-float.ps1 — 全域课堂 · 教师机始终置顶浮窗
# 依赖：Windows PowerShell 5.1 + WPF（系统自带，零第三方依赖）
# 数据源：轮询本机教师服务 http://127.0.0.1:3000/api/v1（本机请求免令牌）
# 功能：状态总览（登记/在线/任务/归还/当前活动）+ 快捷操作
#       （发通知 / 结束活动 / 锁定切换 / 发活动[预设+快捷计时] / 一键回大屏）
# 形态：完整面板 <-> 贴屏幕右缘的细竖条（关键数字 + 点击展开），竖条可上下拖动。
#       每个破坏性操作均需"再点一次确认"（3 秒内），防止误触。
param(
  [string]$BaseUrl = 'http://127.0.0.1:3000/api/v1',
  [int]$PollMs = 3000
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore

# ---- 单实例：重复启动直接退出 ----
$script:mutexCreated = $false
$script:mutex = New-Object System.Threading.Mutex($true, 'Global\AllScopeTeacherFloat', [ref]$script:mutexCreated)
if (-not $script:mutexCreated) { exit 0 }

$script:siteRoot = $BaseUrl -replace '/api/v1/?$', ''

[xml]$script:xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="教师浮窗" Width="316" SizeToContent="Height" Topmost="True"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False">
  <Grid>
    <!-- 完整面板形态 -->
    <Border x:Name="Panel" Background="#F01B2A41" CornerRadius="10" Padding="14,12"
            BorderBrush="#FF3E566E" BorderThickness="1">
      <StackPanel>
        <Grid Margin="0,0,0,8">
          <StackPanel Orientation="Horizontal">
            <Ellipse x:Name="Dot" Width="10" Height="10" Fill="#FF6B7B8C" VerticalAlignment="Center" Margin="0,0,8,0"/>
            <TextBlock Text="全域课堂 · 教师浮窗" Foreground="#FFEAF2FB" FontSize="14" FontWeight="Bold" VerticalAlignment="Center"/>
          </StackPanel>
          <StackPanel Orientation="Horizontal" HorizontalAlignment="Right">
            <Button x:Name="BtnScreen" Content="大屏" Width="38" Height="24" Margin="0,0,4,0"
                    Background="#FF2E6FAF" Foreground="White" BorderThickness="0" FontSize="11" Cursor="Hand"/>
            <Button x:Name="BtnCollapse" Content="—" Width="24" Height="24" Margin="0,0,4,0"
                    Background="Transparent" Foreground="#FF9FB4C9" BorderThickness="0" FontSize="12" Cursor="Hand"/>
            <Button x:Name="BtnClose" Content="X" Width="24" Height="24"
                    Background="Transparent" Foreground="#FF9FB4C9" BorderThickness="0" FontSize="12" Cursor="Hand"/>
          </StackPanel>
        </Grid>
        <TextBlock x:Name="Phase" Text="连接中..." Foreground="#FF8FD3A8" FontSize="12" Margin="0,0,0,8"/>
        <Border Background="#FF22334C" CornerRadius="6" Padding="10,8" Margin="0,0,0,8">
          <StackPanel>
            <TextBlock x:Name="StatCheckin" Foreground="#FFD6E4F2" FontSize="12" Margin="0,1"/>
            <TextBlock x:Name="StatOnline" Foreground="#FFD6E4F2" FontSize="12" Margin="0,1"/>
            <TextBlock x:Name="StatTask" Foreground="#FFD6E4F2" FontSize="12" Margin="0,1"/>
            <TextBlock x:Name="StatReturn" Foreground="#FFD6E4F2" FontSize="12" Margin="0,1"/>
            <TextBlock x:Name="StatTaskCur" Foreground="#FF8FD3A8" FontSize="12" Margin="0,4,0,0" TextWrapping="Wrap"/>
          </StackPanel>
        </Border>
        <!-- 发活动：展开预设清单，每个预设旁快捷计时 -->
        <Button x:Name="BtnAct" Content="发活动" Height="28" Margin="0,0,0,6"
                Background="#FF107C10" Foreground="White" BorderThickness="0" FontSize="12" Cursor="Hand"/>
        <Border x:Name="ActList" Background="#FF22334C" CornerRadius="6" Padding="8,6" Margin="0,0,0,6"
                MaxHeight="170" Visibility="Collapsed">
          <ScrollViewer VerticalScrollBarVisibility="Auto"/>
        </Border>
        <TextBox x:Name="NoticeBox" Background="#FF22334C" Foreground="#FFEAF2FB" BorderBrush="#FF3E566E"
                 FontSize="12" Height="44" TextWrapping="Wrap" AcceptsReturn="False"
                 VerticalContentAlignment="Top" VerticalScrollBarVisibility="Auto" Margin="0,0,0,6"/>
        <Grid Margin="0,0,0,6">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="64"/>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <TextBox x:Name="SeatBox" Grid.Column="0" Background="#FF22334C" Foreground="#FFEAF2FB"
                   BorderBrush="#FF3E566E" FontSize="12" Height="26"/>
          <TextBlock Grid.Column="1" Text="座位留空=全体" Foreground="#FF7C93AB" FontSize="11" Margin="6,6,0,0"/>
          <Button x:Name="BtnNotice" Grid.Column="2" Content="发送通知" Width="96" Height="26"
                  Background="#FF2E6FAF" Foreground="White" BorderThickness="0" FontSize="12" Cursor="Hand"/>
        </Grid>
        <Button x:Name="BtnEnd" Content="结束当前活动" Height="30" Margin="0,0,0,6"
                Background="#FF8A4B3A" Foreground="White" BorderThickness="0" FontSize="12" Cursor="Hand"/>
        <Button x:Name="BtnPolicy" Content="锁定策略" Height="30" Margin="0,0,0,6"
                Background="#FF4B6A8A" Foreground="White" BorderThickness="0" FontSize="12" Cursor="Hand"/>
        <TextBlock x:Name="Msg" Foreground="#FFC9D6E4" FontSize="11" TextWrapping="Wrap" MinHeight="16"/>
        <TextBlock x:Name="Foot" Foreground="#FF5F7386" FontSize="10" Margin="0,6,0,0" Text="-"/>
      </StackPanel>
    </Border>
    <!-- 贴边竖条形态（最小化）：关键数字，点击展开 -->
    <Border x:Name="Strip" Background="#F01B2A41" CornerRadius="8" Padding="6,12"
            BorderBrush="#FF3E566E" BorderThickness="1" Visibility="Collapsed">
      <StackPanel HorizontalAlignment="Center">
        <Ellipse x:Name="SDot" Width="10" Height="10" Fill="#FF6B7B8C" HorizontalAlignment="Center" Margin="0,0,0,10"/>
        <TextBlock x:Name="SReg" Text="-" Foreground="#FFD6E4F2" FontSize="12" TextAlignment="Center" Margin="0,2"/>
        <TextBlock x:Name="SHelp" Text="-" Foreground="#FF7C93AB" FontSize="12" TextAlignment="Center" Margin="0,2"/>
        <TextBlock x:Name="SAct" Text="-" Foreground="#FF7C93AB" FontSize="12" TextAlignment="Center" Margin="0,2"/>
        <Button x:Name="BtnExpand" Content="展开" Margin="0,12,0,0" Padding="6,3"
                Background="#FF2E6FAF" Foreground="White" BorderThickness="0" FontSize="11" Cursor="Hand"/>
      </StackPanel>
    </Border>
  </Grid>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $script:xaml
$script:win = [System.Windows.Markup.XamlReader]::Load($reader)

$script:C = @{}
foreach ($n in 'Panel','Strip','Dot','Phase','StatCheckin','StatOnline','StatTask','StatReturn','StatTaskCur',
               'BtnScreen','BtnCollapse','BtnClose','BtnAct','ActList',
               'NoticeBox','SeatBox','BtnNotice','BtnEnd','BtnPolicy','Msg','Foot',
               'SDot','SReg','SHelp','SAct','BtnExpand') {
  $script:C[$n] = $script:win.FindName($n)
}

$bc = New-Object System.Windows.Media.BrushConverter
$script:brushOk  = $bc.ConvertFromString('#FF8FD3A8')
$script:brushBad = $bc.ConvertFromString('#FFD08A72')
$script:brushDim = $bc.ConvertFromString('#FF6B7B8C')
$script:brushHelp = $bc.ConvertFromString('#FFD08A72')

# 运行期缓存（每轮轮询刷新；快捷操作直接用缓存值）
$script:sessionId = ''
$script:currentTaskId = ''
$script:currentTaskTitle = ''
$script:lastPolicy = ''
$script:pending = $null
$script:pendingText = ''
$script:presets = $null
$script:chip = $null

function Set-Foot([string]$t) {
  $script:C['Foot'].Text = $t
}

function Set-Msg([string]$t) {
  $script:C['Msg'].Text = $t
  Set-Foot ("最近操作 " + (Get-Date -Format 'HH:mm:ss'))
}

function Invoke-Api {
  param([string]$Method, [string]$Path, $Body)
  $p = @{ Uri = "$BaseUrl$Path"; Method = $Method; TimeoutSec = 4; ErrorAction = 'Stop' }
  if ($null -ne $Body) {
    $p['ContentType'] = 'application/json; charset=utf-8'
    $p['Body'] = [System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress))
  }
  return Invoke-RestMethod @p
}

# ---- 二次确认：第一次点击变为"再点一次确认"，3 秒内再点才执行 ----
$script:confirmTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:confirmTimer.Interval = [TimeSpan]::FromSeconds(3)
$script:confirmTimer.Add_Tick({
  $script:confirmTimer.Stop()
  if ($script:pending) {
    $script:pending.Content = $script:pendingText
    $script:pending = $null
    $script:pendingText = ''
  }
})

function Request-Confirm {
  param($Button, [scriptblock]$Action)
  if ($script:pending -ne $Button) {
    if ($script:pending) { $script:pending.Content = $script:pendingText }
    $script:pending = $Button
    $script:pendingText = [string]$Button.Content
    $Button.Content = '再点一次确认'
    $script:confirmTimer.Stop()
    $script:confirmTimer.Start()
    return
  }
  $script:confirmTimer.Stop()
  $Button.Content = $script:pendingText
  $script:pending = $null
  $script:pendingText = ''
  & $Action
}

# ---- 状态刷新（DispatcherTimer 主线程轮询；面板与竖条同步更新） ----
function Update-Panel {
  try {
    $snap = (Invoke-Api -Method Get -Path '/dashboard/snapshot').data
    $sess = $snap.session
    if (-not $sess) {
      $script:C['Dot'].Fill = $script:brushDim
      $script:C['Phase'].Text = '待课中（无进行中的课堂会话）'
      $script:C['StatCheckin'].Text = ''
      $script:C['StatOnline'].Text = ''
      $script:C['StatTask'].Text = ''
      $script:C['StatReturn'].Text = ''
      $script:C['StatTaskCur'].Text = ''
      $script:C['BtnEnd'].IsEnabled = $false
      $script:C['BtnPolicy'].IsEnabled = $false
      $script:C['BtnNotice'].IsEnabled = $false
      $script:C['BtnAct'].IsEnabled = $false
      $script:sessionId = ''
      $script:currentTaskId = ''
      $script:lastPolicy = ''
      $script:C['SDot'].Fill = $script:brushDim
      $script:C['SReg'].Text = '登 -'
      $script:C['SHelp'].Text = '助 -'
      $script:C['SHelp'].Foreground = $script:brushDim
      $script:C['SAct'].Text = '无活动'
      $script:C['SAct'].Foreground = $script:brushDim
      Set-Foot '等待教师服务...'
      return
    }

    $st = $snap.stats
    $names = @{ idle = '待课'; checkin = '登记中'; task = '课中'; return = '归还中'; closed = '已结束' }
    $pn = $names[[string]$sess.phase]
    if (-not $pn) { $pn = [string]$sess.phase }
    $script:C['Dot'].Fill = $script:brushOk
    $script:C['Phase'].Text = "课堂进行中 · $pn"
    $script:C['StatCheckin'].Text = "登记  已到 $($st.checkedIn)/$($sess.totalSeats)   待登记 $($st.pending)"
    $script:C['StatOnline'].Text = "机器  在线 $($st.online)   离线 $($st.offline)"
    $script:C['StatTask'].Text = "任务  进行 $($st.taskDoing)   完成 $($st.taskDone)   求助 $($st.taskHelp)"
    $script:C['StatReturn'].Text = "归还  已确认 $($st.returned)"

    $ct = $snap.currentTask
    if ($ct) {
      $rem = ''
      if ($ct.timed -and $null -ne $ct.remainingMs) {
        $s = [int][Math]::Max(0, [Math]::Round($ct.remainingMs / 1000.0))
        $rem = ("  ·  剩余 {0:D2}:{1:D2}" -f [int][Math]::Floor($s / 60), ($s % 60))
      }
      $script:C['StatTaskCur'].Text = "当前活动：$($ct.title)$rem"
      $script:C['BtnEnd'].IsEnabled = $true
      $script:currentTaskId = [string]$ct.taskId
      $script:currentTaskTitle = [string]$ct.title
    } else {
      $script:C['StatTaskCur'].Text = '当前活动：无'
      $script:C['BtnEnd'].IsEnabled = $false
      $script:currentTaskId = ''
      $script:currentTaskTitle = ''
    }
    $script:C['BtnNotice'].IsEnabled = $true
    $script:C['BtnAct'].IsEnabled = $true
    $script:sessionId = [string]$sess.sessionId

    # 竖条同步：登记数 / 求助数（>0 变红）/ 活动状态
    $script:C['SDot'].Fill = $script:brushOk
    $script:C['SReg'].Text = "登 $($st.checkedIn)/$($sess.totalSeats)"
    $script:C['SHelp'].Text = "助 $($st.taskHelp)"
    if ($st.taskHelp -gt 0) { $script:C['SHelp'].Foreground = $script:brushHelp }
    else { $script:C['SHelp'].Foreground = $script:brushDim }
    if ($ct) { $script:C['SAct'].Text = '活动'; $script:C['SAct'].Foreground = $script:brushOk }
    else { $script:C['SAct'].Text = '无活动'; $script:C['SAct'].Foreground = $script:brushDim }

    try {
      $pol = (Invoke-Api -Method Get -Path "/sessions/$($script:sessionId)/policy").data
      $m = [string]$pol.mode
      if ($m -ne $script:lastPolicy) {
        $script:lastPolicy = $m
        if ($m -eq 'activity') { $script:C['BtnPolicy'].Content = '锁定=仅活动时开放（点击切换）' }
        else { $script:C['BtnPolicy'].Content = '锁定=开放（点击切换）' }
      }
      $script:C['BtnPolicy'].IsEnabled = $true
    } catch { }
    Set-Foot ("刷新 " + (Get-Date -Format 'HH:mm:ss'))
  } catch {
    $script:C['Dot'].Fill = $script:brushBad
    $script:C['Phase'].Text = '教师服务未连接（127.0.0.1:3000）'
    $script:C['BtnEnd'].IsEnabled = $false
    $script:C['BtnPolicy'].IsEnabled = $false
    $script:C['BtnNotice'].IsEnabled = $false
    $script:C['BtnAct'].IsEnabled = $false
    $script:sessionId = ''
    $script:currentTaskId = ''
    $script:C['SDot'].Fill = $script:brushBad
    Set-Foot '等待服务恢复...'
  }
}

# ---- 发活动：预设清单 + 快捷计时（不限时/15/30/45/60 分钟，发布需二次确认） ----
function Get-DescendantButtons($dep) {
  $out = @()
  if ($dep -is [System.Windows.Controls.Button]) { $out += $dep }
  $n = [System.Windows.Media.VisualTreeHelper]::GetChildrenCount($dep)
  for ($i = 0; $i -lt $n; $i++) {
    $c = [System.Windows.Media.VisualTreeHelper]::GetChild($dep, $i)
    $out += Get-DescendantButtons $c
  }
  return $out
}

function Build-ActList($ps) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('<StackPanel xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">')
  foreach ($p in $ps) {
    $nm = [System.Security.SecurityElement]::Escape([string]$p.name)
    [void]$sb.Append('<Border BorderBrush="#FF3E566E" BorderThickness="0,0,0,1" Padding="2,5"><StackPanel>')
    [void]$sb.Append('<TextBlock Text="' + $nm + '" Foreground="#FFEAF2FB" FontSize="12" TextWrapping="Wrap"/>')
    [void]$sb.Append('<WrapPanel Margin="0,4,0,0">')
    foreach ($c in @(@('不限时', '0'), @('15分', '900'), @('30分', '1800'), @('45分', '2700'), @('60分', '3600'))) {
      [void]$sb.Append('<Button Margin="0,0,4,0" Padding="7,2" FontSize="11" Cursor="Hand" Background="#FF2E6FAF" Foreground="White" BorderThickness="0" Tag="' + [string]$p.presetId + '|' + $c[1] + '" Content="' + $c[0] + '"/>')
    }
    [void]$sb.Append('</WrapPanel></StackPanel></Border>')
  }
  [void]$sb.Append('</StackPanel>')
  $list = [System.Windows.Markup.XamlReader]::Parse($sb.ToString())
  foreach ($b in Get-DescendantButtons $list) {
    $b.Add_Click({ Publish-ChipAction $this })
  }
  $script:C['ActList'].Child = $list
}

function Publish-ChipAction {
  param([System.Windows.Controls.Button]$Chip)
  $script:chip = $Chip
  Request-Confirm $Chip {
    $c = $script:chip
    if (-not $script:sessionId) { Set-Msg '没有进行中的课堂'; return }
    $tag = [string]$c.Tag
    $ix = $tag.LastIndexOf('|')
    if ($ix -lt 0) { Set-Msg '预设数据异常，请重新展开清单'; return }
    $pid2 = $tag.Substring(0, $ix)
    $sec = 0
    try { $sec = [int]$tag.Substring($ix + 1) } catch { $sec = 0 }
    $preset = $null
    if ($script:presets) { $preset = $script:presets | Where-Object { $_.presetId -eq $pid2 } | Select-Object -First 1 }
    $body = @{ source = 'preset'; activityPresetId = $pid2 }
    if ($sec -gt 0) { $body['timed'] = $true; $body['durationSec'] = $sec } else { $body['timed'] = $false }
    try {
      Invoke-Api -Method Post -Path "/sessions/$($script:sessionId)/activities" -Body $body | Out-Null
      $nm = if ($preset) { [string]$preset.name } else { $pid2 }
      $du = if ($sec -gt 0) { ([int][Math]::Round($sec / 60.0)).ToString() + '分钟' } else { '不限时' }
      Set-Msg "已发布活动：$nm · $du"
      $script:C['ActList'].Visibility = 'Collapsed'
      $script:C['BtnAct'].Content = '发活动'
      try { Update-Panel } catch { }
    } catch {
      Set-Msg ('发布失败：' + $_.Exception.Message)
    }
  }
}

$script:C['BtnAct'].Add_Click({
  if ($script:C['ActList'].Visibility -eq 'Visible') {
    $script:C['ActList'].Visibility = 'Collapsed'
    $script:C['BtnAct'].Content = '发活动'
    return
  }
  if (-not $script:sessionId) { Set-Msg '没有进行中的课堂，无法发活动'; return }
  try {
    $ps = @((Invoke-Api -Method Get -Path '/presets/activities').data)
  } catch {
    Set-Msg ('预设获取失败：' + $_.Exception.Message)
    return
  }
  if (-not $ps -or $ps.Count -eq 0) { Set-Msg '暂无活动预设（请到大屏预设管理创建）'; return }
  $script:presets = $ps
  try { Build-ActList $ps } catch { Set-Msg ('清单渲染失败：' + $_.Exception.Message); return }
  $script:C['ActList'].Visibility = 'Visible'
  $script:C['BtnAct'].Content = '收起清单'
})

# ---- 一键回大屏：打开默认浏览器 ----
$script:C['BtnScreen'].Add_Click({
  try { Start-Process $script:siteRoot; Set-Msg "已在浏览器打开大屏：$script:siteRoot" }
  catch { Set-Msg ('打开大屏失败：' + $_.Exception.Message) }
})

# ---- 形态切换：完整面板 <-> 贴右缘细竖条 ----
function Set-Collapsed([bool]$on) {
  $wa = [System.Windows.SystemParameters]::WorkArea
  if ($on) {
    $script:win.SizeToContent = 'Manual'
    $script:win.Width = 56
    $script:win.Height = 260
    $script:C['Panel'].Visibility = 'Collapsed'
    $script:C['Strip'].Visibility = 'Visible'
    $script:win.Left = $wa.Right - $script:win.Width
    $script:win.Top = [Math]::Max(0, ($wa.Bottom - $script:win.Height) / 2)
  } else {
    $script:win.SizeToContent = 'Height'
    $script:win.Width = 316
    $script:C['Strip'].Visibility = 'Collapsed'
    $script:C['Panel'].Visibility = 'Visible'
    $script:win.Left = $wa.Right - $script:win.ActualWidth - 12
    $script:win.Top = $wa.Bottom - $script:win.ActualHeight - 12
  }
}

$script:C['BtnCollapse'].Add_Click({ Set-Collapsed $true })
$script:C['BtnExpand'].Add_Click({ Set-Collapsed $false })
# 竖条拖动（任意方向），松手后 X 吸附回屏幕右缘（保持贴边竖条形态）
$script:C['Strip'].Add_MouseLeftButtonDown({ try { $script:win.DragMove() } catch { } })
$script:C['Strip'].Add_MouseLeftButtonUp({
  try {
    $wa = [System.Windows.SystemParameters]::WorkArea
    $script:win.Left = $wa.Right - $script:win.Width
  } catch { }
})

# ---- 快捷操作（通知 / 结束 / 锁定） ----
$script:C['BtnNotice'].Add_Click({
  Request-Confirm $script:C['BtnNotice'] {
    $msg = ''
    if ($script:C['NoticeBox'].Text) { $msg = $script:C['NoticeBox'].Text.Trim() }
    if (-not $msg) { Set-Msg '通知内容为空，未发送'; return }
    $seat = ''
    if ($script:C['SeatBox'].Text) { $seat = $script:C['SeatBox'].Text.Trim() }
    if ($seat -and $seat -notmatch '^\d{1,2}$') { Set-Msg '座位号无效（应为 1-99 的数字，留空=全体）'; return }
    $body = @{ message = $msg }
    if ($seat) { $body['seat'] = $seat }
    try {
      Invoke-Api -Method Post -Path '/commands/notice' -Body $body | Out-Null
      $to = if ($seat) { "座位 $seat" } else { '全体' }
      Set-Msg "通知已下发（$to）：$msg"
      $script:C['NoticeBox'].Text = ''
    } catch {
      Set-Msg ('发送失败：' + $_.Exception.Message)
    }
  }
})

$script:C['BtnEnd'].Add_Click({
  Request-Confirm $script:C['BtnEnd'] {
    if (-not $script:sessionId -or -not $script:currentTaskId) { Set-Msg '当前没有进行中的活动'; return }
    try {
      Invoke-Api -Method Post -Path "/sessions/$($script:sessionId)/activities/$($script:currentTaskId)/end" -Body @{} | Out-Null
      Set-Msg "已结束活动：$($script:currentTaskTitle)"
    } catch {
      Set-Msg ('结束失败：' + $_.Exception.Message)
    }
  }
})

$script:C['BtnPolicy'].Add_Click({
  Request-Confirm $script:C['BtnPolicy'] {
    if (-not $script:sessionId) { Set-Msg '没有进行中的课堂'; return }
    $next = 'activity'
    if ($script:lastPolicy -eq 'activity') { $next = 'open' }
    try {
      Invoke-Api -Method Post -Path "/sessions/$($script:sessionId)/policy" -Body @{ mode = $next } | Out-Null
      if ($next -eq 'activity') { Set-Msg '锁定策略已切换：仅活动时开放' }
      else { Set-Msg '锁定策略已切换：开放' }
    } catch {
      Set-Msg ('切换失败：' + $_.Exception.Message)
    }
  }
})

$script:C['BtnClose'].Add_Click({ $script:win.Close() })
$script:C['Panel'].Add_MouseLeftButtonDown({ try { $script:win.DragMove() } catch { } })

# ---- 启动轮询并显示 ----
$script:pollTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:pollTimer.Interval = [TimeSpan]::FromMilliseconds($PollMs)
$script:pollTimer.Add_Tick({ Update-Panel })
try { Update-Panel } catch { }
$script:pollTimer.Start()
[void]$script:win.ShowDialog()
