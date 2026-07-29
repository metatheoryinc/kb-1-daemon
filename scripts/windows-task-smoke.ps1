#Requires -Version 5.1

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  Write-Host "Windows task smoke skipped: this check runs only on Windows."
  exit 0
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$installer = Join-Path $repoRoot "skills\kb-1-daemon-setup\scripts\install_kb1_daemon_user_task.ps1"
$powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$localAppData = [Environment]::GetFolderPath(
  [Environment+SpecialFolder]::LocalApplicationData
)
$systemDriveRoot = [IO.Path]::GetPathRoot([string]$env:SystemRoot)
if ([string]::IsNullOrWhiteSpace($systemDriveRoot)) {
  throw "A local Windows system drive is required for the Windows task smoke test."
}
$kb1Home = Join-Path $systemDriveRoot "kb1-windows-task~archive-$([Guid]::NewGuid().ToString('N'))"
$trustedToolsRoot = Join-Path $systemDriveRoot "kb1-windows-tools-$([Guid]::NewGuid().ToString('N'))"
$sourceNodeDirectory = Split-Path -Parent (
  (Get-Command node.exe -ErrorAction Stop).Source
)
$originalPath = [string]$env:PATH
$taskName = "KB-1 Windows Smoke $([Guid]::NewGuid().ToString('N'))"
function Set-OwnerOnlyDirectoryAcl {
  param([string]$Path)

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($accessRule in @($acl.Access)) {
    $null = $acl.RemoveAccessRuleSpecific($accessRule)
  }
  $acl.SetOwner($identity.User)
  $acl.AddAccessRule(
    [Security.AccessControl.FileSystemAccessRule]::new(
      $identity.User,
      [Security.AccessControl.FileSystemRights]::FullControl,
      (
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
      ),
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
  )
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Get-StorageKey {
  param([string]$Value)

  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $hash = [BitConverter]::ToString($sha256.ComputeHash($bytes))
    return $hash.Replace("-", "").Substring(0, 16).ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}
$taskKey = Get-StorageKey $taskName.ToUpperInvariant()
$homeKey = Get-StorageKey (
  [IO.Path]::GetFullPath($kb1Home).ToUpperInvariant()
)
$taskStateDirectory = Join-Path (
  $localAppData
) "KB-1\tasks"
$configPath = Join-Path $taskStateDirectory "windows-task-$taskKey.json"
$runtimeRoot = Join-Path `
  $taskStateDirectory `
  "windows-runtimes\$taskKey"

$listener = [Net.Sockets.TcpListener]::new(
  [Net.IPAddress]::IPv6Loopback,
  0
)
$listener.Start()
$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$healthUrl = "http://[::1]:$port/api/health"

function Invoke-Installer {
  param([string[]]$InstallerArguments)

  & $powerShell `
    -NoProfile `
    -NonInteractive `
    -ExecutionPolicy Bypass `
    -File $installer `
    @InstallerArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Windows task installer failed with code $LASTEXITCODE."
  }
}

function Invoke-InstallerExpectedFailure {
  param([string[]]$InstallerArguments)

  & $powerShell `
    -NoProfile `
    -NonInteractive `
    -ExecutionPolicy Bypass `
    -File $installer `
    @InstallerArguments
  if ($LASTEXITCODE -eq 0) {
    throw "Windows task installer unexpectedly succeeded."
  }
}

function Wait-UntilUnavailable {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    try {
      Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1 | Out-Null
    } catch {
      return
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "KB-1 remained reachable after the Scheduled Task stopped."
}

function New-OwnerOnlyGlobalMutex {
  param([string]$Name)

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $security = [Security.AccessControl.MutexSecurity]::new()
  $security.SetOwner($identity.User)
  $security.SetAccessRuleProtection($true, $false)
  $security.AddAccessRule(
    [Security.AccessControl.MutexAccessRule]::new(
      $identity.User,
      [Security.AccessControl.MutexRights]::FullControl,
      [Security.AccessControl.AccessControlType]::Allow
    )
  )
  $createdNew = $false
  return [Threading.Mutex]::new(
    $false,
    $Name,
    [ref]$createdNew,
    $security
  )
}

$commonArguments = @(
  "-RepoDir", $repoRoot,
  "-KB1Home", $kb1Home,
  "-BindHost", "[::1]",
  "-Port", [string]$port,
  "-TaskName", $taskName
)

try {
  New-Item -ItemType Directory -Path $trustedToolsRoot | Out-Null
  Set-OwnerOnlyDirectoryAcl $trustedToolsRoot
  Get-ChildItem -LiteralPath $sourceNodeDirectory -Force |
    Copy-Item -Destination $trustedToolsRoot -Recurse -Force
  $env:PATH = "$trustedToolsRoot;$originalPath"

  Invoke-Installer (@(
    "-Action", "Install",
    "-SkipRepoUpdate",
    "-BuildOnly",
    "-HealthTimeoutSeconds", "15"
  ) + $commonArguments)

  Invoke-Installer (@("-Action", "Status") + $commonArguments)

  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Expected one owner-only Windows task config."
  }
  $currentSid = (
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).User.Value
  $installedConfig = Get-Content -LiteralPath $configPath -Raw |
    ConvertFrom-Json
  $activeRuntime = [string]$installedConfig.repoDir
  if (
    -not $activeRuntime.StartsWith(
      "$runtimeRoot\",
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "The Scheduled Task was not installed from its protected runtime root."
  }
  if ([string]$installedConfig.bindHost -ne "::1") {
    throw "The installer did not normalize the bracketed IPv6 bind host."
  }
  $sharedChildPath = Join-Path $kb1Home "shared-child"
  New-Item -ItemType Directory -Path $sharedChildPath | Out-Null
  $sharedChildAcl = Get-Acl -LiteralPath $sharedChildPath
  $sharedChildAcl.SetAccessRuleProtection($true, $false)
  $sharedChildAcl.AddAccessRule(
    [Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new($currentSid),
      [Security.AccessControl.FileSystemRights]::FullControl,
      (
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
      ),
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
  )
  $sharedChildAcl.AddAccessRule(
    [Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new("S-1-5-32-545"),
      [Security.AccessControl.FileSystemRights]::Modify,
      (
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
      ),
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
  )
  Set-Acl -LiteralPath $sharedChildPath -AclObject $sharedChildAcl
  try {
    Invoke-InstallerExpectedFailure (
      @("-Action", "Start") + $commonArguments
    )
  } finally {
    Remove-Item -LiteralPath $sharedChildPath -Recurse -Force
  }

  $junctionTarget = Join-Path (
    [IO.Path]::GetTempPath()
  ) "kb1-windows-junction-target-$([Guid]::NewGuid().ToString('N'))"
  $junctionPath = Join-Path $kb1Home "redirected-vault"
  New-Item -ItemType Directory -Path $junctionTarget | Out-Null
  & cmd.exe /d /c mklink /J $junctionPath $junctionTarget | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Could not create the KB1_HOME junction used by the smoke test."
  }
  try {
    Invoke-Installer (@("-Action", "Status") + $commonArguments)
    Invoke-Installer (@("-Action", "Stop") + $commonArguments)
    Wait-UntilUnavailable
    Invoke-InstallerExpectedFailure (@("-Action", "Start") + $commonArguments)
  } finally {
    & cmd.exe /d /c rmdir $junctionPath
    Remove-Item -LiteralPath $junctionTarget -Recurse -Force
  }
  Invoke-Installer (@("-Action", "Start") + $commonArguments)
  Invoke-Installer @(
    "-Action", "Install",
    "-TaskName", $taskName,
    "-SkipRepoUpdate",
    "-SkipDependencyInstall",
    "-SkipBuild",
    "-HealthTimeoutSeconds", "15"
  )
  $preservedConfig = Get-Content -LiteralPath $configPath -Raw |
    ConvertFrom-Json
  if (
    [string]$preservedConfig.kb1Home -ne [string]$kb1Home -or
    [string]$preservedConfig.bindHost -ne "::1" -or
    [int]$preservedConfig.port -ne $port -or
    -not [string]::Equals(
      [IO.Path]::GetFullPath([string]$preservedConfig.sourceRepoDir),
      [IO.Path]::GetFullPath($repoRoot),
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "A default upgrade did not preserve the installed custom settings."
  }
  $installedConfig = $preservedConfig
  $installedConfig.bindHost = "::"
  $installedConfig |
    ConvertTo-Json |
    Set-Content -LiteralPath $configPath -Encoding utf8
  Invoke-Installer (@("-Action", "Status") + $commonArguments)
  $installedConfig.bindHost = "::1"
  $installedConfig |
    ConvertTo-Json |
    Set-Content -LiteralPath $configPath -Encoding utf8

  $ownerKey = ([string]$currentSid).Replace("-", "")
  $mutexName = "Global\KB1DaemonTask-$ownerKey-$taskKey"
  $heldMutex = New-OwnerOnlyGlobalMutex $mutexName
  try {
    if (-not $heldMutex.WaitOne(0)) {
      throw "Could not acquire the task lifecycle mutex for smoke coverage."
    }
    Invoke-InstallerExpectedFailure (
      @("-Action", "Status") + $commonArguments
    )
  } finally {
    $heldMutex.ReleaseMutex()
    $heldMutex.Dispose()
  }

  $homeMutexName = "Global\KB1DaemonHome-$ownerKey-$homeKey"
  $heldHomeMutex = New-OwnerOnlyGlobalMutex $homeMutexName
  try {
    if (-not $heldHomeMutex.WaitOne(0)) {
      throw "Could not acquire the KB1_HOME lifecycle mutex for smoke coverage."
    }
    Invoke-InstallerExpectedFailure (
      @("-Action", "Status") + $commonArguments
    )
  } finally {
    $heldHomeMutex.ReleaseMutex()
    $heldHomeMutex.Dispose()
  }

  foreach ($securedPath in @($taskStateDirectory, $configPath)) {
    foreach ($accessRule in @((Get-Acl -LiteralPath $securedPath).Access)) {
      if (
        $accessRule.AccessControlType -ne
          [Security.AccessControl.AccessControlType]::Allow
      ) {
        continue
      }
      $ruleSid = $accessRule.IdentityReference.Translate(
        [Security.Principal.SecurityIdentifier]
      ).Value
      if ([string]$ruleSid -ne [string]$currentSid) {
        throw "Task state path is writable by an unexpected principal: $ruleSid"
      }
    }
  }

  Invoke-InstallerExpectedFailure (@(
    "-Action", "Install",
    "-SkipRepoUpdate",
    "-SkipDependencyInstall",
    "-BuildOnly",
    "-HealthTimeoutSeconds", "5"
  ) + $commonArguments)

  $healthyAfterBuildFailure = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
  if (
    $healthyAfterBuildFailure.ok -ne $true -or
    $healthyAfterBuildFailure.service -ne "kb1d"
  ) {
    throw "The prior Scheduled Task was disrupted by a failed staged build."
  }
  if (
    -not (Test-Path -LiteralPath $activeRuntime -PathType Container) -or
    @(
      Get-ChildItem -LiteralPath $runtimeRoot -Directory
    ).Count -ne 1
  ) {
    throw "A failed staged build changed or leaked the protected runtime set."
  }

  $blockedListener = [Net.Sockets.TcpListener]::new(
    [Net.IPAddress]::IPv6Loopback,
    0
  )
  $blockedListener.Start()
  try {
    $blockedPort = ([Net.IPEndPoint]$blockedListener.LocalEndpoint).Port
    $replacementArguments = @($commonArguments)
    $replacementArguments[7] = [string]$blockedPort
    Invoke-InstallerExpectedFailure (@(
      "-Action", "Install",
      "-SkipRepoUpdate",
      "-SkipDependencyInstall",
      "-SkipBuild",
      "-HealthTimeoutSeconds", "5"
    ) + $replacementArguments)
  } finally {
    $blockedListener.Stop()
  }

  $restoredHealth = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
  if ($restoredHealth.ok -ne $true -or $restoredHealth.service -ne "kb1d") {
    throw "The prior Scheduled Task was not restored after failed replacement."
  }

  $obsoleteRuntime = Join-Path `
    $runtimeRoot `
    ([Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $obsoleteRuntime -Force | Out-Null
  Set-Content `
    -LiteralPath (Join-Path $obsoleteRuntime "obsolete.txt") `
    -Value "remove me"
  Invoke-Installer (@(
    "-Action", "Install",
    "-SkipRepoUpdate",
    "-SkipDependencyInstall",
    "-SkipBuild",
    "-HealthTimeoutSeconds", "15"
  ) + $commonArguments)
  if (Test-Path -LiteralPath $obsoleteRuntime) {
    throw "A healthy replacement did not prune an inactive versioned runtime."
  }

  Invoke-Installer (@("-Action", "Stop") + $commonArguments)
  $gracefulStopInfo = Get-ScheduledTaskInfo `
    -TaskName $taskName `
    -TaskPath "\"
  if ([long]$gracefulStopInfo.LastTaskResult -ne 0) {
    throw "The graceful stop did not record a successful task exit."
  }
  Wait-UntilUnavailable
  Invoke-Installer (@("-Action", "Start") + $commonArguments)

  $forceStopConfig = Get-Content -LiteralPath $configPath -Raw |
    ConvertFrom-Json
  $forceStopConfig.controlToken = [Guid]::NewGuid().ToString("N")
  $forceStopConfig |
    ConvertTo-Json |
    Set-Content -LiteralPath $configPath -Encoding utf8
  Invoke-Installer (@("-Action", "Stop", "-ForceStop") + $commonArguments)
  Invoke-Installer (@("-Action", "Status") + $commonArguments)
  Wait-UntilUnavailable
  Invoke-Installer (@("-Action", "Start") + $commonArguments)

  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
  if ($health.ok -ne $true -or $health.service -ne "kb1d") {
    throw "Unexpected health response after restarting the Scheduled Task."
  }

  Write-Host "Windows per-user task smoke passed."
  Write-Host "Verified owner-only state, task/home lifecycle locks, install, isolated build failure, failed-replacement rollback, runtime pruning, verified graceful and process-tree force-stop, status, restart, health, and uninstall lifecycle."
} finally {
  try {
    Invoke-Installer (@("-Action", "Uninstall", "-ForceStop") + $commonArguments)
  } catch {
    Write-Warning "Task cleanup failed: $($_.Exception.Message)"
  }
  Remove-Item -LiteralPath $kb1Home -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $taskStateDirectory -PathType Container) {
    Get-ChildItem `
      -LiteralPath $taskStateDirectory `
      -Filter "windows-task-$taskKey*" `
      -File `
      -ErrorAction SilentlyContinue |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }
  Remove-Item `
    -LiteralPath $runtimeRoot `
    -Recurse `
    -Force `
    -ErrorAction SilentlyContinue
  $env:PATH = $originalPath
  Remove-Item `
    -LiteralPath $trustedToolsRoot `
    -Recurse `
    -Force `
    -ErrorAction SilentlyContinue
}

if (
  $null -ne (Get-ScheduledTask `
    -TaskName $taskName `
    -TaskPath "\" `
    -ErrorAction SilentlyContinue)
) {
  throw "Windows task smoke left Scheduled Task '$taskName' registered."
}
