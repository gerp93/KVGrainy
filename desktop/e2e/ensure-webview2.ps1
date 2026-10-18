# Make sure the WebView2 runtime (the thing that draws the app's window) is installed, and print its version.
#
# GitHub's Windows Server image notes list Microsoft Edge but not the WebView2 runtime, so this was added in case the
# runtime was missing. It is not: a hosted runner already has it (version 154 when this was checked), and the end-to-end
# failure turned out to be something else (see docs/desktop.md). Kept as a cheap guard that prints the version in every
# run; if the runtime is ever missing it installs Microsoft's Evergreen runtime silently.
$ErrorActionPreference = 'Stop'
$guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'

function Find-Runtime {
  foreach ($root in 'HKLM:\SOFTWARE\WOW6432Node', 'HKLM:\SOFTWARE', 'HKCU:\SOFTWARE') {
    $pv = (Get-ItemProperty -Path "$root\Microsoft\EdgeUpdate\Clients\$guid" -ErrorAction SilentlyContinue).pv
    if ($pv) { return $pv }
  }
}

$version = Find-Runtime
if ($version) {
  "The WebView2 runtime $version is already installed."
  exit 0
}

"The WebView2 runtime is not installed; installing the Evergreen runtime."
$setup = Join-Path $env:RUNNER_TEMP 'MicrosoftEdgeWebview2Setup.exe'
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $setup
$install = Start-Process -FilePath $setup -ArgumentList '/silent', '/install' -Wait -PassThru
"Installer exit code: $($install.ExitCode)"

$version = Find-Runtime
if ($version) { "The WebView2 runtime $version is now installed." }
else { throw 'The WebView2 runtime is still not installed after running its installer.' }
