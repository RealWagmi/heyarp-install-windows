'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  configureHeyarpHome,
  runStartupPreflight,
} = require('../worker/arp-worker-sse-daemon');

test('SSE daemon resolves and pins the worker HEYARP_HOME', () => {
  const previous = process.env.HEYARP_HOME;
  try {
    const args = { 'heyarp-home': 'C:\\Users\\1\\.heyarp-homes\\worker-one' };
    const resolved = configureHeyarpHome(args);
    assert.equal(resolved, path.resolve('C:\\Users\\1\\.heyarp-homes\\worker-one'));
    assert.equal(args['heyarp-home'], resolved);
    assert.equal(process.env.HEYARP_HOME, resolved);
  } finally {
    if (previous === undefined) delete process.env.HEYARP_HOME;
    else process.env.HEYARP_HOME = previous;
  }
});

test('SSE daemon rejects a missing pinned HEYARP_HOME', () => {
  assert.throws(() => configureHeyarpHome({}), /--heyarp-home is required/);
});

test('SSE daemon forwards the pinned Hermes path to startup preflight', () => {
  const hermesPath = 'C:\\Tools\\hermes.cmd';
  let invocation;
  const output = runStartupPreflight({
    'heyarp-home': 'C:\\worker-home',
    'from-did': 'did:arp:worker-one',
    'hermes-path': hermesPath,
    'accept-policy': 'eip155:4663/slip44:60,0.005',
  }, {
    spawnSync: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: 'worker preflight passed' };
    },
  });

  assert.equal(output, 'worker preflight passed');
  assert.equal(invocation.command, process.execPath);
  const pathIndex = invocation.args.indexOf('--hermes-path');
  assert.notEqual(pathIndex, -1);
  assert.equal(invocation.args[pathIndex + 1], hermesPath);
});
