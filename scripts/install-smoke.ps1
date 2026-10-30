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
function Get-DataRetentionSnapshot([object[]]$files) {
  foreach ($file in $files) {
    $exists = Test-Path -LiteralPath $file.path
    $bytes = $null
    $sha256 = $null
    if ($exists) {
      $info = Get-Item -LiteralPath $file.path
      if ($info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '数据保留验收只读取普通夹具文件' }
      $bytes = $info.Length
      $sha256 = (Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash.ToLowerInvariant()
    } elseif (-not $file.optional) { throw "数据保留验收文件缺失：$($file.role)" }
    [pscustomobject][ordered]@{ role=$file.role; path=$file.path; exists=[bool]$exists; bytes=$bytes; sha256=$sha256 }
  }
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
  $taskRetainedFiles = @(
    [pscustomobject]@{ role='database'; path=[IO.Path]::GetFullPath((Join-Path $taskData 'workspace.sqlite')); optional=$false },
    [pscustomobject]@{ role='database-wal'; path=[IO.Path]::GetFullPath((Join-Path $taskData 'workspace.sqlite-wal')); optional=$true }
  )
  if ($taskUpgrade) {
    $taskSavedFixture = Get-Content -LiteralPath $taskEvidence -Raw | ConvertFrom-Json
    $taskFixtureProjectId = [guid]::Empty
    if (-not [guid]::TryParse([string]$taskSavedFixture.projectId, [ref]$taskFixtureProjectId) -or $taskSavedFixture.asset.projectId -cne $taskSavedFixture.projectId -or $taskSavedFixture.asset.kind -cne 'image') { throw '升级素材必须来自本次独立项目夹具' }
    $taskFixtureAsset = [IO.Path]::GetFullPath([string]$taskSavedFixture.asset.path)
    $taskFixtureAssetsRoot = [IO.Path]::GetFullPath((Join-Path $taskData "projects\$($taskFixtureProjectId.ToString())\assets"))
    if (-not $taskFixtureAsset.StartsWith($taskFixtureAssetsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($taskFixtureAsset) -ine '.png') { throw '升级素材超出本次项目的隔离素材目录' }
    $taskRetainedFiles += [pscustomobject]@{ role='fixture-image'; path=$taskFixtureAsset; optional=$false }
  }
  # No runtime is active here. Compare durable database/WAL bytes, rather than
  # opening SQLite after uninstall and potentially checkpointing its WAL.
  $taskDataBeforeUninstall = @(Get-DataRetentionSnapshot $taskRetainedFiles)
  if ($taskUpgrade) {
    $taskFixtureBefore = $taskDataBeforeUninstall | Where-Object { $_.role -eq 'fixture-image' }
    if ($taskFixtureBefore.sha256 -cne $taskSavedFixture.asset.sha256 -or $taskFixtureBefore.bytes -ne $taskSavedFixture.asset.size) { throw '卸载前升级夹具素材已变化' }
  }
  $taskUninstall = Join-Path $taskInstall 'uninstall.exe'
  $taskRemoved = Start-Process -FilePath $taskUninstall -ArgumentList "/S _?=$taskInstall" -WindowStyle Hidden -PassThru -Wait
  if ($taskRemoved.ExitCode -ne 0) { throw '卸载失败' }
  if (Test-Path -LiteralPath (Join-Path $taskInstall 'video-quickly.exe')) { throw '卸载后客户端文件仍存在' }
  if (-not (Test-Path -LiteralPath (Join-Path $taskData 'workspace.sqlite'))) { throw '静默卸载应保留用户项目数据' }
  $taskDataAfterUninstall = @(Get-DataRetentionSnapshot $taskRetainedFiles)
  if ($taskDataBeforeUninstall.Count -ne $taskDataAfterUninstall.Count) { throw '卸载前后的数据验收集合不一致' }
  for ($taskIndex=0; $taskIndex -lt $taskDataBeforeUninstall.Count; $taskIndex++) {
    foreach ($taskProperty in @('role', 'path', 'exists', 'bytes', 'sha256')) {
      if ($taskDataBeforeUninstall[$taskIndex].$taskProperty -cne $taskDataAfterUninstall[$taskIndex].$taskProperty) { throw "静默卸载改变了用户数据：$($taskDataBeforeUninstall[$taskIndex].role) / $taskProperty" }
    }
  }
  $taskRetention = [ordered]@{ scope=$(if ($taskUpgrade) { 'database-wal-and-fixture-image' } else { 'database-and-wal' }); before=@($taskDataBeforeUninstall); after=@($taskDataAfterUninstall) }
  $taskReport = @{ installed=$true; overwriteInstall=$true; legacyDatabaseMigration=(-not $taskUpgrade); nativeLaunch=$true; installedRuntime=$true; actualExport=$true; reviewResumed=$true; uninstall=$true; databaseFileRetained=$true; dataPreserved=$true; dataContentPreserved=$true; dataRetention=$taskRetention; systemFilePicker='manual-check-required' }
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
