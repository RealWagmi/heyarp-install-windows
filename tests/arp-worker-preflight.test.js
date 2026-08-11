'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  preflight,
} = require('../worker/arp-worker-preflight');

const solanaAsset = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501';
const evmAsset = 'eip155:4663/slip44:60';
const workerDid = 'did:arp:worker-one';
const openclawPath = 'C:\\Tools\\openclaw.cmd';

function fixtures() {
  return {
    catalog: {
      networks: [
        {
          network: 'solana-mainnet',
          namespace: 'solana',
          caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          active: true,
          assets: [{ assetId: solanaAsset }],
        },
        {
          network: 'robinhood-mainnet',
          namespace: 'eip155',
          caip2: 'eip155:4663',
          active: true,
          assets: [{ assetId: evmAsset }],
        },
      ],
    },
    escrow: [
      {
        network: 'solana-mainnet',
        programId: 'DckBAFZcE1AZWgVsz5ipnwSUy2wWeK5eBPBoyJgKVPzb',
      },
      {
        network: 'robinhood-mainnet',
        contractAddress: '0xc9Eb0D8D1F5f29B6C90875F174AC97a9e153b6ff',
      },
    ],
    config: {
      'rpc.solana-mainnet': 'https://solana.example',
      'rpc.robinhood-mainnet': 'https://evm.example',
      'contract.robinhood-mainnet': '0xc9Eb0D8D1F5f29B6C90875F174AC97a9e153b6ff',
    },
  };
}

function mockFetch(_url, options) {
  const request = JSON.parse(options.body);
  const result = request.method === 'getGenesisHash'
    ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpMockSuffix'
    : '0x1237';
  return Promise.resolve({
    ok: true,
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  });
}

function mockHeyarpJson(data, localDid = workerDid) {
  return (args) => {
    if (args[0] === 'whoami') return { did: localDid };
    if (args[0] === 'networks') return data.catalog;
    return data.escrow;
  };
}

test('preflight validates accepted Solana and EVM rails', async () => {
  const data = fixtures();
  const previous = process.env.HEYARP_HOME;
  try {
    const result = await preflight({
      'heyarp-home': 'C:\\worker-home',
      'from-did': workerDid,
      'openclaw-path': openclawPath,
      'accept-policy': [`${solanaAsset},0.05`, `${evmAsset},0.005`],
    }, {
      resolveOpenClaw: (options) => {
        assert.equal(options.explicitPath, openclawPath);
        return openclawPath;
      },
      runHeyarpJson: mockHeyarpJson(data),
      runHeyarp: (args) => data.config[args[2]] || '(not set)',
      fetch: mockFetch,
    });
    assert.equal(result.did, workerDid);
    assert.equal(result.openclawPath, openclawPath);
    assert.deepEqual(result.networks, ['solana-mainnet', 'robinhood-mainnet']);
  } finally {
    if (previous === undefined) delete process.env.HEYARP_HOME;
    else process.env.HEYARP_HOME = previous;
  }
});

test('preflight rejects a missing pinned HEYARP_HOME', async () => {
  const data = fixtures();
  await assert.rejects(
    preflight({
      'from-did': workerDid,
      'accept-policy': `${solanaAsset},0.05`,
    }, {
      resolveOpenClaw: () => openclawPath,
      runHeyarpJson: mockHeyarpJson(data),
      runHeyarp: (args) => data.config[args[2]] || '(not set)',
      fetch: mockFetch,
    }),
    /--heyarp-home is required/,
  );
});

test('preflight rejects a missing intended worker DID', async () => {
  const data = fixtures();
  await assert.rejects(
    preflight({
      'heyarp-home': 'C:\\worker-home',
      'accept-policy': `${solanaAsset},0.05`,
    }, {
      resolveOpenClaw: () => openclawPath,
      runHeyarpJson: mockHeyarpJson(data),
      runHeyarp: (args) => data.config[args[2]] || '(not set)',
      fetch: mockFetch,
    }),
    /--from-did with the intended worker DID is required/,
  );
});

test('preflight rejects a home belonging to a different agent', async () => {
  const data = fixtures();
  await assert.rejects(
    preflight({
      'heyarp-home': 'C:\\worker-home',
      'from-did': workerDid,
      'accept-policy': `${solanaAsset},0.05`,
    }, {
      resolveOpenClaw: () => openclawPath,
      runHeyarpJson: mockHeyarpJson(data, 'did:arp:buyer-one'),
      runHeyarp: (args) => data.config[args[2]] || '(not set)',
      fetch: mockFetch,
    }),
    /HEYARP_HOME identity mismatch/,
  );
});

test('preflight fails before startup when an accepted RPC is not saved', async () => {
  const data = fixtures();
  delete data.config['rpc.solana-mainnet'];
  await assert.rejects(
    preflight({
      'heyarp-home': 'C:\\worker-home',
      'from-did': workerDid,
      'accept-policy': `${solanaAsset},0.05`,
    }, {
      resolveOpenClaw: () => openclawPath,
      runHeyarpJson: mockHeyarpJson(data),
      runHeyarp: (args) => data.config[args[2]] || '(not set)',
      fetch: mockFetch,
    }),
    /rpc\.solana-mainnet is not explicitly configured/,
  );
});

test('preflight rejects an EVM contract that differs from the server', async () => {
  const data = fixtures();
  data.config['contract.robinhood-mainnet'] = '0x1111111111111111111111111111111111111111';
  await assert.rejects(
    preflight({
      'heyarp-home': 'C:\\worker-home',
      'from-did': workerDid,
      'accept-policy': `${evmAsset},0.005`,
    }, {
      resolveOpenClaw: () => openclawPath,
      runHeyarpJson: mockHeyarpJson(data),
      runHeyarp: (args) => data.config[args[2]] || '(not set)',
      fetch: mockFetch,
    }),
    /does not match the server escrow contract/,
  );
});

test('preflight rejects a missing or unusable OpenClaw CLI', async () => {
  await assert.rejects(
    preflight({
      'heyarp-home': 'C:\\worker-home',
      'from-did': workerDid,
      'accept-policy': `${solanaAsset},0.05`,
    }, {
      resolveOpenClaw: () => {
        throw new Error('openclaw executable not found');
      },
    }),
    /openclaw executable not found/,
  );
});
