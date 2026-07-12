[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('validate', 'execute')][string]$Mode,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$ExternalId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$TargetId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$RustDeskId,
  [Parameter(Mandatory = $true)][ValidateSet('consent_revoked', 'remote_session_ended', 'tool_ended', 'gateway_ended')][string]$Reason
)
$ErrorActionPreference = 'Stop'
$hook = [string]$env:OPC_RUSTDESK_SESSION_DISCONNECT_HOOK
$available = $false
if ($hook -and [System.IO.Path]::IsPathRooted($hook) -and (Test-Path -LiteralPath $hook -PathType Leaf)) {
  $available = $true
}
if ($Mode -eq 'validate') {
  [ordered]@{ adapter = 'windows-session-hook'; mode = 'validate'; available = $available; targeted = $true } | ConvertTo-Json -Compress
  exit 0
}
if (-not $available) {
  [Console]::Error.WriteLine('session-specific disconnect hook is not configured')
  exit 20
}
& $hook '-ExternalId' $ExternalId '-TargetId' $TargetId '-RustDeskId' $RustDeskId '-Reason' $Reason
if (-not $?) { exit 1 }
if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }
exit 0
