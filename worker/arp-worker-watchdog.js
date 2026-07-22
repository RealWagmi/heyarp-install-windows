#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// Read simple --key value command-line arguments. Repeated options are kept
// as arrays so one worker can publish and enforce more than one exact price.
// Task Scheduler passes options this way, for example:
//   node arp-worker-watchdog.js --workspace C:\path\to\workspace
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      if (out[key] === undefined) out[key] = next;
      else if (Array.isArray(out[key])) out[key].push(next);
      else out[key] = [out[key], next];
      i += 1;
    }
  }
  return out;
}

// Small filesystem helpers. They keep state files durable across ticks and reboots.
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureFile(file) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '', { encoding: 'utf8' });
}

function appendLine(file, line) {
  fs.appendFileSync(file, `${line}\n`, { encoding: 'utf8' });
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
}

// Quote one command argument for Windows shell execution.
// We use this for heyarp commands because npm global commands are often .cmd shims.
function quoteCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

// Run a short command and wait for it to finish.
// The watchdog uses this only for cheap heyarp reads and handshake acceptance.
function runShell(command, args, options = {}) {
  const cmdline = [command, ...args].map(quoteCmdArg).join(' ');
  return spawnSync(cmdline, {
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs || 120000,
    env: process.env,
  });
}

// Run a heyarp command that should return JSON.
// If it fails or returns invalid JSON, log the problem and return an empty list.
// This keeps one bad read from crashing the scheduled monitor tick.
function runHeyarpJson(args, log, label, options = {}) {
  const result = runShell('heyarp', args, options);
  if (result.error) {
    log(`${label} failed: ${result.error.message}`);
    return [];
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    log(`${label} exited ${result.status}${stderr ? `: ${stderr}` : ''}`);
    return [];
  }
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    log(`${label} returned invalid JSON: ${error.message}`);
    return [];
  }
}

function withFromDid(args, fromDid) {
  return fromDid ? [...args, '--from-did', fromDid] : args;
}

// Resolve all persistent worker paths.
// Everything under .heyarp-worker survives process exits and PC reboots.
function getStatePaths(args) {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error('USERPROFILE/HOME is not set');
  const stateRoot = args['state-root'] || path.join(home, '.heyarp-worker');
  const runsRoot = path.join(stateRoot, 'runs');
  const logsRoot = path.join(stateRoot, 'logs');
  ensureDir(stateRoot);
  ensureDir(runsRoot);
  ensureDir(logsRoot);
  return {
    stateRoot,
    runsRoot,
    logsRoot,
    seenFile: path.join(stateRoot, 'seen.txt'),
    dispatchedFile: path.join(stateRoot, 'dispatched.txt'),
    monitorLog: path.join(stateRoot, 'monitor.log'),
    monitorLock: path.join(stateRoot, 'monitor.lock'),
  };
}

// Prevent overlapping watchdog ticks.
// Task Scheduler may start a new tick while the previous one is still running.
// The lock makes the new tick exit instead of racing the old one.
function withMonitorLock(paths, fn) {
  const staleMs = 5 * 60 * 1000;
  if (fs.existsSync(paths.monitorLock)) {
    const age = Date.now() - fs.statSync(paths.monitorLock).mtimeMs;
    if (age < staleMs) {
      appendLine(paths.monitorLog, `${new Date().toISOString()} previous tick still running; exit`);
      return;
    }
    fs.rmSync(paths.monitorLock, { force: true });
  }

  const fd = fs.openSync(paths.monitorLock, 'wx');
  try {
    fs.writeFileSync(fd, `pid=${process.pid} started=${new Date().toISOString()}\n`, { encoding: 'utf8' });
    fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(paths.monitorLock, { force: true });
  }
}

// Read dispatched.txt into a map of delegationId -> latest heartbeat epoch.
// The file is append-only during normal operation, so latest timestamp wins.
function readDispatchMap(file) {
  const map = new Map();
  for (const line of readLines(file)) {
    const [delegationId, epochText] = line.split('\t');
    if (!delegationId || !epochText) continue;
    const epoch = Number(epochText);
    if (!Number.isFinite(epoch)) continue;
    const previous = map.get(delegationId) || 0;
    if (epoch > previous) map.set(delegationId, epoch);
  }
  return map;
}

// Ask Windows for a process command line by PID.
// This lets us decide whether a lock file belongs to a real live worker process.
function getProcessCommandLine(pid) {
  if (!pid) return '';
  const ps = [
    '-NoProfile',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CommandLine`,
  ];
  const result = spawnSync('powershell.exe', ps, { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? (result.stdout || '').trim() : '';
}

function killProcessTree(pid, log, reason) {
  if (!pid || pid === process.pid) return false;
  const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const details = [
    (result.stdout || '').trim(),
    (result.stderr || '').trim(),
  ].filter(Boolean).join(' | ');
  if (result.status === 0) {
    log(`killed runner process tree pid=${pid} reason=${reason}${details ? `; ${details}` : ''}`);
    return true;
  }
  log(`failed to kill runner process tree pid=${pid} reason=${reason} exit=${result.status}${details ? `; ${details}` : ''}`);
  return false;
}

function killRelatedDelegationProcesses(delegationId, log, reason) {
  if (!delegationId) return;
  const escaped = delegationId.replace(/'/g, "''");
  const ps = [
    '-NoProfile',
    '-Command',
    [
      `$needle = '${escaped}'`,
      '$self = $PID',
      'Get-CimInstance Win32_Process | Where-Object {',
      '  $_.ProcessId -ne $self -and',
      "  $_.Name -ne 'powershell.exe' -and",
      '  $_.CommandLine -and',
      '  $_.CommandLine.Contains($needle) -and',
      '  ($_.CommandLine.Contains("heyarp") -or $_.CommandLine.Contains("arp-worker-run-codex.js") -or $_.CommandLine.Contains("codex.exe"))',
      '} | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    ].join('; '),
  ];
  const result = spawnSync('powershell.exe', ps, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !(result.stdout || '').trim()) return;

  let rows;
  try {
    rows = JSON.parse(result.stdout);
  } catch (_) {
    return;
  }
  const processes = Array.isArray(rows) ? rows : [rows];
  for (const proc of processes) {
    const pid = Number(proc && proc.ProcessId);
    if (!pid || pid === process.pid) continue;
    const killed = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const details = [
      (killed.stdout || '').trim(),
      (killed.stderr || '').trim(),
    ].filter(Boolean).join(' | ');
    log(`killed related delegation process pid=${pid} name=${proc.Name || ''} reason=${reason} exit=${killed.status}${details ? `; ${details}` : ''}`);
  }
}

// Parse a lock file such as:
//   pid=1234 started=... delegation=... relationship=...
function readLock(lockFile) {
  if (!fs.existsSync(lockFile)) return {};
  const text = fs.readFileSync(lockFile, 'utf8');
  const fields = {};
  for (const part of text.trim().split(/\s+/)) {
    const [key, ...rest] = part.split('=');
    if (key && rest.length) fields[key] = rest.join('=');
  }
  return { text, fields };
}

// Check whether a delegation lock points to a live worker runner.
// A stale lock must not block work forever after a crash or reboot.
function isActiveWorker(lockFile, delegationId) {
  const lock = readLock(lockFile);
  const pid = Number(lock.fields && lock.fields.pid);
  if (!pid || pid === process.pid) return false;
  const commandLine = getProcessCommandLine(pid);
  return commandLine.includes('arp-worker-run-codex.js') && commandLine.includes(delegationId);
}

function terminalReasonFromDelegation(record) {
  if (!record) return '';
  const releaseStatus = String(record.releaseStatus || '').toLowerCase();
  if (['paid', 'refunded'].includes(releaseStatus)) return `releaseStatus=${releaseStatus}`;

  const state = String(record.state || '').toLowerCase();
  if (['cancelled', 'canceled', 'declined', 'failed', 'refunded'].includes(state)) return `delegationState=${state}`;

  return '';
}

function terminalReasonFromEscrow(record) {
  if (!record) return '';
  const state = String(record.state || record.lockState || '').toLowerCase();
  if (['paid', 'refunded', 'cancelled', 'canceled', 'revoked', 'dispute_resolved', 'dispute_closed'].includes(state)) {
    return `escrowState=${state}`;
  }
  return '';
}

const EVM_NETWORK_BY_CAIP2 = {
  'eip155:4663': 'robinhood-mainnet',
  'eip155:46630': 'robinhood-testnet',
};

function settlementAssetId(record) {
  return firstPresent([
    record?.assetId,
    record?.asset_id,
    record?.currencyAssetId,
    record?.currency_asset_id,
    record?.currency?.assetId,
    record?.currency?.asset_id,
  ]);
}

function settlementNetwork(record) {
  const explicit = firstPresent([
    record?.network,
    record?.settlementNetwork,
    record?.currencyNetwork,
    record?.currency?.network,
    record?.escrowLock?.network,
    record?.attachments?.escrow_lock?.network,
  ]);
  if (explicit) return String(explicit).trim().toLowerCase();

  const assetId = String(settlementAssetId(record) || '').trim().toLowerCase();
  const slash = assetId.indexOf('/');
  const caip2 = slash >= 0 ? assetId.slice(0, slash) : assetId;
  return EVM_NETWORK_BY_CAIP2[caip2] || '';
}

function buildEscrowShowArgs(delegationId, record) {
  const assetId = String(settlementAssetId(record) || '').trim().toLowerCase();
  const explicitNetwork = settlementNetwork(record);
  const isEvm = assetId.startsWith('eip155:') || explicitNetwork.startsWith('robinhood-');
  if (isEvm && !explicitNetwork) return null;

  const args = ['escrow', 'show', delegationId];
  if (isEvm) args.push('--network', explicitNetwork);
  args.push('--json');
  return args;
}

function getEconomicTerminalReason(delegationId, relationshipId, fromDid, log) {
  let delegation;
  if (relationshipId) {
    const delegations = runHeyarpJson(withFromDid(['delegations', relationshipId, '--json'], fromDid), log, `delegation terminal read ${delegationId}`);
    delegation = delegations.find((item) => item && item.delegationId === delegationId);
    const reason = terminalReasonFromDelegation(delegation);
    if (reason) return reason;
  }

  const showArgs = buildEscrowShowArgs(delegationId, delegation);
  if (!showArgs) {
    log(`escrow terminal read ${delegationId} skipped: EVM settlement network could not be resolved; keep runner fail-closed`);
    return '';
  }
  const escrowRows = runHeyarpJson(withFromDid(showArgs, fromDid), log, `escrow terminal read ${delegationId}`);
  const escrow = escrowRows[0];
  return terminalReasonFromEscrow(escrow);
}

function cleanupTerminalActiveLocks(paths, fromDid, log) {
  if (!fs.existsSync(paths.runsRoot)) return;
  for (const entry of fs.readdirSync(paths.runsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.lock')) continue;
    const delegationId = entry.name.slice(0, -'.lock'.length);
    const lockFile = path.join(paths.runsRoot, entry.name);
    const lock = readLock(lockFile);
    const pid = Number(lock.fields && lock.fields.pid);
    if (!pid || !isActiveWorker(lockFile, delegationId)) continue;

    const relationshipId = lock.fields && lock.fields.relationship;
    const reason = getEconomicTerminalReason(delegationId, relationshipId, fromDid, log);
    if (!reason) continue;

    killProcessTree(pid, log, `${delegationId}:${reason}`);
    killRelatedDelegationProcesses(delegationId, log, `${delegationId}:${reason}`);
    fs.rmSync(lockFile, { force: true });
    log(`removed terminal runner lock delegation=${delegationId} pid=${pid} reason=${reason}`);
  }
}

// Count live per-delegation jobs by checking lock files against real processes.
// Capacity checks use this so one busy machine does not spawn too many runner jobs.
function countActiveJobs(paths) {
  if (!fs.existsSync(paths.runsRoot)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(paths.runsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.lock')) continue;
    const delegationId = entry.name.slice(0, -'.lock'.length);
    const lockFile = path.join(paths.runsRoot, entry.name);
    if (isActiveWorker(lockFile, delegationId)) count += 1;
  }
  return count;
}

function isAwaitingAcceptance(task) {
  return task.phase === 'awaiting_acceptance'
    || (task.state === 'offered' && task.nextActionOwner === 'me');
}

function normalizeDecimal(value) {
  const text = String(value || '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return '';
  const [whole, fraction = ''] = text.split('.');
  const cleanWhole = whole.replace(/^0+(?=\d)/, '') || '0';
  const cleanFraction = fraction.replace(/0+$/, '');
  return cleanFraction ? `${cleanWhole}.${cleanFraction}` : cleanWhole;
}

function compareDecimal(left, right) {
  const a = normalizeDecimal(left);
  const b = normalizeDecimal(right);
  if (!a || !b) return null;
  const [aWhole, aFraction = ''] = a.split('.');
  const [bWhole, bFraction = ''] = b.split('.');
  const scale = Math.max(aFraction.length, bFraction.length);
  const aScaled = BigInt(`${aWhole}${aFraction.padEnd(scale, '0')}`);
  const bScaled = BigInt(`${bWhole}${bFraction.padEnd(scale, '0')}`);
  if (aScaled === bScaled) return 0;
  return aScaled > bScaled ? 1 : -1;
}

function firstPresent(values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function taskOfferAmount(task) {
  return firstPresent([
    task.amount,
    task.offerAmount,
    task.price?.amount,
    task.offer?.amount,
    task.delegation?.amount,
    task.terms?.amount,
  ]);
}

function taskCurrencyValues(task) {
  const currency = task.currency || task.offerCurrency || task.delegation?.currency || task.terms?.currency || {};
  const network = firstPresent([
    task.network,
    task.settlementNetwork,
    task.currencyNetwork,
    currency.network,
  ]);
  const symbol = firstPresent([
    task.asset,
    task.currencySymbol,
    currency.symbol,
  ]);
  return [
    task.asset,
    task.assetId,
    task.asset_id,
    typeof task.currency === 'string' ? task.currency : '',
    task.currencySymbol,
    task.currencyAsset,
    task.currencyAssetId,
    task.currency_asset_id,
    currency.symbol,
    currency.asset,
    currency.assetId,
    currency.asset_id,
    currency.id,
    symbol && network ? `${symbol}:${network}` : '',
  ].filter((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function hasPrimaryRefusal(paths, delegationId) {
  return fs.existsSync(path.join(paths.logsRoot, `${delegationId}.refusal.txt`));
}

function parseAcceptPolicy(value) {
  const text = String(value || '').trim();
  const separator = text.lastIndexOf(',');
  if (separator <= 0 || separator === text.length - 1) {
    throw new Error(`invalid --accept-policy '${text}'; expected <asset-id>,<amount>`);
  }
  const asset = text.slice(0, separator).trim().toUpperCase();
  const amount = normalizeDecimal(text.slice(separator + 1));
  if (!asset || !amount || compareDecimal(amount, '0') !== 1) {
    throw new Error(`invalid --accept-policy '${text}'; asset and positive decimal amount are required`);
  }
  return { asset, amount };
}

function readAcceptPolicies(args) {
  const configured = args['accept-policy'];
  const values = configured === undefined ? [] : (Array.isArray(configured) ? configured : [configured]);
  if (values.length > 0) return values.map(parseAcceptPolicy);

  // Backward compatibility for existing scheduled tasks.
  return [{
    amount: normalizeDecimal(args['accept-amount'] || process.env.ARP_WORKER_ACCEPT_AMOUNT || '0.1') || '0.1',
    asset: String(args['accept-asset'] || process.env.ARP_WORKER_ACCEPT_ASSET || 'SOL:solana-mainnet').trim().toUpperCase()
      || 'SOL:SOLANA-MAINNET',
  }];
}

function assetMatches(requiredAsset, offeredAssets) {
  const required = String(requiredAsset || '').trim().toUpperCase();
  if (!required) return false;
  for (const offeredAsset of offeredAssets) {
    const offered = String(offeredAsset || '').trim().toUpperCase();
    if (!offered) continue;
    if (offered === required) return true;
  }
  return false;
}

function evaluateAcceptPolicy(task, policy) {
  const amount = normalizeDecimal(taskOfferAmount(task));
  if (!amount) {
    return {
      ok: false,
      reason: 'policy',
      detail: `offer missing amount; required exact ${policy.amount} ${policy.asset}`,
    };
  }

  const currencies = taskCurrencyValues(task).map((value) => String(value).trim().toUpperCase());
  if (!assetMatches(policy.asset, currencies)) {
    return {
      ok: false,
      reason: 'policy',
      detail: `offer asset ${currencies.join('/') || '<missing>'} does not match required ${policy.asset}`,
    };
  }

  const amountCompare = compareDecimal(amount, policy.amount);
  if (amountCompare !== 0) {
    return {
      ok: false,
      reason: amountCompare !== null && amountCompare < 0 ? 'rate_too_low' : 'policy',
      detail: `offer amount ${amount} ${policy.asset} does not match required exact ${policy.amount} ${policy.asset}`,
    };
  }

  return { ok: true, detail: `matches exact ${policy.amount} ${policy.asset}` };
}

function evaluateAcceptPolicies(task, policies) {
  const decisions = policies.map((policy) => evaluateAcceptPolicy(task, policy));
  const accepted = decisions.find((decision) => decision.ok);
  if (accepted) return accepted;

  const currencies = taskCurrencyValues(task).map((value) => String(value).trim().toUpperCase());
  const matchingAssetIndex = policies.findIndex((policy) => assetMatches(policy.asset, currencies));
  if (matchingAssetIndex >= 0) return decisions[matchingAssetIndex];

  return {
    ok: false,
    reason: 'policy',
    detail: `offer asset ${currencies.join('/') || '<missing>'} does not match an accepted exact policy`,
  };
}

function isWaitingForCounterpartyOrChain(task) {
  const phase = String(task.phase || '').toLowerCase();
  const state = String(task.state || '').toLowerCase();
  if (task.nextActionOwner && task.nextActionOwner !== 'me') return true;
  return ['awaiting_fund', 'awaiting_lock'].includes(phase)
    || ['accepted', 'pending_lock_finalization'].includes(state);
}

function classifyFundedState(delegation, escrow) {
  const delegationState = String(delegation?.state || '').toLowerCase();
  const escrowState = String(escrow?.state || escrow?.lockState || '').toLowerCase();
  const terminalDelegationStates = new Set(['cancelled', 'canceled', 'declined', 'failed', 'refunded']);
  const terminalEscrowStates = new Set(['paid', 'refunded', 'cancelled', 'canceled', 'revoked', 'dispute_resolved', 'dispute_closed']);
  const actionableEscrowStates = new Set(['created', 'in_progress', 'submitted', 'disputing']);

  if (!delegation) return { actionable: false, reason: 'delegation-read-missing' };
  if (terminalDelegationStates.has(delegationState)) return { actionable: false, terminal: true, reason: `delegation-${delegationState}` };
  if (!escrow) return { actionable: false, reason: 'escrow-read-missing' };
  if (terminalEscrowStates.has(escrowState)) return { actionable: false, terminal: true, reason: `escrow-${escrowState}` };
  if (!['locked', 'submitted', 'completed', 'disputing'].includes(delegationState)) {
    return { actionable: false, reason: `delegation-${delegationState || 'unknown'}-not-funded` };
  }
  if (!actionableEscrowStates.has(escrowState)) return { actionable: false, reason: `escrow-${escrowState || 'unknown'}-not-actionable` };
  return { actionable: true, escrowState, reason: `funded-${escrowState}` };
}

function readFundedState(relationshipId, delegationId, fromDid, log, task) {
  const delegations = runHeyarpJson(
    withFromDid(['delegations', relationshipId, '--json'], fromDid),
    log,
    `funding delegation read ${delegationId}`,
    { timeoutMs: 30000 },
  );
  const delegation = delegations.find((row) => row?.delegationId === delegationId);
  const settlement = delegation || task;
  const showArgs = buildEscrowShowArgs(delegationId, settlement);
  if (!showArgs) return { actionable: false, reason: 'evm-network-unresolved' };
  const escrowRows = runHeyarpJson(
    withFromDid(showArgs, fromDid),
    log,
    `funding escrow read ${delegationId}`,
    { timeoutMs: 30000 },
  );
  return classifyFundedState(delegation, escrowRows[0]);
}

function isWorkerLine(line) {
  const parts = line.split('\t');
  return parts[0] === 'STALL' || (parts[0] === 'NEW' && parts[2] !== 'handshake');
}

function parseNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Build the argument list for the one-delegation runner process.
// Optional IDs are added only when present so Node receives clean arguments.
function buildWorkerArgs(context, paths, workspace, runnerPath) {
  const workerArgs = [
    runnerPath,
    '--workspace', workspace,
    '--relationship-id', context.relationshipId,
    '--delegation-id', context.delegationId,
    '--state-root', paths.stateRoot,
  ];
  if (context.senderDid) workerArgs.push('--sender-did', context.senderDid);
  if (context.eventId) workerArgs.push('--event-id', context.eventId);
  if (context.requestId) workerArgs.push('--request-id', context.requestId);
  if (context.fromDid) workerArgs.push('--from-did', context.fromDid);
  if (context.maxRuntimeMinutes !== undefined) workerArgs.push('--max-runtime-minutes', String(context.maxRuntimeMinutes));
  return workerArgs;
}

// Start one real worker run for one delegation.
// This does not do the ARP work itself. It starts arp-worker-run-codex.js,
// writes logs, creates a lock, verifies the process stayed alive, then records
// the delegation as dispatched.
function startWorkerRun(context, paths, workspace, log) {
  if (!context.delegationId) throw new Error('cannot start worker run without delegationId');

  const runnerPath = path.join(__dirname, 'arp-worker-run-codex.js');
  if (!fs.existsSync(runnerPath)) throw new Error(`runner script missing at ${runnerPath}`);

  const lockFile = path.join(paths.runsRoot, `${context.delegationId}.lock`);
  const dispatchLog = path.join(paths.logsRoot, `${context.delegationId}.dispatch.log`);
  const stdoutLog = path.join(paths.logsRoot, `${context.delegationId}.runner.stdout.log`);
  const stderrLog = path.join(paths.logsRoot, `${context.delegationId}.runner.stderr.log`);
  const dispatch = (message) => {
    const entry = `${new Date().toISOString()} ${message}`;
    appendLine(dispatchLog, entry);
    log(message);
  };

  // If a lock exists, trust it only when the referenced process is still alive.
  // Otherwise remove it and re-dispatch the work.
  if (fs.existsSync(lockFile)) {
    if (isActiveWorker(lockFile, context.delegationId)) {
      dispatch(`skip duplicate active run for ${context.delegationId}`);
      return false;
    }
    const lockText = fs.readFileSync(lockFile, 'utf8').trim() || '<empty>';
    dispatch(`removing stale lock for ${context.delegationId}; lock='${lockText}'`);
    fs.rmSync(lockFile, { force: true });
  }

  // Start the runner detached so the watchdog can exit quickly.
  // Task Scheduler should run cheap ticks, not long order lifecycles.
  const outFd = fs.openSync(stdoutLog, 'a');
  const errFd = fs.openSync(stderrLog, 'a');
  const workerArgs = buildWorkerArgs(context, paths, workspace, runnerPath);
  dispatch(`starting worker run relationship=${context.relationshipId} delegation=${context.delegationId} runner=${runnerPath}`);

  const child = spawn(process.execPath, workerArgs, {
    detached: true,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
    cwd: workspace,
    env: process.env,
  });
  child.unref();
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  // Store PID metadata so future ticks can detect whether this worker is alive.
  fs.writeFileSync(
    lockFile,
    `pid=${child.pid} started=${new Date().toISOString()} delegation=${context.delegationId} relationship=${context.relationshipId}\n`,
    { encoding: 'utf8' },
  );

  // Give the child a moment to fail fast. If it exits immediately, do not mark
  // the event as handled; throw so a later watchdog tick can retry.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  if (!isActiveWorker(lockFile, context.delegationId)) {
    fs.rmSync(lockFile, { force: true });
    const stdoutTail = readLines(stdoutLog).slice(-20).join(' | ');
    const stderrTail = readLines(stderrLog).slice(-20).join(' | ');
    dispatch(`worker run exited immediately for ${context.delegationId}; stdout=${stdoutTail}; stderr=${stderrTail}`);
    throw new Error(`worker run exited immediately for ${context.delegationId}`);
  }

  // Only after the runner is alive do we mark this delegation/event as handled.
  appendLine(paths.dispatchedFile, `${context.delegationId}\t${Math.floor(Date.now() / 1000)}`);
  if (context.eventId) appendLine(paths.seenFile, context.eventId);
  dispatch(`started worker run for ${context.delegationId} pid=${child.pid}`);
  return true;
}

// Handle one normalized watchdog line.
// STALL starts a replacement worker, ACCEPT accepts a policy-matching offer, DECLINE
// rejects a non-matching offer, and NEW
// either accepts a handshake inline or starts a funded/executable worker run.
function handleLine(line, paths, workspace, log, fromDid, maxRuntimeMinutes) {
  const parts = line.split('\t');
  const kind = parts[0];

  if (kind === 'STALL') {
    return startWorkerRun({
      relationshipId: parts[1],
      delegationId: parts[2],
      fromDid,
      maxRuntimeMinutes,
    }, paths, workspace, log);
  }

  if (kind === 'ACCEPT') {
    const relationshipId = parts[1];
    const delegationId = parts[2];
    const result = runShell('heyarp', withFromDid([
      'delegation',
      'accept',
      relationshipId,
      delegationId,
    ], fromDid));
    if (result.status !== 0) throw new Error(`delegation accept failed: ${(result.stderr || '').trim()}`);
    log(`ACCEPT delegation accepted relationship=${relationshipId} delegation=${delegationId}`);
    return false;
  }

  if (kind === 'DECLINE') {
    const relationshipId = parts[1];
    const delegationId = parts[2];
    const reason = parts[3] || 'policy';
    const detail = parts[4] || 'does not match worker accept policy';
    const result = runShell('heyarp', withFromDid([
      'delegation',
      'decline',
      relationshipId,
      delegationId,
      '--reason',
      reason,
      '--reason-detail',
      detail,
    ], fromDid));
    if (result.status !== 0) throw new Error(`delegation decline failed: ${(result.stderr || '').trim()}`);
    log(`DECLINE delegation declined relationship=${relationshipId} delegation=${delegationId} reason=${reason} detail=${detail}`);
    return false;
  }

  if (kind !== 'NEW') return false;

  const context = {
    relationshipId: parts[1],
    type: parts[2],
    eventId: parts[3],
    senderDid: parts[4],
    delegationId: parts[5],
    requestId: parts[6],
    fromDid,
    maxRuntimeMinutes,
  };

  if (context.type === 'handshake') {
    // Handshakes are cheap and do not need a Codex worker run.
    const result = runShell('heyarp', withFromDid([
      'send-handshake-response',
      context.senderDid,
      '--decision',
      'accept',
      '--notes',
      'Ready to take your order.',
    ], fromDid));
    if (result.status !== 0) throw new Error(`handshake accept failed: ${(result.stderr || '').trim()}`);
    if (context.eventId) appendLine(paths.seenFile, context.eventId);
    log(`NEW handshake accepted event=${context.eventId}`);
    return false;
  }

  return startWorkerRun(context, paths, workspace, log);
}

// Main scheduled tick:
// 1. Load durable state.
// 2. Scan inbox for new handshakes.
// 3. Read the worker's server-computed active task queue.
// 4. Health-check actionable tasks for STALL, then dispatch NEW work.
// 5. Exit quickly so Task Scheduler can call us again next minute.
function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(args.workspace || process.cwd());
  const stallMinutes = parseNonNegativeNumber(args['stall-min'], 3);
  const maxJobs = parseNonNegativeNumber(args['max-jobs'] || process.env.ARP_WORKER_MAX_JOBS, 3);
  const fromDid = args['from-did'] || process.env.ARP_WORKER_FROM_DID || '';
  if (!fromDid) throw new Error('--from-did is required for the worker watchdog');
  const maxRuntimeMinutes = parseNonNegativeNumber(args['max-runtime-minutes'] || process.env.ARP_WORKER_MAX_RUNTIME_MINUTES, 60);
  const acceptPolicies = readAcceptPolicies(args);
  const paths = getStatePaths(args);
  for (const file of [paths.seenFile, paths.dispatchedFile, paths.monitorLog]) ensureFile(file);
  const log = (message) => appendLine(paths.monitorLog, `${new Date().toISOString()} ${message}`);

  withMonitorLock(paths, () => {
    log(`accept policies ${acceptPolicies.map((policy) => `exact_amount=${policy.amount} asset=${policy.asset}`).join('; ')}`);
    // seen.txt prevents processing the same inbox event twice.
    // dispatched.txt tells us which active tasks already have a worker run.
    const seen = new Set(readLines(paths.seenFile));
    const dispatched = readDispatchMap(paths.dispatchedFile);
    const lines = [];
    const queuedDelegations = new Set();

    const pushLine = (parts) => {
      const line = parts.join('\t');
      lines.push(line);
      const kind = parts[0];
      const delegationId = kind === 'STALL' || kind === 'ACCEPT' || kind === 'DECLINE' ? parts[2] : parts[5];
      if (delegationId) queuedDelegations.add(delegationId);
    };

    // Inbox scan only handles fresh handshakes inline. Worker task dispatch is
    // driven by `heyarp tasks --next`, the signed worker-specific active-task
    // route, so the watchdog no longer crawls every relationship/delegation.
    const events = runHeyarpJson(withFromDid(['inbox', '--json'], fromDid), log, 'inbox read');
    events.forEach((event) => {
      const type = event.type;
      const eventId = event.eventId;
      if (type === 'handshake' && eventId && !seen.has(eventId)) {
        pushLine(['NEW', event.relationshipId || '', type || '', eventId, event.senderDid || '', '', '']);
      }
    });

    // Server-side active tasks are scoped to this worker DID and filtered to
    // rows where nextActionOwner=me. It replaces the old relationships ->
    // delegations crawl for normal dispatch, while terminal lock cleanup below
    // handles local runner processes that outlive paid/refunded/canceled jobs.
    const tasks = runHeyarpJson(withFromDid(['tasks', '--next', '--json'], fromDid), log, 'tasks read', {
      timeoutMs: 30000,
    });
    const disputeTasks = runHeyarpJson(withFromDid(['tasks', '--state', 'disputing', '--json'], fromDid), log, 'dispute recovery tasks read', {
      timeoutMs: 30000,
    });
    cleanupTerminalActiveLocks(paths, fromDid, log);
    const now = Math.floor(Date.now() / 1000);
    const stallSeconds = stallMinutes * 60;
    for (const task of tasks) {
      const delegationId = task.delegationId || '';
      const relationshipId = task.relationshipId || '';
      if (!delegationId || !relationshipId || queuedDelegations.has(delegationId)) continue;

      if (isAwaitingAcceptance(task)) {
        const decision = evaluateAcceptPolicies(task, acceptPolicies);
        if (decision.ok) {
          pushLine(['ACCEPT', relationshipId, delegationId, task.state || task.phase || 'offered']);
        } else {
          pushLine(['DECLINE', relationshipId, delegationId, decision.reason, decision.detail]);
        }
        continue;
      }

      if (isWaitingForCounterpartyOrChain(task)) {
        log(`wait delegation=${delegationId} phase=${task.phase || ''} state=${task.state || ''} nextActionOwner=${task.nextActionOwner || ''}; no Codex runner`);
        continue;
      }

      const funded = readFundedState(relationshipId, delegationId, fromDid, log, task);
      if (!funded.actionable) {
        log(`wait delegation=${delegationId}; funded_check=${funded.reason}; no Codex runner`);
        continue;
      }

      if (funded.escrowState === 'created' && hasPrimaryRefusal(paths, delegationId)) {
        log(`wait delegation=${delegationId}; primary preflight refusal is recorded; no Codex redispatch while buyer cancellation is pending`);
        continue;
      }

      if (dispatched.has(delegationId)) {
        const age = now - dispatched.get(delegationId);
        if (age > stallSeconds) {
          const lockFile = path.join(paths.runsRoot, `${delegationId}.lock`);
          if (isActiveWorker(lockFile, delegationId)) {
            log(`heartbeat stale for ${delegationId} age_min=${Math.floor(age / 60)} but runner process is alive; skip STALL`);
          } else {
            pushLine(['STALL', relationshipId, delegationId, task.state || task.phase || 'active', Math.floor(age / 60)]);
          }
        }
      } else {
        pushLine([
          'NEW',
          relationshipId,
          task.phase || task.state || 'task',
          '',
          task.offererDid || '',
          delegationId,
          '',
        ]);
      }
    }

    // `tasks --next` intentionally excludes disputes because neither party is
    // the action owner while the arbiter is deciding. Read them separately so
    // a reboot or crashed runner can restore monitoring without treating the
    // dispute as ordinary new delivery work.
    for (const task of disputeTasks) {
      const delegationId = task.delegationId || '';
      const relationshipId = task.relationshipId || '';
      if (!delegationId || !relationshipId || queuedDelegations.has(delegationId)) continue;

      const funded = readFundedState(relationshipId, delegationId, fromDid, log, task);
      if (!funded.actionable || funded.escrowState !== 'disputing') {
        log(`dispute recovery wait delegation=${delegationId}; funded_check=${funded.reason}; escrow=${funded.escrowState || 'unknown'}; no Codex runner`);
        continue;
      }

      if (dispatched.has(delegationId)) {
        const age = now - dispatched.get(delegationId);
        if (age <= stallSeconds) continue;
        const lockFile = path.join(paths.runsRoot, `${delegationId}.lock`);
        if (isActiveWorker(lockFile, delegationId)) {
          log(`dispute heartbeat stale for ${delegationId} age_min=${Math.floor(age / 60)} but runner process is alive; skip recovery`);
        } else {
          pushLine(['STALL', relationshipId, delegationId, 'dispute-monitoring', Math.floor(age / 60)]);
        }
        continue;
      }

      pushLine([
        'NEW',
        relationshipId,
        'dispute-monitoring',
        '',
        task.offererDid || '',
        delegationId,
        '',
      ]);
    }

    // Idle is the expected common case. Log it and stop.
    if (!lines.length) {
      log('idle');
      return;
    }

    // Recovery first, new work last.
    // Job-starting lines respect capacity. If capacity is full, do not mark
    // the event seen; the next watchdog tick can retry it.
    let activeJobs = countActiveJobs(paths);
    for (const kind of ['STALL', 'DECLINE', 'ACCEPT', 'NEW']) {
      for (const line of lines.filter((candidate) => candidate.startsWith(`${kind}\t`))) {
        if (isWorkerLine(line) && activeJobs >= maxJobs) {
          log(`job capacity full active=${activeJobs} max=${maxJobs}; retry next tick line=${line}`);
          continue;
        }
        log(`handle ${line}`);
        const started = handleLine(line, paths, workspace, log, fromDid, maxRuntimeMinutes);
        if (started) activeJobs += 1;
      }
    }
  });
}

if (require.main === module) try {
  main();
} catch (error) {
  // Last-resort logging. Task Scheduler does not show an interactive error,
  // so write failures to the durable monitor log for later debugging.
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
  const fallbackLog = path.join(home, '.heyarp-worker', 'monitor.log');
  try {
    ensureDir(path.dirname(fallbackLog));
    appendLine(fallbackLog, `${new Date().toISOString()} ERROR ${error.stack || error.message}`);
  } catch (_) {
    // Nothing else to do; Task Scheduler will retry next tick.
  }
  process.exitCode = 1;
}

module.exports = {
  assetMatches,
  buildEscrowShowArgs,
  classifyFundedState,
  compareDecimal,
  evaluateAcceptPolicies,
  evaluateAcceptPolicy,
  hasPrimaryRefusal,
  isWaitingForCounterpartyOrChain,
  normalizeDecimal,
  taskCurrencyValues,
};
