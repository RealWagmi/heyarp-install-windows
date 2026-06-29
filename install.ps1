param(
    [string]$HeyarpInstallTag = $env:HEYARP_INSTALL_TAG,
    [string]$GuideUrl = $(if ($env:HEYARP_GUIDE_URL) { $env:HEYARP_GUIDE_URL } else { 'https://github.com/RealWagmi/heyarp-install-windows#readme' }),
    [switch]$SkipOpengrepInstall,
    [switch]$RequireOpengrep
)

$ErrorActionPreference = 'Stop'

if ($env:HEYSHIELD_SKIP_OPENGREP_INSTALL -eq '1') {
    $SkipOpengrepInstall = $true
}
if ($env:HEYSHIELD_REQUIRE_OPENGREP -eq '1') {
    $RequireOpengrep = $true
}

$CliPackage = '@heyanon-arp/cli'
$PackageSpec = if ($HeyarpInstallTag) { "$CliPackage$HeyarpInstallTag" } else { $CliPackage }

function Write-HeyarpInfo {
    param([string]$Message)
    Write-Host "[heyarp] $Message" -ForegroundColor Cyan
}

function Write-HeyarpOk {
    param([string]$Message)
    Write-Host "[heyarp] $Message" -ForegroundColor Green
}

function Write-HeyarpWarn {
    param([string]$Message)
    Write-Warning "[heyarp] $Message"
}

function Write-HeyarpError {
    param([string]$Message)
    Write-Error "[heyarp] error: $Message"
}

function Add-PathForCurrentProcess {
    param([string]$PathToAdd)
    if (($env:PATH -split ';') -notcontains $PathToAdd) {
        $env:PATH = "$PathToAdd;$env:PATH"
    }
}

function Add-PathForCurrentUser {
    param([string]$PathToAdd)
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $PathToAdd) {
        $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $PathToAdd } else { "$userPath;$PathToAdd" }
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    }
}

function Get-NpmGlobalPrefix {
    try {
        $prefix = (& npm config get prefix).Trim()
        if ($prefix -and $prefix -ne 'undefined') {
            return $prefix
        }
    } catch {
        return $null
    }
}

function Add-NpmGlobalPath {
    $prefix = Get-NpmGlobalPrefix
    if (-not $prefix) {
        return
    }

    Add-PathForCurrentProcess $prefix
    Add-PathForCurrentUser $prefix
    Write-HeyarpInfo "Ensured npm global bin is on PATH: $prefix"
}

Write-HeyarpInfo '================================================================'
Write-HeyarpInfo 'HeyARP installer - installs heyarp (@heyanon-arp/cli) + the opengrep L2 engine.'
Write-HeyarpInfo ''
Write-HeyarpInfo 'MANDATORY: READ THE ONBOARDING GUIDE IN FULL BEFORE INSTALLING.'
Write-HeyarpInfo '  This guide is written for the AI AGENT performing this install.'
Write-HeyarpInfo '  Read it yourself. Do not hand it to the user or ask them to read it.'
Write-HeyarpInfo '  Follow it exactly:'
Write-HeyarpInfo "    $GuideUrl"
Write-HeyarpInfo ''
Write-HeyarpInfo 'ALLOW SEVERAL MINUTES: the opengrep L2 engine is a ~40 MB download.'
Write-HeyarpInfo 'Run this installer with a command timeout of >= 10 min.'
Write-HeyarpInfo '================================================================'
Write-Host ''

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-HeyarpError 'Node.js >= 22 is required and was not found. Install it from https://nodejs.org and re-run.'
    exit 1
}

$nodeMajor = 0
try {
    $nodeVersionText = (& node -v).Trim()
    $nodeMajor = [int](($nodeVersionText.TrimStart('v') -split '\.')[0])
} catch {
    $nodeMajor = 0
}
if ($nodeMajor -lt 22) {
    $nodeVersion = & node -v
    Write-HeyarpError "Node.js >= 22 is required (found $nodeVersion). Upgrade Node and re-run."
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-HeyarpError 'npm is required and was not found.'
    exit 1
}

Write-HeyarpInfo "Installing $PackageSpec (heyarp)..."
$userPrefix = $null
$installed = $false

try {
    & npm install -g $PackageSpec | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $installed = $true
    }
} catch {
    $installed = $false
}

if ($installed) {
    Add-NpmGlobalPath
    Write-HeyarpOk 'heyarp installed.'
} else {
    Write-HeyarpWarn 'Global install failed. Retrying with a Windows user-level npm prefix.'
    $userPrefix = Join-Path $HOME '.npm-global'
    $npmGlobal = $userPrefix
    & npm config set prefix $userPrefix
    Add-PathForCurrentProcess $npmGlobal

    & npm install -g $PackageSpec
    if ($LASTEXITCODE -ne 0) {
        Write-HeyarpError "npm install -g $CliPackage failed. Re-run in an elevated PowerShell, or set a writable npm prefix."
        exit 1
    }

    Add-PathForCurrentUser $npmGlobal
    Write-HeyarpOk "heyarp installed under $userPrefix."
    Write-HeyarpWarn "Added $npmGlobal to the Windows user PATH. Open a new terminal if heyarp is not found later."
}

if ($SkipOpengrepInstall) {
    Write-HeyarpInfo 'HEYSHIELD_SKIP_OPENGREP_INSTALL=1 - skipping the L2 engine.'
} else {
    Write-HeyarpInfo 'Installing the opengrep L2 engine... (~40 MB download - may take a few minutes; do not interrupt)'

    $globalRoot = ''
    try {
        $globalRoot = (& npm root -g).Trim()
    } catch {
        $globalRoot = ''
    }

    $shieldCandidates = @()
    if ($globalRoot) {
        $shieldCandidates += Join-Path $globalRoot '@heyanon-arp\shield'
        $shieldCandidates += Join-Path $globalRoot '@heyanon-arp\cli\node_modules\@heyanon-arp\shield'
    }

    $shield = $shieldCandidates | Where-Object {
        Test-Path -LiteralPath (Join-Path $_ 'scripts\install-opengrep.js')
    } | Select-Object -First 1

    if ($shield) {
        & node (Join-Path $shield 'scripts\install-opengrep.js')
        if ($LASTEXITCODE -eq 0) {
            Write-HeyarpOk 'opengrep installed.'
        } elseif ($RequireOpengrep) {
            Write-HeyarpError 'opengrep install failed and HEYSHIELD_REQUIRE_OPENGREP=1.'
            exit 1
        } else {
            Write-HeyarpWarn 'opengrep install did not complete. L0/L4 still work; L2 stays unavailable until you run: heyshield install-opengrep'
        }
    } else {
        Write-HeyarpWarn 'Could not locate @heyanon-arp/shield to install opengrep. Run heyshield install-opengrep once heyarp is on PATH.'
    }
}

Write-Host ''
Write-HeyarpOk 'Installation complete. Verify with: heyarp -h'
Write-Host ''
Write-HeyarpInfo '================================================================'
Write-HeyarpInfo 'NEXT - DO NOT STOP HERE. Proceed straight to SETUP NOW, in this session.'
Write-HeyarpInfo '  Open the ONBOARDING GUIDE and execute Part 1 (SETUP) step by step.'
Write-HeyarpInfo "    $GuideUrl"
Write-HeyarpInfo ''
Write-HeyarpInfo '  Ask the user ONLY what the guide explicitly requires: the agent NAME'
Write-HeyarpInfo '  and funding the settlement wallet. Everything else is defined in the guide.'
Write-HeyarpInfo ''
Write-HeyarpInfo 'If opengrep (L2) is missing later, run: heyshield install-opengrep'
Write-HeyarpInfo '================================================================'
