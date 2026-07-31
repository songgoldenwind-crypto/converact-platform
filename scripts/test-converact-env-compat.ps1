$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'converact-env-compat.ps1')

function Set-ProcessEnv([string]$Name, [AllowNull()][string]$Value) {
  [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

function Assert-Equal([AllowNull()]$Actual, [AllowNull()]$Expected, [string]$Message) {
  if ($Actual -cne $Expected) { throw "$Message; expected '$Expected'" }
}

$keys = @(
  'CONVERACT_API_KEY',
  'OPC_API_KEY',
  'CONVERACT_FABRIC_INSTANCE_ID',
  'OPC_IVEKIT_INSTANCE_ID'
)
$saved = @{}
foreach ($key in $keys) {
  $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}

try {
  foreach ($key in $keys) { Set-ProcessEnv $key $null }

  Set-ProcessEnv 'CONVERACT_API_KEY' 'new'
  Resolve-ConveractEnvironmentAlias -Scope brand -Suffix API_KEY
  Assert-Equal $env:CONVERACT_API_KEY 'new' 'current value was not preserved'

  Set-ProcessEnv 'CONVERACT_API_KEY' $null
  Set-ProcessEnv 'OPC_API_KEY' 'legacy'
  Resolve-ConveractEnvironmentAlias -Scope brand -Suffix API_KEY
  Assert-Equal $env:CONVERACT_API_KEY 'legacy' 'legacy value was not installed'

  Set-ProcessEnv 'CONVERACT_API_KEY' 'same'
  Set-ProcessEnv 'OPC_API_KEY' 'same'
  Resolve-ConveractEnvironmentAlias -Scope brand -Suffix API_KEY

  Set-ProcessEnv 'CONVERACT_API_KEY' ''
  Set-ProcessEnv 'OPC_API_KEY' 'legacy-secret'
  try {
    Resolve-ConveractEnvironmentAlias -Scope brand -Suffix API_KEY
    throw 'expected conflict was not raised'
  } catch {
    if ($_.Exception.Message -notmatch 'conflicting branded environment variables') { throw }
    if ($_.Exception.Message -match 'legacy-secret') { throw 'conflict exposed a value' }
  }

  Set-ProcessEnv 'CONVERACT_FABRIC_INSTANCE_ID' $null
  Set-ProcessEnv 'OPC_IVEKIT_INSTANCE_ID' 'legacy-instance'
  Resolve-ConveractEnvironmentAlias -Scope fabric -Suffix INSTANCE_ID
  Assert-Equal $env:CONVERACT_FABRIC_INSTANCE_ID 'legacy-instance' 'Fabric alias was not installed'
} finally {
  foreach ($key in $keys) { Set-ProcessEnv $key $saved[$key] }
}
