#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

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

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${line}\n`, { encoding: 'utf8' });
}

function quoteCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function parseNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getStateRoot(args) {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error('USERPROFILE/HOME is not set');
  return args['state-root'] || path.join(home, '.heyarp-worker');
}

function runWatchdog(args, log, reason) {
  const watchdog = path.join(__dirname, 'arp-worker-watchdog.js');
  const watchdogArgs = [watchdog];
  if (args.workspace) watchdogArgs.push('--workspace', path.resolve(args.workspace));
  if (args['state-root']) watchdogArgs.push('--state-root', args['state-root']);
  if (args['from-did']) watchdogArgs.push('--from-did', args['from-did']);
  if (args['openclaw-path']) watchdogArgs.push('--openclaw-path', args['openclaw-path']);
  const openclawAgents = args['openclaw-agent'] === undefined
    ? []
    : (Array.isArray(args['openclaw-agent']) ? args['openclaw-agent'] : [args['openclaw-agent']]);
  for (const agentId of openclawAgents) watchdogArgs.push('--openclaw-agent', agentId);
  if (args['stall-min']) watchdogArgs.push('--stall-min', args['stall-min']);
  if (args['max-jobs']) watchdogArgs.push('--max-jobs', args['max-jobs']);
  if (args['accept-amount']) watchdogArgs.push('--accept-amount', args['accept-amount']);
  if (args['accept-asset']) watchdogArgs.push('--accept-asset', args['accept-asset']);
  const acceptPolicies = args['accept-policy'] === undefined
    ? []
    : (Array.isArray(args['accept-policy']) ? args['accept-policy'] : [args['accept-policy']]);
  for (const policy of acceptPolicies) watchdogArgs.push('--accept-policy', policy);
  if (args['max-runtime-minutes']) watchdogArgs.push('--max-runtime-minutes', args['max-runtime-minutes']);

  const started = Date.now();
  const result = spawnSync(process.execPath, watchdogArgs, {
    cwd: args.workspace ? path.resolve(args.workspace) : process.cwd(),
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10 * 60 * 1000,
  });
  const durationMs = Date.now() - started;
  if (result.error) {
    log(`watchdog reason=${reason} error=${result.error.message} duration_ms=${durationMs}`);
    return false;
  }
  const stderr = (result.stderr || '').trim().replace(/\s+/g, ' ').slice(0, 500);
  log(`watchdog reason=${reason} exit=${result.status} duration_ms=${durationMs}${stderr ? ` stderr=${stderr}` : ''}`);
  return result.status === 0;
}

function startTail(args, log) {
  const tailArgs = ['inbox', '--tail', '--json'];
  if (args['from-did']) tailArgs.push('--from-did', args['from-did']);

  const cmdline = ['heyarp', ...tailArgs].map(quoteCmdArg).join(' ');
  log(`tail start command=${cmdline}`);
  return spawn('cmd.exe', ['/d', '/s', '/c', cmdline], {
    cwd: args.workspace ? path.resolve(args.workspace) : process.cwd(),
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['from-did']) throw new Error('--from-did is required for the SSE worker daemon');

  const stateRoot = getStateRoot(args);
  args['state-root'] = stateRoot;
  ensureDir(stateRoot);
  const logFile = path.join(stateRoot, 'sse-daemon.log');
  const log = (message) => appendLine(logFile, `${new Date().toISOString()} ${message}`);

  const reconcileMs = Math.max(1000, parseNonNegativeNumber(args['reconcile-seconds'], 30) * 1000);
  const activePollMs = Math.max(1000, parseNonNegativeNumber(args['active-poll-seconds'], 2) * 1000);
  const activeWindowMs = Math.max(activePollMs, parseNonNegativeNumber(args['active-window-seconds'], 120) * 1000);
  const backoffMinMs = Math.max(1000, parseNonNegativeNumber(args['tail-restart-min-seconds'], 2) * 1000);
  const backoffMaxMs = Math.max(backoffMinMs, parseNonNegativeNumber(args['tail-restart-max-seconds'], 60) * 1000);

  let activeUntil = 0;
  let tickRunning = false;
  let stopping = false;
  let tail = null;
  let tailBackoffMs = backoffMinMs;
  let lineBuffer = '';
  let keepAlive = null;
  let reconcileTimer = null;
  let activeTimer = null;

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`daemon stopping signal=${signal}`);
    if (reconcileTimer) clearInterval(reconcileTimer);
    if (activeTimer) clearInterval(activeTimer);
    if (keepAlive) clearInterval(keepAlive);
    if (tail?.pid) {
      spawnSync('taskkill.exe', ['/PID', String(tail.pid), '/T', '/F'], {
        encoding: 'utf8',
        windowsHide: true,
      });
    }
    setTimeout(() => process.exit(0), 250).unref();
  };

  const requestTick = (reason, activeWindow) => {
    if (activeWindow) activeUntil = Math.max(activeUntil, Date.now() + activeWindowMs);
    if (tickRunning) {
      log(`watchdog skip reason=${reason} already_running=true`);
      return;
    }
    tickRunning = true;
    setImmediate(() => {
      try {
        runWatchdog(args, log, reason);
      } catch (error) {
        log(`watchdog reason=${reason} threw=${error.stack || error.message}`);
      } finally {
        tickRunning = false;
      }
    });
  };

  const handleTailLine = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      log(`tail invalid_json error=${error.message} line=${line.slice(0, 500)}`);
      return;
    }

    if (event.type === 'tail.started') {
      log(`tail started server=${event.server || ''} signer=${event.signer || ''}`);
      requestTick('tail-start', false);
      return;
    }
    if (event.type === 'connected') {
      log('tail connected');
      tailBackoffMs = backoffMinMs;
      requestTick('tail-connected', false);
      return;
    }
    if (event.type === 'heartbeat') return;
    if (event.type === 'envelope') {
      const data = event.data || {};
      const body = data.body || {};
      const eventId = event.id || data.eventId || '';
      log(`tail envelope event=${eventId} body=${body.type || data.type || ''} relationship=${data.relationshipId || ''}`);
      requestTick(`sse-envelope:${eventId || 'unknown'}`, true);
      return;
    }
    log(`tail event type=${event.type || '<unknown>'}`);
  };

  const attachTail = () => {
    if (stopping) return;
    tail = startTail(args, log);
    lineBuffer = '';

    tail.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8');
      let newline = lineBuffer.indexOf('\n');
      while (newline !== -1) {
        const line = lineBuffer.slice(0, newline).replace(/\r$/, '');
        lineBuffer = lineBuffer.slice(newline + 1);
        handleTailLine(line);
        newline = lineBuffer.indexOf('\n');
      }
    });

    tail.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) log(`tail stderr=${text.replace(/\s+/g, ' ').slice(0, 1000)}`);
    });

    tail.on('error', (error) => {
      log(`tail error=${error.message}`);
    });

    tail.on('exit', (code, signal) => {
      if (stopping) return;
      log(`tail exit code=${code} signal=${signal || ''}; restart_in_ms=${tailBackoffMs}`);
      const waitMs = tailBackoffMs;
      tailBackoffMs = Math.min(backoffMaxMs, tailBackoffMs * 2);
      setTimeout(() => attachTail(), waitMs).unref();
    });
  };

  process.on('SIGTERM', () => shutdown('sigterm'));
  process.on('SIGINT', () => shutdown('sigint'));

  log(`daemon start fromDid=${args['from-did']} reconcile_ms=${reconcileMs} active_poll_ms=${activePollMs} active_window_ms=${activeWindowMs}`);
  requestTick('daemon-start', false);
  attachTail();

  reconcileTimer = setInterval(() => {
    requestTick('reconcile', false);
  }, reconcileMs);

  activeTimer = setInterval(() => {
    if (Date.now() < activeUntil) requestTick('active-poll', false);
  }, activePollMs);

  // Keep the process alive while still letting Node process SSE stdout,
  // timers, and child-process events.
  keepAlive = setInterval(() => {}, 60 * 60 * 1000);
}

try {
  main();
} catch (error) {
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
  const fallbackLog = path.join(home, '.heyarp-worker', 'sse-daemon.log');
  try {
    appendLine(fallbackLog, `${new Date().toISOString()} ERROR ${error.stack || error.message}`);
  } catch (_) {
    // Nothing else to do.
  }
  process.exitCode = 1;
}
