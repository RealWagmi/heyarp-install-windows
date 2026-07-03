#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${line}\n`, { encoding: 'utf8' });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function getStateRoot(args) {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error('USERPROFILE/HOME is not set');
  return args['state-root'] || path.join(home, '.heyarp-worker');
}

function stripLoopArgs(argv) {
  const loopKeys = new Set(['loop-interval-seconds', 'loop-max-ticks']);
  const forwarded = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      forwarded.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (loopKeys.has(key)) {
      if (next && !next.startsWith('--')) i += 1;
      continue;
    }
    forwarded.push(arg);
    if (next && !next.startsWith('--')) {
      forwarded.push(next);
      i += 1;
    }
  }
  return forwarded;
}

function main() {
  const rawArgs = process.argv.slice(2);
  const args = parseArgs(rawArgs);
  const intervalMs = Math.max(1000, Math.round(Number(args['loop-interval-seconds'] || 1) * 1000));
  const maxTicks = Number(args['loop-max-ticks'] || 0);
  const stateRoot = getStateRoot(args);
  const loopLog = path.join(stateRoot, 'watchdog-loop.log');
  const watchdog = path.join(__dirname, 'arp-worker-watchdog.js');
  const watchdogArgs = stripLoopArgs(rawArgs);

  appendLine(loopLog, `${new Date().toISOString()} loop start interval_ms=${intervalMs} watchdog=${watchdog}`);

  let tick = 0;
  while (!maxTicks || tick < maxTicks) {
    tick += 1;
    const started = Date.now();
    const result = spawnSync(process.execPath, [watchdog, ...watchdogArgs], {
      cwd: args.workspace ? path.resolve(args.workspace) : process.cwd(),
      env: process.env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10 * 60 * 1000,
    });
    const durationMs = Date.now() - started;
    const status = result.error ? `error=${result.error.message}` : `exit=${result.status}`;
    const stderr = (result.stderr || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    appendLine(loopLog, `${new Date().toISOString()} tick=${tick} duration_ms=${durationMs} ${status}${stderr ? ` stderr=${stderr}` : ''}`);

    const waitMs = intervalMs - durationMs;
    if (waitMs > 0) sleep(waitMs);
  }

  appendLine(loopLog, `${new Date().toISOString()} loop stop ticks=${tick}`);
}

try {
  main();
} catch (error) {
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
  const fallbackLog = path.join(home, '.heyarp-worker', 'watchdog-loop.log');
  try {
    appendLine(fallbackLog, `${new Date().toISOString()} ERROR ${error.stack || error.message}`);
  } catch (_) {
    // Nothing else to do.
  }
  process.exitCode = 1;
}
