#Requires -Version 5.1

[CmdletBinding()]
param(
  [ValidateSet("Install", "Uninstall", "Start", "Stop", "Status")]
  [string]$Action = "Install",

  [string]$RepoUrl = "https://github.com/metatheoryinc/kb-1-daemon.git",

  [string]$RepoDir = $(if ($env:KB1_REPO_DIR) {
    $env:KB1_REPO_DIR
  } else {
    ""
  }),

  [string]$KB1Home = $(if ($env:KB1_HOME) {
    $env:KB1_HOME
  } else {
    Join-Path $HOME ".kb1"
  }),

  [string]$BindHost = $(if ($env:KB1_HOST) {
    $env:KB1_HOST
  } else {
    "127.0.0.1"
  }),

  [ValidateRange(1, 65535)]
  [int]$Port = $(if ($env:KB1_PORT) {
    [int]$env:KB1_PORT
  } else {
    7382
  }),

  [string]$TaskName = $(if ($env:KB1_WINDOWS_TASK_NAME) {
    $env:KB1_WINDOWS_TASK_NAME
  } else {
    "KB-1 Local"
  }),

  [switch]$BuildOnly,
  [switch]$ConfirmNonLoopbackBind,
  [switch]$ForceStop,
  [switch]$SkipRepoUpdate,
  [switch]$SkipDependencyInstall,
  [switch]$SkipBuild,

  [ValidateRange(1, 300)]
  [int]$HealthTimeoutSeconds = 30
)

$script:ExplicitParameters = @{}
foreach ($parameterName in $PSBoundParameters.Keys) {
  $script:ExplicitParameters[$parameterName] = $true
}
foreach ($environmentOverride in @{
  RepoDir = "KB1_REPO_DIR"
  KB1Home = "KB1_HOME"
  BindHost = "KB1_HOST"
  Port = "KB1_PORT"
}.GetEnumerator()) {
  if (-not [string]::IsNullOrWhiteSpace(
    [Environment]::GetEnvironmentVariable($environmentOverride.Value)
  )) {
    $script:ExplicitParameters[$environmentOverride.Key] = $true
  }
}
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($RepoDir)) {
  if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    throw "Could not resolve the installer script directory."
  }
  $RepoDir = Join-Path $PSScriptRoot "..\..\.."
}
$RepoDir = [IO.Path]::GetFullPath($RepoDir)
$KB1Home = [IO.Path]::GetFullPath($KB1Home)
if ($BindHost.StartsWith("[") -and $BindHost.EndsWith("]")) {
  $BindHost = $BindHost.Substring(1, $BindHost.Length - 2)
}
$TaskPath = "\"

function Get-StableStorageKey {
  param([string]$Value)

  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $hash = $sha256.ComputeHash($bytes)
    return ([BitConverter]::ToString($hash).Replace("-", "").Substring(0, 16)).ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Get-TaskStorageKey {
  return Get-StableStorageKey ([string]$script:TaskName).ToUpperInvariant()
}

function Get-HomeStorageKey {
  $normalizedHome = [IO.Path]::GetFullPath($script:KB1Home).ToUpperInvariant()
  return Get-StableStorageKey $normalizedHome
}

function Get-TaskStateRoot {
  $localAppData = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::LocalApplicationData
  )
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw "Windows LocalAppData could not be resolved for the current user."
  }
  return Join-Path $localAppData "KB-1\tasks"
}

function Get-LifecycleUrlHost {
  param([string]$ListenHost)

  $probeHost = switch ($ListenHost) {
    "0.0.0.0" { "127.0.0.1" }
    "::" { "::1" }
    default { $ListenHost }
  }
  if ($probeHost.Contains(":") -and -not $probeHost.StartsWith("[")) {
    return "[$probeHost]"
  }
  return $probeHost
}

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

function Set-RuntimeUrls {
  $healthHost = Get-LifecycleUrlHost $script:BindHost
  $taskKey = Get-TaskStorageKey
  $script:TaskStateRoot = Get-TaskStateRoot
  $script:ConfigPath = Join-Path $script:TaskStateRoot "windows-task-$taskKey.json"
  $script:BaseUrl = "http://${healthHost}:$($script:Port)"
  $script:HealthUrl = "$($script:BaseUrl)/api/health"
}

Set-RuntimeUrls

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message"
}

function Resolve-CommandPath {
  param([string[]]$Names)

  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -ne $command) {
      return $command.Source
    }
  }
  return $null
}

function Invoke-External {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath exited with code $LASTEXITCODE."
  }
}

function Invoke-ExternalOutput {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )

  $output = & $FilePath @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath exited with code $LASTEXITCODE. $($output -join [Environment]::NewLine)"
  }
  return ([string]($output -join [Environment]::NewLine)).Trim()
}

function Invoke-ExternalOutputOrNull {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )

  $output = & $FilePath @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) {
    return $null
  }
  return ([string]($output -join [Environment]::NewLine)).Trim()
}

function Test-LoopbackHost {
  param([string]$Value)

  if ($Value -in @("localhost", "::1", "[::1]")) {
    return $true
  }

  $address = $null
  if ([Net.IPAddress]::TryParse($Value, [ref]$address)) {
    return [Net.IPAddress]::IsLoopback($address)
  }
  return $false
}

function Get-InstalledTask {
  return Get-ScheduledTask `
    -TaskName $TaskName `
    -TaskPath $script:TaskPath `
    -ErrorAction SilentlyContinue
}

function Find-TaskConfigPath {
  param($Task)

  if ($null -eq $Task) {
    return $null
  }
  foreach ($action in @($Task.Actions)) {
    $match = [regex]::Match(
      [string]$action.Arguments,
      '(?i)-ConfigPath\s+"([^"]+)"'
    )
    if ($match.Success) {
      return $match.Groups[1].Value
    }
  }
  return $null
}

function Find-TaskRunnerPath {
  param($Task)

  if ($null -eq $Task) {
    return $null
  }
  foreach ($action in @($Task.Actions)) {
    $match = [regex]::Match(
      [string]$action.Arguments,
      '(?i)-File\s+"([^"]+)"'
    )
    if ($match.Success) {
      return $match.Groups[1].Value
    }
  }
  return $null
}

function Test-CurrentUserTaskPrincipal {
  param($Task)

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $userId = ([string]$Task.Principal.UserId).Trim()
  if (
    [string]::Equals(
      $userId,
      [string]$identity.User.Value,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    [string]::Equals(
      $userId,
      [string]$identity.Name,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    return $true
  }

  try {
    $principalSid = (
      [Security.Principal.NTAccount]::new($userId)
    ).Translate(
      [Security.Principal.SecurityIdentifier]
    )
    return [string]::Equals(
      [string]$principalSid.Value,
      [string]$identity.User.Value,
      [StringComparison]::OrdinalIgnoreCase
    )
  } catch {
    return $false
  }
}

function Test-KB1RunnerAction {
  param(
    $Task,
    [string]$ConfigPath
  )

  $runnerSuffix = "\skills\kb-1-daemon-setup\scripts\run_kb1_daemon_user_task.ps1"
  foreach ($action in @($Task.Actions)) {
    if ([IO.Path]::GetFileName([string]$action.Execute) -ine "powershell.exe") {
      continue
    }
    $runnerPath = Find-TaskRunnerPath ([pscustomobject]@{ Actions = @($action) })
    if (
      -not [string]::IsNullOrWhiteSpace([string]$runnerPath) -and
      [string]$runnerPath.Replace("/", "\").EndsWith(
        $runnerSuffix,
        [StringComparison]::OrdinalIgnoreCase
      ) -and
      [string]::Equals(
        (Find-TaskConfigPath ([pscustomobject]@{ Actions = @($action) })),
        $ConfigPath,
        [StringComparison]::OrdinalIgnoreCase
      )
    ) {
      return $true
    }
  }
  return $false
}

function Test-TrustedLocalConfigPath {
  param(
    [string]$Path,
    [string]$RequiredParent
  )

  if (
    [string]::IsNullOrWhiteSpace($Path) -or
    $Path.StartsWith("\\") -or
    $Path -notmatch '^[A-Za-z]:[\\/]'
  ) {
    return $false
  }
  try {
    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not [string]::IsNullOrWhiteSpace($RequiredParent)) {
      $parentPrefix = [IO.Path]::GetFullPath($RequiredParent).TrimEnd("\") + "\"
      if (-not $fullPath.StartsWith(
        $parentPrefix,
        [StringComparison]::OrdinalIgnoreCase
      )) {
        return $false
      }
    }
    return $true
  } catch {
    return $false
  }
}

function Assert-OwnedTask {
  param($Task)

  if (
    [string]$Task.TaskPath -ne $script:TaskPath -or
    -not (Test-CurrentUserTaskPrincipal $Task)
  ) {
    throw "Refusing to modify Scheduled Task '$TaskName': its principal is not owned by KB-1."
  }

  $configPath = Find-TaskConfigPath $Task
  if (
    -not (Test-TrustedLocalConfigPath $configPath $null) -or
    -not (Test-KB1RunnerAction $Task $configPath) -or
    -not (Test-Path -LiteralPath $configPath -PathType Leaf)
  ) {
    throw "Refusing to modify Scheduled Task '$TaskName': it is not an owned KB-1 task."
  }

  Assert-NoUntrustedWriteAccess -Paths @(
    $configPath,
    (Split-Path -Parent $configPath)
  )

  try {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  } catch {
    throw "Refusing to modify Scheduled Task '$TaskName': its KB-1 configuration is invalid."
  }

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $ownedConfigDirectory = Get-TaskStateRoot
  if (
    [string]$config.kind -ne "kb1-windows-user-task" -or
    [string]$config.taskName -ne $TaskName -or
    [string]$config.ownerSid -ne [string]$identity.User.Value -or
    -not (Test-EquivalentPath ([string]$config.taskStateRoot) $ownedConfigDirectory) -or
    -not (Test-TrustedLocalConfigPath $configPath $ownedConfigDirectory)
  ) {
    throw "Refusing to modify Scheduled Task '$TaskName': its ownership signature does not match."
  }

  return $configPath
}

function Use-InstalledTaskConfig {
  $task = Get-InstalledTask
  if ($null -eq $task) {
    return
  }
  $installedConfigPath = Assert-OwnedTask $task

  $installedConfig = Get-Content -LiteralPath $installedConfigPath -Raw |
    ConvertFrom-Json
  $script:RepoDir = [IO.Path]::GetFullPath([string]$installedConfig.repoDir)
  $script:KB1Home = [IO.Path]::GetFullPath([string]$installedConfig.kb1Home)
  $script:BindHost = [string]$installedConfig.bindHost
  $script:Port = [int]$installedConfig.port
  Set-RuntimeUrls
  $script:ConfigPath = $installedConfigPath
}

function Use-InstalledTaskUpgradeDefaults {
  $task = Get-InstalledTask
  if ($null -eq $task) {
    return
  }
  $installedConfigPath = Assert-OwnedTask $task
  $installedConfig = Get-Content -LiteralPath $installedConfigPath -Raw |
    ConvertFrom-Json

  if (-not $script:ExplicitParameters.ContainsKey("RepoUrl")) {
    $installedRepoUrl = [string]$installedConfig.sourceRepoUrl
    if (-not [string]::IsNullOrWhiteSpace($installedRepoUrl)) {
      $script:RepoUrl = $installedRepoUrl
    }
  }
  if (-not $script:ExplicitParameters.ContainsKey("RepoDir")) {
    $installedSourceRepoDir = [string]$installedConfig.sourceRepoDir
    if (-not [string]::IsNullOrWhiteSpace($installedSourceRepoDir)) {
      $script:RepoDir = [IO.Path]::GetFullPath($installedSourceRepoDir)
    }
  }
  if (-not $script:ExplicitParameters.ContainsKey("KB1Home")) {
    $script:KB1Home = [IO.Path]::GetFullPath(
      [string]$installedConfig.kb1Home
    )
  }
  if (-not $script:ExplicitParameters.ContainsKey("BindHost")) {
    $script:BindHost = [string]$installedConfig.bindHost
  }
  if (-not $script:ExplicitParameters.ContainsKey("Port")) {
    $script:Port = [int]$installedConfig.port
  }
  Set-RuntimeUrls
  $script:ConfigPath = $installedConfigPath
}

function Wait-TaskStopped {
  param([switch]$RequireSuccessfulExit)

  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  do {
    $task = Get-InstalledTask
    if ($null -eq $task) {
      if ($RequireSuccessfulExit) {
        throw "Scheduled Task '$TaskName' disappeared while waiting for a verified graceful shutdown."
      }
      return
    }
    if ($task.State -in @("Ready", "Disabled")) {
      if ($RequireSuccessfulExit) {
        $taskInfo = Get-ScheduledTaskInfo `
          -TaskName $TaskName `
          -TaskPath $script:TaskPath
        if ([long]$taskInfo.LastTaskResult -ne 0) {
          throw @"
Scheduled Task '$TaskName' exited with code $($taskInfo.LastTaskResult) instead
of completing a verified graceful shutdown. The task may be scheduled to
restart. Repair the shutdown failure, or retry with -ForceStop only when you
accept that the latest in-memory edits may be lost.
"@
        }
      }
      return
    }
    if ($task.State -eq "Unknown") {
      throw "Scheduled Task '$TaskName' entered an unknown state while stopping."
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "Scheduled Task '$TaskName' did not stop within 45 seconds."
}

function Get-SupervisedDaemonIdentity {
  param([string]$TaskConfigPath)

  $taskConfig = Get-Content -LiteralPath $TaskConfigPath -Raw |
    ConvertFrom-Json
  $runtimeStatePath = [string]$taskConfig.runtimeStatePath
  if (
    [string]::IsNullOrWhiteSpace($runtimeStatePath) -or
    -not (Test-Path -LiteralPath $runtimeStatePath -PathType Leaf)
  ) {
    return $null
  }
  Assert-NoUntrustedWriteAccess -Paths @(
    $runtimeStatePath,
    (Split-Path -Parent $runtimeStatePath)
  )
  $runtimeState = Get-Content -LiteralPath $runtimeStatePath -Raw |
    ConvertFrom-Json
  if (
    [int]$runtimeState.daemonPid -le 0 -or
    [string]::IsNullOrWhiteSpace(
      [string]$runtimeState.daemonStartTimeFileTimeUtc
    )
  ) {
    throw "The supervised daemon runtime state is incomplete."
  }
  return [pscustomobject]@{
    daemonPid = [int]$runtimeState.daemonPid
    daemonStartTimeFileTimeUtc = [long](
      [string]$runtimeState.daemonStartTimeFileTimeUtc
    )
    nodePath = [string]$taskConfig.nodePath
    runtimeStatePath = $runtimeStatePath
  }
}

function Get-MatchingSupervisedDaemonProcess {
  param($Identity)

  $daemonProcess = Get-Process `
    -Id ([int]$Identity.daemonPid) `
    -ErrorAction SilentlyContinue
  if ($null -eq $daemonProcess) {
    return $null
  }
  try {
    if (
      -not (Test-EquivalentPath $daemonProcess.Path ([string]$Identity.nodePath)) -or
      [long]$daemonProcess.StartTime.ToFileTimeUtc() -ne
        [long]$Identity.daemonStartTimeFileTimeUtc
    ) {
      return $null
    }
  } catch {
    return $null
  }
  return $daemonProcess
}

function Stop-SupervisedDaemonProcessTree {
  param($Identity)

  $daemonProcess = Get-MatchingSupervisedDaemonProcess $Identity
  if ($null -eq $daemonProcess) {
    Remove-Item `
      -LiteralPath ([string]$Identity.runtimeStatePath) `
      -Force `
      -ErrorAction SilentlyContinue
    return
  }

  $taskKillPath = Join-Path $env:SystemRoot "System32\taskkill.exe"
  if (-not (Test-Path -LiteralPath $taskKillPath -PathType Leaf)) {
    throw "Windows taskkill.exe is required for verified process-tree shutdown."
  }
  Assert-NoUntrustedWriteAccess -Paths @(
    $taskKillPath,
    (Split-Path -Parent $taskKillPath)
  )

  & $taskKillPath /PID ([string]$daemonProcess.Id) /T /F | Out-Null
  $taskKillExitCode = $LASTEXITCODE
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    if ($null -eq (Get-MatchingSupervisedDaemonProcess $Identity)) {
      Remove-Item `
        -LiteralPath ([string]$Identity.runtimeStatePath) `
        -Force `
        -ErrorAction SilentlyContinue
      return
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "taskkill.exe exited with code $taskKillExitCode, and the supervised daemon process tree is still running."
}

function Stop-KB1TaskHard {
  param(
    [string]$TaskConfigPath,
    [switch]$StopTaskAction
  )

  $identity = Get-SupervisedDaemonIdentity $TaskConfigPath
  if ($StopTaskAction) {
    Stop-ScheduledTask -TaskName $TaskName -TaskPath $script:TaskPath
    Wait-TaskStopped
    if ($null -eq $identity) {
      return
    }
  } elseif ($null -eq $identity) {
    throw "Cannot hard-stop the daemon safely because its runtime identity is unavailable."
  }
  Stop-SupervisedDaemonProcessTree $identity
}

function Stop-KB1Task {
  $task = Get-InstalledTask
  if ($null -eq $task) {
    throw "Scheduled Task '$TaskName' is not installed."
  }
  if ($task.State -eq "Unknown") {
    throw "Refusing to report a successful stop because Scheduled Task '$TaskName' has an unknown state."
  }
  $installedConfigPath = Assert-OwnedTask $task
  if ($task.State -eq "Queued") {
    Stop-ScheduledTask -TaskName $TaskName -TaskPath $script:TaskPath
    Wait-TaskStopped
  }
  if ($task.State -eq "Running") {
    try {
      $null = Assert-HealthyTask `
        -TimeoutSeconds 3 `
        -TaskConfigPath $installedConfigPath
      $taskConfig = Get-Content -LiteralPath $installedConfigPath -Raw |
        ConvertFrom-Json
      $urlHost = Get-LifecycleUrlHost ([string]$taskConfig.bindHost)
      $shutdown = Invoke-DirectRestMethod `
        -Uri "http://${urlHost}:$($taskConfig.port)/api/control/shutdown" `
        -NodePath ([string]$taskConfig.nodePath) `
        -ErrorDirectory ([string]$taskConfig.taskStateRoot) `
        -Method Post `
        -Headers @{ "x-kb1-control-token" = [string]$taskConfig.controlToken } `
        -TimeoutSec 3
      if ($shutdown.ok -ne $true -or $shutdown.shuttingDown -ne $true) {
        throw "The daemon did not accept the graceful shutdown request."
      }
      Wait-TaskStopped -RequireSuccessfulExit
    } catch {
      if (-not $ForceStop) {
        throw @"
Could not verify and gracefully stop '$TaskName': $($_.Exception.Message)

Repair local task health, then retry. Use -ForceStop only when you accept that
the latest in-memory edits may be lost.
"@
      }
      Write-Warning "Hard-stopping without verified graceful shutdown because -ForceStop was supplied."
      Stop-KB1TaskHard `
        -TaskConfigPath $installedConfigPath `
        -StopTaskAction
    }
    return
  }

  $identity = Get-SupervisedDaemonIdentity $installedConfigPath
  if ($null -ne $identity) {
    if ($null -eq (Get-MatchingSupervisedDaemonProcess $identity)) {
      Remove-Item `
        -LiteralPath ([string]$identity.runtimeStatePath) `
        -Force `
        -ErrorAction SilentlyContinue
      return
    }
    if (-not $ForceStop) {
      throw @"
Scheduled Task '$TaskName' is stopped, but its supervised daemon process may
still be running. Rerun with -ForceStop to terminate the verified process tree.
"@
    }
    Write-Warning "Terminating a verified orphan daemon process tree because -ForceStop was supplied."
    Stop-KB1TaskHard -TaskConfigPath $installedConfigPath
  }
}

function Test-EquivalentPath {
  param(
    [string]$Left,
    [string]$Right
  )

  $leftFull = [IO.Path]::GetFullPath($Left).TrimEnd("\")
  $rightFull = [IO.Path]::GetFullPath($Right).TrimEnd("\")
  return [string]::Equals(
    $leftFull,
    $rightFull,
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

function Assert-ContainedRuntimeReparseTargets {
  param(
    [string]$RuntimeDirectory,
    [string]$TrustedRoot
  )

  if (-not (Test-PathAtOrWithin $RuntimeDirectory $TrustedRoot)) {
    throw "The scheduled runtime is outside the protected per-user runtime root."
  }
  foreach ($item in @(
    Get-ChildItem -LiteralPath $RuntimeDirectory -Recurse -Force
  )) {
    if (
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0
    ) {
      continue
    }
    $targets = @($item.Target)
    if ($targets.Count -eq 0) {
      throw "Could not resolve runtime reparse-point target: $($item.FullName)"
    }
    foreach ($target in $targets) {
      if ([string]::IsNullOrWhiteSpace([string]$target)) {
        throw "Could not resolve runtime reparse-point target: $($item.FullName)"
      }
      $targetPath = if ([IO.Path]::IsPathRooted([string]$target)) {
        [IO.Path]::GetFullPath([string]$target)
      } else {
        [IO.Path]::GetFullPath(
          (Join-Path (Split-Path -Parent $item.FullName) ([string]$target))
        )
      }
      if (-not (Test-PathAtOrWithin $targetPath $TrustedRoot)) {
        throw @"
Refusing to schedule code through a reparse point outside the protected runtime:
$($item.FullName) -> $targetPath
"@
      }
    }
  }
}

function Assert-HealthyTask {
  param(
    [int]$TimeoutSeconds = 30,
    [string]$TaskConfigPath = $script:ConfigPath
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastError = $null
  $taskConfig = Get-Content -LiteralPath $TaskConfigPath -Raw |
    ConvertFrom-Json
  $urlHost = Get-LifecycleUrlHost ([string]$taskConfig.bindHost)
  $healthUrl = "http://${urlHost}:$($taskConfig.port)/api/health"
  do {
    try {
      $task = Get-InstalledTask
      if ($null -eq $task -or $task.State -ne "Running") {
        throw "Scheduled Task '$TaskName' is not running."
      }

      $health = Invoke-DirectRestMethod `
        -Uri $healthUrl `
        -NodePath ([string]$taskConfig.nodePath) `
        -ErrorDirectory ([string]$taskConfig.taskStateRoot) `
        -TimeoutSec 2
      $expectedStatusFile = Join-Path ([string]$taskConfig.kb1Home) "daemon\status.json"
      $runtimeState = Get-Content `
        -LiteralPath ([string]$taskConfig.runtimeStatePath) `
        -Raw |
        ConvertFrom-Json
      if (
        $health.ok -ne $true -or
        $health.service -ne "kb1d" -or
        $health.status.serviceName -ne "kb1d" -or
        -not (Test-EquivalentPath ([string]$health.status.kb1Home) ([string]$taskConfig.kb1Home)) -or
        -not (Test-EquivalentPath ([string]$health.status.statusFile) $expectedStatusFile) -or
        ([int]$health.status.pid) -ne ([int]$runtimeState.daemonPid) -or
        ([string]$health.status.instanceId) -ne ([string]$runtimeState.instanceId)
      ) {
        throw "The health endpoint does not match the installed KB-1 task."
      }

      $daemonProcess = Get-Process -Id ([int]$health.status.pid) -ErrorAction Stop
      if (
        -not (Test-EquivalentPath $daemonProcess.Path ([string]$taskConfig.nodePath)) -or
        [long]($daemonProcess.StartTime.ToFileTimeUtc()) -ne
          [long]([string]$runtimeState.daemonStartTimeFileTimeUtc)
      ) {
        throw "The healthy daemon PID is not the Node executable configured for the task."
      }
      return $health
    } catch {
      $lastError = $_.Exception.Message
      Start-Sleep -Seconds 1
    }
  } while ([DateTime]::UtcNow -lt $deadline)

  $logPath = [string]$taskConfig.logPath
  if (Test-Path -LiteralPath $logPath) {
    Write-Host ""
    Write-Host "Recent task log:"
    Get-Content -LiteralPath $logPath -Tail 80
  }
  foreach ($outputPath in @(
    [string]$taskConfig.stdoutPath,
    [string]$taskConfig.stderrPath
  )) {
    if (Test-Path -LiteralPath $outputPath) {
      Write-Host ""
      Write-Host "Recent output from ${outputPath}:"
      Get-Content -LiteralPath $outputPath -Tail 80
    }
  }
  throw "KB-1 task did not become healthy at $healthUrl. Last error: $lastError"
}

function Show-KB1Status {
  $task = Get-InstalledTask
  if ($null -eq $task) {
    throw "Scheduled Task '$TaskName' is not installed."
  }

  Write-Host "Task:   $TaskName"
  Write-Host "State:  $($task.State)"
  Write-Host "Health: $script:HealthUrl"
  Write-Host "Home:   $KB1Home"
  if ($task.State -ne "Running") {
    return
  }
  $health = Assert-HealthyTask -TimeoutSeconds 2
  Write-Host "PID:    $($health.status.pid)"
}

function Assert-NoOtherTaskUsesHome {
  $expectedConfigDirectory = Get-TaskStateRoot
  $currentOwnerSid = (
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).User.Value
  foreach ($candidate in @(Get-ScheduledTask -ErrorAction SilentlyContinue)) {
    if (
      [string]$candidate.TaskName -eq $TaskName -and
      [string]$candidate.TaskPath -eq $script:TaskPath
    ) {
      continue
    }
    if (
      -not (Test-CurrentUserTaskPrincipal $candidate)
    ) {
      continue
    }
    $candidateConfigPath = Find-TaskConfigPath $candidate
    if (
      -not (Test-TrustedLocalConfigPath $candidateConfigPath $expectedConfigDirectory) -or
      -not (Test-KB1RunnerAction $candidate $candidateConfigPath) -or
      -not (Test-Path -LiteralPath $candidateConfigPath -PathType Leaf)
    ) {
      continue
    }
    Assert-NoUntrustedWriteAccess -Paths @(
      $candidateConfigPath,
      (Split-Path -Parent $candidateConfigPath)
    )
    try {
      $candidateConfig = Get-Content -LiteralPath $candidateConfigPath -Raw |
        ConvertFrom-Json
    } catch {
      throw @"
Refusing to install because current-user Scheduled Task
'$($candidate.TaskName)' uses the KB-1 runner, but its configuration is
unreadable. Repair or remove that task before installing another KB-1 task.
"@
    }
    if (
      [string]$candidateConfig.kind -ne "kb1-windows-user-task" -or
      [string]$candidateConfig.taskName -ne [string]$candidate.TaskName -or
      [string]$candidateConfig.ownerSid -ne [string]$currentOwnerSid -or
      [string]::IsNullOrWhiteSpace([string]$candidateConfig.kb1Home) -or
      -not (
        Test-EquivalentPath `
          ([string]$candidateConfig.taskStateRoot) `
          $expectedConfigDirectory
      )
    ) {
      throw @"
Refusing to install because current-user Scheduled Task
'$($candidate.TaskName)' uses the KB-1 runner, but its ownership configuration
is invalid. Repair or remove that task before installing another KB-1 task.
"@
    }
    if (Test-EquivalentPath ([string]$candidateConfig.kb1Home) $KB1Home) {
      throw "Scheduled Task '$($candidate.TaskName)' already manages KB1_HOME=$KB1Home."
    }
  }
}

function Enter-TaskOperationLock {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $ownerKey = ([string]$identity.User.Value).Replace("-", "")
  $mutexName = "Global\KB1DaemonTask-$ownerKey-$(Get-TaskStorageKey)"
  $mutex = New-OwnerOnlyGlobalMutex $mutexName
  $acquired = $false
  try {
    try {
      $acquired = $mutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
      $acquired = $true
    }
    if (-not $acquired) {
      throw "Another lifecycle operation is already running for Scheduled Task '$TaskName'."
    }
    return $mutex
  } catch {
    $mutex.Dispose()
    throw
  }
}

function Enter-HomeOperationLock {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $ownerKey = ([string]$identity.User.Value).Replace("-", "")
  $mutexName = "Global\KB1DaemonHome-$ownerKey-$(Get-HomeStorageKey)"
  $mutex = New-OwnerOnlyGlobalMutex $mutexName
  $acquired = $false
  try {
    try {
      $acquired = $mutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
      $acquired = $true
    }
    if (-not $acquired) {
      throw "Another lifecycle operation is already running for KB1_HOME=$KB1Home."
    }
    return $mutex
  } catch {
    $mutex.Dispose()
    throw
  }
}

function Set-OwnerOnlyAcl {
  param(
    [string]$Path,
    [switch]$Directory
  )

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($accessRule in @($acl.Access)) {
    $null = $acl.RemoveAccessRuleSpecific($accessRule)
  }
  $acl.SetOwner($identity.User)
  if ($Directory) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $identity.User,
      [Security.AccessControl.FileSystemRights]::FullControl,
      (
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
      ),
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
  } else {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $identity.User,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.AccessControlType]::Allow
    )
  }
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $acl
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
  try {
    $mutex = [Threading.Mutex]::new(
      $false,
      $Name,
      [ref]$createdNew,
      $security
    )
  } catch {
    throw "Could not create or open the cross-session lifecycle mutex '$Name'."
  }

  if (-not $createdNew) {
    try {
      $existingSecurity = $mutex.GetAccessControl()
      $ownerSid = $existingSecurity.GetOwner(
        [Security.Principal.SecurityIdentifier]
      ).Value
      if ($ownerSid -ne [string]$identity.User.Value) {
        throw "The lifecycle mutex is owned by another principal."
      }
      foreach ($rule in @(
        $existingSecurity.GetAccessRules(
          $true,
          $true,
          [Security.Principal.SecurityIdentifier]
        )
      )) {
        if (
          $rule.AccessControlType -eq
            [Security.AccessControl.AccessControlType]::Allow -and
          [string]$rule.IdentityReference.Value -ne
            [string]$identity.User.Value
        ) {
          throw "The lifecycle mutex grants access to another principal."
        }
      }
    } catch {
      $mutex.Dispose()
      throw "Refusing to use an untrusted cross-session lifecycle mutex '$Name'."
    }
  }
  return $mutex
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
    Assert-NoReparsePoints -Paths @($path)
    $acl = Get-Acl -LiteralPath $path
    try {
      $ownerSid = $acl.GetOwner(
        [Security.Principal.SecurityIdentifier]
      ).Value
    } catch {
      throw "Could not validate filesystem ownership for $path."
    }
    if ($ownerSid -notin $trustedWriteSids) {
      throw @"
Refusing to register the task because an untrusted local principal owns:
$path

Move the checkout and KB1_HOME into a private directory owned by the current
user, then retry.
"@
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
      try {
        $ruleSid = $accessRule.IdentityReference.Translate(
          [Security.Principal.SecurityIdentifier]
        ).Value
      } catch {
        throw "Could not validate filesystem permissions for $path."
      }
      if ($ruleSid -notin $trustedWriteSids) {
        throw @"
Refusing to register the task because another local principal can modify:
$path

Move the checkout and KB1_HOME into a private directory owned by the current
user, then retry.
"@
      }
    }
  }
}

function Assert-NoReparsePoints {
  param([string[]]$Paths)

  foreach ($path in $Paths) {
    $item = Get-Item -LiteralPath $path -Force
    if (
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    ) {
      throw "Refusing to trust reparse-point path: $path"
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
    Assert-NoReparsePoints -Paths @($path)
    $acl = Get-Acl -LiteralPath $path
    try {
      $ownerSid = $acl.GetOwner(
        [Security.Principal.SecurityIdentifier]
      ).Value
    } catch {
      throw "Could not validate filesystem ownership for $path."
    }
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
      try {
        $ruleSid = $accessRule.IdentityReference.Translate(
          [Security.Principal.SecurityIdentifier]
        ).Value
      } catch {
        throw "Could not validate filesystem permissions for $path."
      }
      if ($ruleSid -notin $trustedWriteSids) {
        throw "Refusing to trust KB1_HOME beneath a replaceable directory: $path"
      }
    }
  }
}

function Initialize-TrustedKB1Home {
  param(
    [string]$Path,
    [switch]$Create
  )

  $chain = @(Get-LocalDirectoryChain $Path)
  for ($index = 0; $index -lt $chain.Count; $index++) {
    $candidate = [string]$chain[$index]
    if (-not (Test-Path -LiteralPath $candidate)) {
      if (-not $Create) {
        throw "KB1_HOME does not exist: $Path"
      }
      New-Item -ItemType Directory -Path $candidate | Out-Null
      Set-OwnerOnlyAcl -Path $candidate -Directory
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
      throw "KB1_HOME path component is not a directory: $candidate"
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

  return [IO.Path]::GetFullPath(
    (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  )
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

function Assert-ExecutableTrust {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required executable is missing: $Path"
  }
  Assert-TrustedPathChain -Path $Path
}

function Assert-GitCheckoutTrust {
  param([string]$Checkout)

  $gitDirectory = Join-Path $Checkout ".git"
  if (-not (Test-Path -LiteralPath $gitDirectory -PathType Container)) {
    throw "$Checkout must be a standalone Git checkout with a .git directory."
  }
  Assert-TrustedPathChain -Path $Checkout -Directory
  $paths = @(
    $gitDirectory
  )
  foreach ($gitControlPath in @(
    (Join-Path $gitDirectory "config"),
    (Join-Path $gitDirectory "HEAD"),
    (Join-Path $gitDirectory "index"),
    (Join-Path $gitDirectory "hooks")
  )) {
    if (Test-Path -LiteralPath $gitControlPath) {
      $paths += $gitControlPath
    }
  }
  Assert-NoUntrustedWriteAccess -Paths @($paths | Select-Object -Unique)
}

function Remove-InactiveWindowsRuntimes {
  param(
    [string]$RuntimeRoot,
    [string]$ActiveRuntime,
    [switch]$WarnOnly
  )

  if (-not (Test-Path -LiteralPath $RuntimeRoot -PathType Container)) {
    return
  }
  foreach ($candidate in @(Get-ChildItem -LiteralPath $RuntimeRoot -Directory)) {
    $runtimeId = [Guid]::Empty
    if (-not [Guid]::TryParseExact($candidate.Name, "N", [ref]$runtimeId)) {
      continue
    }
    if (
      -not [string]::IsNullOrWhiteSpace($ActiveRuntime) -and
      (Test-EquivalentPath $candidate.FullName $ActiveRuntime)
    ) {
      continue
    }
    try {
      Remove-Item -LiteralPath $candidate.FullName -Recurse -Force
    } catch {
      $message = "Could not remove inactive Windows runtime '$($candidate.FullName)': $($_.Exception.Message)"
      if ($WarnOnly) {
        Write-Warning $message
      } else {
        throw $message
      }
    }
  }
}

function Install-KB1Task {
  if (-not (Test-LoopbackHost $BindHost) -and -not $ConfirmNonLoopbackBind) {
    throw @"
Refusing to bind KB-1 to non-loopback host: $BindHost

KB-1 Local has no application authentication. Keep the daemon on 127.0.0.1.
If you intentionally accept direct network exposure, rerun with
-ConfirmNonLoopbackBind.
"@
  }

  $gitPath = Resolve-CommandPath @("git.exe", "git")
  $nodePath = Resolve-CommandPath @("node.exe", "node")
  if ($null -eq $gitPath) {
    throw "Missing Git. Install Git for Windows before installing KB-1 Local."
  }
  if ($null -eq $nodePath) {
    throw "Missing Node.js. Install a supported Node release (20.19.x, 22.12+, or 24+)."
  }
  Assert-ExecutableTrust $gitPath
  Assert-ExecutableTrust $nodePath

  $taskStateDirectory = Get-TaskStateRoot
  $appStateDirectory = Split-Path -Parent $taskStateDirectory
  $localAppData = Split-Path -Parent $appStateDirectory
  Assert-NoReparsePoints -Paths @($localAppData)
  Assert-NoUntrustedWriteAccess -Paths @($localAppData)
  if (Test-Path -LiteralPath $appStateDirectory) {
    Assert-NoUntrustedWriteAccess -Paths @($appStateDirectory)
  } else {
    New-Item -ItemType Directory -Path $appStateDirectory | Out-Null
  }
  Set-OwnerOnlyAcl -Path $appStateDirectory -Directory
  if (Test-Path -LiteralPath $taskStateDirectory) {
    Assert-NoUntrustedWriteAccess -Paths @($taskStateDirectory)
  } else {
    New-Item -ItemType Directory -Path $taskStateDirectory | Out-Null
  }
  Set-OwnerOnlyAcl -Path $taskStateDirectory -Directory
  Assert-NoUntrustedWriteAccess -Paths @(
    $appStateDirectory,
    $taskStateDirectory
  )
  $runtimeRoot = Join-Path `
    $taskStateDirectory `
    "windows-runtimes\$(Get-TaskStorageKey)"

  $existingTask = Get-InstalledTask
  $existingConfigPath = $null
  $existingTaskConfig = $null
  if ($null -ne $existingTask) {
    $existingConfigPath = Assert-OwnedTask $existingTask
    $existingTaskConfig = Get-Content -LiteralPath $existingConfigPath -Raw |
      ConvertFrom-Json
  }
  Assert-NoOtherTaskUsesHome
  Remove-InactiveWindowsRuntimes `
    -RuntimeRoot $runtimeRoot `
    -ActiveRuntime ([string]$existingTaskConfig.repoDir)

  $requestedRepoDir = $RepoDir
  $stagedRuntimeDir = $null
  $usingStagedRuntime = $false
  $wouldMutateRuntime = (
    -not $SkipRepoUpdate -or
    -not $SkipDependencyInstall -or
    -not $SkipBuild
  )
  if (-not $wouldMutateRuntime -and $null -eq $existingTaskConfig) {
    throw @"
The three skip switches can reuse an existing protected KB-1 runtime, but they
cannot register a first task directly from an arbitrary checkout.

Rerun without -SkipDependencyInstall and -SkipBuild so the installer can create
an isolated per-user runtime.
"@
  }
  if ($wouldMutateRuntime) {
    $stagedRuntimeDir = Join-Path $runtimeRoot ([Guid]::NewGuid().ToString("N"))
    $usingStagedRuntime = $true
  } else {
    $RepoDir = [IO.Path]::GetFullPath([string]$existingTaskConfig.repoDir)
    if (-not (Test-PathAtOrWithin $RepoDir $runtimeRoot)) {
      throw @"
The existing Scheduled Task predates protected runtime staging and cannot be
reused with all three skip switches.

Rerun a normal Install to replace it with an isolated per-user runtime.
"@
    }
  }

  try {
    if ($usingStagedRuntime) {
      $repoParent = Split-Path -Parent $requestedRepoDir
      New-Item -ItemType Directory -Path $repoParent -Force | Out-Null
      Assert-NoUntrustedWriteAccess -Paths @($repoParent)
      if (-not (Test-Path -LiteralPath $requestedRepoDir)) {
        Write-Step "Cloning source checkout at $requestedRepoDir"
        Invoke-External $gitPath @("clone", $RepoUrl, $requestedRepoDir)
      } elseif (
        -not (Test-Path -LiteralPath (Join-Path $requestedRepoDir ".git") -PathType Container)
      ) {
        throw "$requestedRepoDir exists but is not a standalone Git repository."
      }
      Assert-GitCheckoutTrust $requestedRepoDir

      Write-Step "Preparing isolated replacement runtime at $stagedRuntimeDir"
      New-Item `
        -ItemType Directory `
        -Path (Split-Path -Parent $stagedRuntimeDir) `
        -Force |
        Out-Null
      Set-OwnerOnlyAcl -Path $runtimeRoot -Directory

      $dirtyCheckout = Invoke-ExternalOutput `
        -FilePath $gitPath `
        -Arguments @(
          "-C",
          $requestedRepoDir,
          "status",
          "--porcelain",
          "--untracked-files=all"
        )
      if (-not [string]::IsNullOrWhiteSpace($dirtyCheckout)) {
        throw @"
Refusing to stage a replacement from a dirty checkout at $requestedRepoDir.

Commit or stash the local changes, or rerun with all three skip switches only
when intentionally reusing an already-built runtime.
"@
      }

      $selectedCommit = Invoke-ExternalOutput `
        -FilePath $gitPath `
        -Arguments @("-C", $requestedRepoDir, "rev-parse", "HEAD")
      if (-not $SkipRepoUpdate) {
        Invoke-External $gitPath @("-C", $requestedRepoDir, "fetch", "--prune")
        $currentBranch = Invoke-ExternalOutput `
          -FilePath $gitPath `
          -Arguments @("-C", $requestedRepoDir, "branch", "--show-current")
        $upstream = Invoke-ExternalOutputOrNull `
          -FilePath $gitPath `
          -Arguments @(
            "-C",
            $requestedRepoDir,
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}"
          )
        if (
          -not [string]::IsNullOrWhiteSpace($currentBranch) -and
          -not [string]::IsNullOrWhiteSpace($upstream)
        ) {
          $aheadBehind = Invoke-ExternalOutput `
            -FilePath $gitPath `
            -Arguments @(
              "-C",
              $requestedRepoDir,
              "rev-list",
              "--left-right",
              "--count",
              "HEAD...$upstream"
            )
          $counts = @($aheadBehind -split "\s+")
          if ([int]$counts[0] -eq 0 -and [int]$counts[1] -gt 0) {
            $selectedCommit = Invoke-ExternalOutput `
              -FilePath $gitPath `
              -Arguments @("-C", $requestedRepoDir, "rev-parse", $upstream)
          }
        }
      }
      Invoke-External $gitPath @(
        "clone",
        "--no-hardlinks",
        "--no-checkout",
        $requestedRepoDir,
        $stagedRuntimeDir
      )
      Invoke-External $gitPath @(
        "-C",
        $stagedRuntimeDir,
        "checkout",
        "--detach",
        $selectedCommit
      )
      $RepoDir = $stagedRuntimeDir
    } else {
      Write-Step "Reusing installed protected runtime at $RepoDir"
    }

    $RepoDir = (Resolve-Path -LiteralPath $RepoDir).Path
    $entrypoint = Join-Path $RepoDir "apps\daemon\dist\main.js"
    $runnerPath = Join-Path $RepoDir "skills\kb-1-daemon-setup\scripts\run_kb1_daemon_user_task.ps1"
    Assert-GitCheckoutTrust $RepoDir

    if (-not $SkipDependencyInstall -or -not $SkipBuild) {
      Push-Location $RepoDir
      try {
        $pnpmPath = Resolve-CommandPath @("pnpm.cmd", "pnpm")
        if ($null -eq $pnpmPath) {
          $corepackPath = Resolve-CommandPath @("corepack.cmd", "corepack")
          if ($null -eq $corepackPath) {
            throw "pnpm is missing and Corepack is unavailable."
          }
          Assert-ExecutableTrust $corepackPath
          Write-Step "Activating the repository package manager with Corepack"
          Invoke-External $corepackPath @("enable")
          Invoke-External $corepackPath @("install")
          $pnpmPath = Resolve-CommandPath @("pnpm.cmd", "pnpm")
          if ($null -eq $pnpmPath) {
            throw "Corepack did not make pnpm available. Reopen PowerShell and retry."
          }
        }
        Assert-ExecutableTrust $pnpmPath

        if (-not $SkipDependencyInstall) {
          Write-Step "Installing isolated runtime dependencies"
          Invoke-External $pnpmPath @(
            "install",
            "--frozen-lockfile",
            "--store-dir",
            (Join-Path $RepoDir ".pnpm-store"),
            "--package-import-method",
            "copy"
          )
        }
        if (-not $SkipBuild) {
          if ($BuildOnly) {
            Write-Step "Building KB-1 Local"
            Invoke-External $pnpmPath @("build")
          } else {
            Write-Step "Running the full KB-1 check"
            Invoke-External $pnpmPath @("check")
          }
        }
      } finally {
        Pop-Location
      }
    }

    foreach ($requiredFile in @($entrypoint, $runnerPath)) {
      if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required runtime file is missing: $requiredFile"
      }
    }
    if (-not (Test-PathAtOrWithin $RepoDir $runtimeRoot)) {
      throw "Refusing to register a Scheduled Task outside the protected runtime root."
    }
    Assert-ContainedRuntimeReparseTargets `
      -RuntimeDirectory $RepoDir `
      -TrustedRoot $runtimeRoot

    $codeAclPaths = @(
      $nodePath,
      (Split-Path -Parent $nodePath),
      (Split-Path -Parent $RepoDir),
      $RepoDir,
      $entrypoint,
      $runnerPath
    )
    $repoAclRoot = [IO.Path]::GetFullPath($RepoDir).TrimEnd("\")
    foreach ($codeFile in @($entrypoint, $runnerPath)) {
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
        $codeAclPaths += $parentPath
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
    Assert-NoUntrustedWriteAccess -Paths @(
      $codeAclPaths | Select-Object -Unique
    )
  } catch {
    if (
      $usingStagedRuntime -and
      -not [string]::IsNullOrWhiteSpace($stagedRuntimeDir)
    ) {
      Remove-Item `
        -LiteralPath $stagedRuntimeDir `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
    }
    throw
  }

  try {
    $taskKey = Get-TaskStorageKey
    $windowsIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $identityName = $windowsIdentity.Name
    $taskConfig = [ordered]@{
      version = 5
      kind = "kb1-windows-user-task"
      taskName = $TaskName
      ownerSid = $windowsIdentity.User.Value
      nodePath = $nodePath
      sourceRepoUrl = $RepoUrl
      sourceRepoDir = $requestedRepoDir
      repoDir = $RepoDir
      entrypoint = $entrypoint
      taskStateRoot = $taskStateDirectory
      kb1Home = $KB1Home
      bindHost = $BindHost
      port = $Port
      logPath = Join-Path $taskStateDirectory "windows-task-$taskKey.log"
      stdoutPath = Join-Path $taskStateDirectory "windows-task-$taskKey.stdout.log"
      stderrPath = Join-Path $taskStateDirectory "windows-task-$taskKey.stderr.log"
      runtimeStatePath = Join-Path $taskStateDirectory "windows-task-$taskKey.runtime.json"
      controlToken = [Guid]::NewGuid().ToString("N")
    }

    $powerShellPath = Resolve-CommandPath @("powershell.exe")
    if ($null -eq $powerShellPath) {
      throw "Windows PowerShell 5.1 is required to register the background task."
    }
    Assert-ExecutableTrust $powerShellPath
    $taskArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}"' -f (
      $runnerPath.Replace('"', '\"')
    ), (
      $script:ConfigPath.Replace('"', '\"')
    )
    $taskAction = New-ScheduledTaskAction `
      -Execute $powerShellPath `
      -Argument $taskArguments `
      -WorkingDirectory $RepoDir
    $principal = New-ScheduledTaskPrincipal `
      -UserId $identityName `
      -LogonType Interactive `
      -RunLevel Limited
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identityName
    $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -MultipleInstances IgnoreNew `
      -RestartCount 3 `
      -RestartInterval (New-TimeSpan -Minutes 1) `
      -StartWhenAvailable

    $previousTaskXml = $null
    $previousConfigPath = $null
    $previousConfigBytes = $null
    $previousWasActive = $false
    if ($null -ne $existingTask) {
      $previousConfigPath = Assert-OwnedTask $existingTask
      $previousTaskXml = Export-ScheduledTask `
        -TaskName $TaskName `
        -TaskPath $script:TaskPath
      $previousConfigBytes = [IO.File]::ReadAllBytes($previousConfigPath)
      $previousWasActive = $existingTask.State -in @("Running", "Queued")
    }
  } catch {
    if (
      $usingStagedRuntime -and
      -not [string]::IsNullOrWhiteSpace($stagedRuntimeDir)
    ) {
      Remove-Item `
        -LiteralPath $stagedRuntimeDir `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
    }
    throw
  }

  $registrationAttempted = $false
  $replacementConfigAttempted = $false
  $previousStopped = $false
  try {
    if ($null -ne $existingTask) {
      $taskBeforeStop = Get-InstalledTask
      if ($null -eq $taskBeforeStop) {
        throw "Scheduled Task '$TaskName' disappeared before replacement."
      }
      $previousWasActive = (
        $previousWasActive -or
        $taskBeforeStop.State -in @("Running", "Queued")
      )
      if (-not $previousWasActive) {
        $previousIdentity = Get-SupervisedDaemonIdentity $previousConfigPath
        $previousWasActive = (
          $null -ne $previousIdentity -and
          $null -ne (Get-MatchingSupervisedDaemonProcess $previousIdentity)
        )
      }

      # Even a Ready or Disabled task can have a live orphaned child. Stop
      # (or fail closed on) that verified process before replacing the config
      # and its only persisted PID/start-time identity.
      $previousStopped = $previousWasActive
      Stop-KB1Task
    }

    Write-Step "Writing task configuration"
    $replacementConfigAttempted = $true
    Remove-Item `
      -LiteralPath $taskConfig.runtimeStatePath `
      -Force `
      -ErrorAction SilentlyContinue
    $taskConfig |
      ConvertTo-Json |
      Set-Content -LiteralPath $script:ConfigPath -Encoding utf8
    Set-OwnerOnlyAcl -Path $script:ConfigPath

    Write-Step "Registering per-user Scheduled Task '$TaskName'"
    $registrationAttempted = $true
    Register-ScheduledTask `
      -TaskName $TaskName `
      -TaskPath $script:TaskPath `
      -Action $taskAction `
      -Trigger $trigger `
      -Principal $principal `
      -Settings $settings `
      -Description "KB-1 Local per-user background task" `
      -Force | Out-Null

    Start-ScheduledTask -TaskName $TaskName -TaskPath $script:TaskPath
    Write-Step "Waiting for KB-1 Local health"
    $health = Assert-HealthyTask -TimeoutSeconds $HealthTimeoutSeconds
    $health | ConvertTo-Json -Depth 8
  } catch {
    $installError = $_.Exception
    $rollbackError = $null
    $shouldRestorePrevious = (
      $null -ne $previousTaskXml -and
      ($previousStopped -or $replacementConfigAttempted -or $registrationAttempted)
    )

    if ($registrationAttempted) {
      $failedTask = Get-InstalledTask
      if ($null -ne $failedTask) {
        try {
          Stop-KB1Task
        } catch {
          Stop-KB1TaskHard `
            -TaskConfigPath $script:ConfigPath `
            -StopTaskAction:($failedTask.State -in @("Running", "Queued"))
        }
      }
      Unregister-ScheduledTask `
        -TaskName $TaskName `
        -TaskPath $script:TaskPath `
        -Confirm:$false `
        -ErrorAction SilentlyContinue
    }

    if ($replacementConfigAttempted) {
      Remove-Item `
        -LiteralPath ([string]$taskConfig.runtimeStatePath) `
        -Force `
        -ErrorAction SilentlyContinue
      Remove-Item `
        -LiteralPath $script:ConfigPath `
        -Force `
        -ErrorAction SilentlyContinue
    }

    if ($shouldRestorePrevious) {
      try {
        if (
          $null -ne $previousConfigBytes -and
          -not [string]::IsNullOrWhiteSpace([string]$previousConfigPath)
        ) {
          New-Item `
            -ItemType Directory `
            -Path (Split-Path -Parent $previousConfigPath) `
            -Force |
            Out-Null
          [IO.File]::WriteAllBytes($previousConfigPath, $previousConfigBytes)
          Set-OwnerOnlyAcl -Path $previousConfigPath
        }
        Register-ScheduledTask `
          -TaskName $TaskName `
          -TaskPath $script:TaskPath `
          -Xml $previousTaskXml `
          -Force |
          Out-Null
        if ($previousWasActive) {
          Start-ScheduledTask -TaskName $TaskName -TaskPath $script:TaskPath
          $null = Assert-HealthyTask `
            -TimeoutSeconds $HealthTimeoutSeconds `
            -TaskConfigPath $previousConfigPath
        }
      } catch {
        $rollbackError = $_.Exception
      }
    }

    if (
      $null -eq $rollbackError -and
      $usingStagedRuntime -and
      -not [string]::IsNullOrWhiteSpace($stagedRuntimeDir)
    ) {
      Remove-Item `
        -LiteralPath $stagedRuntimeDir `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
    }

    if ($null -ne $rollbackError) {
      throw @"
KB-1 task installation failed: $($installError.Message)

Restoring the previous Scheduled Task also failed: $($rollbackError.Message)
"@
    }
    throw $installError
  }

  if (
    -not [string]::IsNullOrWhiteSpace([string]$previousConfigPath) -and
    -not [string]::Equals(
      [IO.Path]::GetFullPath($previousConfigPath),
      [IO.Path]::GetFullPath($script:ConfigPath),
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    Remove-Item `
      -LiteralPath $previousConfigPath `
      -Force `
      -ErrorAction SilentlyContinue
  }

  Remove-InactiveWindowsRuntimes `
    -RuntimeRoot $runtimeRoot `
    -ActiveRuntime $RepoDir `
    -WarnOnly

  Write-Step "Installation complete"
  Write-Host "Local app/API: $($script:BaseUrl)"
  Write-Host "Local MCP:     $($script:BaseUrl)/mcp"
  Write-Host "Task:          $TaskName"
  Write-Host "Log:           $($taskConfig.logPath)"
}

function Invoke-Main {
  if ($env:OS -ne "Windows_NT") {
    throw "This installer is supported only on Windows."
  }
  $taskLock = Enter-TaskOperationLock
  $homeLock = $null
  try {
    if ($Action -eq "Install") {
      Use-InstalledTaskUpgradeDefaults
    } else {
      Use-InstalledTaskConfig
    }
    if ($Action -in @("Install", "Start")) {
      $script:KB1Home = Initialize-TrustedKB1Home `
        -Path $script:KB1Home `
        -Create
      Set-RuntimeUrls
    }
    $homeLock = Enter-HomeOperationLock

    switch ($Action) {
      "Install" {
        Install-KB1Task
      }
      "Uninstall" {
        Write-Step "Removing Scheduled Task '$TaskName'"
        $task = Get-InstalledTask
        if ($null -ne $task) {
          Stop-KB1Task
          Unregister-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath $script:TaskPath `
            -Confirm:$false
        }
        if (Test-Path -LiteralPath $script:ConfigPath -PathType Leaf) {
          $removedConfig = Get-Content -LiteralPath $script:ConfigPath -Raw |
            ConvertFrom-Json
          if (-not [string]::IsNullOrWhiteSpace([string]$removedConfig.runtimeStatePath)) {
            Remove-Item `
              -LiteralPath ([string]$removedConfig.runtimeStatePath) `
              -Force `
              -ErrorAction SilentlyContinue
          }
        }
        Remove-Item -LiteralPath $script:ConfigPath -Force -ErrorAction SilentlyContinue
        Write-Host "The repository, logs, and vault data were preserved."
      }
      "Start" {
        $task = Get-InstalledTask
        if ($null -eq $task) {
          throw "Scheduled Task '$TaskName' is not installed."
        }
        Start-ScheduledTask -TaskName $TaskName -TaskPath $script:TaskPath
        Assert-HealthyTask | Out-Null
        Write-Host "KB-1 Local is healthy at $script:HealthUrl"
      }
      "Stop" {
        Stop-KB1Task
        Write-Host "KB-1 Local task stopped."
      }
      "Status" {
        Show-KB1Status
      }
    }
  } finally {
    if ($null -ne $homeLock) {
      $homeLock.ReleaseMutex()
      $homeLock.Dispose()
    }
    $taskLock.ReleaseMutex()
    $taskLock.Dispose()
  }
}

try {
  Invoke-Main
} catch {
  Write-Error $_
  exit 1
}
