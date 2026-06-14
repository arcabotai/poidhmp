#!/usr/bin/env node
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import pLimit from 'p-limit';

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.split('=');
  return [key, rest.length ? rest.join('=') : 'true'];
}));

const concurrency = Number(args.get('--concurrency') ?? 4);
const batchSize = Number(args.get('--batch-size') ?? 80);
const limitArg = Number(args.get('--limit') ?? 0);
const dryRun = args.has('--dry-run');
const rpcTimeoutMs = Number(args.get('--rpc-timeout-ms') ?? 30_000);

const required = ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL'];
for (const name of required) {
  if (!process.env[name] && !dryRun) throw new Error(`Missing required env var ${name}`);
}

const INDEXER_BASE_URL = 'https://indexer.poidh.xyz';
const CHAINS = [
  {
    key: 'base',
    chainId: 8453,
    nftAddress: '0x27e117cc9a8da363442e7bd0618939e3eeeacf6a',
    rpcUrls: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'],
  },
  {
    key: 'arbitrum',
    chainId: 42161,
    nftAddress: '0x27e117cc9a8da363442e7bd0618939e3eeeacf6a',
    rpcUrls: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://arbitrum.drpc.org'],
  },
  {
    key: 'ethereum',
    chainId: 1,
    nftAddress: '0x9c5f45d5e1382e4058d334d93c6c01442012a4d9',
    rpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  },
  {
    key: 'degen',
    chainId: 666666666,
    nftAddress: '0x39f04b7897dcaf9dc454e433f43fb1c3bb528e11',
    rpcUrls: ['https://rpc.degen.tips', 'https://rpc.degen.chain.community'],
  },
];

const s3 = dryRun ? null : new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function ownerOfCalldata(tokenId) {
  return `0x6352211e${BigInt(tokenId).toString(16).padStart(64, '0')}`;
}

function decodeAddress(result) {
  if (!result || result === '0x' || result.length < 42) return undefined;
  return `0x${result.slice(-40)}`.toLowerCase();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(rpcTimeoutMs),
    headers: { accept: 'application/json', 'user-agent': 'poidhmp-mint-status-sync/0.1' },
  });
  if (!response.ok) throw new Error(`fetch ${url} ${response.status}`);
  return response.json();
}

async function rpcBatch(rpcUrl, contract, tokenIds) {
  const payload = tokenIds.map((tokenId, index) => ({
    jsonrpc: '2.0',
    id: index,
    method: 'eth_call',
    params: [{ to: contract, data: ownerOfCalldata(tokenId) }, 'latest'],
  }));

  const response = await fetch(rpcUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(rpcTimeoutMs),
    headers: { 'content-type': 'application/json', 'user-agent': 'poidhmp-mint-status-sync/0.1' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) throw new Error(`rpc ${response.status}`);
  const json = await response.json();
  if (!Array.isArray(json)) throw new Error('RPC did not return batch array');

  const byId = new Map(json.map((item) => [item.id, item]));
  return tokenIds.map((tokenId, index) => {
    const item = byId.get(index);
    const owner = decodeAddress(item?.result);
    if (owner) return { tokenId, status: 'minted', owner };
    if (item?.error) return { tokenId, status: 'indexed-only', error: item.error.message || 'ownerOf reverted' };
    return { tokenId, status: 'unknown', error: 'empty RPC response' };
  });
}

async function probeBatch(chain, tokenIds) {
  let lastError;
  for (const rpcUrl of chain.rpcUrls) {
    try {
      return await rpcBatch(rpcUrl, chain.nftAddress, tokenIds);
    } catch (error) {
      lastError = error;
    }
  }

  if (tokenIds.length > 1) {
    const middle = Math.ceil(tokenIds.length / 2);
    const [left, right] = await Promise.all([
      probeBatch(chain, tokenIds.slice(0, middle)),
      probeBatch(chain, tokenIds.slice(middle)),
    ]);
    return [...left, ...right];
  }

  return tokenIds.map((tokenId) => ({ tokenId, status: 'unknown', error: lastError instanceof Error ? lastError.message : 'RPC failed' }));
}

async function syncChain(chain) {
  const claims = await fetchJson(`${INDEXER_BASE_URL}/claim/${chain.chainId}`);
  const tokenIds = [...new Set(claims.map((claim) => claim.onChainId))].sort((a, b) => a - b);
  const selected = limitArg ? tokenIds.slice(0, limitArg) : tokenIds;
  const chunks = [];
  for (let i = 0; i < selected.length; i += batchSize) chunks.push(selected.slice(i, i + batchSize));

  const records = {};
  let done = 0;
  const limiter = pLimit(concurrency);
  await Promise.all(chunks.map((chunk) => limiter(async () => {
    const results = await probeBatch(chain, chunk);
    for (const result of results) {
      records[`${chain.chainId}:${result.tokenId}`] = {
        status: result.status,
        ...(result.owner ? { owner: result.owner } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    }
    done += chunk.length;
    if (done % (batchSize * 5) === 0 || done === selected.length) {
      const values = Object.values(records);
      console.log(`${chain.key} ${done}/${selected.length} minted=${values.filter((r) => r.status === 'minted').length} indexedOnly=${values.filter((r) => r.status === 'indexed-only').length} unknown=${values.filter((r) => r.status === 'unknown').length}`);
    }
  })));

  return { chain, records };
}

async function main() {
  console.log(`Checking POIDH mint status via ownerOf, batch=${batchSize}, concurrency=${concurrency}${dryRun ? ' (dry-run)' : ''}`);
  const chainResults = await Promise.all(CHAINS.map(syncChain));
  const records = Object.assign({}, ...chainResults.map((result) => result.records));
  const values = Object.values(records);
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: INDEXER_BASE_URL,
    method: 'ownerOf(tokenId) on each chain claim NFT contract',
    totalChecked: values.length,
    totalMinted: values.filter((r) => r.status === 'minted').length,
    totalIndexedOnly: values.filter((r) => r.status === 'indexed-only').length,
    totalUnknown: values.filter((r) => r.status === 'unknown').length,
    records,
  };

  const key = 'poidh/v1/mint-status.json';
  if (!dryRun) {
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: JSON.stringify(manifest),
      ContentType: 'application/json; charset=utf-8',
      CacheControl: 'public, max-age=300',
    }));
  }

  console.log(JSON.stringify({
    totalChecked: manifest.totalChecked,
    totalMinted: manifest.totalMinted,
    totalIndexedOnly: manifest.totalIndexedOnly,
    totalUnknown: manifest.totalUnknown,
    manifestUrl: `${process.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, '')}/${key}`,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
