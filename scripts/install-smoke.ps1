param(
  [Parameter(Mandatory=$true)][string]$InstallerPath,
  [string]$InstallerManifestPath,
  [string]$PreviousInstallerPath,
  [string]$PreviousInstallerManifestPath
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw '此脚本只允许在隔离 Windows CI 账号中执行，会修改安装注册项。' }
$taskInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$taskUpgrade = -not [string]::IsNullOrWhiteSpace($PreviousInstallerPath)
if ($taskUpgrade -ne (-not [string]::IsNullOrWhiteSpace($PreviousInstallerManifestPath))) { throw '真实升级需要旧安装包与对应清单' }
if ($taskUpgrade -and [string]::IsNullOrWhiteSpace($InstallerManifestPath)) { throw '真实升级需要当前安装包清单' }
$taskVersion = (Get-Content -LiteralPath 'apps/desktop/src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
function Assert-InstallerManifest([string]$path, [string]$manifestPath, [string]$version) {
  $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not [string]::IsNullOrWhiteSpace($manifestPath)) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.version -ne $version -or $manifest.platform -ne 'windows-x64' -or $manifest.installer.name -ne [IO.Path]::GetFileName($path)) { throw '安装包版本、平台或文件名与清单不一致' }
    if ($manifest.installer.sha256 -ne $hash -or $manifest.installer.bytes -ne (Get-Item -LiteralPath $path).Length) { throw '安装包摘要或长度与清单不一致' }
  }
  return $hash
}
$taskCurrentHash = Assert-InstallerManifest $taskInstaller $InstallerManifestPath $taskVersion
$taskPrevious = $null
if ($taskUpgrade) {
  $taskPreviousInstaller = (Resolve-Path -LiteralPath $PreviousInstallerPath).Path
  $taskPrevious = Get-Content -LiteralPath $PreviousInstallerManifestPath -Raw | ConvertFrom-Json
  if ([version]$taskPrevious.version -ge [version]$taskVersion) { throw '旧产品版本必须低于新版本，不能把同版本构建当作跨版本升级' }
  $taskPreviousHash = Assert-InstallerManifest $taskPreviousInstaller $PreviousInstallerManifestPath $taskPrevious.version
  if ($taskPreviousHash -eq $taskCurrentHash) { throw '新旧安装包不能相同' }
}
$taskRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
$taskInstallName = if ($taskUpgrade) { 'Video Quickly 真实跨版本升级' } else { 'Video Quickly 中文安装验收' }
$taskInstall = [IO.Path]::GetFullPath((Join-Path $taskRoot $taskInstallName))
if (-not $taskInstall.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '验收安装目录超出 RUNNER_TEMP' }
$taskData = Join-Path $env:APPDATA 'net.lazyseacow.video-quickly'
if (Test-Path -LiteralPath $taskData) { throw '验收账号已有项目数据，停止安装操作。' }
if (Test-Path -LiteralPath $taskInstall) { throw '验收安装目录已存在，停止操作。' }
$taskEvidence = Join-Path $taskRoot $(if ($taskUpgrade) { 'vq-version-upgrade-fixture.json' } else { 'vq-installed-fixture.json' })
$taskDesktop = $null
function Invoke-Installer([string]$path, [string]$extra, [string]$version) {
  $taskSetup = Start-Process -FilePath $path -ArgumentList "/S $extra /D=$taskInstall" -WindowStyle Hidden -PassThru -Wait
  if ($taskSetup.ExitCode -ne 0) { throw "安装失败：$($taskSetup.ExitCode)" }
  if (-not (Test-Path -LiteralPath (Join-Path $taskInstall 'video-quickly.exe'))) { throw '安装后缺少客户端' }
  $installedVersion = (Get-Item -LiteralPath (Join-Path $taskInstall 'video-quickly.exe')).VersionInfo.ProductVersion
  if ([regex]::Match($installedVersion, '^\d+\.\d+\.\d+').Value -ne $version) { throw "安装后的真实产品版本不匹配：$installedVersion" }
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
  if ($taskUpgrade) {
    Invoke-Installer $taskPreviousInstaller '' $taskPrevious.version
    Invoke-InstalledRuntime 'prepare-upgrade'
  } else {
    Invoke-Installer $taskInstaller '' $taskVersion
    Invoke-InstalledRuntime 'prepare'
  }
  Invoke-Installer $taskInstaller '/UPDATE' $taskVersion
  Test-NativeLaunch
  Invoke-InstalledRuntime $(if ($taskUpgrade) { 'verify-upgrade' } else { 'verify' })
  if ($taskUpgrade) { Invoke-Installer $taskInstaller '/UPDATE' $taskVersion }
  Test-NativeLaunch
  $taskUninstall = Join-Path $taskInstall 'uninstall.exe'
  $taskRemoved = Start-Process -FilePath $taskUninstall -ArgumentList "/S _?=$taskInstall" -WindowStyle Hidden -PassThru -Wait
  if ($taskRemoved.ExitCode -ne 0) { throw '卸载失败' }
  if (Test-Path -LiteralPath (Join-Path $taskInstall 'video-quickly.exe')) { throw '卸载后客户端文件仍存在' }
  if (-not (Test-Path -LiteralPath (Join-Path $taskData 'workspace.sqlite'))) { throw '静默卸载应保留用户项目数据' }
  $taskReport = @{ installed=$true; overwriteInstall=$true; legacyDatabaseMigration=(-not $taskUpgrade); nativeLaunch=$true; installedRuntime=$true; actualExport=$true; reviewResumed=$true; uninstall=$true; dataPreserved=$true; systemFilePicker='manual-check-required' }
  $taskReportPath = '.generated/install-smoke.json'
  if ($taskUpgrade) {
    $verified = Get-Content -LiteralPath "$taskEvidence.verified.json" -Raw | ConvertFrom-Json
    $taskReport.versionUpgrade = $true; $taskReport.previousVersion = $taskPrevious.version; $taskReport.version = $taskVersion
    $taskReport.previousCommit = $taskPrevious.commit; $taskReport.previousInstallerSha256 = $taskPreviousHash; $taskReport.installerSha256 = $taskCurrentHash
    $taskReport.schemaBefore = $verified.schemaBefore; $taskReport.schemaAfter = $verified.schemaAfter; $taskReport.preservation = $verified
    $taskReportPath = '.generated/version-upgrade-smoke.json'
  }
  $taskReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskReportPath -Encoding utf8
} finally { if ($null -ne $taskDesktop -and -not $taskDesktop.HasExited) { Stop-Process -Id $taskDesktop.Id } }
