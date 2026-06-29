$ErrorActionPreference = 'Stop'

$loginOut = Join-Path $env:TEMP 'heyarp-login.out.txt'
$loginErr = Join-Path $env:TEMP 'heyarp-login.err.txt'

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

Start-Process $url

try {
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    $owner.StartPosition = 'CenterScreen'
    $owner.Size = New-Object System.Drawing.Size(1, 1)
    $owner.ShowInTaskbar = $false
    $owner.Opacity = 0
    $owner.Show()
    $owner.Activate()

    [System.Windows.Forms.MessageBox]::Show(
        $owner,
        "HeyARP login opened in your browser.`r`n`r`nIf you do not see it, check your taskbar or browser window.`r`n`r`nThe login URL was copied to clipboard.",
        'HeyARP Login',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
    $owner.Close()
    $owner.Dispose()
} catch {
    Write-Warning "Could not show login popup: $($_.Exception.Message)"
}

Write-Host "LOGIN_URL=$url"
Write-Host "LOGIN_PID=$($process.Id)"
Write-Host "Opened browser with the login URL and copied it to clipboard."
Write-Host "Stop now and wait for the user to approve in the browser."
