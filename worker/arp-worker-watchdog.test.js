'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assetMatches,
  classifyFundedState,
  evaluateAcceptPolicy,
  hasPrimaryRefusal,
  isWaitingForCounterpartyOrChain,
  taskCurrencyValues,
} = require('./arp-worker-watchdog.js');

test('unfunded delegations are never actionable', () => {
  assert.equal(classifyFundedState({ state: 'accepted' }, null).actionable, false);
  assert.equal(classifyFundedState({ state: 'accepted' }, { state: 'created' }).actionable, false);
  assert.equal(classifyFundedState({ state: 'offered' }, { state: 'created' }).actionable, false);
});

test('funded v4 primary and recovery states are actionable', () => {
  assert.equal(classifyFundedState({ state: 'locked' }, { state: 'created' }).actionable, true);
  assert.equal(classifyFundedState({ state: 'locked' }, { state: 'in_progress' }).actionable, true);
  assert.equal(classifyFundedState({ state: 'submitted' }, { state: 'in_progress' }).actionable, true);
  assert.equal(classifyFundedState({ state: 'completed' }, { state: 'submitted' }).actionable, true);
  assert.equal(classifyFundedState({ state: 'locked' }, { state: 'disputing' }).actionable, true);
});

test('unknown and terminal escrow states fail closed', () => {
  assert.equal(classifyFundedState({ state: 'locked' }, { state: 'mystery' }).actionable, false);
  assert.equal(classifyFundedState({ state: 'failed' }, { state: 'created' }).actionable, false);
  assert.equal(classifyFundedState({ state: 'locked' }, { state: 'paid' }).actionable, false);
  assert.equal(classifyFundedState({ state: 'locked' }, { state: 'dispute_closed' }).actionable, false);
});

test('primary flow does not wait for an initial work request', () => {
  assert.equal(isWaitingForCounterpartyOrChain({ phase: 'awaiting_work_request', state: 'locked', nextActionOwner: 'me' }), false);
  assert.equal(isWaitingForCounterpartyOrChain({ phase: 'awaiting_fund', state: 'accepted', nextActionOwner: 'buyer' }), true);
});

test('asset policy is exact and network-specific', () => {
  assert.equal(assetMatches('SOL:SOLANA-MAINNET', ['SOL:solana-mainnet']), true);
  assert.equal(assetMatches('SOL:SOLANA-MAINNET', ['SOL:solana-devnet', 'SOL']), false);
  assert.equal(assetMatches('USDC:ROBINHOOD-TESTNET', ['USDC:solana-mainnet']), false);
});

test('currency candidates include a network-qualified symbol', () => {
  const values = taskCurrencyValues({ currency: { symbol: 'ETH', network: 'robinhood-testnet' } });
  assert.ok(values.includes('ETH:robinhood-testnet'));
});

test('accept policy requires exact amount and asset', () => {
  const policy = { amount: '0.1', asset: 'SOL:SOLANA-MAINNET' };
  assert.equal(evaluateAcceptPolicy({ amount: '0.10', currency: 'SOL:solana-mainnet' }, policy).ok, true);
  assert.equal(evaluateAcceptPolicy({ amount: '0.1', currency: 'SOL:solana-devnet' }, policy).ok, false);
  assert.equal(evaluateAcceptPolicy({ amount: '0.2', currency: 'SOL:solana-mainnet' }, policy).ok, false);
});

test('primary refusal marker suppresses funded redispatch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arp-watchdog-test-'));
  const paths = { logsRoot: root };
  const delegationId = '00000000-0000-4000-8000-000000000001';
  assert.equal(hasPrimaryRefusal(paths, delegationId), false);
  const refusalFile = path.join(root, `${delegationId}.refusal.txt`);
  fs.writeFileSync(refusalFile, 'policy refusal', 'utf8');
  assert.equal(hasPrimaryRefusal(paths, delegationId), true);
  fs.unlinkSync(refusalFile);
  fs.rmdirSync(root);
});
