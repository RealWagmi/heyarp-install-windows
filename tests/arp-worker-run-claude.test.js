#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClaudeArgs,
  buildClaudeInvocation,
  buildPrompt,
  configureHeyarpHome,
  resolveClaude,
  validateClaudeCandidate,
} = require('../worker/arp-worker-run-claude');

test('Claude Code worker prompt uses the v4 primary delegation flow', () => {
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

test('delegation runner pins HEYARP_HOME for the Claude Code child', () => {
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

  assert.match(prompt, /This one Claude Code process owns the complete non-terminal lifecycle/);
  assert.match(prompt, /heyarp status rel-1 --wait --wait-timeout 300 --json --from-did did:arp:worker without --until/);
  assert.match(prompt, /Exit code 124 is a bounded poll timeout/);
  assert.match(prompt, /Do not start or request another Claude Code worker/);
  assert.doesNotMatch(prompt, /--until cycle\.released/);
});

test('Claude Code worker prompt settles error revisions with a rejected receipt', () => {
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

test('Claude Code unattended arguments preserve the Claude-specific command shape', () => {
  assert.deepEqual(buildClaudeArgs({ ARP_WORKER_CLAUDE_MODEL: 'claude-test-model' }), [
    '--print',
    '--dangerously-skip-permissions',
    '--output-format', 'text',
    '--no-session-persistence',
    '--model', 'claude-test-model',
  ]);
});

test('Windows cmd shim is launched through cmd.exe', () => {
  const invocation = buildClaudeInvocation('C:\\Tools\\claude.cmd', ['--print'], {
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  });

  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', 'C:\\Tools\\claude.cmd', '--print']);
});

test('Windows rejects extensionless Claude Code shims before launch', () => {
  let launched = false;
  const result = validateClaudeCandidate('C:\\npm\\claude', {
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

test('Claude Code discovery skips unusable candidates and selects a launchable cmd shim', () => {
  const extensionless = 'C:\\npm\\claude';
  const brokenExe = 'C:\\WindowsApps\\claude.exe';
  const workingCmd = 'C:\\npm\\claude.cmd';
  const existing = new Set([extensionless, brokenExe, workingCmd]);
  const result = resolveClaude({
    env: { ComSpec: 'cmd.exe' },
    existsSync: (candidate) => existing.has(candidate),
    statSync: () => ({ isFile: () => true }),
    spawnSync: (command, args) => {
      if (command === 'where.exe') {
        return { status: 0, stdout: `${extensionless}\r\n${brokenExe}\r\n${workingCmd}\r\n` };
      }
      if (command === brokenExe) return { status: 1, stdout: '', stderr: 'Access is denied' };
      if (command === 'cmd.exe' && args[3] === workingCmd) return { status: 0, stdout: 'claude-cli 1.0.0' };
      return { status: 1, stdout: '', stderr: 'unexpected candidate' };
    },
  });

  assert.equal(result, workingCmd);
});

test('explicit Claude Code path fails clearly instead of falling back', () => {
  assert.throws(() => resolveClaude({
    explicitPath: 'C:\\bad\\claude.exe',
    env: {},
    existsSync: () => false,
    statSync: () => ({ isFile: () => true }),
    spawnSync: () => ({ status: 0 }),
  }), /--claude-path is not a usable Claude Code executable/);
});
