[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('validate', 'execute')][string]$Mode,
  [Parameter(Mandatory = $true)]
  [ValidateSet('ivekit-rustdesk-native-control-v1', 'ivekit-rustdesk-native-control-v2')]
  [string]$Protocol,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$CommandId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$ExternalId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$TargetId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$RustDeskId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$ControllerRustDeskId,
  [ValidatePattern('^$|^[1-9][0-9]{0,18}$')][string]$NativeSessionId = '',
  [Parameter(Mandatory = $true)][ValidateSet('consent_revoked', 'remote_session_ended', 'tool_ended', 'gateway_ended')][string]$Reason,
  [ValidatePattern('^$|^[A-Za-z0-9._:@/-]+$')][string]$InteractionId = '',
  [ValidatePattern('^$|^[A-Za-z0-9._:@/-]+$')][string]$ReservationId = '',
  [ValidatePattern('^$|^[1-9][0-9]{0,19}$')][string]$OwnerEpoch = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'converact-env-compat.ps1')
Install-ConveractEnvironmentAliases
$bridge = [string]$env:CONVERACT_RUSTDESK_PRECISE_DISCONNECT_SCRIPT
if (-not $bridge) {
  $bridge = Join-Path (Split-Path $PSScriptRoot -Parent) 'windows\Invoke-IveKitRustDeskSessionDisconnect.ps1'
}
$available = $false
if ($bridge -and [System.IO.Path]::IsPathRooted($bridge) -and (Test-Path -LiteralPath $bridge -PathType Leaf)) {
  $available = $true
}
if ($Mode -eq 'validate') {
  [ordered]@{ adapter = $Protocol; mode = 'validate'; available = $available; targeted = $true } | ConvertTo-Json -Compress
  exit 0
}
if (-not $available) {
  [Console]::Error.WriteLine('iveKit precise disconnect bridge is not installed')
  exit 20
}
& $bridge '-Mode' $Mode '-Protocol' $Protocol '-CommandId' $CommandId `
  '-ExternalId' $ExternalId '-TargetId' $TargetId '-RustDeskId' $RustDeskId `
  '-ControllerRustDeskId' $ControllerRustDeskId '-Reason' $Reason `
  '-NativeSessionId' $NativeSessionId `
  '-InteractionId' $InteractionId '-ReservationId' $ReservationId '-OwnerEpoch' $OwnerEpoch
if (-not $?) { exit 1 }
if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }
exit 0
