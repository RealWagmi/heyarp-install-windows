#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// Delegations in these states are finished from the worker monitor's point of view.
// When the watchdog sees one of them, it removes the delegation from tracking.
const TERMINAL_STATES = new Set(['completed', 'canceled', 'declined', 'refunded']);

// Read simple --key value command-line arguments.
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
      out[key] = next;
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

function writeLines(file, lines) {
  fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '', { encoding: 'utf8' });
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
function runHeyarpJson(args, log, label) {
  const result = runShell('heyarp', args);
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

// Remove a terminal delegation from dispatched.txt.
// This is used for DONE so completed/canceled work stops being health-checked.
function removeDispatched(file, delegationId) {
  writeLines(file, readLines(file).filter((line) => !line.startsWith(`${delegationId}\t`)));
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
  return commandLine.includes('arp-worker-run-claude.js') && commandLine.includes(delegationId);
}

// Count live per-delegation worker runners by checking lock files against real processes.
// Capacity checks use this so one busy machine does not spawn too many Claude Code workers.
function countActiveWorkers(paths) {
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

// Pick a stable age/order value from whatever timestamp shape the server returns.
// Unknown timestamps sort last so known older delegations are dispatched first.
function getDelegationSortTime(delegation) {
  const candidates = [
    delegation.createdAt,
    delegation.created_at,
    delegation.offeredAt,
    delegation.offered_at,
    delegation.updatedAt,
    delegation.updated_at,
    delegation.timestamp,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.MAX_SAFE_INTEGER;
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
  return workerArgs;
}

// Start one real worker run for one delegation.
// This does not do the ARP work itself. It starts arp-worker-run-claude.js,
// writes logs, creates a lock, verifies the process stayed alive, then records
// the delegation as dispatched.
function startWorkerRun(context, paths, workspace, log) {
  if (!context.delegationId) throw new Error('cannot start worker run without delegationId');

  const runnerPath = path.join(__dirname, 'arp-worker-run-claude.js');
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
// DONE cleans tracking, STALL starts a replacement worker, NEW either accepts
// a handshake inline or starts a new worker run.
function handleLine(line, paths, workspace, log, fromDid) {
  const parts = line.split('\t');
  const kind = parts[0];

  if (kind === 'DONE') {
    const delegationId = parts[2];
    removeDispatched(paths.dispatchedFile, delegationId);
    log(`DONE cleaned ${delegationId}`);
    return false;
  }

  if (kind === 'STALL') {
    return startWorkerRun({
      relationshipId: parts[1],
      delegationId: parts[2],
      fromDid,
    }, paths, workspace, log);
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
  };

  if (context.type === 'handshake') {
    // Handshakes are cheap and do not need a Claude Code worker run.
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
// 2. Scan inbox for new actionable events.
// 3. Health-check tracked delegations for DONE or STALL.
// 4. Process lines in DONE -> STALL -> NEW order.
// 5. Exit quickly so Task Scheduler can call us again next minute.
function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(args.workspace || process.cwd());
  const stallMinutes = parseNonNegativeNumber(args['stall-min'], 3);
  const maxWorkers = parseNonNegativeNumber(args['max-workers'] || process.env.ARP_WORKER_MAX_WORKERS, 3);
  const fromDid = args['from-did'] || process.env.ARP_WORKER_FROM_DID || '';
  const paths = getStatePaths(args);
  for (const file of [paths.seenFile, paths.dispatchedFile, paths.monitorLog]) ensureFile(file);
  const log = (message) => appendLine(paths.monitorLog, `${new Date().toISOString()} ${message}`);

  withMonitorLock(paths, () => {
    // seen.txt prevents processing the same inbox event twice.
    // dispatched.txt tells us which delegations already have a worker run.
    const seen = new Set(readLines(paths.seenFile));
    const dispatched = readDispatchMap(paths.dispatchedFile);
    const lines = [];
    const queuedDelegations = new Set();
    const pendingEvents = new Map();
    const discoveredDelegations = new Set();

    const pushLine = (parts) => {
      const line = parts.join('\t');
      lines.push(line);
      const kind = parts[0];
      const delegationId = kind === 'DONE' || kind === 'STALL' ? parts[2] : parts[5];
      if (delegationId) queuedDelegations.add(delegationId);
    };

    // Inbox scan: find fresh handshakes, delegation offers, and work requests.
    // Worker events are not dispatched directly from the inbox page. They feed
    // metadata into the live delegation scan below, so old backlog can run first.
    const events = runHeyarpJson(withFromDid(['inbox', '--json'], fromDid), log, 'inbox read');
    events.forEach((event, index) => {
      const content = event && event.body && event.body.content ? event.body.content : {};
      const type = event.type;
      const eventId = event.eventId;
      const delegationId = event.delegationId || content.delegation_id || '';
      const requestId = event.requestId || content.request_id || '';
      const actionable = type === 'handshake' || type === 'work_request' || (type === 'delegation' && content.action === 'offer');
      if (actionable && eventId && !seen.has(eventId)) {
        if (type === 'handshake') {
          pushLine(['NEW', event.relationshipId || '', type || '', eventId, event.senderDid || '', delegationId, requestId]);
        } else if (delegationId && dispatched.has(delegationId)) {
          appendLine(paths.seenFile, eventId);
          seen.add(eventId);
          log(`inbox event ${eventId} already covered by dispatched delegation ${delegationId}`);
        } else if (delegationId) {
          pendingEvents.set(delegationId, {
            relationshipId: event.relationshipId || '',
            type: type || 'backlog',
            eventId,
            senderDid: event.senderDid || '',
            requestId,
            order: index,
          });
        } else {
          pushLine(['NEW', event.relationshipId || '', type || '', eventId, event.senderDid || '', delegationId, requestId]);
        }
      }
    });

    // Health check: inspect existing relationships and delegations.
    // This is what makes a crashed worker get re-dispatched even if no new
    // inbox event arrives. It also discovers backlog that is older than the
    // latest inbox page, so pending work is dispatched oldest first.
    const relationships = runHeyarpJson(withFromDid(['relationships', '--json'], fromDid), log, 'relationships read');
    const now = Math.floor(Date.now() / 1000);
    const stallSeconds = stallMinutes * 60;
    const backlog = [];
    for (const relationship of relationships) {
      const rel = relationship.relationshipId;
      if (!rel) continue;
      const delegations = runHeyarpJson(withFromDid(['delegations', rel, '--json'], fromDid), log, `delegations read ${rel}`);
      for (const delegation of delegations) {
        const did = delegation.delegationId;
        const state = delegation.state;
        if (!did) continue;
        discoveredDelegations.add(did);
        if (TERMINAL_STATES.has(state)) {
          if (dispatched.has(did)) pushLine(['DONE', rel, did, state]);
        } else if (dispatched.has(did)) {
          const age = now - dispatched.get(did);
          if (age > stallSeconds) {
            const lockFile = path.join(paths.runsRoot, `${did}.lock`);
            if (isActiveWorker(lockFile, did)) {
              log(`heartbeat stale for ${did} age_min=${Math.floor(age / 60)} but runner process is alive; skip STALL`);
            } else {
              pushLine(['STALL', rel, did, state, Math.floor(age / 60)]);
            }
          }
        } else if (!queuedDelegations.has(did)) {
          const pendingEvent = pendingEvents.get(did) || {};
          backlog.push({
            line: [
              'NEW',
              rel,
              pendingEvent.type || 'backlog',
              pendingEvent.eventId || '',
              pendingEvent.senderDid || '',
              did,
              pendingEvent.requestId || '',
            ].join('\t'),
            sortTime: getDelegationSortTime(delegation),
          });
          queuedDelegations.add(did);
        }
      }
    }

    for (const [delegationId, pendingEvent] of pendingEvents.entries()) {
      if (discoveredDelegations.has(delegationId) || queuedDelegations.has(delegationId)) continue;
      backlog.push({
        line: [
          'NEW',
          pendingEvent.relationshipId,
          pendingEvent.type,
          pendingEvent.eventId,
          pendingEvent.senderDid,
          delegationId,
          pendingEvent.requestId,
        ].join('\t'),
        sortTime: Number.MAX_SAFE_INTEGER - (events.length - pendingEvent.order),
      });
      queuedDelegations.add(delegationId);
    }

    backlog
      .sort((a, b) => a.sortTime - b.sortTime)
      .forEach((item) => lines.push(item.line));

    // Idle is the expected common case. Log it and stop.
    if (!lines.length) {
      log('idle');
      return;
    }

    // Cleanup first, recovery second, new work last.
    // Worker-starting lines respect capacity. If capacity is full, do not mark
    // the event seen; the next watchdog tick can retry it.
    let activeWorkers = countActiveWorkers(paths);
    for (const kind of ['DONE', 'STALL', 'NEW']) {
      for (const line of lines.filter((candidate) => candidate.startsWith(`${kind}\t`))) {
        if (isWorkerLine(line) && activeWorkers >= maxWorkers) {
          log(`worker capacity full active=${activeWorkers} max=${maxWorkers}; retry next tick line=${line}`);
          continue;
        }
        log(`handle ${line}`);
        const started = handleLine(line, paths, workspace, log, fromDid);
        if (started) activeWorkers += 1;
      }
    }
  });
}

try {
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
