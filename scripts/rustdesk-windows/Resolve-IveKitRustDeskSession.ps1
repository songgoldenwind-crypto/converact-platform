[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('register', 'unregister', 'resolve')][string]$Mode,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$ExternalId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$TargetId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$RustDeskId,
  [ValidatePattern('^$|^[1-9][0-9]{0,18}$')][string]$NativeSessionId = '',
  [string]$RegistryFile = $env:OPC_RUSTDESK_SESSION_REGISTRY_FILE,
  [ValidateRange(60, 604800)][int]$TtlSeconds = 86400
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RegistryFile)) {
  $RegistryFile = Join-Path $env:ProgramData 'iveKit\RustDesk\state\rustdesk-native-sessions.json'
}
if (-not [IO.Path]::IsPathRooted($RegistryFile)) {
  throw 'RustDesk session registry path must be absolute.'
}
if ($Mode -eq 'register' -and -not $NativeSessionId) {
  throw 'NativeSessionId is required when registering a RustDesk session.'
}

$registryDirectory = Split-Path -Parent $RegistryFile
$mutex = [Threading.Mutex]::new($false, 'Global\IveKitRustDeskNativeSessionRegistryV1')
$locked = $false

function Read-Registry {
  if (-not (Test-Path -LiteralPath $RegistryFile -PathType Leaf)) {
    return [pscustomobject]@{ schema_version = 1; sessions = @() }
  }
  $registry = Get-Content -LiteralPath $RegistryFile -Raw | ConvertFrom-Json
  if ($registry.schema_version -ne 1 -or $null -eq $registry.sessions) {
    throw 'Unsupported RustDesk native session registry.'
  }
  return $registry
}

function Write-Registry([object[]]$Sessions) {
  New-Item -ItemType Directory -Force -Path $registryDirectory | Out-Null
  & icacls $registryDirectory '/inheritance:r' '/grant:r' 'SYSTEM:(OI)(CI)(F)' 'BUILTIN\Administrators:(OI)(CI)(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to restrict the RustDesk session registry directory ACL.' }
  $temporary = Join-Path $registryDirectory ('.rustdesk-native-sessions.' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [ordered]@{ schema_version = 1; sessions = @($Sessions) } |
      ConvertTo-Json -Depth 6 |
      Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $RegistryFile -Force
    & icacls $RegistryFile '/inheritance:r' '/grant:r' 'SYSTEM:(F)' 'BUILTIN\Administrators:(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to restrict the RustDesk session registry file ACL.' }
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

try {
  $locked = $mutex.WaitOne([TimeSpan]::FromSeconds(10))
  if (-not $locked) { throw 'Timed out acquiring the RustDesk session registry lock.' }
  $now = [DateTimeOffset]::UtcNow
  $registry = Read-Registry
  $active = @($registry.sessions | Where-Object {
    $_.expires_at -and ([DateTimeOffset]::Parse([string]$_.expires_at) -gt $now)
  })

  if ($Mode -eq 'register') {
    $conflicts = @($active | Where-Object {
      ($_.native_session_id -eq $NativeSessionId -and
       ($_.external_id -ne $ExternalId -or $_.target_id -ne $TargetId -or $_.rustdesk_id -ne $RustDeskId)) -or
      ($_.external_id -eq $ExternalId -and
       ($_.target_id -ne $TargetId -or $_.rustdesk_id -ne $RustDeskId))
    })
    if ($conflicts.Count -gt 0) { throw 'RustDesk native session mapping is ambiguous.' }
    $remaining = @($active | Where-Object {
      -not ($_.external_id -eq $ExternalId -and $_.target_id -eq $TargetId -and $_.rustdesk_id -eq $RustDeskId)
    })
    $entry = [ordered]@{
      external_id = $ExternalId
      target_id = $TargetId
      rustdesk_id = $RustDeskId
      native_session_id = $NativeSessionId
      registered_at = $now.ToString('o')
      expires_at = $now.AddSeconds($TtlSeconds).ToString('o')
    }
    Write-Registry @($remaining + [pscustomobject]$entry)
    $entry | ConvertTo-Json -Compress
    exit 0
  }

  $matches = @($active | Where-Object {
    $_.external_id -eq $ExternalId -and $_.target_id -eq $TargetId -and $_.rustdesk_id -eq $RustDeskId -and
    (-not $NativeSessionId -or $_.native_session_id -eq $NativeSessionId)
  })
  if ($matches.Count -gt 1) {
    [Console]::Error.WriteLine('RustDesk native session mapping is ambiguous.')
    exit 22
  }
  if ($Mode -eq 'unregister') {
    $remaining = @($active | Where-Object { $matches -notcontains $_ })
    Write-Registry $remaining
    [ordered]@{ status = 'unregistered'; removed = $matches.Count } | ConvertTo-Json -Compress
    exit 0
  }
  if ($matches.Count -eq 0) {
    [Console]::Error.WriteLine('RustDesk native session mapping is unavailable or expired.')
    exit 20
  }
  $matches[0] | ConvertTo-Json -Compress
  exit 0
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
