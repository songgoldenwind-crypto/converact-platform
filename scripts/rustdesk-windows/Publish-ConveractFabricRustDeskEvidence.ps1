[CmdletBinding()]
param(
  [ValidateSet('validate', 'publish')]
  [string]$Mode = 'validate',
  [Parameter(Mandatory = $true)]
  [ValidateSet('file_transfer_completed', 'screen_recording_completed')]
  [string]$EventType,
  [Parameter(Mandatory = $true)]
  [string]$EventDirectory,
  [Parameter(Mandatory = $true)]
  [string]$AllowedRoot,
  [Parameter(Mandatory = $true)]
  [string]$NativeEventId,
  [Parameter(Mandatory = $true)]
  [string]$ExternalId,
  [Parameter(Mandatory = $true)]
  [string]$OperationId,
  [Parameter(Mandatory = $true)]
  [ValidateSet('operation', 'session')]
  [string]$AuthorizationScope,
  [Parameter(Mandatory = $true)]
  [string]$AuthorizationId,
  [Parameter(Mandatory = $true)]
  [string]$SourcePath,
  [Parameter(Mandatory = $true)]
  [string]$Filename,
  [Parameter(Mandatory = $true)]
  [string]$DeclaredMime,
  [Parameter(Mandatory = $true)]
  [string]$ObservedAt,
  [ValidateSet('', 'upload', 'download')]
  [string]$Direction = '',
  [int]$ControlVersion = 0,
  [string]$RetentionUntil = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Identifier([string]$Value, [string]$Name) {
  if ($Value -notmatch '^[A-Za-z0-9._:@/-]{1,256}$') {
    throw "$Name contains unsupported characters or length."
  }
}

function Resolve-RealItem([string]$Path, [string]$Name, [bool]$RequireFile) {
  if (-not [IO.Path]::IsPathRooted($Path)) { throw "$Name must be an absolute path." }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Name must not be a reparse point."
  }
  if ($RequireFile -and $item.PSIsContainer) { throw "$Name must be a file." }
  if (-not $RequireFile -and -not $item.PSIsContainer) { throw "$Name must be a directory." }
  return $item
}

function ConvertTo-UtcTimestamp([string]$Value, [string]$Name) {
  $parsed = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse(
    $Value,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind,
    [ref]$parsed
  )) { throw "$Name must be an ISO-8601 timestamp." }
  return $parsed.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

function Get-Sha256([string]$Value) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

foreach ($pair in @(
  @($NativeEventId, 'NativeEventId'),
  @($ExternalId, 'ExternalId'),
  @($OperationId, 'OperationId'),
  @($AuthorizationId, 'AuthorizationId')
)) { Assert-Identifier ([string]$pair[0]) ([string]$pair[1]) }

if ($Filename.Length -lt 1 -or $Filename.Length -gt 255 -or
    [IO.Path]::GetFileName($Filename) -ne $Filename -or $Filename -match '[\x00-\x1f]') {
  throw 'Filename must be one safe leaf name.'
}
if ($DeclaredMime -notmatch '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$') {
  throw 'DeclaredMime is invalid.'
}

$eventDirItem = Resolve-RealItem $EventDirectory 'EventDirectory' $false
$rootItem = Resolve-RealItem $AllowedRoot 'AllowedRoot' $false
$sourceItem = Resolve-RealItem $SourcePath 'SourcePath' $true
$rootPrefix = $rootItem.FullName.TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
if (-not $sourceItem.FullName.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'SourcePath is outside AllowedRoot.'
}

$observed = ConvertTo-UtcTimestamp $ObservedAt 'ObservedAt'
$retention = if ([string]::IsNullOrWhiteSpace($RetentionUntil)) {
  ''
} else {
  ConvertTo-UtcTimestamp $RetentionUntil 'RetentionUntil'
}
if ($retention -and [DateTimeOffset]::Parse($retention) -le [DateTimeOffset]::Parse($observed)) {
  throw 'RetentionUntil must be later than ObservedAt.'
}

if ($EventType -eq 'file_transfer_completed') {
  if ($AuthorizationScope -ne 'operation' -or [string]::IsNullOrWhiteSpace($AuthorizationId)) {
    throw 'File evidence requires operation authorization.'
  }
  if ($Direction -ne 'upload' -and $Direction -ne 'download') {
    throw 'File evidence requires Direction.'
  }
  if ($ControlVersion -lt 1) { throw 'File evidence requires a positive ControlVersion.' }
} else {
  if ($AuthorizationScope -ne 'session' -or $AuthorizationId -ne $ExternalId) {
    throw 'Recording evidence requires matching session authorization.'
  }
  if ($Direction -or $ControlVersion -ne 0) {
    throw 'Recording evidence must not include file control fields.'
  }
}

$event = [ordered]@{
  schema_version = 1
  native_event_id = $NativeEventId
  event_type = $EventType
  external_id = $ExternalId
  operation_id = $OperationId
  authorization_scope = $AuthorizationScope
  authorization_id = $AuthorizationId
  source_path = $sourceItem.FullName
  filename = $Filename
  declared_mime = $DeclaredMime
  observed_at = $observed
}
if ($retention) { $event['retention_until'] = $retention }
if ($EventType -eq 'file_transfer_completed') {
  $event['direction'] = $Direction
  $event['control_version'] = $ControlVersion
}
$payload = ($event | ConvertTo-Json -Compress) + "`n"

if ($Mode -eq 'validate') {
  [ordered]@{
    schema_version = 1
    status = 'valid'
    native_event_id = $NativeEventId
    event_type = $EventType
  } | ConvertTo-Json -Compress
  exit 0
}

$eventHash = Get-Sha256 $NativeEventId
$destination = Join-Path $eventDirItem.FullName ($eventHash + '.json')
if (Test-Path -LiteralPath $destination -PathType Leaf) {
  if ((Get-Content -LiteralPath $destination -Raw) -ne $payload) {
    throw 'NativeEventId already exists with a different payload.'
  }
  [ordered]@{ schema_version = 1; status = 'replayed'; native_event_id = $NativeEventId } |
    ConvertTo-Json -Compress
  exit 0
}

$temporary = Join-Path $eventDirItem.FullName ('.' + $eventHash + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
$encoding = New-Object Text.UTF8Encoding($false)
try {
  $stream = [IO.FileStream]::new(
    $temporary,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
  )
  try {
    $bytes = $encoding.GetBytes($payload)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
  [IO.File]::Move($temporary, $destination)
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}

[ordered]@{ schema_version = 1; status = 'published'; native_event_id = $NativeEventId } |
  ConvertTo-Json -Compress
