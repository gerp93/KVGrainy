# What the machine looks like when the app's window could not be reached. The end-to-end test runs this at the
# moment it gives up, and puts the output in its error message, so a failed CI run says why.
param([string]$UserDataDir, [string]$ScreenshotPath)
$ErrorActionPreference = 'Continue'

function Section([string]$Name, [scriptblock]$Body) {
  "--- $Name"
  try { (& $Body | Out-String -Width 200).TrimEnd() } catch { "(this check failed: $_)" }
}

Section 'who and where' {
  "OS: $([Environment]::OSVersion.VersionString); user: $env:USERNAME; interactive: $([Environment]::UserInteractive); session id: $((Get-Process -Id $PID).SessionId)"
}
Section 'WebView2 runtime (registry)' {
  foreach ($root in 'HKLM:\SOFTWARE\WOW6432Node', 'HKLM:\SOFTWARE', 'HKCU:\SOFTWARE') {
    $pv = (Get-ItemProperty -Path "$root\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue).pv
    "$root => $(if ($pv) { $pv } else { '(not installed)' })"
  }
}
Section 'WebView2 runtime (files)' {
  $dir = "${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application"
  if (Test-Path $dir) { Get-ChildItem $dir | Select-Object -ExpandProperty Name } else { "(no $dir)" }
}
Section 'processes (the app, WebView2, Edge)' {
  Get-Process | Where-Object { $_.ProcessName -match 'kvgrainy|msedgewebview2|msedge' } |
    Select-Object Id, ProcessName, SessionId, Responding, MainWindowTitle | Format-Table -AutoSize
}
Section 'the browser profile folder and its DevToolsActivePort file (the port the browser chose)' {
  $port = Join-Path $UserDataDir 'EBWebView\DevToolsActivePort'
  if (Test-Path $port) { "DevToolsActivePort:"; Get-Content $port } else { "(no $port)" }
  if (Test-Path $UserDataDir) {
    Get-ChildItem $UserDataDir -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 40 -ExpandProperty FullName
  } else { "(no folder $UserDataDir)" }
}
Section 'TCP port ranges Windows reserves (a browser cannot listen on these)' {
  netsh int ipv4 show excludedportrange protocol=tcp
}
Section 'WebView2 browser process command line (is the debugging flag there?)' {
  Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
    ForEach-Object { "pid $($_.ProcessId): $($_.CommandLine.Substring(0, [Math]::Min(900, $_.CommandLine.Length)))" }
}
Section 'WebView2 and Edge policies in the registry' {
  foreach ($key in 'HKLM:\SOFTWARE\Policies\Microsoft\Edge', 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2', 'HKCU:\SOFTWARE\Policies\Microsoft\Edge') {
    if (Test-Path $key) {
      "$key"
      (Get-ItemProperty $key | Select-Object * -ExcludeProperty PS* | Format-List | Out-String).TrimEnd()
    } else { "$key (none)" }
  }
}
Section 'listening TCP ports above 1024' {
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -gt 1024 } |
    Sort-Object LocalPort | Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table -AutoSize
}
Section 'Windows application log, last 15 minutes, mentioning the app or WebView' {
  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = (Get-Date).AddMinutes(-15) } -ErrorAction SilentlyContinue |
    Where-Object { $_.Message -match 'kvgrainy|WebView' } | Select-Object -First 8 |
    ForEach-Object { "$($_.TimeCreated) $($_.ProviderName) id $($_.Id): $($_.Message.Substring(0, [Math]::Min(300, $_.Message.Length)))" }
}
if ($ScreenshotPath) {
  Section 'screenshot of the desktop' {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save($ScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
    "saved $ScreenshotPath ($($bounds.Width)x$($bounds.Height))"
  }
}
