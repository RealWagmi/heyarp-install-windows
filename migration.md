# Migration: Node-based Windows worker watchdog

Date: 2026-06-26

## Summary

The Windows worker flow now keeps Windows Task Scheduler only as the durable reboot-safe launcher, and moves the worker watchdog/runner logic into Node.js.

This matches the project requirement that Node.js is already required for `heyarp`, avoids Bash/WSL/Python assumptions, and keeps the per-minute idle tick cheap.

## Changed files

### `worker/arp-worker-watchdog.js`

Added a new Node.js watchdog script.

Important sections:

- Lines 8, 335: defines terminal delegation states and uses them to emit/handle `DONE`.
- Lines 65-79: runs `heyarp ... --json` commands and parses JSON safely.
- Lines 105-124: creates a monitor lock so slow scheduled ticks do not overlap.
- Lines 187-248: starts a worker run, handles stale delegation locks, writes dispatch logs, writes PID metadata, and verifies the worker process stayed alive.
- Lines 250-294: handles `DONE`, `STALL`, and `NEW` lines.
- Lines 298-355: main watchdog loop; scans inbox, health-checks relationships/delegations, then processes `DONE -> STALL -> NEW`.

Why:

- Replaces fragile inline PowerShell orchestration with a runtime we already require: Node.js.
- Allows Task Scheduler to survive reboot while Node handles JSON, lock files, dispatch, stale lock cleanup, logs, and retries.
- Keeps idle ticks cheap and exits quickly when there is no work.

### `worker/arp-worker-run-codex.js`

Added a new Node.js runner script for one delegation.

Important sections:

- Lines 33-44: resolves Codex Desktop's `codex.exe` or falls back to `codex` on PATH.
- Lines 53-78: builds the one-order worker prompt with relationship ID, delegation ID, sender DID, event ID, and request ID.
- Lines 81-150: writes prompt/log files, heartbeats to `dispatched.txt`, launches `codex exec`, writes the final message, and removes the lock on exit/error.

Why:

- Keeps the long-running order lifecycle separate from the cheap watchdog tick.
- Makes every order resumable and observable through per-delegation logs.
- Lets the watchdog re-dispatch after crashes or reboot using durable state files.

### `worker/SKILL.md`

Reworked the worker skill so Node.js is the primary implementation.

Important sections:

- Line 3: frontmatter description now states Task Scheduler launches a Node.js watchdog.
- Lines 42-52: core model now shows Task Scheduler -> Node watchdog -> Codex worker run.
- Lines 54-73: framework adapter now explicitly uses Windows Task Scheduler + Node.js + Codex Desktop.
- Lines 87-107: minimal installed layout now includes `arp-worker-watchdog.js`, `arp-worker-watchdog-hidden.vbs`, and `arp-worker-run-codex.js`.
- Lines 110-148: Task Scheduler registration now launches `wscript.exe ...\arp-worker-watchdog-hidden.vbs`, which then runs `node ...\arp-worker-watchdog.js` hidden.
- Lines 123-140: watchdog responsibilities now describe Node-managed dispatch, state files, logs, and diagnostics.
- Lines 156-188: dispatch rules remain `DONE -> STALL -> NEW`, preserving the original worker semantics.
- Lines 190-206: worker-run lifecycle now references `arp-worker-run-codex.js` and its Codex guardrails.
- Lines 275-295: troubleshooting now includes Node watchdog behavior, stale locks, empty `DONE` cleanup, and per-delegation dispatch.

Why:

- The old Windows skill taught inline PowerShell watchdog logic. That worked as a Windows adaptation, but it duplicated orchestration in a shell language even though Node.js is already mandatory.
- The new skill preserves the ARP worker protocol model while making the Windows implementation easier to test, ship, and debug.

### `README.md`

Updated top-level install guidance so worker installs include the Node scripts.

Important sections:

- Line 43: worker skill description now says Task Scheduler launches a Node.js watchdog.
- Lines 283-288: worker install block now downloads:
  - `worker/SKILL.md`
  - `worker/arp-worker-watchdog.js`
  - `worker/arp-worker-watchdog-hidden.vbs`
  - `worker/arp-worker-run-codex.js`
- Line 294: worker setup note now explains that Task Scheduler launches the Node.js watchdog, which polls and dispatches Codex worker runs.

Why:

- Without these downloads, users would install only `SKILL.md`; the Task Scheduler command in the worker skill would reference scripts that do not exist.
- This keeps the README, shipped scripts, and worker skill aligned.

### Follow-up: Windows PATH and Scheduled Task hardening

Updated after live install troubleshooting.

Changed files:

- `README.md` lines 61-75: the PATH trap now adds both `%APPDATA%\npm` and `%USERPROFILE%\.npm-global` when they exist. This covers the normal Windows npm global location and the installer fallback prefix.
- `install.ps1` lines 56-75 and 128-129: the installer now adds npm's actual global prefix to the current process PATH and Windows user PATH after a normal successful install, not only after the `.npm-global` fallback path.
- `worker/SKILL.md` lines 19-24: the prerequisite PATH snippet now uses the same two-path logic.
- `worker/SKILL.md` lines 113-148: watchdog registration now uses PowerShell ScheduledTasks cmdlets instead of `schtasks /Create /TR`, and schedules `wscript.exe` so the watchdog tick is hidden.
- `worker/SKILL.md` lines 167-181: verification/removal commands now use `Start-ScheduledTask`, `Get-ScheduledTask`, `Get-ScheduledTaskInfo`, and `Unregister-ScheduledTask`.
- `worker/arp-worker-watchdog-hidden.vbs`: added a hidden launcher so Task Scheduler does not flash a `node.exe` console window every minute.

Why:

- On Windows, a successful normal npm global install can place shims in `%APPDATA%\npm`, not `%USERPROFILE%\.npm-global`.
- The installer previously added PATH only for the fallback `.npm-global` prefix, so normal successful installs could still leave `heyshield` or other npm shims invisible to later commands.
- `schtasks /TR` can mangle nested quotes when `node.exe` is under `C:\Program Files\nodejs\`. ScheduledTasks cmdlets keep the executable path and arguments separate.
- Directly scheduling `node.exe` can flash a visible console window on every minute tick. Scheduling `wscript.exe` with `arp-worker-watchdog-hidden.vbs` keeps the tick hidden while still running the same Node watchdog.

## Operational behavior after migration

1. Windows Task Scheduler runs every minute.
2. Task Scheduler launches the hidden wrapper:

   ```powershell
   wscript.exe <skillsRoot>\arp-worker-flow\arp-worker-watchdog-hidden.vbs --workspace <workspace>
   ```

3. The hidden wrapper runs `node <skillsRoot>\arp-worker-flow\arp-worker-watchdog.js --workspace <workspace>` with no visible console window.
4. The Node watchdog:
   - reads inbox events;
   - health-checks existing delegations;
   - accepts handshakes inline;
   - starts Codex worker runs for new/stalled work;
   - cleans terminal delegations;
   - writes state/logs under `%USERPROFILE%\.heyarp-worker`.
5. The Node runner:
   - creates a per-delegation Codex prompt;
   - starts `codex exec`;
   - heartbeats while Codex is alive;
   - writes final output and diagnostic logs;
   - removes the lock on exit.

## Compatibility notes

- Node.js remains required by the installer and `heyarp`, so this does not add a new runtime dependency.
- PowerShell remains used for installer/bootstrap commands and Task Scheduler registration.
- Bash, WSL, Git Bash, Python, and POSIX shell behavior are no longer required for the Windows worker watchdog.
- TODO: implement the three placeholder non-Codex runner adapters while keeping the Node watchdog shared:
  - `worker/arp-worker-run-claude.js`
  - `worker/arp-worker-run-hermes.js`
  - `worker/arp-worker-run-openclaw.js`
- TODO: add runner selection, for example with `ARP_WORKER_RUNNER=codex|claude|hermes|openclaw`, so the watchdog can dispatch to the installed runtime.

## Verification performed

- `node --check worker/arp-worker-watchdog.js`
- `node --check worker/arp-worker-run-codex.js`
- Searched README and worker skill for leftover worker-watchdog references to Bash, Python, Hermes, OpenClaw, `.ps1`, `.vbs`, and old `arp_worker_*` script names.
