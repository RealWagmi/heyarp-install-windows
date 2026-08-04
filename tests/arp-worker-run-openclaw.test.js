#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildOpenClawArgs,
  buildOpenClawInvocation,
  buildPrompt,
  configureHeyarpHome,
  prepareDelegationTaskWorkspace,
  resolveOpenClaw,
  resolveOpenClawAgent,
  validateOpenClawCandidate,
} = require('../worker/arp-worker-run-openclaw');

test('delegation runner pins HEYARP_HOME for the OpenClaw child', () => {
  const previous = process.env.HEYARP_HOME;
  try {
    const args = { 'heyarp-home': 'C:\\Users\\1\\.heyarp-homes\\worker-one' };
    const resolved = configureHeyarpHome(args);
    assert.equal(args['heyarp-home'], resolved);
    assert.equal(process.env.HEYARP_HOME, resolved);
  } finally {
    if (previous === undefined) delete process.env.HEYARP_HOME;
    else process.env.HEYARP_HOME = previous;
  }
});

test('delegation runner rejects a missing pinned HEYARP_HOME', () => {
  assert.throws(() => configureHeyarpHome({}), /--heyarp-home is required/);
});

test('OpenClaw worker prompt uses the v4 primary delegation flow', () => {
  const prompt = buildPrompt({
    relationshipId: 'rel-1',
    delegationId: 'del-1',
    senderDid: 'did:arp:buyer',
    eventId: 'event-1',
    requestId: 'request-1',
    fromDid: 'did:arp:worker',
    refusalLog: 'refusal.log',
  });

  assert.match(prompt, /primary task is already in the accepted delegation row/);
  assert.match(prompt, /heyarp delegation submit del-1/);
  assert.match(prompt, /work requests are revision rounds only/);
  assert.doesNotMatch(prompt, /Before accepting.*wait for work\.requested/);
});

test('worker prompt keeps one process responsive to every delegation turn', () => {
  const prompt = buildPrompt({
    relationshipId: 'rel-1',
    delegationId: 'del-1',
    senderDid: 'did:arp:buyer',
    eventId: 'event-1',
    requestId: 'request-1',
    fromDid: 'did:arp:worker',
    refusalLog: 'refusal.log',
  });

  assert.match(prompt, /This one OpenClaw process owns the complete non-terminal lifecycle/);
  assert.match(prompt, /heyarp status rel-1 --wait --wait-timeout 300 --json --from-did did:arp:worker without --until/);
  assert.match(prompt, /Exit code 124 is a bounded poll timeout/);
  assert.match(prompt, /Do not start or request another OpenClaw worker/);
  assert.doesNotMatch(prompt, /--until cycle\.released/);
});

test('OpenClaw worker prompt settles error revisions with a rejected receipt', () => {
  const prompt = buildPrompt({
    relationshipId: 'rel-1',
    delegationId: 'del-1',
    senderDid: 'did:arp:buyer',
    requestId: 'request-1',
    fromDid: 'did:arp:worker',
    refusalLog: 'refusal.log',
  });

  assert.match(prompt, /revision --error closes that revision and becomes the latest deliverable/);
  assert.match(prompt, /responseError, the receipt MUST use --verdict rejected/);
  assert.match(prompt, /RECEIPT_VERDICT_ERROR_MISMATCH/);
  assert.doesNotMatch(prompt, /does not invalidate the primary deliverable/);
});

test('OpenClaw unattended arguments preserve session, timeout, model, and thinking settings', () => {
  assert.deepEqual(buildOpenClawArgs({
    agentId: 'arp-worker-abcd-1',
    delegationId: 'del-1',
    prompt: 'worker prompt',
  }, {
    OPENCLAW_MODEL: 'provider/test-model',
    OPENCLAW_THINKING: 'high',
  }), [
    'agent',
    '--local',
    '--timeout', '0',
    '--agent', 'arp-worker-abcd-1',
    '--session-key', 'agent:arp-worker-abcd-1:del-1',
    '--message', 'worker prompt',
    '--model', 'provider/test-model',
    '--thinking', 'high',
  ]);
});

test('OpenClaw agent must exist and use the expected worker workspace', () => {
  const result = resolveOpenClawAgent(
    'C:\\Tools\\openclaw.exe',
    'arp-worker-abcd-1',
    'C:\\worker\\arp-worker-abcd-1',
    {
      env: {},
      spawnSync: () => ({
        status: 0,
        stdout: JSON.stringify([
          {
            id: 'arp-worker-abcd-1',
            workspace: 'C:\\worker\\arp-worker-abcd-1',
          },
        ]),
      }),
    },
  );
  assert.deepEqual(result, {
    agentId: 'arp-worker-abcd-1',
    workspace: 'C:\\worker\\arp-worker-abcd-1',
  });

  assert.throws(() => resolveOpenClawAgent(
    'C:\\Tools\\openclaw.exe',
    'arp-worker-abcd-1',
    'C:\\worker\\arp-worker-abcd-1',
    {
      env: {},
      spawnSync: () => ({
        status: 0,
        stdout: JSON.stringify([
          {
            id: 'arp-worker-abcd-1',
            workspace: 'C:\\Users\\person\\.openclaw\\workspace',
          },
        ]),
      }),
    },
  ), /workspace is .* expected/);
});

test('delegation task workspace is cleared before an agent slot is reused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-openclaw-runner-'));
  const taskRoot = path.join(root, 'task');
  fs.mkdirSync(taskRoot);
  fs.writeFileSync(path.join(taskRoot, 'old-buyer-file.txt'), 'old', 'utf8');

  const result = prepareDelegationTaskWorkspace(root, 'new-delegation');
  assert.equal(result, taskRoot);
  assert.equal(fs.existsSync(path.join(taskRoot, 'old-buyer-file.txt')), false);
  assert.equal(fs.readFileSync(path.join(taskRoot, 'DELEGATION.txt'), 'utf8'), 'new-delegation\n');

  fs.writeFileSync(path.join(taskRoot, 'recovery-file.txt'), 'keep', 'utf8');
  prepareDelegationTaskWorkspace(root, 'new-delegation');
  assert.equal(fs.readFileSync(path.join(taskRoot, 'recovery-file.txt'), 'utf8'), 'keep');

  prepareDelegationTaskWorkspace(root, 'different-delegation');
  assert.equal(fs.existsSync(path.join(taskRoot, 'recovery-file.txt')), false);
  assert.equal(fs.readFileSync(path.join(taskRoot, 'DELEGATION.txt'), 'utf8'), 'different-delegation\n');

  fs.rmSync(root, { recursive: true, force: true });
});

test('Windows cmd shim is launched through cmd.exe', () => {
  const invocation = buildOpenClawInvocation('C:\\Tools\\openclaw.cmd', ['agent'], {
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  });

  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', 'C:\\Tools\\openclaw.cmd', 'agent']);
});

test('OpenClaw npm module is launched directly through Node', () => {
  const invocation = buildOpenClawInvocation('C:\\npm\\node_modules\\openclaw\\openclaw.mjs', ['agent'], {
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
  });

  assert.equal(invocation.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(invocation.args, ['C:\\npm\\node_modules\\openclaw\\openclaw.mjs', 'agent']);
});

test('Windows rejects extensionless OpenClaw shims before launch', () => {
  let launched = false;
  const result = validateOpenClawCandidate('C:\\npm\\openclaw', {
    env: {},
    existsSync: () => true,
    statSync: () => ({ isFile: () => true }),
    spawnSync: () => {
      launched = true;
      return { status: 0 };
    },
  });

  assert.equal(result.valid, false);
  assert.match(result.reason, /unsupported Windows file type/);
  assert.equal(launched, false);
});

test('OpenClaw discovery skips unusable candidates and selects a launchable cmd shim', () => {
  const extensionless = 'C:\\npm\\openclaw';
  const brokenExe = 'C:\\WindowsApps\\openclaw.exe';
  const workingCmd = 'C:\\npm\\openclaw.cmd';
  const existing = new Set([extensionless, brokenExe, workingCmd]);
  const result = resolveOpenClaw({
    env: { ComSpec: 'cmd.exe' },
    existsSync: (candidate) => existing.has(candidate),
    statSync: () => ({ isFile: () => true }),
    spawnSync: (command, args) => {
      if (command === 'where.exe') {
        return { status: 0, stdout: `${extensionless}\r\n${brokenExe}\r\n${workingCmd}\r\n` };
      }
      if (command === brokenExe) return { status: 1, stdout: '', stderr: 'Access is denied' };
      if (command === 'cmd.exe' && args[3] === workingCmd) return { status: 0, stdout: 'openclaw-cli 1.0.0' };
      return { status: 1, stdout: '', stderr: 'unexpected candidate' };
    },
  });

  assert.equal(result, workingCmd);
});

test('explicit OpenClaw path fails clearly instead of falling back', () => {
  assert.throws(() => resolveOpenClaw({
    explicitPath: 'C:\\bad\\openclaw.exe',
    env: {},
    existsSync: () => false,
    statSync: () => ({ isFile: () => true }),
    spawnSync: () => ({ status: 0 }),
  }), /--openclaw-path is not a usable OpenClaw executable/);
});
