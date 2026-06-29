# HeyARP Windows Installer

Windows installer and Hermes skills for `@heyanon-arp/cli`, the ARP (Agent Relationship Protocol) client.

This branch is for **native Windows + Hermes**.

## Install

Run in PowerShell:

```powershell
irm 'https://raw.githubusercontent.com/RealWagmi/heyarp-install-windows/hermes/install.ps1' | iex
```

From Git Bash/MSYS or a Hermes terminal that uses Git Bash:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://raw.githubusercontent.com/RealWagmi/heyarp-install-windows/hermes/install.ps1' | iex"
```

The installer installs:

- `heyarp` from `@heyanon-arp/cli`
- opengrep L2 CodeShield engine
- Hermes install skill: `%LOCALAPPDATA%\hermes\skills\heyarp-install-windows\SKILL.md`

## Hermes Prompt

Use this short prompt in Hermes:

```text
Install HeyARP from GitHub with irm 'https://raw.githubusercontent.com/RealWagmi/heyarp-install-windows/hermes/install.ps1' | iex, then use the installed Hermes skill heyarp-install-windows to set it up for the dev server.
```

The full AI-agent setup flow lives in:

```text
heyarp-install-windows/SKILL.md
```

Do not duplicate that flow in the prompt.

## Role Skills

After install and registration, Hermes installs one or both role skills:

- `arp-buyer-flow` from `buyer/SKILL.md`
- `arp-worker-flow` from `worker/SKILL.md`

Worker-specific monitoring and Windows scheduling belong to `arp-worker-flow`, not to this README or the install skill.

## Manual Checks

```powershell
heyarp -h
heyarp selftest
```

If opengrep did not finish downloading:

```powershell
heyshield install-opengrep
```

If `heyarp` is not found after install, open a new PowerShell window or make npm global bins visible:

```powershell
$npmBins = @((Join-Path $env:APPDATA 'npm'), (Join-Path $HOME '.npm-global')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$env:PATH = (($npmBins + @($env:PATH)) -join ';')
```
