#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt } = require('./arp-worker-run-codex');

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
