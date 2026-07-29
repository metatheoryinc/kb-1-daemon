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
$trustedWorkspaceRoot = Join-Path $systemDriveRoot "kb1-windows-smoke-$([Guid]::NewGuid().ToString('N'))"
$kb1Home = Join-Path $trustedWorkspaceRoot "home~archive"
$trustedToolsRoot = Join-Path $trustedWorkspaceRoot "tools"
$trustedNodePath = Join-Path $trustedToolsRoot "node.exe"
$trustedSourceRoot = Join-Path $trustedWorkspaceRoot "source"
$sourceNodeDirectory = Split-Path -Parent (
  (Get-Command node.exe -ErrorAction Stop).Source
)
$sourceGitPath = (Get-Command git.exe -ErrorAction Stop).Source
$sourceStatus = & $sourceGitPath `
  -C $repoRoot `
  status `
  --porcelain `
  --untracked-files=all
if ($LASTEXITCODE -ne 0) {
  throw "Could not inspect the Windows smoke source checkout."
}
if (-not [string]::IsNullOrWhiteSpace([string]$sourceStatus)) {
  throw "The Windows task smoke requires a clean source checkout."
}
$sourceCommit = (
  & $sourceGitPath -C $repoRoot rev-parse HEAD
).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "Could not resolve the Windows smoke source commit."
}
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

function Invoke-DirectRestMethod {
  param(
    [Parameter(Mandatory = $true)]
    [Uri]$Uri,
    [Parameter(Mandatory = $true)]
    [string]$NodePath,
    [Parameter(Mandatory = $true)]
    [string]$ErrorDirectory,
    [ValidateSet("Get", "Post")]
    [string]$Method = "Get",
    [hashtable]$Headers = @{},
    [ValidateRange(1, 300)]
    [int]$TimeoutSec = 30
  )

  $requestScript = @'
const [url, method, timeoutSeconds] = process.argv.slice(1);
const { default: http } = await import("node:http");
const { default: https } = await import("node:https");
const headers = JSON.parse(process.env.KB1_DIRECT_REQUEST_HEADERS || "{}");
const writeUtf8 = (value) => {
  process.stdout.write(Buffer.from(value, "utf8").toString("base64"));
};
try {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutSeconds}s`));
  }, Number(timeoutSeconds) * 1000);
  try {
    const response = await new Promise((resolve, reject) => {
      const request = transport.request(target, {
        method: method.toUpperCase(),
        headers,
        signal: controller.signal
      }, resolve);
      request.on("error", reject);
      request.end();
    });
    const chunks = [];
    for await (const chunk of response) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (
      response.statusCode === undefined ||
      response.statusCode < 200 ||
      response.statusCode >= 300
    ) {
      writeUtf8(
        `HTTP ${response.statusCode ?? "unknown"} ` +
        `${response.statusMessage ?? ""}: ${body.toString("utf8")}`
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(body.toString("base64"));
    }
  } finally {
    clearTimeout(deadline);
  }
} catch (error) {
  writeUtf8(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
'@
  $encodedRequestScript = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes($requestScript)
  )
  $bootstrapScript = "const[a,b]=process.argv.splice(1,2);await(import(a+b))"
  $previousHeaders = $env:KB1_DIRECT_REQUEST_HEADERS
  $previousNodeOptions = $env:NODE_OPTIONS
  $previousNodePath = $env:NODE_PATH
  $previousNodeProxy = $env:NODE_USE_ENV_PROXY
  $previousNodeDebug = $env:NODE_DEBUG
  $previousNodeDebugNative = $env:NODE_DEBUG_NATIVE
  $previousExtraCaCertificates = $env:NODE_EXTRA_CA_CERTS
  $stderrPath = Join-Path `
    $ErrorDirectory `
    "windows-request-$([Guid]::NewGuid().ToString('N')).stderr.log"
  $output = @()
  $exitCode = 1
  try {
    $env:KB1_DIRECT_REQUEST_HEADERS = ConvertTo-Json `
      -InputObject $Headers `
      -Compress
    $env:NODE_OPTIONS = $null
    $env:NODE_PATH = $null
    $env:NODE_USE_ENV_PROXY = $null
    $env:NODE_DEBUG = $null
    $env:NODE_DEBUG_NATIVE = $null
    $env:NODE_EXTRA_CA_CERTS = $null
    $output = @(
      & $NodePath `
        --input-type=module `
        -e $bootstrapScript `
        -- `
        "data:text/javascript;base64," `
        $encodedRequestScript `
        ([string]$Uri.AbsoluteUri) `
        $Method `
        ([string]$TimeoutSec) `
        2> $stderrPath
    )
    $exitCode = $LASTEXITCODE
  } finally {
    foreach ($environmentValue in @(
      @{ Name = "KB1_DIRECT_REQUEST_HEADERS"; Value = $previousHeaders },
      @{ Name = "NODE_OPTIONS"; Value = $previousNodeOptions },
      @{ Name = "NODE_PATH"; Value = $previousNodePath },
      @{ Name = "NODE_USE_ENV_PROXY"; Value = $previousNodeProxy },
      @{ Name = "NODE_DEBUG"; Value = $previousNodeDebug },
      @{ Name = "NODE_DEBUG_NATIVE"; Value = $previousNodeDebugNative },
      @{
        Name = "NODE_EXTRA_CA_CERTS"
        Value = $previousExtraCaCertificates
      }
    )) {
      if ($null -eq $environmentValue.Value) {
        Remove-Item `
          -LiteralPath "Env:$($environmentValue.Name)" `
          -ErrorAction SilentlyContinue
      } else {
        [Environment]::SetEnvironmentVariable(
          [string]$environmentValue.Name,
          [string]$environmentValue.Value
        )
      }
    }
    Remove-Item `
      -LiteralPath $stderrPath `
      -Force `
      -ErrorAction SilentlyContinue
  }

  $encodedBody = ($output -join "").Trim()
  $body = ""
  if (-not [string]::IsNullOrWhiteSpace($encodedBody)) {
    try {
      $body = [Text.Encoding]::UTF8.GetString(
        [Convert]::FromBase64String($encodedBody)
      )
    } catch {
      throw "Direct Node request returned invalid encoded output."
    }
  }
  if ($exitCode -ne 0) {
    if ([string]::IsNullOrWhiteSpace($body)) {
      throw "Direct Node request failed with exit code $exitCode."
    }
    throw $body
  }
  if ([string]::IsNullOrWhiteSpace($body)) {
    return $null
  }
  return $body | ConvertFrom-Json
}

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
  param(
    [string[]]$InstallerArguments,
    [string[]]$ExpectedOutputSubstrings = @()
  )

  if ($ExpectedOutputSubstrings.Count -eq 0) {
    & $powerShell `
      -NoProfile `
      -NonInteractive `
      -ExecutionPolicy Bypass `
      -File $installer `
      @InstallerArguments
    $installerExitCode = $LASTEXITCODE
  } else {
    $installerOutput = @(
      & $powerShell `
        -NoProfile `
        -NonInteractive `
        -ExecutionPolicy Bypass `
        -File $installer `
        @InstallerArguments 2>&1
    )
    $installerExitCode = $LASTEXITCODE
    foreach ($outputLine in $installerOutput) {
      Write-Host ([string]$outputLine)
    }
    $combinedInstallerOutput = $installerOutput | Out-String
    foreach ($expectedSubstring in $ExpectedOutputSubstrings) {
      if (-not $combinedInstallerOutput.Contains($expectedSubstring)) {
        throw "Expected installer failure output to contain: $expectedSubstring"
      }
    }
  }
  if ($installerExitCode -eq 0) {
    throw "Windows task installer unexpectedly succeeded."
  }
}

function Wait-UntilUnavailable {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    try {
      Invoke-DirectRestMethod `
        -Uri $healthUrl `
        -NodePath $trustedNodePath `
        -ErrorDirectory $taskStateDirectory `
        -TimeoutSec 1 |
        Out-Null
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
  "-RepoDir", $trustedSourceRoot,
  "-KB1Home", $kb1Home,
  "-BindHost", "[::1]",
  "-Port", [string]$port,
  "-TaskName", $taskName
)

try {
  New-Item -ItemType Directory -Path $trustedWorkspaceRoot | Out-Null
  Set-OwnerOnlyDirectoryAcl $trustedWorkspaceRoot
  New-Item -ItemType Directory -Path $trustedToolsRoot | Out-Null
  Set-OwnerOnlyDirectoryAcl $trustedToolsRoot
  Get-ChildItem -LiteralPath $sourceNodeDirectory -Force |
    Copy-Item -Destination $trustedToolsRoot -Recurse -Force
  $env:PATH = "$trustedToolsRoot;$originalPath"
  & $sourceGitPath `
    clone `
    --no-hardlinks `
    --no-checkout `
    $repoRoot `
    $trustedSourceRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Could not create the trusted Windows smoke source checkout."
  }
  & $sourceGitPath `
    -C $trustedSourceRoot `
    checkout `
    --detach `
    $sourceCommit
  if ($LASTEXITCODE -ne 0) {
    throw "Could not check out the Windows smoke source commit."
  }

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
      [IO.Path]::GetFullPath($trustedSourceRoot),
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

  $failingBuildPath = Join-Path `
    $trustedSourceRoot `
    "apps\daemon\src\windows-smoke-build-failure.ts"
  Set-Content `
    -LiteralPath $failingBuildPath `
    -Value "const windowsSmokeBuildFailure: string = 1; export {};"
  & $sourceGitPath `
    -C $trustedSourceRoot `
    add `
    -- `
    "apps/daemon/src/windows-smoke-build-failure.ts"
  if ($LASTEXITCODE -ne 0) {
    throw "Could not stage the intentional Windows smoke build failure."
  }
  & $sourceGitPath `
    -C $trustedSourceRoot `
    -c "user.name=KB-1 Windows Smoke" `
    -c "user.email=windows-smoke@kb-1.invalid" `
    commit `
    --no-gpg-sign `
    --no-verify `
    -m "test: force Windows smoke build failure"
  if ($LASTEXITCODE -ne 0) {
    throw "Could not commit the intentional Windows smoke build failure."
  }
  try {
    Invoke-InstallerExpectedFailure `
      -InstallerArguments (@(
        "-Action", "Install",
        "-SkipRepoUpdate",
        "-BuildOnly",
        "-HealthTimeoutSeconds", "5"
      ) + $commonArguments) `
      -ExpectedOutputSubstrings @(
        "==> Building KB-1 Local",
        "windows-smoke-build-failure.ts",
        "TS2322"
      )
  } finally {
    & $sourceGitPath `
      -C $trustedSourceRoot `
      reset `
      --hard `
      $sourceCommit
    if ($LASTEXITCODE -ne 0) {
      throw "Could not restore the Windows smoke source checkout."
    }
  }

  $healthyAfterBuildFailure = Invoke-DirectRestMethod `
    -Uri $healthUrl `
    -NodePath $trustedNodePath `
    -ErrorDirectory $taskStateDirectory `
    -TimeoutSec 5
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

  $restoredHealth = Invoke-DirectRestMethod `
    -Uri $healthUrl `
    -NodePath $trustedNodePath `
    -ErrorDirectory $taskStateDirectory `
    -TimeoutSec 5
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

  $health = Invoke-DirectRestMethod `
    -Uri $healthUrl `
    -NodePath $trustedNodePath `
    -ErrorDirectory $taskStateDirectory `
    -TimeoutSec 5
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
  Remove-Item `
    -LiteralPath $trustedWorkspaceRoot `
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
