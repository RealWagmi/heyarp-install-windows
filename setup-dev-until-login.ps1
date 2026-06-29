$ErrorActionPreference = 'Stop'

$branch = if ($env:HEYARP_INSTALL_WINDOWS_BRANCH) { $env:HEYARP_INSTALL_WINDOWS_BRANCH } else { 'hermes' }
$rawBase = "https://raw.githubusercontent.com/RealWagmi/heyarp-install-windows/$branch"

function Write-HeyarpStep {
    param([string]$Message)
    Write-Host "[heyarp-setup] $Message" -ForegroundColor Cyan
}

function Add-PathIfPresent {
    param([string]$PathToAdd)
    if ($PathToAdd -and (Test-Path -LiteralPath $PathToAdd) -and (($env:PATH -split ';') -notcontains $PathToAdd)) {
        $env:PATH = "$PathToAdd;$env:PATH"
    }
}

Write-HeyarpStep "Installing HeyARP from $branch..."
$env:HEYARP_GUIDE_URL = "https://github.com/RealWagmi/heyarp-install-windows/tree/$branch#readme"
Invoke-RestMethod -Uri "$rawBase/install.ps1" | Invoke-Expression

Write-HeyarpStep 'Refreshing npm global paths for this PowerShell process...'
$npmBins = @(
    (Join-Path $env:APPDATA 'npm'),
    (Join-Path $HOME '.npm-global')
)
foreach ($npmBin in $npmBins) {
    Add-PathIfPresent $npmBin
}

if (-not (Get-Command heyarp -ErrorAction SilentlyContinue)) {
    throw 'heyarp was installed, but the command is still not available on PATH in this shell.'
}

Write-HeyarpStep 'Configuring HeyARP for dev server...'
heyarp config set server https://dev.api.heyanon.ai/arp
heyarp config set rpcUrl https://api.devnet.solana.com

Write-HeyarpStep 'Starting login helper. It will open the browser, copy the URL, print LOGIN_URL, then exit.'
Invoke-RestMethod -Uri "$rawBase/login.ps1" | Invoke-Expression

Write-HeyarpStep 'Stop here. Approve the login in the browser, then continue README.md from after login.'
