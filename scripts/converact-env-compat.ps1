Set-StrictMode -Version Latest

function Resolve-ConveractEnvironmentAlias {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][ValidateSet('brand', 'fabric')][string]$Scope,
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Z][A-Z0-9_]*$')][string]$Suffix
  )

  $currentPrefix = if ($Scope -eq 'fabric') { 'CONVERACT_FABRIC_' } else { 'CONVERACT_' }
  $legacyPrefix = if ($Scope -eq 'fabric') { 'OPC_IVEKIT_' } else { 'OPC_' }
  $currentKey = "$currentPrefix$Suffix"
  $legacyKey = "$legacyPrefix$Suffix"
  $currentValue = [Environment]::GetEnvironmentVariable($currentKey, 'Process')
  $legacyValue = [Environment]::GetEnvironmentVariable($legacyKey, 'Process')
  $hasCurrent = $null -ne $currentValue
  $hasLegacy = $null -ne $legacyValue

  if ($hasCurrent -and $hasLegacy -and $currentValue -cne $legacyValue) {
    throw "conflicting branded environment variables: $currentKey and $legacyKey"
  }
  if (-not $hasCurrent -and $hasLegacy) {
    [Environment]::SetEnvironmentVariable($currentKey, $legacyValue, 'Process')
    [ordered]@{
      event = 'converact.config.deprecated_environment_key'
      scope = $Scope
      current_key = $currentKey
      legacy_key = $legacyKey
    } | ConvertTo-Json -Compress | ForEach-Object { [Console]::Error.WriteLine($_) }
  }
}

function Install-ConveractEnvironmentAliases {
  [CmdletBinding()]
  param()

  $keys = @([Environment]::GetEnvironmentVariables('Process').Keys)
  foreach ($keyValue in $keys) {
    $key = [string]$keyValue
    if ($key -match '^CONVERACT_FABRIC_([A-Z][A-Z0-9_]*)$') {
      Resolve-ConveractEnvironmentAlias -Scope fabric -Suffix $Matches[1]
    } elseif ($key -match '^OPC_IVEKIT_([A-Z][A-Z0-9_]*)$') {
      Resolve-ConveractEnvironmentAlias -Scope fabric -Suffix $Matches[1]
    } elseif ($key -match '^CONVERACT_([A-Z][A-Z0-9_]*)$') {
      Resolve-ConveractEnvironmentAlias -Scope brand -Suffix $Matches[1]
    } elseif ($key -match '^OPC_([A-Z][A-Z0-9_]*)$') {
      Resolve-ConveractEnvironmentAlias -Scope brand -Suffix $Matches[1]
    }
  }
}
