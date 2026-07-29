#Requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "The KB-1 user task runner is supported only on Windows."
}

function Test-EquivalentPath {
  param(
    [string]$Left,
    [string]$Right
  )

  return [string]::Equals(
    [IO.Path]::GetFullPath($Left).TrimEnd("\"),
    [IO.Path]::GetFullPath($Right).TrimEnd("\"),
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Test-PathAtOrWithin {
  param(
    [string]$Candidate,
    [string]$Root
  )

  $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd("\")
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd("\")
  return (
    [string]::Equals(
      $candidateFull,
      $rootFull,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    $candidateFull.StartsWith(
      "$rootFull\",
      [StringComparison]::OrdinalIgnoreCase
    )
  )
}

function Get-TaskStorageKey {
  param([string]$TaskName)

  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($TaskName.ToUpperInvariant())
    $hash = $sha256.ComputeHash($bytes)
    return ([BitConverter]::ToString($hash).Replace("-", "").Substring(0, 16)).ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Assert-NoUntrustedWriteAccess {
  param([string[]]$Paths)

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $trustedWriteSids = @(
    [string]$identity.User.Value,
    "S-1-5-18",
    "S-1-5-32-544",
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
  )
  $writeMask = (
    [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  )

  foreach ($path in $Paths) {
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to execute through reparse-point path: $path"
    }
    $acl = Get-Acl -LiteralPath $path
    $ownerSid = $acl.GetOwner(
      [Security.Principal.SecurityIdentifier]
    ).Value
    if ($ownerSid -notin $trustedWriteSids) {
      throw "Refusing to execute through path owned by an untrusted principal: $path"
    }
    foreach ($accessRule in @($acl.Access)) {
      if (
        $accessRule.AccessControlType -ne
          [Security.AccessControl.AccessControlType]::Allow -or
        (
          $accessRule.PropagationFlags -band
          [Security.AccessControl.PropagationFlags]::InheritOnly
        ) -ne 0 -or
        ($accessRule.FileSystemRights -band $writeMask) -eq 0
      ) {
        continue
      }
      $ruleSid = $accessRule.IdentityReference.Translate(
        [Security.Principal.SecurityIdentifier]
      ).Value
      if ($ruleSid -notin $trustedWriteSids) {
        throw "Refusing to execute through path writable by an untrusted principal: $path"
      }
    }
  }
}

function Get-LocalDirectoryChain {
  param([string]$Path)

  $fullPath = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($fullPath)
  if (
    [string]::IsNullOrWhiteSpace($root) -or
    -not [regex]::IsMatch($root, '^[A-Za-z]:\\$')
  ) {
    throw "KB1_HOME must be an absolute path on a local Windows drive."
  }
  $relativePath = $fullPath.Substring($root.Length)
  $components = @(
    $relativePath -split '[\\/]' |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )

  $chain = @($root)
  $current = $root
  foreach ($component in $components) {
    $current = Join-Path $current $component
    $chain += $current
  }
  return $chain
}

function Assert-NoUntrustedReplaceAccess {
  param([string[]]$Paths)

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $trustedWriteSids = @(
    [string]$identity.User.Value,
    "S-1-5-18",
    "S-1-5-32-544",
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
  )
  $replaceMask = (
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  )

  foreach ($path in $Paths) {
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to trust reparse-point path: $path"
    }
    $acl = Get-Acl -LiteralPath $path
    $ownerSid = $acl.GetOwner(
      [Security.Principal.SecurityIdentifier]
    ).Value
    if ($ownerSid -notin $trustedWriteSids) {
      throw "Refusing to trust KB1_HOME beneath a directory owned by an untrusted principal: $path"
    }
    foreach ($accessRule in @($acl.Access)) {
      if (
        $accessRule.AccessControlType -ne
          [Security.AccessControl.AccessControlType]::Allow -or
        (
          $accessRule.PropagationFlags -band
          [Security.AccessControl.PropagationFlags]::InheritOnly
        ) -ne 0 -or
        ($accessRule.FileSystemRights -band $replaceMask) -eq 0
      ) {
        continue
      }
      $ruleSid = $accessRule.IdentityReference.Translate(
        [Security.Principal.SecurityIdentifier]
      ).Value
      if ($ruleSid -notin $trustedWriteSids) {
        throw "Refusing to trust KB1_HOME beneath a replaceable directory: $path"
      }
    }
  }
}

function Assert-TrustedKB1Home {
  param([string]$Path)

  $chain = @(Get-LocalDirectoryChain $Path)
  for ($index = 0; $index -lt $chain.Count; $index++) {
    $candidate = [string]$chain[$index]
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
      throw "KB1_HOME path component is missing or is not a directory: $candidate"
    }
    if ($index -eq ($chain.Count - 1)) {
      Assert-NoUntrustedWriteAccess -Paths @($candidate)
    } else {
      Assert-NoUntrustedReplaceAccess -Paths @($candidate)
    }
  }
  $pendingDirectories = [Collections.Generic.Queue[string]]::new()
  $pendingDirectories.Enqueue([IO.Path]::GetFullPath($Path))
  while ($pendingDirectories.Count -gt 0) {
    $directory = $pendingDirectories.Dequeue()
    foreach ($item in @(
      Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop
    )) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "KB1_HOME contains a reparse point that could redirect vault access: $($item.FullName)"
      }
      if ($item.PSIsContainer) {
        Assert-NoUntrustedWriteAccess -Paths @($item.FullName)
        $pendingDirectories.Enqueue([string]$item.FullName)
      }
    }
  }
  $resolved = [IO.Path]::GetFullPath(
    (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  )
  if (-not (Test-EquivalentPath $Path $resolved)) {
    throw "KB1_HOME did not resolve to its configured canonical path."
  }
}

function Assert-TrustedPathChain {
  param(
    [string]$Path,
    [switch]$Directory
  )

  $fullPath = [IO.Path]::GetFullPath($Path)
  $trustedDirectory = if ($Directory) {
    $fullPath
  } else {
    Split-Path -Parent $fullPath
  }
  $chain = @(Get-LocalDirectoryChain $trustedDirectory)
  if ($chain.Count -gt 1) {
    Assert-NoUntrustedReplaceAccess -Paths @(
      $chain[0..($chain.Count - 2)]
    )
  }
  Assert-NoUntrustedWriteAccess -Paths @($trustedDirectory)
  if (-not $Directory) {
    Assert-NoUntrustedWriteAccess -Paths @($fullPath)
  }
}

$localAppData = [Environment]::GetFolderPath(
  [Environment+SpecialFolder]::LocalApplicationData
)
$appStateRoot = Join-Path $localAppData "KB-1"
$expectedTaskStateRoot = Join-Path $appStateRoot "tasks"
if (
  -not (Test-EquivalentPath (Split-Path -Parent $ConfigPath) $expectedTaskStateRoot)
) {
  throw "KB-1 task configuration is outside the per-user task-state root."
}
Assert-NoUntrustedWriteAccess -Paths @(
  $localAppData,
  $appStateRoot,
  $expectedTaskStateRoot,
  $ConfigPath
)
Assert-TrustedPathChain -Path $localAppData -Directory

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
foreach ($property in @(
  "kind",
  "taskName",
  "ownerSid",
  "nodePath",
  "repoDir",
  "entrypoint",
  "taskStateRoot",
  "kb1Home",
  "bindHost",
  "port",
  "logPath",
  "stdoutPath",
  "stderrPath",
  "runtimeStatePath",
  "controlToken"
)) {
  if ([string]::IsNullOrWhiteSpace([string]$config.$property)) {
    throw "KB-1 task config is missing required property: $property"
  }
}
if ([string]$config.kind -ne "kb1-windows-user-task") {
  throw "KB-1 task config has an invalid ownership signature."
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ([string]$config.ownerSid -ne [string]$identity.User.Value) {
  throw "KB-1 task config belongs to a different Windows user."
}
if (-not (Test-EquivalentPath ([string]$config.taskStateRoot) $expectedTaskStateRoot)) {
  throw "KB-1 task config names an unexpected task-state root."
}
$expectedRuntimeRoot = Join-Path `
  $expectedTaskStateRoot `
  "windows-runtimes\$(Get-TaskStorageKey ([string]$config.taskName))"
if (-not (Test-PathAtOrWithin ([string]$config.repoDir) $expectedRuntimeRoot)) {
  throw "KB-1 task repository is outside its protected per-user runtime root."
}
Assert-TrustedKB1Home -Path ([string]$config.kb1Home)
Assert-TrustedPathChain -Path ([string]$config.nodePath)
Assert-TrustedPathChain -Path ([string]$config.repoDir) -Directory

$expectedRunner = Join-Path `
  ([string]$config.repoDir) `
  "skills\kb-1-daemon-setup\scripts\run_kb1_daemon_user_task.ps1"
$expectedEntrypoint = Join-Path `
  ([string]$config.repoDir) `
  "apps\daemon\dist\main.js"
if (
  -not (Test-EquivalentPath $PSCommandPath $expectedRunner) -or
  -not (Test-EquivalentPath ([string]$config.entrypoint) $expectedEntrypoint)
) {
  throw "KB-1 task code paths do not match the configured repository."
}
foreach ($statePath in @(
  [string]$config.logPath,
  [string]$config.stdoutPath,
  [string]$config.stderrPath,
  [string]$config.runtimeStatePath
)) {
  if (
    -not (Test-EquivalentPath (Split-Path -Parent $statePath) $expectedTaskStateRoot)
  ) {
    throw "KB-1 task state path is outside the per-user task-state root."
  }
}

$codePaths = @(
  [string]$config.nodePath,
  (Split-Path -Parent ([string]$config.nodePath)),
  $expectedRuntimeRoot,
  (Split-Path -Parent ([string]$config.repoDir)),
  [string]$config.repoDir,
  [string]$config.entrypoint,
  $PSCommandPath
)
$repoAclRoot = [IO.Path]::GetFullPath([string]$config.repoDir).TrimEnd("\")
foreach ($codeFile in @([string]$config.entrypoint, $PSCommandPath)) {
  $parentPath = Split-Path -Parent $codeFile
  while (
    [string]::Equals(
      $parentPath,
      $repoAclRoot,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    $parentPath.StartsWith(
      "$repoAclRoot\",
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    $codePaths += $parentPath
    if ([string]::Equals(
      $parentPath,
      $repoAclRoot,
      [StringComparison]::OrdinalIgnoreCase
    )) {
      break
    }
    $parentPath = Split-Path -Parent $parentPath
  }
}
Assert-NoUntrustedWriteAccess -Paths @($codePaths | Select-Object -Unique)

$logPath = [string]$config.logPath
$logDirectory = Split-Path -Parent $logPath
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

$env:NODE_ENV = "production"
$env:NODE_OPTIONS = $null
$env:NODE_PATH = $null
$env:KB1_HOME = [string]$config.kb1Home
$env:KB1_HOST = [string]$config.bindHost
$env:KB1_PORT = [string]$config.port
$env:KB1_CONTROL_TOKEN = [string]$config.controlToken
$env:KB1_INSTANCE_ID = [Guid]::NewGuid().ToString("N")
Set-Location -LiteralPath ([string]$config.repoDir)

"[$([DateTimeOffset]::Now.ToString("o"))] Starting KB-1 Local" |
  Out-File -LiteralPath $logPath -Append -Encoding utf8

Remove-Item `
  -LiteralPath ([string]$config.runtimeStatePath) `
  -Force `
  -ErrorAction SilentlyContinue

$nodeArguments = '"{0}"' -f ([string]$config.entrypoint).Replace('"', '\"')
$daemonProcess = $null
$daemonExitCode = $null
try {
  $daemonProcess = Start-Process `
    -FilePath ([string]$config.nodePath) `
    -ArgumentList $nodeArguments `
    -WorkingDirectory ([string]$config.repoDir) `
    -NoNewWindow `
    -PassThru `
    -RedirectStandardOutput ([string]$config.stdoutPath) `
    -RedirectStandardError ([string]$config.stderrPath)

  $runtimeState = [ordered]@{
    version = 1
    runnerPid = $PID
    daemonPid = $daemonProcess.Id
    daemonStartTimeFileTimeUtc = [string]$daemonProcess.StartTime.ToFileTimeUtc()
    instanceId = $env:KB1_INSTANCE_ID
    startedAt = [DateTimeOffset]::Now.ToString("o")
  }
  $runtimeState | ConvertTo-Json |
    Set-Content -LiteralPath ([string]$config.runtimeStatePath) -Encoding utf8

  $daemonProcess.WaitForExit()
  $daemonExitCode = $daemonProcess.ExitCode
} finally {
  if ($null -ne $daemonProcess -and -not $daemonProcess.HasExited) {
    $daemonProcess.Kill()
    if (-not $daemonProcess.WaitForExit(5000)) {
      throw "The detached KB-1 daemon did not exit after its runner failed."
    }
  }
  Remove-Item `
    -LiteralPath ([string]$config.runtimeStatePath) `
    -Force `
    -ErrorAction SilentlyContinue
}

"[$([DateTimeOffset]::Now.ToString("o"))] KB-1 Local exited with code $daemonExitCode" |
  Out-File -LiteralPath $logPath -Append -Encoding utf8

exit $daemonExitCode
