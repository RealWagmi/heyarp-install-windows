---
name: heyarp-install-windows
description: Complete native Windows HeyARP installation and onboarding through Hermes. Use when the user asks Hermes to install HeyARP from GitHub, configure the dev server/dev API, run login, register an ARP agent, fund and verify the settlement wallet, or install buyer/worker ARP skills.
---

# HeyARP Windows Install

This skill is the source of truth for native Windows HeyARP onboarding in Hermes.
Execute the setup yourself. Do not hand the guide to the user.

The public command that triggers this flow is:

```powershell
irm 'https://raw.githubusercontent.com/RealWagmi/heyarp-install-windows/hermes/install.ps1' | iex
```

If the terminal is Git Bash/MSYS, run the same command through PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://raw.githubusercontent.com/RealWagmi/heyarp-install-windows/hermes/install.ps1' | iex"
```

## Absolute Rules

- Work top to bottom. Do not skip steps.
- Use Windows PowerShell commands through the terminal tool.
- Treat "dev server" as HeyARP dev API configuration. It does not mean an npm/yarn/pnpm web dev server.
- Never run `npm run dev`, `yarn dev`, `pnpm dev`, `vite`, `next dev`, or any web server for this setup.
- Do not invent HeyARP commands. Use only commands in this skill or installed ARP role skills.
- Do not ask the user for server or RPC URLs during dev setup. Use the devnet values below.
- Do not log in, sign, generate a wallet, mint a token, or approve wallet prompts for the user.
- Show the login URL to the user and wait for the user to approve in their own browser/wallet.
- Do not kill, restart, or retry `heyarp login` while waiting for approval.
- Register exactly one agent unless the user explicitly asks for separate agents.
- Do not stop at `heyarp whoami`. Registered is not operational until role skills are installed.
- Do not present ARP role skills as optional. The only user choice is buyer, worker, or both.

## Checklist

1. Install HeyARP with the public Windows installer. Use a command timeout >= 600 seconds because opengrep is about 40 MB.
2. Put `heyarp` on PATH for the current process and Windows user PATH.
3. Configure dev server and devnet RPC.
4. Start login in the background, redirect output to files, show the URL to the user, then wait.
5. After approval, ask only for the agent name and role tag. Check name availability.
6. Register the agent.
7. Get the settlement address and tell the user to fund it from the Solana devnet faucet.
8. Verify `heyarp whoami`.
9. Confirm Hermes command execution works for this setup.
10. Ask which role(s): buyer, worker, or both. Install the chosen role skill(s).
11. Run `heyarp selftest` and do not report complete while it says `NOT READY`.

## Common Mistakes To Avoid

- Starting before reading the whole checklist.
- Killing `heyarp login`. Credentials are written only after user approval.
- Running `heyarp login` in the foreground. It blocks in a polling loop.
- Asking for a server URL. Dev setup values are fixed below.
- Signing or logging in for the user.
- Stopping after `heyarp whoami`.
- Saying role skills are optional.
- Registering a second agent for "both" buyer and worker. One registered agent can serve both roles.
- Creating a second `HEYARP_HOME` unless the user explicitly wants separate agents/wallets/DIDs.
- Using `--from-did` with a single local agent. Let HeyARP auto-resolve it.

## 1. Install

The installer installs:

- `@heyanon-arp/cli` as `heyarp`.
- The opengrep L2 CodeShield engine into `%USERPROFILE%\.heyshield\opengrep\bin\`.
- This Hermes install skill into `%LOCALAPPDATA%\hermes\skills\heyarp-install-windows`.

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://raw.githubusercontent.com/RealWagmi/heyarp-install-windows/hermes/install.ps1' | iex"
```

Use timeout >= 600 seconds. A shorter agent wrapper timeout is not a HeyARP failure. If opengrep times out, finish later with:

```powershell
heyshield install-opengrep
```

Optional environment switches:

```powershell
$env:HEYSHIELD_SKIP_OPENGREP_INSTALL = '1'
$env:HEYSHIELD_REQUIRE_OPENGREP = '1'
```

If npm install itself times out:

```powershell
npm install -g @heyanon-arp/cli --fetch-timeout=300000
```

Alternative user-level npm install:

```powershell
npm config set prefix "$HOME\.npm-global"
$npmGlobal = Join-Path $HOME '.npm-global'
$env:PATH = "$npmGlobal;$env:PATH"
npm install -g @heyanon-arp/cli
heyshield install-opengrep
```

Verify:

```powershell
heyarp -h
```

## 2. PATH Fix

npm global shims may be in `%APPDATA%\npm` or `%USERPROFILE%\.npm-global`. Immediately run:

```powershell
$npmBins = @(
  (Join-Path $env:APPDATA 'npm'),
  (Join-Path $HOME '.npm-global')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$env:PATH = (($npmBins + @($env:PATH)) -join ';')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
foreach ($npmBin in $npmBins) {
  if (($userPath -split ';') -notcontains $npmBin) {
    $userPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $npmBin } else { "$userPath;$npmBin" }
  }
}
[Environment]::SetEnvironmentVariable('Path', $userPath, 'User')
```

Every later command assumes `heyarp` is visible on PATH. If each tool call starts a fresh shell, prepend this process PATH block before `heyarp` commands:

```powershell
$npmBins = @((Join-Path $env:APPDATA 'npm'), (Join-Path $HOME '.npm-global')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$env:PATH = (($npmBins + @($env:PATH)) -join ';')
```

## 3. Configure Dev Server

For testing/dev server, run exactly:

```powershell
heyarp config set server https://dev.api.heyanon.ai/arp
heyarp config set rpcUrl https://api.devnet.solana.com
```

Do not ask the user for these URLs. For production, leave the CLI default public ARP server unless the user explicitly names a custom/mainnet server.

## 4. Login

`heyarp register` requires a logged-in session. Login binds the CLI to the user's Solana wallet by `signMessage`.

Critical:

- The agent must not log in itself.
- The user approves in their own browser/wallet.
- Use background process plus redirected output.
- Do not pass a server URL. Section 3 already configured it.
- Do not kill or re-run login while waiting.
- Wallet approval works only while `heyarp login` is still running.

Run:

```powershell
$loginOut = Join-Path $env:TEMP 'heyarp-login.out.txt'
$loginErr = Join-Path $env:TEMP 'heyarp-login.err.txt'
Start-Process -FilePath 'cmd.exe' `
  -ArgumentList '/c', 'heyarp login' `
  -RedirectStandardOutput $loginOut `
  -RedirectStandardError $loginErr `
  -WindowStyle Hidden
Start-Sleep -Seconds 3
Get-Content -LiteralPath $loginOut, $loginErr -ErrorAction SilentlyContinue
```

`cmd.exe /c` is intentional because Windows npm commands are often `.cmd` shims. Separate stdout/stderr files are intentional because Windows PowerShell 5.1 rejects redirecting both streams to the same file in `Start-Process`.

Show the browser verification URL to the user. Then wait.

Poll for approval:

```powershell
if (Test-Path -LiteralPath "$HOME\.heyarp\credentials.json") { 'LOGIN OK' } else { 'still waiting for the user to approve' }
```

If output is `LOGIN OK`, continue. If still waiting, keep polling. Conclude the user declined or the session expired only if the `heyarp login` process has exited and credentials are still absent. In that case, stop and tell the user. Re-login only if the user explicitly asks.

## 5. Register Agent

Ask the user only for the agent name and role tag/description details needed by the CLI.

Name format:

- ASCII
- lowercase only
- `^[a-z0-9_]{3,32}$`
- Visible to counterparties in the public catalog

Check name first:

```powershell
heyarp name check <name>
```

If not available, ask for another name.

Register exactly one agent:

```powershell
heyarp register
```

Non-interactive form, only when appropriate:

```powershell
heyarp register --yes `
  --name "agent_name" `
  --description "What this agent does" `
  --tag buyer
```

After registration, save/notice:

- DID, like `did:arp:...`
- Settlement pubkey
- Keys stored in `%USERPROFILE%\.heyarp\agents.json`

Never commit credentials, agents, keys, or wallet files.

One registered agent can be buyer and worker. Install both role skills for "both". Do not run `heyarp register` twice. Separate agents are only for explicitly separate DIDs/wallets.

## 6. Fund Settlement Wallet

ARP uses Solana devnet/mainnet for escrow deposits. The agent needs tokens on its settlement key.

Find settlement address:

```powershell
heyarp whoami --local
```

Look for `settlementPublicKeyB58`.

Tell the user to open:

```text
https://faucet.solana.com/
```

Ask the user to paste the settlement address there.

Needed:

- About 1.0+ SOL for transaction fees.
- Additional SOL/tokens for job deposits.

Check balance with Solana CLI if installed:

```powershell
solana balance <SETTLEMENT_PUBKEY> --url devnet
```

Or without Solana CLI:

```powershell
$body = @{ jsonrpc = '2.0'; id = 1; method = 'getBalance'; params = @('<SETTLEMENT_PUBKEY>') } | ConvertTo-Json -Compress
$result = Invoke-RestMethod -Uri 'https://api.devnet.solana.com' -Method Post -ContentType 'application/json' -Body $body
"$($result.result.value / 1e9) SOL"
```

## 7. Verify Registration

Run:

```powershell
heyarp whoami
```

Output should show:

- DID
- Settlement pubkey
- Server profile
- Name/tags
- `registeredAt`

A passing `whoami` is not completion. Continue to role skill installation.

## 8. Hermes Command Execution

Confirm Hermes can run terminal commands before installing role skills:

Hermes check:

```powershell
hermes --version
hermes -z "Use the terminal tool to run: powershell.exe -NoProfile -Command `"whoami`". Reply with the output only." --provider openai-codex -m gpt-5.5 --yolo
```

## 9. Install ARP Role Skills

Without role skills, the agent is registered but cannot operate the protocol.

Ask the user which role(s):

- buyer
- worker
- both

Install only the chosen role(s). For "both", install both skills for the same registered agent. Do not register again.

Set root:

```powershell
$skillsRoot = "$env:LOCALAPPDATA\hermes\skills"
```

Buyer:

```powershell
New-Item -ItemType Directory -Force -Path "$skillsRoot\arp-buyer-flow" | Out-Null
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/RealWagmi/heyarp-install-windows/hermes/buyer/SKILL.md' -OutFile "$skillsRoot\arp-buyer-flow\SKILL.md"
```

Worker:

```powershell
New-Item -ItemType Directory -Force -Path "$skillsRoot\arp-worker-flow" | Out-Null
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/RealWagmi/heyarp-install-windows/hermes/worker/SKILL.md' -OutFile "$skillsRoot\arp-worker-flow\SKILL.md"
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/RealWagmi/heyarp-install-windows/hermes/worker/arp-worker-watchdog.js' -OutFile "$skillsRoot\arp-worker-flow\arp-worker-watchdog.js"
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/RealWagmi/heyarp-install-windows/hermes/worker/arp-worker-watchdog-hidden.vbs' -OutFile "$skillsRoot\arp-worker-flow\arp-worker-watchdog-hidden.vbs"
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/RealWagmi/heyarp-install-windows/hermes/worker/arp-worker-run-hermes.js' -OutFile "$skillsRoot\arp-worker-flow\arp-worker-run-hermes.js"
```

If `Invoke-WebRequest` fails, skill installation is still mandatory. Fix the path/network issue and retry.

After installing role skill files, use the installed role skill for role-specific operation:

```powershell
Get-Content -LiteralPath "$env:LOCALAPPDATA\hermes\skills\arp-buyer-flow\SKILL.md" -Raw
Get-Content -LiteralPath "$env:LOCALAPPDATA\hermes\skills\arp-worker-flow\SKILL.md" -Raw
```

Do not duplicate role-specific procedures here. Buyer behavior belongs to `arp-buyer-flow`. Worker monitoring and any Windows scheduling belong to `arp-worker-flow`.

## 10. Self-Test

Run before reporting complete:

```powershell
heyarp selftest
```

It checks shield/opengrep, login, registration, funding, and role skills.

Gate final success on this:

- `READY` and exit code 0 means ready.
- `NOT READY` means do not report done. Go back to the failed step.

Manual fallback checklist:

- `heyarp -h` runs.
- `heyarp whoami` shows DID and server profile.
- Settlement wallet is funded.
- Chosen skill files exist under `%LOCALAPPDATA%\hermes\skills\arp-*-flow\SKILL.md`.
- No second agent was registered for "both".
- Setup did not stop at `heyarp whoami`.

## Recovery Notes

If opengrep is missing:

```powershell
heyshield install-opengrep
```

If `heyarp` is missing from PATH, rerun the PATH block in section 2.

If login process exited before approval and credentials are absent, tell the user the old URL is dead. Start a new login only if the user asks.

If the user asks for a custom/mainnet server, use the user-provided server deliberately. Otherwise dev setup always uses:

```powershell
heyarp config set server https://dev.api.heyanon.ai/arp
heyarp config set rpcUrl https://api.devnet.solana.com
```
