#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
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

function appendJson(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8' });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (_) {
    return 0;
  }
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function trackedProcesses(stateRoot) {
  const root = String(stateRoot);
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$root = ${psLiteral(root)}`,
    '$processes = Get-CimInstance Win32_Process | Where-Object {',
    '  $_.CommandLine -and (',
    '    $_.CommandLine -like "*arp-worker-watchdog*" -or',
    '    $_.CommandLine -like "*arp-worker-run-codex*" -or',
    '    $_.CommandLine -like "*arp-worker-metrics-logger*" -or',
    '    $_.CommandLine -like "*codex exec*" -or',
    '    $_.CommandLine -like "*$root*"',
    '  )',
    '} | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,UserModeTime,KernelModeTime',
    '$processes | ConvertTo-Json -Compress',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((processInfo) => {
      const name = String(processInfo.Name || '').toLowerCase();
      // The logger samples through a short-lived PowerShell/WMI query. Exclude
      // that sampling helper so metrics focus on the worker runtime itself.
      return name !== 'powershell.exe';
    });
  } catch (_) {
    return [];
  }
}

function cpuTime100ns(processInfo) {
  return Number(processInfo.UserModeTime || 0) + Number(processInfo.KernelModeTime || 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error('USERPROFILE/HOME is not set');

  const stateRoot = args['state-root'] || path.join(home, '.heyarp-worker');
  const metricsLog = args['metrics-log'] || path.join(stateRoot, 'metrics.log');
  const monitorLog = args['monitor-log'] || path.join(stateRoot, 'monitor.log');
  const intervalMs = Math.max(1000, Math.round(Number(args['interval-seconds'] || 1) * 1000));
  const maxSamples = Number(args['max-samples'] || 0);
  const cpuCount = Math.max(1, os.cpus().length);

  let previousMonitorSize = fileSize(monitorLog);
  let previousAt = Date.now();
  let previousCpu = new Map();
  let sample = 0;

  appendJson(metricsLog, {
    ts: new Date().toISOString(),
    event: 'metrics-start',
    intervalMs,
    stateRoot,
    monitorLog,
  });

  while (!maxSamples || sample < maxSamples) {
    sample += 1;
    const nowMs = Date.now();
    const elapsedMs = Math.max(1, nowMs - previousAt);
    const monitorSize = fileSize(monitorLog);
    const processes = trackedProcesses(stateRoot);
    let ramBytes = 0;
    let cpuPercent = 0;
    const top = [];

    for (const proc of processes) {
      const pid = Number(proc.ProcessId);
      const ram = Number(proc.WorkingSetSize || 0);
      const totalCpu = cpuTime100ns(proc);
      ramBytes += ram;

      const prevCpu = previousCpu.get(pid);
      const procCpuPercent = prevCpu === undefined
        ? 0
        : Math.max(0, ((totalCpu - prevCpu) / 10000) / elapsedMs / cpuCount * 100);
      cpuPercent += procCpuPercent;
      previousCpu.set(pid, totalCpu);

      top.push({
        pid,
        name: proc.Name,
        ramMb: Math.round((ram / 1024 / 1024) * 10) / 10,
        cpuPercent: Math.round(procCpuPercent * 10) / 10,
      });
    }

    const currentPids = new Set(processes.map((proc) => Number(proc.ProcessId)));
    for (const pid of previousCpu.keys()) {
      if (!currentPids.has(pid)) previousCpu.delete(pid);
    }

    top.sort((a, b) => (b.cpuPercent - a.cpuPercent) || (b.ramMb - a.ramMb));
    appendJson(metricsLog, {
      ts: new Date().toISOString(),
      sample,
      intervalMs,
      trackedProcesses: processes.length,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      ramMb: Math.round((ramBytes / 1024 / 1024) * 10) / 10,
      monitorLogBytes: monitorSize,
      monitorLogGrowthBytes: monitorSize - previousMonitorSize,
      monitorLogGrowthBytesPerSec: Math.round(((monitorSize - previousMonitorSize) / (elapsedMs / 1000)) * 10) / 10,
      topProcesses: top.slice(0, 5),
    });

    previousMonitorSize = monitorSize;
    previousAt = nowMs;
    sleep(intervalMs);
  }

  appendJson(metricsLog, {
    ts: new Date().toISOString(),
    event: 'metrics-stop',
    samples: sample,
  });
}

try {
  main();
} catch (error) {
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
  const fallbackLog = path.join(home, '.heyarp-worker', 'metrics.log');
  try {
    appendJson(fallbackLog, { ts: new Date().toISOString(), event: 'metrics-error', error: error.stack || error.message });
  } catch (_) {
    // Nothing else to do.
  }
  process.exitCode = 1;
}
