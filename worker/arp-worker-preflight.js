#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveHermes } = require('./arp-worker-run-hermes');

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
      if (out[key] === undefined) out[key] = next;
      else if (Array.isArray(out[key])) out[key].push(next);
      else out[key] = [out[key], next];
      i += 1;
    }
  }
  return out;
}

function configureHeyarpHome(args) {
  const configured = args['heyarp-home'];
  if (configured === undefined) {
    throw new Error('--heyarp-home is required for the scheduled worker');
  }
  if (configured === true || String(configured).trim() === '') {
    throw new Error('--heyarp-home requires a directory path');
  }
  const resolved = path.resolve(String(configured));
  args['heyarp-home'] = resolved;
  process.env.HEYARP_HOME = resolved;
  return resolved;
}

function quoteCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function runHeyarp(args) {
  const cmdline = ['heyarp', ...args].map(quoteCmdArg).join(' ');
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', cmdline], {
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
    timeout: 30000,
  });
  if (result.error) throw new Error(`heyarp ${args.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`heyarp ${args.join(' ')} exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return String(result.stdout || '').trim();
}

function runHeyarpJson(args) {
  const raw = runHeyarp(args);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`heyarp ${args.join(' ')} returned invalid JSON: ${error.message}`);
  }
}

function acceptPolicyAssetIds(args) {
  const configured = args['accept-policy'];
  const policies = configured === undefined ? [] : (Array.isArray(configured) ? configured : [configured]);
  if (policies.length === 0) throw new Error('at least one --accept-policy <asset-id,amount> is required');
  return policies.map((policy) => {
    const [assetId, amount] = String(policy).split(',', 2);
    if (!assetId || !amount) throw new Error(`invalid --accept-policy '${policy}'; expected <asset-id,amount>`);
    return assetId.trim();
  });
}

function acceptedNetworkRows(assetIds, catalog) {
  const rows = Array.isArray(catalog?.networks) ? catalog.networks : [];
  return assetIds.map((assetId) => {
    const row = rows.find((network) => (
      network.active === true
      && Array.isArray(network.assets)
      && network.assets.some((asset) => asset.assetId === assetId)
    ));
    if (!row) throw new Error(`accepted asset does not map to an active HeyARP network: ${assetId}`);
    return row;
  }).filter((row, index, all) => all.findIndex((candidate) => candidate.network === row.network) === index);
}

async function rpcRequest(url, method, params, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('this Node.js runtime does not provide fetch');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
    if (body.result === undefined || body.result === null) throw new Error('response has no result');
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyRpc(row, rpcUrl, fetchImpl) {
  if (row.namespace === 'solana') {
    const genesisHash = String(await rpcRequest(rpcUrl, 'getGenesisHash', [], fetchImpl));
    const expected = String(row.caip2 || '').split(':')[1] || '';
    if (!expected || genesisHash.slice(0, 31) !== expected.slice(0, 31)) {
      throw new Error(`rpc.${row.network} responds from the wrong Solana cluster`);
    }
    return;
  }
  if (row.namespace === 'eip155') {
    const chainId = await rpcRequest(rpcUrl, 'eth_chainId', [], fetchImpl);
    const expected = String(row.caip2 || '').split(':')[1] || '';
    if (!expected || BigInt(chainId) !== BigInt(expected)) {
      throw new Error(`rpc.${row.network} responds with EVM chain ${chainId}, expected ${expected}`);
    }
    return;
  }
  throw new Error(`unsupported namespace for accepted network ${row.network}: ${row.namespace}`);
}

function verifyEscrowConfiguration(row, escrowRows, getConfig) {
  const escrow = escrowRows.find((candidate) => candidate.network === row.network);
  if (!escrow) throw new Error(`server has no escrow configuration for accepted network ${row.network}`);
  if (row.namespace === 'solana') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(escrow.programId || ''))) {
      throw new Error(`server did not provide a valid Solana programId for ${row.network}`);
    }
    return;
  }
  if (row.namespace === 'eip155') {
    const serverContract = String(escrow.contractAddress || '');
    if (!/^0x[0-9a-fA-F]{40}$/.test(serverContract)) {
      throw new Error(`server did not provide a valid EVM contract for ${row.network}`);
    }
    const savedContract = getConfig(`contract.${row.network}`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(savedContract)) {
      throw new Error(`contract.${row.network} is not explicitly configured`);
    }
    if (savedContract.toLowerCase() !== serverContract.toLowerCase()) {
      throw new Error(`contract.${row.network} does not match the server escrow contract`);
    }
  }
}

async function preflight(args, deps = {}) {
  const heyarpHome = configureHeyarpHome(args);
  const fromDid = args['from-did'];
  if (fromDid === undefined || fromDid === true || !String(fromDid).startsWith('did:arp:')) {
    throw new Error('--from-did with the intended worker DID is required');
  }
  const findHermes = deps.resolveHermes || resolveHermes;
  const hermesPath = findHermes({ explicitPath: args['hermes-path'] });
  const getJson = deps.runHeyarpJson || runHeyarpJson;
  const getText = deps.runHeyarp || runHeyarp;
  const localAgent = getJson(['whoami', '--local', '--json', '--from-did', String(fromDid)]);
  if (localAgent?.did !== String(fromDid)) {
    throw new Error(`HEYARP_HOME identity mismatch: expected ${fromDid}, found ${localAgent?.did || '<none>'}`);
  }
  const catalog = getJson(['networks', '--json']);
  const assetIds = acceptPolicyAssetIds(args);
  const rows = acceptedNetworkRows(assetIds, catalog);
  const escrowRows = getJson(['escrow', 'info', '--json']);
  const getConfig = (key) => getText(['config', 'get', key]).trim();

  for (const row of rows) {
    const rpcUrl = getConfig(`rpc.${row.network}`);
    if (!rpcUrl || rpcUrl === '(not set)') {
      throw new Error(`rpc.${row.network} is not explicitly configured in ${heyarpHome || '<default HEYARP_HOME>'}`);
    }
    try {
      new URL(rpcUrl);
    } catch {
      throw new Error(`rpc.${row.network} is not a valid URL`);
    }
    await verifyRpc(row, rpcUrl, deps.fetch);
    verifyEscrowConfiguration(row, escrowRows, getConfig);
  }

  return {
    heyarpHome,
    hermesPath,
    did: localAgent.did,
    networks: rows.map((row) => row.network),
  };
}

if (require.main === module) {
  preflight(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`worker preflight passed did=${result.did} networks=${result.networks.join(',')} heyarpHome=${result.heyarpHome} hermes=${result.hermesPath}\n`);
    })
    .catch((error) => {
      process.stderr.write(`worker preflight failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  acceptPolicyAssetIds,
  acceptedNetworkRows,
  configureHeyarpHome,
  preflight,
  verifyEscrowConfiguration,
  verifyRpc,
};
