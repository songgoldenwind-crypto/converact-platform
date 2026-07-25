[CmdletBinding()]
param(
  [ValidateSet('validate', 'install', 'repair', 'uninstall')]
  [string]$Mode = 'validate',
  [string]$ManifestPath = (Join-Path $PSScriptRoot 'manifest.json'),
  [string]$InstallRoot = (Join-Path $env:ProgramData 'iveKit\RustDesk'),
  [string]$BaseUrl = '',
  [string]$TenantId = '',
  [string]$BusinessRefType = '',
  [string]$BusinessRefId = '',
  [string]$DisplayName = $env:COMPUTERNAME,
  [string]$DeviceTokenFile = '',
  [string]$NodeExe = 'node.exe',
  [string]$NativeProducerPrincipal = 'NT AUTHORITY\LOCAL SERVICE',
  [string[]]$NativeFileRoots = @(),
  [string[]]$NativeRecordingRoots = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$AllowedCapabilityOptions = @(
  'access-mode',
  'allow-auto-record-incoming',
  'allow-remote-config-modification',
  'approve-mode',
  'disable-clipboard',
  'displays-as-individual-windows',
  'enable-audio',
  'enable-block-input',
  'enable-camera',
  'enable-clipboard',
  'enable-file-copy-paste',
  'enable-file-transfer',
  'enable-keyboard',
  'enable-perm-change-in-accept-window',
  'enable-privacy-mode',
  'enable-record-session',
  'enable-remote-printer',
  'enable-remote-restart',
  'enable-terminal',
  'enable-tunnel',
  'show-monitors-toolbar'
)

function Assert-WindowsX64 {
  if ($env:OS -ne 'Windows_NT') {
    throw 'This package supports Windows only.'
  }
  if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'This package supports Windows x64 only.'
  }
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'install, repair, and uninstall require an elevated PowerShell session.'
  }
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Hash([string]$Path, [string]$Expected) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Required file is missing: $Path"
  }
  $actual = Get-Sha256 $Path
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "SHA-256 mismatch for $Path"
  }
}

function Read-Manifest {
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "Manifest is missing: $ManifestPath"
  }
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  if ($manifest.schema_version -ne 1 -or $manifest.package_type -ne 'ivekit-rustdesk-windows-x86_64') {
    throw 'Unsupported RustDesk Windows package manifest.'
  }
  if ($manifest.secret_free -ne $true) {
    throw 'RustDesk Windows package must be marked secret-free.'
  }
  if ($manifest.rustdesk.client_version -ne '1.4.9' -or $manifest.rustdesk.server_version -ne '1.1.16') {
    throw 'RustDesk client or server version drift detected.'
  }
  if ($manifest.companion.package_version -ne 6) {
    throw 'RustDesk companion package version drift detected.'
  }
  $protocol = [string]$manifest.companion.native_session_control.protocol
  if ($protocol -notin @(
      'ivekit-rustdesk-native-control-v1',
      'ivekit-rustdesk-native-control-v2'
    )) {
    throw 'RustDesk native control protocol is unsupported.'
  }
  if ($manifest.placement.enabled -eq $true -and (
      $protocol -ne 'ivekit-rustdesk-native-control-v2' -or
      $manifest.placement.owner_epoch_required -ne $true -or
      $manifest.companion.native_session_control.owner_epoch_fence -ne 'durable'
    )) {
    throw 'Placement-enabled RustDesk requires the durable owner-epoch v2 protocol.'
  }
  if ($manifest.real_windows_acceptance -ne 'not_run') {
    throw 'Package generation cannot claim real Windows acceptance.'
  }
  return $manifest
}

function Assert-PackageFiles($Manifest) {
  $packageRoot = Split-Path -Parent $ManifestPath
  foreach ($file in $Manifest.package_files) {
    if ($file.path -notmatch '^[A-Za-z0-9._/-]+$' -or $file.path.Contains('..')) {
      throw "Unsafe package path: $($file.path)"
    }
    $path = Join-Path $packageRoot ($file.path.Replace('/', [IO.Path]::DirectorySeparatorChar))
    Assert-Hash $path $file.sha256
    if ((Get-Item -LiteralPath $path).Length -ne [long]$file.size_bytes) {
      throw "Size mismatch for $path"
    }
  }
}

function Read-CapabilityPolicy($Manifest) {
  $packageRoot = Split-Path -Parent $ManifestPath
  $policyPath = Join-Path $packageRoot $Manifest.rustdesk.capability_policy.path
  Assert-Hash $policyPath $Manifest.rustdesk.capability_policy.sha256
  $policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
  if ($policy.schema_version -ne 1 -or $policy.platform -ne 'windows' -or $policy.architecture -ne 'x86_64') {
    throw 'Unsupported effective capability policy.'
  }
  if ($policy.client_version -ne '1.4.9' -or $policy.access_mode -ne 'attended') {
    throw 'Effective capability policy version or access mode drift detected.'
  }
  $actualNames = @($policy.options.PSObject.Properties.Name | Sort-Object)
  $expectedNames = @($AllowedCapabilityOptions | Sort-Object)
  if (($actualNames -join ',') -ne ($expectedNames -join ',')) {
    throw 'Effective capability policy contains missing or unknown RustDesk options.'
  }
  return $policy
}

function Resolve-NodeExecutable {
  $command = Get-Command $NodeExe -ErrorAction Stop
  $resolved = $command.Source
  $rawVersion = (& $resolved --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $rawVersion -notmatch '^v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$') {
    throw 'Unable to read the Node.js runtime version.'
  }
  if ([int]$Matches.major -lt 23) {
    throw 'The iveKit RustDesk companion requires Node.js 23 or newer.'
  }
  return $resolved
}

function Invoke-RustDesk([string]$Executable, [string[]]$Arguments) {
  $output = & $Executable @Arguments 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "RustDesk command failed: $($Arguments[0])"
  }
  if ($output -match 'Installation and administrative privileges required|Settings are disabled') {
    throw "RustDesk rejected command: $($Arguments[0])"
  }
  return $output.Trim()
}

function Find-RustDeskExecutable {
  $candidates = @((Join-Path $env:ProgramFiles 'RustDesk\rustdesk.exe'))
  $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($programFilesX86) {
    $candidates += Join-Path $programFilesX86 'RustDesk\rustdesk.exe'
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return $candidate
    }
  }
  return $null
}

function Wait-RustDeskExecutable {
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    $candidate = Find-RustDeskExecutable
    if ($candidate) { return $candidate }
    Start-Sleep -Seconds 1
  }
  throw 'RustDesk executable was not installed within 30 seconds.'
}

function Get-CurrentOptions([string]$RustDeskExe, $Policy) {
  $values = [ordered]@{}
  foreach ($property in $Policy.options.PSObject.Properties) {
    $values[$property.Name] = Invoke-RustDesk $RustDeskExe @('--option', $property.Name)
  }
  return $values
}

function Apply-AndVerifyOptions([string]$RustDeskExe, $Policy) {
  foreach ($property in $Policy.options.PSObject.Properties) {
    [void](Invoke-RustDesk $RustDeskExe @('--option', $property.Name, [string]$property.Value))
  }
  foreach ($property in $Policy.options.PSObject.Properties) {
    $actual = Invoke-RustDesk $RustDeskExe @('--option', $property.Name)
    if ($actual -ne [string]$property.Value) {
      throw "RustDesk option drift detected: $($property.Name)"
    }
  }
}

function Save-RollbackState($Policy) {
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  $statePath = Join-Path $InstallRoot 'rollback-state.json'
  if (Test-Path -LiteralPath $statePath) {
    return Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  }
  $existingRustDesk = Find-RustDeskExecutable
  $service = Get-Service -Name 'RustDesk' -ErrorAction SilentlyContinue
  $companion = Get-Service -Name $script:Manifest.companion.service_name -ErrorAction SilentlyContinue
  if ($companion) {
    throw 'A companion service already exists without iveKit rollback metadata.'
  }
  $state = [ordered]@{
    schema_version = 1
    rustdesk_preexisting = [bool]$existingRustDesk
    rustdesk_executable = [string]$existingRustDesk
    rustdesk_version = ''
    rustdesk_service_status = if ($service) { [string]$service.Status } else { 'missing' }
    rustdesk_options = [ordered]@{}
    rustdesk_video_save_directory = ''
    previous_binary = ''
    companion_preexisting = $false
  }
  if ($existingRustDesk) {
    $state.rustdesk_version = Invoke-RustDesk $existingRustDesk @('--version')
    $state.rustdesk_options = Get-CurrentOptions $existingRustDesk $Policy
    $state.rustdesk_video_save_directory = Invoke-RustDesk $existingRustDesk @('--option', 'video-save-directory')
    $rollbackDir = Join-Path $InstallRoot 'rollback'
    New-Item -ItemType Directory -Force -Path $rollbackDir | Out-Null
    $previousBinary = Join-Path $rollbackDir 'rustdesk-previous.exe'
    Copy-Item -LiteralPath $existingRustDesk -Destination $previousBinary -Force
    $state.previous_binary = $previousBinary
  }
  $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding UTF8
  return [pscustomobject]$state
}

function Remove-CompanionService {
  $serviceExe = Join-Path $InstallRoot $script:Manifest.companion.service_wrapper.filename
  if (Test-Path -LiteralPath $serviceExe -PathType Leaf) {
    & $serviceExe stop 2>$null | Out-Null
    & $serviceExe uninstall 2>$null | Out-Null
  }
}

function Restore-IveKitRollback($State) {
  Remove-CompanionService
  $current = Find-RustDeskExecutable
  if ($State.rustdesk_preexisting -eq $true) {
    if ($State.previous_binary -and (Test-Path -LiteralPath $State.previous_binary -PathType Leaf)) {
      & $State.previous_binary --silent-install | Out-Null
      $current = Wait-RustDeskExecutable
    }
    if ($current) {
      foreach ($property in $State.rustdesk_options.PSObject.Properties) {
        [void](Invoke-RustDesk $current @('--option', $property.Name, [string]$property.Value))
      }
      if ($State.PSObject.Properties.Name -contains 'rustdesk_video_save_directory') {
        [void](Invoke-RustDesk $current @(
          '--option',
          'video-save-directory',
          [string]$State.rustdesk_video_save_directory
        ))
      }
      if ($State.rustdesk_service_status -eq 'Running') {
        Start-Service -Name 'RustDesk' -ErrorAction SilentlyContinue
      } elseif ($State.rustdesk_service_status -eq 'Stopped') {
        Stop-Service -Name 'RustDesk' -Force -ErrorAction SilentlyContinue
      }
    }
  } elseif ($current) {
    & $current --uninstall | Out-Null
  }
}

function Assert-InstallInputs {
  if ([string]::IsNullOrWhiteSpace($BaseUrl) -or
      [string]::IsNullOrWhiteSpace($TenantId) -or
      [string]::IsNullOrWhiteSpace($BusinessRefType) -or
      [string]::IsNullOrWhiteSpace($BusinessRefId) -or
      [string]::IsNullOrWhiteSpace($DeviceTokenFile)) {
    throw 'BaseUrl, TenantId, BusinessRefType, BusinessRefId, and DeviceTokenFile are required.'
  }
  $uri = [Uri]$BaseUrl
  if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
    throw 'BaseUrl must be credential-free HTTPS without query or fragment.'
  }
  foreach ($value in @($TenantId, $BusinessRefType, $BusinessRefId)) {
    if ($value -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') {
      throw 'Tenant and business reference values contain unsupported characters.'
    }
  }
  if (-not (Test-Path -LiteralPath $DeviceTokenFile -PathType Leaf)) {
    throw 'DeviceTokenFile does not exist.'
  }
  $tokenItem = Get-Item -LiteralPath $DeviceTokenFile -Force
  if ($tokenItem.LinkType) {
    throw 'DeviceTokenFile must not be a symbolic link.'
  }
  $token = (Get-Content -LiteralPath $DeviceTokenFile -Raw).Trim()
  if ($token.Length -lt 32 -or $token.Length -gt 4096 -or $token -match '\s') {
    throw 'Device token file content is invalid.'
  }
  if ([string]::IsNullOrWhiteSpace($NativeProducerPrincipal) -or
      $NativeProducerPrincipal -match '[\r\n]') {
    throw 'NativeProducerPrincipal is invalid.'
  }
  foreach ($root in @($NativeFileRoots) + @($NativeRecordingRoots)) {
    if ([string]::IsNullOrWhiteSpace($root) -or
        $root -match '[\r\n\t]' -or
        -not [IO.Path]::IsPathRooted($root)) {
      throw 'Native evidence roots must be absolute paths.'
    }
  }
}

function Install-VerifiedArtifact([string]$Url, [string]$Destination, [string]$ExpectedHash) {
  if (-not (Test-Path -LiteralPath $Destination -PathType Leaf) -or (Get-Sha256 $Destination) -ne $ExpectedHash) {
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
  }
  Assert-Hash $Destination $ExpectedHash
}

function ConvertTo-XmlSafe([string]$Value) {
  return [Security.SecurityElement]::Escape($Value)
}

function Install-Companion([string]$NodePath, [string]$RustDeskId, [string]$RustDeskExe) {
  $packageRoot = Split-Path -Parent $ManifestPath
  $edgeRoot = Join-Path $InstallRoot 'edge'
  New-Item -ItemType Directory -Force -Path $edgeRoot | Out-Null
  Copy-Item -Path (Join-Path $packageRoot 'edge\*') -Destination $edgeRoot -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $packageRoot 'effective-capability-policy.json') -Destination $InstallRoot -Force

  $stateDir = Join-Path $InstallRoot 'state'
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  & icacls $stateDir '/inheritance:r' '/grant:r' 'SYSTEM:(OI)(CI)(F)' 'BUILTIN\Administrators:(OI)(CI)(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to restrict the native session state ACL.' }
  $sessionRegistry = Join-Path $stateDir 'rustdesk-native-sessions.json'
  $preciseDisconnectScript = Join-Path $InstallRoot 'edge\windows\Invoke-IveKitRustDeskSessionDisconnect.ps1'
  $sessionResolverScript = Join-Path $InstallRoot 'edge\windows\Resolve-IveKitRustDeskSession.ps1'
  foreach ($requiredScript in @($preciseDisconnectScript, $sessionResolverScript)) {
    if (-not (Test-Path -LiteralPath $requiredScript -PathType Leaf)) {
      throw "Packaged RustDesk native session component is missing: $requiredScript"
    }
  }

  $nativeEventDir = Join-Path $InstallRoot 'native-evidence\events'
  $nativeSpoolDir = Join-Path $InstallRoot 'native-evidence\spool'
  $nativeCandidateDir = Join-Path $InstallRoot 'native-evidence\candidates'
  $fileRoots = if ($NativeFileRoots.Count -gt 0) {
    @($NativeFileRoots)
  } else {
    @((Join-Path $InstallRoot 'native-evidence\files'))
  }
  $recordingRoots = if ($NativeRecordingRoots.Count -gt 0) {
    @($NativeRecordingRoots)
  } else {
    @((Join-Path $InstallRoot 'native-evidence\recordings'))
  }
  foreach ($directory in @($nativeEventDir, $nativeSpoolDir, $nativeCandidateDir) + $fileRoots + $recordingRoots) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    & icacls $directory '/inheritance:r' '/grant:r' `
      'SYSTEM:(OI)(CI)(F)' 'BUILTIN\Administrators:(OI)(CI)(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to restrict native evidence directory ACL: $directory" }
  }
  foreach ($producerDirectory in @($nativeEventDir, $nativeCandidateDir) + $fileRoots + $recordingRoots) {
    & icacls $producerDirectory '/grant:r' "${NativeProducerPrincipal}:(OI)(CI)(M)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to grant native evidence producer ACL: $producerDirectory" }
  }
  $nativeFileRootsJson = ConvertTo-Json -InputObject @($fileRoots) -Compress
  $nativeRecordingRootsJson = ConvertTo-Json -InputObject @($recordingRoots) -Compress
  $nativeRootsConfig = Join-Path $stateDir 'native-evidence-roots-v1.txt'
  $rootLines = @()
  foreach ($root in $fileRoots) { $rootLines += "file`t$root" }
  foreach ($root in $recordingRoots) { $rootLines += "recording`t$root" }
  $rootsConfigTemp = $nativeRootsConfig + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  $utf8WithoutBom = [Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllLines($rootsConfigTemp, [string[]]$rootLines, $utf8WithoutBom)
  Move-Item -LiteralPath $rootsConfigTemp -Destination $nativeRootsConfig -Force
  & icacls $nativeRootsConfig '/inheritance:r' '/grant:r' `
    'SYSTEM:(R)' 'BUILTIN\Administrators:(R)' "${NativeProducerPrincipal}:(R)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to restrict the native evidence roots config ACL.' }

  $recordingDirectory = [IO.Path]::GetFullPath([string]$recordingRoots[0])
  [void](Invoke-RustDesk $RustDeskExe @('--option', 'video-save-directory', $recordingDirectory))
  $actualRecordingDirectory = Invoke-RustDesk $RustDeskExe @('--option', 'video-save-directory')
  $expectedNormalized = $recordingDirectory.TrimEnd([char[]]@('\', '/'))
  $actualNormalized = ([IO.Path]::GetFullPath($actualRecordingDirectory)).TrimEnd([char[]]@('\', '/'))
  if (-not [string]::Equals($actualNormalized, $expectedNormalized, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'RustDesk video-save-directory drift detected.'
  }

  $secretDir = Join-Path $InstallRoot 'secrets'
  New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
  $tokenPath = Join-Path $secretDir 'edge-token'
  Copy-Item -LiteralPath $DeviceTokenFile -Destination $tokenPath -Force
  & icacls $tokenPath '/inheritance:r' '/grant:r' 'SYSTEM:(R)' 'BUILTIN\Administrators:(R)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to restrict the device token ACL.' }

  $serviceExe = Join-Path $InstallRoot $script:Manifest.companion.service_wrapper.filename
  Install-VerifiedArtifact `
    $script:Manifest.companion.service_wrapper.url `
    $serviceExe `
    $script:Manifest.companion.service_wrapper.sha256

  $templatePath = Join-Path $packageRoot ($script:Manifest.companion.service_name + '.xml.template')
  $xml = Get-Content -LiteralPath $templatePath -Raw
  $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $disconnectArgs = @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $InstallRoot 'edge\adapters\windows-disconnect.ps1'),
    '-Protocol', '{native_control_protocol}', '-CommandId', '{command_id}',
    '-Mode', 'execute', '-ExternalId', '{external_id}', '-TargetId', '{target_id}',
    '-RustDeskId', '{rustdesk_id}', '-ControllerRustDeskId', '{controller_rustdesk_id}',
    '-NativeSessionId', '{native_session_id}',
    '-Reason', '{requested_reason}', '-InteractionId', '{interaction_id}',
    '-ReservationId', '{reservation_id}', '-OwnerEpoch', '{owner_epoch}'
  ) | ConvertTo-Json -Compress
  $restartArgs = @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $InstallRoot 'edge\adapters\windows-restart.ps1'),
    '-Mode', 'execute', '-ExternalId', '{external_id}', '-TargetId', '{target_id}',
    '-RustDeskId', '{rustdesk_id}', '-Reason', '{requested_reason}'
  ) | ConvertTo-Json -Compress
  $replacements = [ordered]@{
    '{{SERVICE_NAME}}' = $script:Manifest.companion.service_name
    '{{NODE_EXE}}' = $NodePath
    '{{INSTALL_ROOT}}' = $InstallRoot
    '{{BASE_URL}}' = $BaseUrl.TrimEnd('/')
    '{{TENANT_ID}}' = $TenantId
    '{{BUSINESS_REF_TYPE}}' = $BusinessRefType
    '{{BUSINESS_REF_ID}}' = $BusinessRefId
    '{{RUSTDESK_ID}}' = $RustDeskId
    '{{DISPLAY_NAME}}' = $DisplayName
    '{{EDGE_INSTANCE_ID}}' = ($env:COMPUTERNAME + '-' + $RustDeskId)
    '{{TOKEN_FILE}}' = $tokenPath
    '{{PLACEMENT_ENABLED}}' = $(if ($script:Manifest.placement.enabled -eq $true) { '1' } else { '0' })
    '{{NATIVE_CONTROL_PROTOCOL}}' = $script:Manifest.companion.native_session_control.protocol
    '{{POWERSHELL_EXE}}' = $powershellExe
    '{{PRECISE_DISCONNECT_SCRIPT}}' = $preciseDisconnectScript
    '{{SESSION_REGISTRY_FILE}}' = $sessionRegistry
    '{{NATIVE_CONTROL_PIPE}}' = $script:Manifest.companion.native_session_control.protocol
    '{{NATIVE_EVIDENCE_EVENT_DIR}}' = $nativeEventDir
    '{{NATIVE_EVIDENCE_CANDIDATE_DIR}}' = $nativeCandidateDir
    '{{NATIVE_EVIDENCE_SPOOL_DIR}}' = $nativeSpoolDir
    '{{NATIVE_FILE_ROOTS_JSON}}' = $nativeFileRootsJson
    '{{NATIVE_RECORDING_ROOTS_JSON}}' = $nativeRecordingRootsJson
    '{{DISCONNECT_ARGS_JSON}}' = $disconnectArgs
    '{{RESTART_ARGS_JSON}}' = $restartArgs
  }
  foreach ($entry in $replacements.GetEnumerator()) {
    $xml = $xml.Replace($entry.Key, (ConvertTo-XmlSafe ([string]$entry.Value)))
  }
  if ($xml -match '{{[A-Z0-9_]+}}') { throw 'Unresolved companion service template placeholder.' }
  $serviceXml = Join-Path $InstallRoot ($script:Manifest.companion.service_name + '.xml')
  Set-Content -LiteralPath $serviceXml -Value $xml -Encoding UTF8
  & $serviceExe install | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to install the iveKit RustDesk companion service.' }
  & $serviceExe start | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to start the iveKit RustDesk companion service.' }
}

function Invoke-InstallOrRepair($Policy) {
  Assert-Administrator
  Assert-InstallInputs
  $nodePath = Resolve-NodeExecutable
  $state = Save-RollbackState $Policy
  try {
    New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot 'cache') | Out-Null
    $installerPath = Join-Path (Join-Path $InstallRoot 'cache') $script:Manifest.rustdesk.installer.filename
    Install-VerifiedArtifact $script:Manifest.rustdesk.installer.url $installerPath $script:Manifest.rustdesk.installer.sha256
    $signature = Get-AuthenticodeSignature -LiteralPath $installerPath
    if ($signature.Status -ne 'Valid' -or
        $signature.SignerCertificate.Subject -notlike ('*' + $script:Manifest.rustdesk.installer.authenticode.publisher_subject_contains + '*')) {
      throw 'RustDesk installer Authenticode validation failed.'
    }
    & $installerPath --silent-install | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'RustDesk silent installation failed.' }
    $rustDeskExe = Wait-RustDeskExecutable
    $version = Invoke-RustDesk $rustDeskExe @('--version')
    if ($version -ne '1.4.9') { throw 'Installed RustDesk version drift detected.' }
    [void](Invoke-RustDesk $rustDeskExe @('--install-service'))
    Start-Service -Name 'RustDesk' -ErrorAction Stop

    $packageRoot = Split-Path -Parent $ManifestPath
    $networkConfigPath = Join-Path $packageRoot $script:Manifest.rustdesk.network_config.path
    Assert-Hash $networkConfigPath $script:Manifest.rustdesk.network_config.sha256
    $networkConfig = (Get-Content -LiteralPath $networkConfigPath -Raw).Trim()
    [void](Invoke-RustDesk $rustDeskExe @('--config', $networkConfig))
    Apply-AndVerifyOptions $rustDeskExe $Policy
    $rustDeskId = Invoke-RustDesk $rustDeskExe @('--get-id')
    if ($rustDeskId -notmatch '^\d{6,20}$') { throw 'RustDesk returned an invalid runtime ID.' }
    Install-Companion $nodePath $rustDeskId $rustDeskExe
    [pscustomobject]@{
      mode = $Mode
      status = 'ready_for_real_acceptance'
      rustdesk_id = $rustDeskId
      client_version = $version
      service = $script:Manifest.companion.service_name
      native_session_control = $script:Manifest.companion.native_session_control.protocol
      real_windows_acceptance = 'not_run'
    } | ConvertTo-Json -Depth 5
  } catch {
    Restore-IveKitRollback $state
    throw
  }
}

Assert-WindowsX64
$script:Manifest = Read-Manifest
Assert-PackageFiles $script:Manifest
$policy = Read-CapabilityPolicy $script:Manifest

if ($Mode -eq 'validate') {
  $nodePath = Resolve-NodeExecutable
  [pscustomobject]@{
    mode = 'validate'
    status = 'passed'
    source_commit = $script:Manifest.source_commit
    node = $nodePath
    client_version = $script:Manifest.rustdesk.client_version
    server_version = $script:Manifest.rustdesk.server_version
    real_windows_acceptance = 'not_run'
  } | ConvertTo-Json -Depth 5
  exit 0
}

if ($Mode -eq 'uninstall') {
  Assert-Administrator
  $statePath = Join-Path $InstallRoot 'rollback-state.json'
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    throw 'rollback-state.json is required for safe uninstall.'
  }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  Restore-IveKitRollback $state
  [pscustomobject]@{ mode = 'uninstall'; status = 'restored' } | ConvertTo-Json
  exit 0
}

Invoke-InstallOrRepair $policy
