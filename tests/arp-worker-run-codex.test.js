#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCodexInvocation,
  buildPrompt,
  resolveCodex,
  validateCodexCandidate,
} = require('../worker/arp-worker-run-codex');

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

  assert.match(prompt, /This one Codex process owns the complete non-terminal lifecycle/);
  assert.match(prompt, /heyarp status rel-1 --wait --wait-timeout 300 --json --from-did did:arp:worker without --until/);
  assert.match(prompt, /Exit code 124 is a bounded poll timeout/);
  assert.match(prompt, /Do not start or request another Codex worker/);
  assert.doesNotMatch(prompt, /--until cycle\.released/);
});

test('Windows cmd shim is launched through cmd.exe', () => {
  const invocation = buildCodexInvocation('C:\\Tools\\codex.cmd', ['exec'], {
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  });

  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', 'C:\\Tools\\codex.cmd', 'exec']);
});

test('Windows rejects extensionless Codex shims before launch', () => {
  let launched = false;
  const result = validateCodexCandidate('C:\\npm\\codex', {
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

test('Codex discovery skips unusable candidates and selects a launchable cmd shim', () => {
  const extensionless = 'C:\\npm\\codex';
  const brokenExe = 'C:\\WindowsApps\\codex.exe';
  const workingCmd = 'C:\\npm\\codex.cmd';
  const existing = new Set([extensionless, brokenExe, workingCmd]);
  const result = resolveCodex({
    env: { ComSpec: 'cmd.exe' },
    existsSync: (candidate) => existing.has(candidate),
    statSync: () => ({ isFile: () => true }),
    spawnSync: (command, args) => {
      if (command === 'where.exe') {
        return { status: 0, stdout: `${extensionless}\r\n${brokenExe}\r\n${workingCmd}\r\n` };
      }
      if (command === brokenExe) return { status: 1, stdout: '', stderr: 'Access is denied' };
      if (command === 'cmd.exe' && args[3] === workingCmd) return { status: 0, stdout: 'codex-cli 1.0.0' };
      return { status: 1, stdout: '', stderr: 'unexpected candidate' };
    },
  });

  assert.equal(result, workingCmd);
});

test('explicit Codex path fails clearly instead of falling back', () => {
  assert.throws(() => resolveCodex({
    explicitPath: 'C:\\bad\\codex.exe',
    env: {},
    existsSync: () => false,
    statSync: () => ({ isFile: () => true }),
    spawnSync: () => ({ status: 0 }),
  }), /--codex-path is not a usable Codex executable/);
});
