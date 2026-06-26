#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const TERMINAL_STATES = new Set(['completed', 'canceled', 'declined', 'refunded']);

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

function quoteCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

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

function removeDispatched(file, delegationId) {
  writeLines(file, readLines(file).filter((line) => !line.startsWith(`${delegationId}\t`)));
}

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

function isActiveWorker(lockFile, delegationId) {
  const lock = readLock(lockFile);
  const pid = Number(lock.fields && lock.fields.pid);
  if (!pid || pid === process.pid) return false;
  const commandLine = getProcessCommandLine(pid);
  return commandLine.includes('arp-worker-run-codex.js') && commandLine.includes(delegationId);
}

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
  return workerArgs;
}

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

  if (fs.existsSync(lockFile)) {
    if (isActiveWorker(lockFile, context.delegationId)) {
      dispatch(`skip duplicate active run for ${context.delegationId}`);
      return false;
    }
    const lockText = fs.readFileSync(lockFile, 'utf8').trim() || '<empty>';
    dispatch(`removing stale lock for ${context.delegationId}; lock='${lockText}'`);
    fs.rmSync(lockFile, { force: true });
  }

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

  fs.writeFileSync(
    lockFile,
    `pid=${child.pid} started=${new Date().toISOString()} delegation=${context.delegationId} relationship=${context.relationshipId}\n`,
    { encoding: 'utf8' },
  );

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  if (!isActiveWorker(lockFile, context.delegationId)) {
    fs.rmSync(lockFile, { force: true });
    const stdoutTail = readLines(stdoutLog).slice(-20).join(' | ');
    const stderrTail = readLines(stderrLog).slice(-20).join(' | ');
    dispatch(`worker run exited immediately for ${context.delegationId}; stdout=${stdoutTail}; stderr=${stderrTail}`);
    throw new Error(`worker run exited immediately for ${context.delegationId}`);
  }

  appendLine(paths.dispatchedFile, `${context.delegationId}\t${Math.floor(Date.now() / 1000)}`);
  if (context.eventId) appendLine(paths.seenFile, context.eventId);
  dispatch(`started worker run for ${context.delegationId} pid=${child.pid}`);
  return true;
}

function handleLine(line, paths, workspace, log) {
  const parts = line.split('\t');
  const kind = parts[0];

  if (kind === 'DONE') {
    const delegationId = parts[2];
    removeDispatched(paths.dispatchedFile, delegationId);
    log(`DONE cleaned ${delegationId}`);
    return;
  }

  if (kind === 'STALL') {
    startWorkerRun({
      relationshipId: parts[1],
      delegationId: parts[2],
    }, paths, workspace, log);
    return;
  }

  if (kind !== 'NEW') return;

  const context = {
    relationshipId: parts[1],
    type: parts[2],
    eventId: parts[3],
    senderDid: parts[4],
    delegationId: parts[5],
    requestId: parts[6],
  };

  if (context.type === 'handshake') {
    const result = runShell('heyarp', [
      'send-handshake-response',
      context.senderDid,
      '--decision',
      'accept',
      '--notes',
      'Ready to take your order.',
    ]);
    if (result.status !== 0) throw new Error(`handshake accept failed: ${(result.stderr || '').trim()}`);
    if (context.eventId) appendLine(paths.seenFile, context.eventId);
    log(`NEW handshake accepted event=${context.eventId}`);
    return;
  }

  startWorkerRun(context, paths, workspace, log);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(args.workspace || process.cwd());
  const stallMinutes = Number(args['stall-min'] || 5);
  const paths = getStatePaths(args);
  for (const file of [paths.seenFile, paths.dispatchedFile, paths.monitorLog]) ensureFile(file);
  const log = (message) => appendLine(paths.monitorLog, `${new Date().toISOString()} ${message}`);

  withMonitorLock(paths, () => {
    const seen = new Set(readLines(paths.seenFile));
    const dispatched = readDispatchMap(paths.dispatchedFile);
    const lines = [];

    const events = runHeyarpJson(['inbox', '--json'], log, 'inbox read');
    for (const event of events) {
      const content = event && event.body && event.body.content ? event.body.content : {};
      const type = event.type;
      const eventId = event.eventId;
      const delegationId = event.delegationId || content.delegation_id || '';
      const requestId = event.requestId || content.request_id || '';
      const actionable = type === 'handshake' || type === 'work_request' || (type === 'delegation' && content.action === 'offer');
      if (actionable && eventId && !seen.has(eventId)) {
        lines.push(['NEW', event.relationshipId || '', type || '', eventId, event.senderDid || '', delegationId, requestId].join('\t'));
      }
    }

    const relationships = runHeyarpJson(['relationships', '--json'], log, 'relationships read');
    const now = Math.floor(Date.now() / 1000);
    const stallSeconds = stallMinutes * 60;
    for (const relationship of relationships) {
      const rel = relationship.relationshipId;
      if (!rel) continue;
      const delegations = runHeyarpJson(['delegations', rel, '--json'], log, `delegations read ${rel}`);
      for (const delegation of delegations) {
        const did = delegation.delegationId;
        const state = delegation.state;
        if (!did) continue;
        if (TERMINAL_STATES.has(state)) {
          if (dispatched.has(did)) lines.push(['DONE', rel, did, state].join('\t'));
        } else if (dispatched.has(did)) {
          const age = now - dispatched.get(did);
          if (age > stallSeconds) lines.push(['STALL', rel, did, state, Math.floor(age / 60)].join('\t'));
        }
      }
    }

    if (!lines.length) {
      log('idle');
      return;
    }

    for (const kind of ['DONE', 'STALL', 'NEW']) {
      for (const line of lines.filter((candidate) => candidate.startsWith(`${kind}\t`))) {
        log(`handle ${line}`);
        handleLine(line, paths, workspace, log);
      }
    }
  });
}

try {
  main();
} catch (error) {
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
