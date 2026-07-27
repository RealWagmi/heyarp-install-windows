'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  configureHeyarpHome,
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
