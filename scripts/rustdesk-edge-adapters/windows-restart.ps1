[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('validate', 'execute')][string]$Mode,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$ExternalId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$TargetId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:@/-]+$')][string]$RustDeskId,
  [Parameter(Mandatory = $true)][ValidateSet('consent_revoked', 'remote_session_ended', 'tool_ended', 'gateway_ended')][string]$Reason
)
$ErrorActionPreference = 'Stop'
$serviceName = if ($env:OPC_RUSTDESK_SERVICE_NAME) { [string]$env:OPC_RUSTDESK_SERVICE_NAME } else { 'RustDesk' }
if ($serviceName -notmatch '^[A-Za-z0-9_.@-]+$') { throw 'invalid RustDesk service name' }
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
$available = $null -ne $service
if ($Mode -eq 'validate') {
  [ordered]@{ adapter = 'windows-service-restart'; mode = 'validate'; available = $available; targeted = $false; collateral_sessions_may_disconnect = $true } | ConvertTo-Json -Compress
  exit 0
}
if (-not $available) {
  [Console]::Error.WriteLine('RustDesk Windows service is unavailable')
  exit 21
}
Restart-Service -Name $serviceName -Force
$service = Get-Service -Name $serviceName
if ($service.Status -ne 'Running') { throw 'RustDesk Windows service did not return to Running' }
[ordered]@{ adapter = 'windows-service-restart'; mode = 'execute'; status = 'succeeded'; targeted = $false; collateral_sessions_may_disconnect = $true } | ConvertTo-Json -Compress
