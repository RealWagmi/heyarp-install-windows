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

function requireArg(args, name) {
  const value = args[name];
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function resolveOpenClaw() {
  if (process.env.OPENCLAW_BIN) {
    return { command: process.env.OPENCLAW_BIN, args: [], shell: false, label: process.env.OPENCLAW_BIN };
  }

  const result = spawnSync('where', ['openclaw'], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0) {
    const first = (result.stdout || '').split(/\r?\n/).find(Boolean);
    if (first) {
      const shimDir = path.dirname(first.trim());
      const modulePath = path.join(shimDir, 'node_modules', 'openclaw', 'openclaw.mjs');
      if (fs.existsSync(modulePath)) {
        return { command: process.execPath, args: [modulePath], shell: false, label: modulePath };
      }
      return { command: first.trim(), args: [], shell: true, label: first.trim() };
    }
  }

  return { command: 'openclaw', args: [], shell: true, label: 'openclaw' };
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
  const openclaw = resolveOpenClaw();
  const context = {
    relationshipId,
    delegationId,
    senderDid: args['sender-did'],
    eventId: args['event-id'],
    requestId: args['request-id'],
    fromDid: args['from-did'],
  };

  const prompt = buildPrompt(context);
  appendLine(runnerLog, `${new Date().toISOString()} start pid=${process.pid} openclaw=${openclaw.label}`);
  fs.writeFileSync(promptFile, prompt, { encoding: 'utf8' });

  const heartbeat = setInterval(() => {
    appendLine(dispatchedFile, `${delegationId}\t${Math.floor(Date.now() / 1000)}`);
  }, 60000);
  appendLine(dispatchedFile, `${delegationId}\t${Math.floor(Date.now() / 1000)}`);

  const openclawArgs = [
    ...openclaw.args,
    'agent',
    '--local',
    '--timeout',
    String(args.timeout || process.env.OPENCLAW_AGENT_TIMEOUT || 3600),
    '--session-key',
    `agent:arp-worker:${delegationId}`,
    '--message',
    prompt,
  ];
  if (args.model || process.env.OPENCLAW_MODEL) {
    openclawArgs.push('--model', args.model || process.env.OPENCLAW_MODEL);
  }
  if (args.thinking || process.env.OPENCLAW_THINKING) {
    openclawArgs.push('--thinking', args.thinking || process.env.OPENCLAW_THINKING);
  }

  const child = spawn(openclaw.command, openclawArgs, {
    cwd: workspace,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    shell: openclaw.shell,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  child.on('exit', (code, signal) => {
    clearInterval(heartbeat);
    fs.writeFileSync(finalFile, stdout || stderr || '', { encoding: 'utf8' });
    appendLine(runnerLog, `${new Date().toISOString()} openclaw exit code=${code} signal=${signal || ''}`);
    fs.rmSync(lockFile, { force: true });
    process.exitCode = code || 0;
  });

  child.on('error', (error) => {
    clearInterval(heartbeat);
    appendLine(runnerLog, `${new Date().toISOString()} openclaw error ${error.stack || error.message}`);
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
