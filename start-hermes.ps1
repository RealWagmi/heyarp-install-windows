param(
    [string]$Path = (Get-Location).Path,
    [string]$Model,
    [string]$Provider,
    [switch]$NoYolo,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Find-GitBash {
    $candidates = @(
        $env:HERMES_GIT_BASH_PATH,
        'C:\Program Files\Git\bin\bash.exe',
        'C:\Program Files (x86)\Git\bin\bash.exe',
        'C:\Program Files\Git\usr\bin\bash.exe',
        'C:\Program Files (x86)\Git\usr\bin\bash.exe'
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    $command = Get-Command bash.exe -ErrorAction SilentlyContinue
    if ($command -and (Test-Path -LiteralPath $command.Source)) {
        return $command.Source
    }

    return $null
}

if (-not (Get-Command hermes -ErrorAction SilentlyContinue)) {
    throw 'Hermes CLI was not found on PATH. Install Hermes first, then rerun this launcher.'
}

$gitBash = Find-GitBash
if (-not $gitBash) {
    throw 'Git Bash was not found. Install Git for Windows from https://git-scm.com/download/win, then rerun this launcher.'
}

if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Path does not exist or is not a directory: $Path"
}

$env:HERMES_GIT_BASH_PATH = $gitBash
$env:TERMINAL_ENV = 'local'

Set-Location -LiteralPath $Path

$args = @('chat', '--tui', '-t', 'terminal,file,skills')
if ($Provider) {
    $args += @('--provider', $Provider)
}
if ($Model) {
    $args += @('-m', $Model)
}
if (-not $NoYolo) {
    $args += '--yolo'
}

Write-Host "[hermes] Git Bash: $gitBash" -ForegroundColor Cyan
Write-Host "[hermes] Working directory: $((Get-Location).Path)" -ForegroundColor Cyan
Write-Host "[hermes] Starting: hermes $($args -join ' ')" -ForegroundColor Cyan

if ($DryRun) {
    return
}

& hermes @args
