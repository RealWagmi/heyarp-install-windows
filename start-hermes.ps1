param(
    [string]$Path = (Join-Path $HOME 'heyarp-work'),
    [string]$Model,
    [string]$Provider,
    [switch]$NoYolo,
    [switch]$DryRun
)

# Hermes terminal tools expect a Unix-style shell such as bash/sh/zsh.
# On Linux/macOS that shell is normally available at paths like /bin/bash.
# A normal Windows install does not have /bin/bash; Windows shells are
# powershell.exe and cmd.exe. Without a Windows bash path, Hermes can fail
# before a command runs with an error like:
#   execvpe(/bin/bash) failed: No such file or directory
#
# Git for Windows installs Git Bash, usually at:
#   C:\Program Files\Git\bin\bash.exe
#
# This launcher points Hermes at Git Bash via HERMES_GIT_BASH_PATH and uses
# TERMINAL_ENV=local. Hermes then has a working shell bridge on Windows and
# can run Windows commands through it, including:
#   powershell.exe -NoProfile ...
#
# Git Bash is not required by HeyARP itself. It is used here only to make
# Hermes command execution work reliably on Windows.
#
# The default Hermes workspace is %USERPROFILE%\heyarp-work instead of this
# installer repository. ARP order deliverables are normal workspace files, so
# launching Hermes from the installer repo can leave files such as hello.js or
# heyarp-response-*.json beside install.ps1. Pass -Path when you intentionally
# want Hermes to work in a specific project folder.

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

if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Path is not a directory: $Path"
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
