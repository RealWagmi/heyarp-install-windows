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
  fs.appendFileSync(file, `${line}\n`, { encoding: 'utf8' });
}

function resolveCodex() {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const desktopPath = path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe');
    if (fs.existsSync(desktopPath)) return desktopPath;
  }
  const result = spawnSync('where', ['codex'], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0) {
    const first = (result.stdout || '').split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  }
  throw new Error('codex executable not found');
}

function requireArg(args, name) {
  const value = args[name];
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function buildPrompt(context) {
  return `You are the HeyARP worker run for one delegation.

Read the arp-worker-flow skill, then resume idempotently from live HeyARP state.

Context:
- relationshipId: ${context.relationshipId}
- delegationId: ${context.delegationId}
- senderDid: ${context.senderDid || ''}
- eventId: ${context.eventId || ''}
- requestId: ${context.requestId || ''}
- fromDid: ${context.fromDid || ''}

Required behavior:
1. Read live state with heyarp delegations, heyarp escrow show, heyarp work-list, and heyarp receipts${context.fromDid ? `, always passing --from-did ${context.fromDid}` : ''}.
2. If delegation is offered, run: heyarp delegation accept ${context.relationshipId} ${context.delegationId}${context.fromDid ? ` --from-did ${context.fromDid}` : ''}
3. Wait for delegation.locked.
4. If escrow state is created, run: heyarp escrow accept ${context.delegationId}${context.fromDid ? ` --from-did ${context.fromDid}` : ''}
5. Wait for work.requested.
6. Produce the requested deliverable.
7. Respond with heyarp work respond using a UTF-8 no-BOM JSON output file.
8. Submit work on-chain with heyarp escrow submit-work ${context.delegationId}${context.fromDid ? ` --from-did ${context.fromDid}` : ''}.
9. Propose receipt.
10. Wait for release or self-claim when allowed.

Do not repeat non-idempotent actions that live state shows are already done.
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(requireArg(args, 'workspace'));
  const relationshipId = requireArg(args, 'relationship-id');
  const delegationId = requireArg(args, 'delegation-id');
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error('USERPROFILE/HOME is not set');

  const stateRoot = args['state-root'] || path.join(home, '.heyarp-worker');
  const runsRoot = path.join(stateRoot, 'runs');
  const logsRoot = path.join(stateRoot, 'logs');
  ensureDir(runsRoot);
  ensureDir(logsRoot);

  const lockFile = path.join(runsRoot, `${delegationId}.lock`);
  const promptFile = path.join(runsRoot, `${delegationId}.prompt.txt`);
  const finalFile = path.join(logsRoot, `${delegationId}.final.txt`);
  const runnerLog = path.join(logsRoot, `${delegationId}.runner.log`);
  const dispatchedFile = path.join(stateRoot, 'dispatched.txt');
  const codex = resolveCodex();
  const context = {
    relationshipId,
    delegationId,
    senderDid: args['sender-did'],
    eventId: args['event-id'],
    requestId: args['request-id'],
    fromDid: args['from-did'],
  };

  appendLine(runnerLog, `${new Date().toISOString()} start pid=${process.pid} codex=${codex}`);
  fs.writeFileSync(promptFile, buildPrompt(context), { encoding: 'utf8' });

  const heartbeat = setInterval(() => {
    appendLine(dispatchedFile, `${delegationId}\t${Math.floor(Date.now() / 1000)}`);
  }, 60000);
  appendLine(dispatchedFile, `${delegationId}\t${Math.floor(Date.now() / 1000)}`);

  const codexArgs = [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '-C',
    workspace,
    '-c',
    'service_tier="fast"',
    '-m',
    'gpt-5.5',
    '--output-last-message',
    finalFile,
    '-',
  ];

  const child = spawn(codex, codexArgs, {
    cwd: workspace,
    windowsHide: true,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: process.env,
  });
  child.stdin.end(fs.readFileSync(promptFile, 'utf8'));

  child.on('exit', (code, signal) => {
    clearInterval(heartbeat);
    appendLine(runnerLog, `${new Date().toISOString()} codex exit code=${code} signal=${signal || ''}`);
    fs.rmSync(lockFile, { force: true });
    process.exitCode = code || 0;
  });

  child.on('error', (error) => {
    clearInterval(heartbeat);
    appendLine(runnerLog, `${new Date().toISOString()} codex error ${error.stack || error.message}`);
    fs.rmSync(lockFile, { force: true });
    process.exitCode = 1;
  });
}

try {
  main();
} catch (error) {
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
  const fallbackRoot = path.join(home, '.heyarp-worker', 'logs');
  ensureDir(fallbackRoot);
  appendLine(path.join(fallbackRoot, 'worker-runner.error.log'), `${new Date().toISOString()} ${error.stack || error.message}`);
  process.exitCode = 1;
}
