[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('validate', 'execute')][string]$Mode,
  [ValidateSet('ivekit-rustdesk-native-control-v1', 'ivekit-rustdesk-native-control-v2')]
  [string]$Protocol = $env:OPC_RUSTDESK_NATIVE_CONTROL_PROTOCOL,
  [ValidatePattern('^$|^[A-Za-z0-9._:@/-]+$')][string]$CommandId = $env:OPC_RUSTDESK_COMMAND_ID,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$ExternalId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$TargetId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$RustDeskId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$ControllerRustDeskId,
  [Parameter(Mandatory = $true)][ValidateSet('consent_revoked', 'remote_session_ended', 'tool_ended', 'gateway_ended')][string]$Reason,
  [ValidatePattern('^$|^[A-Za-z0-9._:@/-]+$')][string]$InteractionId = '',
  [ValidatePattern('^$|^[A-Za-z0-9._:@/-]+$')][string]$ReservationId = '',
  [ValidatePattern('^$|^[1-9][0-9]{0,19}$')][string]$OwnerEpoch = '',
  [string]$PipeName = $env:OPC_RUSTDESK_NATIVE_CONTROL_PIPE,
  [ValidateRange(100, 30000)][int]$TimeoutMs = 5000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Protocol)) {
  $Protocol = 'ivekit-rustdesk-native-control-v2'
}
if ([string]::IsNullOrWhiteSpace($PipeName)) { $PipeName = $Protocol }
if ($PipeName -notmatch '^[A-Za-z][A-Za-z0-9._-]{2,127}$') {
  throw 'RustDesk native control pipe name is invalid.'
}

if ($Mode -eq 'validate') {
  [ordered]@{
    adapter = $Protocol
    mode = 'validate'
    available = $true
    targeted = $true
    pipe_name = $PipeName
  } | ConvertTo-Json -Compress
  exit 0
}

$schemaVersion = if ($Protocol -eq 'ivekit-rustdesk-native-control-v2') { 2 } else { 1 }
if (-not $CommandId) { $CommandId = [Guid]::NewGuid().ToString('D') }
if ($schemaVersion -eq 2 -and (-not $InteractionId -or -not $ReservationId -or -not $OwnerEpoch)) {
  throw 'RustDesk v2 native control requires interaction, reservation, and owner epoch.'
}
$request = [ordered]@{
  schema_version = $schemaVersion
  operation = 'disconnect_session'
  command_id = $CommandId
  external_id = $ExternalId
  target_id = $TargetId
  rustdesk_id = $RustDeskId
  controller_rustdesk_id = $ControllerRustDeskId
  reason = $Reason
}
if ($schemaVersion -eq 2) {
  $request.interaction_id = $InteractionId
  $request.reservation_id = $ReservationId
  $request.owner_epoch = $OwnerEpoch
}

$pipe = [IO.Pipes.NamedPipeClientStream]::new(
  '.',
  $PipeName,
  [IO.Pipes.PipeDirection]::InOut,
  [IO.Pipes.PipeOptions]::Asynchronous
)
try {
  try {
    $pipe.Connect($TimeoutMs)
  } catch [TimeoutException] {
    [Console]::Error.WriteLine('RustDesk native control pipe is unavailable.')
    exit 20
  }
  $utf8 = [Text.UTF8Encoding]::new($false)
  $writer = [IO.StreamWriter]::new($pipe, $utf8, 4096, $true)
  $reader = [IO.StreamReader]::new($pipe, $utf8, $false, 4096, $true)
  try {
    $writer.AutoFlush = $true
    $writer.WriteLine(($request | ConvertTo-Json -Compress))
    $readTask = $reader.ReadLineAsync()
    if (-not $readTask.Wait($TimeoutMs) -or $null -eq $readTask.Result) {
      [Console]::Error.WriteLine('RustDesk native control response timed out.')
      exit 21
    }
    $response = $readTask.Result | ConvertFrom-Json
  } finally {
    $reader.Dispose()
    $writer.Dispose()
  }
} finally {
  $pipe.Dispose()
}

if ($response.schema_version -ne $schemaVersion -or [string]$response.command_id -ne $CommandId) {
  [Console]::Error.WriteLine('RustDesk native control response binding is invalid.')
  exit 23
}
if ($schemaVersion -eq 2 -and (
    [string]$response.interaction_id -ne $InteractionId -or
    [string]$response.reservation_id -ne $ReservationId -or
    [string]$response.owner_epoch -ne $OwnerEpoch
  )) {
  [Console]::Error.WriteLine('RustDesk native control owner binding is invalid.')
  exit 23
}
if ([string]$response.native_session_id -notmatch '^[1-9][0-9]{0,18}$') {
  [Console]::Error.WriteLine('native_session_id_mismatch')
  exit 23
}
if ([string]$response.status -notin @('disconnected', 'already_disconnected')) {
  [Console]::Error.WriteLine(('RustDesk precise disconnect failed: ' + [string]$response.error_code))
  exit 21
}

[ordered]@{
  status = [string]$response.status
  command_id = $CommandId
  native_session_id = [string]$response.native_session_id
  execution_method = 'native_control_pipe'
} | ConvertTo-Json -Compress
exit 0
