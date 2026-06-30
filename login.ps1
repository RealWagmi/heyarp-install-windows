$ErrorActionPreference = 'Stop'

$loginOut = Join-Path $env:TEMP 'heyarp-login.out.txt'
$loginErr = Join-Path $env:TEMP 'heyarp-login.err.txt'

function Open-LoginUrl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url
    )

    $rundll32 = Join-Path $env:SystemRoot 'System32\rundll32.exe'
    Start-Process -FilePath $rundll32 -ArgumentList 'url.dll,FileProtocolHandler', $Url
}

Remove-Item -LiteralPath $loginOut, $loginErr -ErrorAction SilentlyContinue

$process = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c', 'heyarp login' `
    -RedirectStandardOutput $loginOut `
    -RedirectStandardError $loginErr `
    -WindowStyle Hidden `
    -PassThru

$url = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    $text = Get-Content -LiteralPath $loginOut, $loginErr -ErrorAction SilentlyContinue -Raw
    $url = [regex]::Match($text, 'https?://\S+').Value
    if ($url) {
        break
    }
}

if (-not $url) {
    Write-Host "LOGIN_URL_NOT_FOUND"
    Write-Host "LOGIN_PID=$($process.Id)"
    Write-Host "OUT=$loginOut"
    Write-Host "ERR=$loginErr"
    exit 1
}

try {
    Set-Clipboard $url
} catch {
    Write-Warning "Could not copy login URL to clipboard: $($_.Exception.Message)"
}

Open-LoginUrl -Url $url

Write-Host "LOGIN_URL=$url"
Write-Host "LOGIN_PID=$($process.Id)"
Write-Host "Opened browser with the login URL and copied it to clipboard."
Write-Host "Stop now and wait for the user to approve in the browser."
