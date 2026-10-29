param([Parameter(Mandatory=$true)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw '此脚本只允许在隔离 Windows CI 账号中执行，会修改安装注册项。' }
$taskInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$taskRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
$taskInstall = [IO.Path]::GetFullPath((Join-Path $taskRoot 'Video Quickly 中文安装验收'))
if (-not $taskInstall.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '验收安装目录超出 RUNNER_TEMP' }
$taskData = Join-Path $env:APPDATA 'net.lazyseacow.video-quickly'
if (Test-Path -LiteralPath $taskData) { throw '验收账号已有项目数据，停止安装操作。' }
$taskEvidence = Join-Path $taskRoot 'vq-installed-fixture.json'
$taskDesktop = $null
function Invoke-Installer([string]$extra) {
  $taskSetup = Start-Process -FilePath $taskInstaller -ArgumentList "/S $extra /D=$taskInstall" -WindowStyle Hidden -PassThru -Wait
  if ($taskSetup.ExitCode -ne 0) { throw "安装失败：$($taskSetup.ExitCode)" }
  if (-not (Test-Path -LiteralPath (Join-Path $taskInstall 'video-quickly.exe'))) { throw '安装后缺少客户端' }
}
function Invoke-InstalledRuntime([string]$mode) {
  node scripts/installed-runtime-smoke.mjs $mode $taskInstall $taskData $taskEvidence
  if ($LASTEXITCODE -ne 0) { throw "安装后运行时验收失败：$mode" }
}
function Test-NativeLaunch {
  $script:taskDesktop = Start-Process -FilePath (Join-Path $taskInstall 'video-quickly.exe') -WindowStyle Hidden -PassThru
  try {
    $taskChildren = @()
    for ($taskAttempt=0; $taskAttempt -lt 20; $taskAttempt++) {
      Start-Sleep -Seconds 1
      if ($script:taskDesktop.HasExited) { throw '安装后的原生客户端启动失败' }
      $taskChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($script:taskDesktop.Id)" | Where-Object { $_.Name -eq 'node.exe' })
      if ($taskChildren.Count -eq 1) { break }
    }
    if ($taskChildren.Count -ne 1) { throw '原生客户端应启动一个执行组件' }
    Start-Sleep -Seconds 2
    Invoke-InstalledRuntime 'inspect'
  } finally {
    if (-not $script:taskDesktop.HasExited) { Stop-Process -Id $script:taskDesktop.Id; $script:taskDesktop.WaitForExit() }
    $script:taskDesktop = $null
  }
  Start-Sleep -Seconds 1
  foreach ($taskChild in $taskChildren) { if (Get-Process -Id $taskChild.ProcessId -ErrorAction SilentlyContinue) { throw '客户端退出后执行组件仍在运行' } }
}
try {
  Invoke-Installer ''
  Invoke-InstalledRuntime 'prepare'
  Invoke-Installer '/UPDATE'
  Test-NativeLaunch
  Invoke-InstalledRuntime 'verify'
  Test-NativeLaunch
  $taskUninstall = Join-Path $taskInstall 'uninstall.exe'
  $taskRemoved = Start-Process -FilePath $taskUninstall -ArgumentList "/S _?=$taskInstall" -WindowStyle Hidden -PassThru -Wait
  if ($taskRemoved.ExitCode -ne 0) { throw '卸载失败' }
  if (Test-Path -LiteralPath (Join-Path $taskInstall 'video-quickly.exe')) { throw '卸载后客户端文件仍存在' }
  if (-not (Test-Path -LiteralPath (Join-Path $taskData 'workspace.sqlite'))) { throw '静默卸载应保留用户项目数据' }
  @{ installed=$true; overwriteInstall=$true; legacyDatabaseMigration=$true; nativeLaunch=$true; installedRuntime=$true; actualExport=$true; reviewResumed=$true; uninstall=$true; dataPreserved=$true; systemFilePicker='manual-check-required' } | ConvertTo-Json | Set-Content -LiteralPath '.generated/install-smoke.json' -Encoding utf8
} finally { if ($null -ne $taskDesktop -and -not $taskDesktop.HasExited) { Stop-Process -Id $taskDesktop.Id } }
