$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'Atingaii/UsageMesh'
$DefaultReleaseBase = "https://github.com/$Repo/releases/latest/download"
$Base = if ($env:USAGEMESH_RELEASE_BASE) { $env:USAGEMESH_RELEASE_BASE.TrimEnd('/') } else { $DefaultReleaseBase }

if ($PSVersionTable.PSEdition -eq 'Desktop') {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch {}
}

function Get-UsageMeshArchitecture {
  $raw = $env:PROCESSOR_ARCHITEW6432
  if ([string]::IsNullOrWhiteSpace($raw)) { $raw = $env:PROCESSOR_ARCHITECTURE }
  if (-not [string]::IsNullOrWhiteSpace($raw)) {
    switch ($raw.Trim().ToUpperInvariant()) {
      'AMD64' { return 'x64' }
      'ARM64' { return 'arm64' }
      'X86' {
        if ([Environment]::Is64BitOperatingSystem) { return 'x64' }
        return 'x86'
      }
    }
  }
  if ([Environment]::Is64BitOperatingSystem) { return 'x64' }
  return 'x86'
}

$Arch = Get-UsageMeshArchitecture
switch ($Arch) {
  'x64' { $AssetArch = 'x86_64' }
  'arm64' { $AssetArch = 'aarch64' }
  default { throw "Unsupported Windows architecture: $Arch (UsageMesh requires 64-bit Windows)" }
}

$Stem = "usagemesh-windows-$AssetArch"
$Asset = "$Stem.zip"
$Checksum = "$Stem.sha256"

$LocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($LocalAppData)) { $LocalAppData = $env:LOCALAPPDATA }
if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
  $profileHome = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  if ([string]::IsNullOrWhiteSpace($profileHome)) { throw 'Cannot determine the current Windows user profile directory.' }
  $LocalAppData = Join-Path $profileHome 'AppData\Local'
}

$InstallDir = if ($env:USAGEMESH_INSTALL_DIR) { $env:USAGEMESH_INSTALL_DIR } else { Join-Path $LocalAppData 'UsageMesh\bin' }
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ("usagemesh-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Temp, $InstallDir | Out-Null

function Normalize-PathEntry([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  try { return ([System.IO.Path]::GetFullPath($Value)).TrimEnd('\').ToLowerInvariant() }
  catch { return $Value.TrimEnd('\').ToLowerInvariant() }
}

function Get-GitHubToken {
  foreach ($name in @('USAGEMESH_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if (-not [string]::IsNullOrWhiteSpace($value)) { return $value.Trim() }
  }
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if ($null -ne $gh) {
    try {
      $token = (& gh auth token 2>$null | Out-String).Trim()
      if (-not [string]::IsNullOrWhiteSpace($token)) { return $token }
    } catch {}
  }
  return $null
}

function Download-Direct([string]$Url, [string]$OutFile) {
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
}

function Download-WithGitHubCli([string]$Name, [string]$OutFile) {
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if ($null -eq $gh) { return $false }

  $savedGhToken = $env:GH_TOKEN
  try {
    $token = Get-GitHubToken
    if (-not [string]::IsNullOrWhiteSpace($token)) { $env:GH_TOKEN = $token }
    & gh release download --repo $Repo --pattern $Name --output $OutFile --clobber 2>$null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  } finally {
    $env:GH_TOKEN = $savedGhToken
  }
}

function Download-ReleaseFile([string]$Name, [string]$OutFile) {
  try {
    Download-Direct "$Base/$Name" $OutFile
    return
  } catch {
    if ($env:USAGEMESH_RELEASE_BASE) {
      throw "Failed to download $Name from $Base. $($_.Exception.Message)"
    }
    Write-Host 'Direct latest-release download failed; trying GitHub CLI...'
  }

  if (Download-WithGitHubCli $Name $OutFile) { return }
  throw "Failed to download $Name. If GitHub access is restricted, run 'gh auth login' once and retry."
}

try {
  $Zip = Join-Path $Temp $Asset
  $ChecksumPath = Join-Path $Temp $Checksum
  Download-ReleaseFile $Asset $Zip
  Download-ReleaseFile $Checksum $ChecksumPath

  $Expected = ((Get-Content -Raw $ChecksumPath).Trim() -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($Expected) -or $Expected -ne $Actual) {
    throw "SHA-256 mismatch for $Asset. Expected $Expected, got $Actual"
  }

  Expand-Archive -Force -Path $Zip -DestinationPath $Temp
  $Binary = Join-Path $InstallDir 'usagemesh.exe'
  Copy-Item -Force (Join-Path $Temp 'usagemesh.exe') $Binary

  & $Binary --version
  if ($LASTEXITCODE -ne 0) { throw "Downloaded usagemesh.exe failed to run (exit $LASTEXITCODE)" }

  $Wanted = Normalize-PathEntry $InstallDir
  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($null -eq $UserPath) { $UserPath = '' }
  $UserParts = @($UserPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $UserNormalized = @($UserParts | ForEach-Object { Normalize-PathEntry $_ })
  if ($UserNormalized -notcontains $Wanted) {
    [Environment]::SetEnvironmentVariable('Path', (($UserParts + $InstallDir) -join ';'), 'User')
    Write-Host "Added $InstallDir to your user PATH."
  }

  $ProcessPath = if ($null -eq $env:Path) { '' } else { $env:Path }
  $ProcessParts = @($ProcessPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $ProcessNormalized = @($ProcessParts | ForEach-Object { Normalize-PathEntry $_ })
  if ($ProcessNormalized -notcontains $Wanted) {
    $env:Path = if ($ProcessPath) { "$InstallDir;$ProcessPath" } else { $InstallDir }
  }

  Write-Host "`nInstalled: $Binary"
  $SavedErrorActionPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5.1 promotes native stderr to an ErrorRecord when
    # ErrorActionPreference is Stop. `status` legitimately writes a diagnostic
    # when this is a fresh install, so probe it non-fatally and use its exit code.
    $ErrorActionPreference = 'SilentlyContinue'
    & $Binary status 1>$null 2>$null
    $StatusExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $SavedErrorActionPreference
  }
  $Configured = ($StatusExitCode -eq 0)
  if ($Configured) {
    Write-Host 'Existing UsageMesh configuration detected on this machine.'
    Write-Host 'Refresh historical accounting after an upgrade with:'
    Write-Host '  usagemesh sync --full'
  } else {
    Write-Host 'No local UsageMesh configuration detected on this machine.'
    Write-Host 'If this is the FIRST device for a new workspace:'
    Write-Host '  usagemesh setup'
    Write-Host 'If another device already owns the workspace, DO NOT run setup here.'
    Write-Host "Run 'usagemesh invite' on the existing device and paste its complete"
    Write-Host "'usagemesh join ...' command on this machine."
  }
}
finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Temp
}
