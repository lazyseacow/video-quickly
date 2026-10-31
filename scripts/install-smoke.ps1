param([Parameter(Mandatory=$true)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw '此脚本只允许在隔离 Windows CI 账号中执行，会修改安装注册项。' }
$taskInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$taskInstallerSha256 = (Get-FileHash -LiteralPath $taskInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
$taskVersion = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
$taskRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
$taskInstallName = 'Video Quickly 中文安装验收'
$taskInstall = [IO.Path]::GetFullPath((Join-Path $taskRoot $taskInstallName))
if (-not $taskInstall.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '验收安装目录超出 RUNNER_TEMP' }
$taskData = Join-Path $env:APPDATA 'VideoQuickly-Electron'
if (Test-Path -LiteralPath $taskData) { throw '验收账号已有项目数据，停止安装操作。' }
if (Test-Path -LiteralPath $taskInstall) { throw '验收安装目录已存在，停止操作。' }
# These exact aliases are removed by the builder's generic deletion flag. They
# are not this application's workspace; only this fresh CI account owns fixtures.
$taskRoamingRoot = [IO.Path]::GetFullPath($env:APPDATA)
$taskLocalRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
$taskNamespaceParent = Join-Path $taskRoamingRoot '@video-quickly'
$taskProtectedDirectories = @((Join-Path $taskRoamingRoot 'video-quickly'), (Join-Path $taskNamespaceParent 'desktop'), (Join-Path $taskLocalRoot 'VideoQuickly-Electron'))
$taskFixtureRoots = @($taskProtectedDirectories[0], $taskNamespaceParent, $taskProtectedDirectories[2])
$taskOwnedRoots = [Collections.Generic.List[string]]::new()
foreach ($taskDirectory in @($taskFixtureRoots + $taskProtectedDirectories)) {
  if (Test-Path -LiteralPath $taskDirectory) { throw '验收账号已有受保护目录，停止操作。' }
}
foreach ($taskDirectory in @($taskRoamingRoot, $taskLocalRoot)) {
  $taskInformation = Get-Item -LiteralPath $taskDirectory
  if (-not $taskInformation.PSIsContainer -or ($taskInformation.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '验收数据根目录必须是普通目录' }
}
$taskEvidence = Join-Path $taskRoot 'vq-installed-fixture.json'
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
  node scripts/check-installed-electron.mjs $taskInstall $taskData
  if ($LASTEXITCODE -ne 0) { throw '安装后的 Electron 窗口、原生桥接或退出清理失败' }
  Invoke-InstalledRuntime 'inspect'
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
function Assert-FixtureDirectory([string]$path) {
  $full = [IO.Path]::GetFullPath($path)
  if (@($taskFixtureRoots + $taskProtectedDirectories) -notcontains $full) { throw '哨兵目录不在本次夹具清单内' }
  $parent = if ($full -eq $taskProtectedDirectories[2]) { $taskLocalRoot } else { $taskRoamingRoot }
  if (-not $full.StartsWith($parent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $full -eq $taskData) { throw '哨兵目录越界' }
  if (Test-Path -LiteralPath $full) {
    $info = Get-Item -LiteralPath $full
    if (-not $info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '哨兵目录必须是普通目录' }
  }
}
function Get-ProtectedSentinelSnapshot([string]$stage) {
  foreach ($path in $taskProtectedDirectories) { Assert-FixtureDirectory $path }
  $snapshot = @(Get-DataRetentionSnapshot $taskSentinelFiles)
  for ($index=0; $index -lt $taskSentinelBefore.Count; $index++) {
    foreach ($property in @('role', 'path', 'exists', 'bytes', 'sha256')) {
      if ($taskSentinelBefore[$index].$property -cne $snapshot[$index].$property) { throw "$stage 改变了受保护哨兵：$($taskSentinelBefore[$index].role) / $property" }
    }
  }
  return $snapshot
}
try {
  foreach ($taskDirectory in $taskFixtureRoots) {
    Assert-FixtureDirectory $taskDirectory
    New-Item -ItemType Directory -Path $taskDirectory | Out-Null
    $taskOwnedRoots.Add($taskDirectory)
  }
  New-Item -ItemType Directory -Path $taskProtectedDirectories[1] | Out-Null
  $taskSentinelFiles = @()
  for ($taskIndex=0; $taskIndex -lt $taskProtectedDirectories.Count; $taskIndex++) {
    $taskSentinel = Join-Path $taskProtectedDirectories[$taskIndex] 'vq-uninstall-scope-fixture.bin'
    [IO.File]::WriteAllBytes($taskSentinel, [Text.Encoding]::UTF8.GetBytes("isolated-uninstall-sentinel-$taskIndex-$([guid]::NewGuid())"))
    $taskSentinelFiles += [pscustomobject]@{ role="protected-alias-$taskIndex"; path=$taskSentinel; optional=$false }
  }
  $taskSentinelBefore = @(Get-DataRetentionSnapshot $taskSentinelFiles)
  Invoke-Installer $taskInstaller '/currentuser' $taskVersion
  Invoke-InstalledRuntime 'prepare'
  Invoke-Installer $taskInstaller '/currentuser' $taskVersion
  Test-NativeLaunch
  Invoke-InstalledRuntime 'verify'
  Invoke-Installer $taskInstaller '/currentuser' $taskVersion
  Test-NativeLaunch
  $taskRetainedFiles = @(
    [pscustomobject]@{ role='database'; path=[IO.Path]::GetFullPath((Join-Path $taskData 'workspace.sqlite')); optional=$false },
    [pscustomobject]@{ role='database-wal'; path=[IO.Path]::GetFullPath((Join-Path $taskData 'workspace.sqlite-wal')); optional=$true }
  )
  $taskSavedFixture = Get-Content -LiteralPath $taskEvidence -Raw | ConvertFrom-Json
  $taskFixtureAsset = [IO.Path]::GetFullPath([string]$taskSavedFixture.asset.path)
  $taskAssetRoot = [IO.Path]::GetFullPath((Join-Path $taskData "projects\$($taskSavedFixture.projectId)\assets"))
  if (-not $taskFixtureAsset.StartsWith($taskAssetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '素材不在隔离项目目录内' }
  $taskRetainedFiles += [pscustomobject]@{ role='fixture-image'; path=$taskFixtureAsset; optional=$false }
  # No runtime is active here. Compare durable database/WAL bytes, rather than
  # opening SQLite after uninstall and potentially checkpointing its WAL.
  $taskDataBeforeUninstall = @(Get-DataRetentionSnapshot $taskRetainedFiles)
  $taskImageBefore = $taskDataBeforeUninstall | Where-Object { $_.role -eq 'fixture-image' }
  if ($taskImageBefore.sha256 -cne $taskSavedFixture.asset.sha256 -or $taskImageBefore.bytes -ne $taskSavedFixture.asset.size) { throw '卸载前夹具素材已变化' }
  $taskUninstall = Join-Path $taskInstall 'Uninstall video-quickly.exe'
  if (-not (Test-Path -LiteralPath $taskUninstall)) { throw '安装后缺少卸载程序' }
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
  $taskRetention = [ordered]@{ scope='database-wal-and-fixture-image'; before=@($taskDataBeforeUninstall); after=@($taskDataAfterUninstall) }
  $taskSentinelAfterDefault = @(Get-ProtectedSentinelSnapshot '默认卸载')
  # Default uninstall has already proved byte-for-byte retention. Separately
  # verify the user's explicit deletion choice on the same disposable fixture.
  Invoke-Installer $taskInstaller '/currentuser' $taskVersion
  Test-NativeLaunch
  $taskDeleted = Start-Process -FilePath $taskUninstall -ArgumentList "/S --delete-electron-workspace _?=$taskInstall" -WindowStyle Hidden -PassThru -Wait
  if ($taskDeleted.ExitCode -ne 0 -or (Test-Path -LiteralPath $taskData)) { throw '明确选择删除数据后工作区仍存在' }
  $taskSentinelAfterExplicit = @(Get-ProtectedSentinelSnapshot '明确删除工作区')
  $taskDeletionScope = @{ option='--delete-electron-workspace'; workspace=$taskData; protectedDirectoriesPreserved=$true; before=@($taskSentinelBefore); afterDefault=@($taskSentinelAfterDefault); afterExplicit=@($taskSentinelAfterExplicit) }
  $taskReport = @{ installerSha256=$taskInstallerSha256; installed=$true; overwriteInstall=$true; framework='electron'; nativeLaunch=$true; installedRuntime=$true; actualExport=$true; reviewResumed=$true; uninstall=$true; databaseFileRetained=$true; dataPreserved=$true; dataContentPreserved=$true; explicitDataDeletion=$true; dataRetention=$taskRetention; deletionScope=$taskDeletionScope; systemFilePicker='manual-check-required' }
  $taskReportPath = '.generated/install-smoke.json'
  $taskReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskReportPath -Encoding utf8
} finally {
  if ($null -ne $taskDesktop -and -not $taskDesktop.HasExited) { Stop-Process -Id $taskDesktop.Id }
  foreach ($taskDirectory in $taskOwnedRoots) {
    foreach ($taskProtected in $taskProtectedDirectories) { Assert-FixtureDirectory $taskProtected }
    Assert-FixtureDirectory $taskDirectory
    if (Test-Path -LiteralPath $taskDirectory) { Remove-Item -LiteralPath $taskDirectory -Recurse -Force }
  }
}
