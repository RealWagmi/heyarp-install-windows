#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildHermesInvocation,
  buildPrompt,
  resolveHermes,
  validateHermesCandidate,
} = require('../worker/arp-worker-run-hermes');

test('Hermes worker prompt uses the v4 primary delegation flow', () => {
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

test('Hermes worker prompt keeps one process responsive to every delegation turn', () => {
  const prompt = buildPrompt({
    relationshipId: 'rel-1',
    delegationId: 'del-1',
    senderDid: 'did:arp:buyer',
    eventId: 'event-1',
    requestId: 'request-1',
    fromDid: 'did:arp:worker',
    refusalLog: 'refusal.log',
  });

  assert.match(prompt, /This one Hermes process owns the complete non-terminal lifecycle/);
  assert.match(prompt, /heyarp status rel-1 --wait --wait-timeout 300 --json --from-did did:arp:worker without --until/);
  assert.match(prompt, /Exit code 124 is a bounded poll timeout/);
  assert.match(prompt, /Do not start or request another Hermes worker/);
  assert.doesNotMatch(prompt, /--until cycle\.released/);
});

test('Windows cmd shim is launched through cmd.exe', () => {
  const invocation = buildHermesInvocation('C:\\Tools\\hermes.cmd', ['--version'], {
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  });

  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', 'C:\\Tools\\hermes.cmd', '--version']);
});

test('Windows rejects extensionless Hermes shims before launch', () => {
  let launched = false;
  const result = validateHermesCandidate('C:\\npm\\hermes', {
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

test('Hermes discovery skips unusable candidates and selects a launchable cmd shim', () => {
  const extensionless = 'C:\\npm\\hermes';
  const brokenExe = 'C:\\WindowsApps\\hermes.exe';
  const workingCmd = 'C:\\npm\\hermes.cmd';
  const existing = new Set([extensionless, brokenExe, workingCmd]);
  const result = resolveHermes({
    env: { ComSpec: 'cmd.exe' },
    existsSync: (candidate) => existing.has(candidate),
    statSync: () => ({ isFile: () => true }),
    spawnSync: (command, args) => {
      if (command === 'where.exe') {
        return { status: 0, stdout: `${extensionless}\r\n${brokenExe}\r\n${workingCmd}\r\n` };
      }
      if (command === brokenExe) return { status: 1, stdout: '', stderr: 'Access is denied' };
      if (command === 'cmd.exe' && args[3] === workingCmd) return { status: 0, stdout: 'hermes 1.0.0' };
      return { status: 1, stdout: '', stderr: 'unexpected candidate' };
    },
  });

  assert.equal(result, workingCmd);
});

test('explicit Hermes path fails clearly instead of falling back', () => {
  assert.throws(() => resolveHermes({
    explicitPath: 'C:\\bad\\hermes.exe',
    env: {},
    existsSync: () => false,
    statSync: () => ({ isFile: () => true }),
    spawnSync: () => ({ status: 0 }),
  }), /--hermes-path is not a usable Hermes executable/);
});
