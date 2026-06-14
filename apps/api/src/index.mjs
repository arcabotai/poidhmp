import http from 'node:http';
import { URL } from 'node:url';
import {
  CHAIN_ORDER,
  POIDH_CHAINS,
  explorerAddressUrl,
  explorerTokenUrl,
  openseaAssetUrl,
  versionHintForClaim,
} from './chains.mjs';

const INDEXER_BASE_URL = process.env.INDEXER_BASE_URL?.replace(/\/$/, '') || 'https://indexer.poidh.xyz';
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, '') || '';
const PORT = Number(process.env.PORT || 3001);
const SYNC_INTERVAL_MS = Number(process.env.POIDHMP_SYNC_INTERVAL_MS || 15 * 60 * 1000);
const MAX_OWNEROF_PROBES_PER_SYNC = Number(process.env.MAX_OWNEROF_PROBES_PER_SYNC || 300);
const RPC_BATCH_SIZE = Number(process.env.RPC_BATCH_SIZE || 50);
const SYNC_SECRET = process.env.POIDHMP_SYNC_SECRET || '';
const USER_AGENT = 'poidhmp-api/0.1 (+https://poidhmp.arcabot.ai)';

const zeroAddress = '0x0000000000000000000000000000000000000000';

let cache = {
  ready: false,
  syncing: false,
  syncedAt: null,
  startedAt: new Date().toISOString(),
  errors: [],
  source: INDEXER_BASE_URL,
  imageCache: { enabled: false },
  nftStatusCache: { enabled: false },
  stats: blankStats(),
  claims: [],
};

function blankStats() {
  return {
    total: 0,
    byChain: {},
    byNftStatus: { 'v3-nft': 0, 'legacy-claim': 0, unknown: 0 },
    byProtocolVersion: { v3: 0, legacy: 0, unknown: 0 },
    accepted: 0,
    escrow: 0,
    voting: 0,
    cachedImages: 0,
  };
}

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': status === 200 ? 'public, max-age=30, s-maxage=60' : 'no-store',
    ...corsHeaders(),
    ...headers,
  });
  res.end(payload);
}

function corsHeaders() {
  return {
    'access-control-allow-origin': process.env.ALLOWED_ORIGINS || '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-sync-secret',
  };
}

function normalizeStatus(status) {
  if (status === 'v3-nft' || status === 'minted') return 'v3-nft';
  if (status === 'legacy-claim' || status === 'indexed-only') return 'legacy-claim';
  return 'unknown';
}

function ownerOfData(tokenId) {
  return `0x6352211e${BigInt(tokenId).toString(16).padStart(64, '0')}`;
}

function parseOwnerOfResponse(tokenId, payload) {
  if (payload?.result && /^0x[0-9a-fA-F]{64}$/.test(payload.result)) {
    const owner = `0x${payload.result.slice(-40)}`.toLowerCase();
    if (owner !== zeroAddress) return { tokenId, nftStatus: 'v3-nft', owner };
  }

  const message = `${payload?.error?.message || ''} ${payload?.error?.data || ''}`.toLowerCase();
  if (message.includes('revert') || message.includes('nonexistent') || message.includes('invalid token')) {
    return { tokenId, nftStatus: 'legacy-claim', error: payload?.error?.message || 'ownerOf reverted' };
  }

  return { tokenId, nftStatus: 'unknown', error: payload?.error?.message || 'empty ownerOf result' };
}

async function rpcBatch(rpcUrl, chain, tokenIds) {
  const body = tokenIds.map((tokenId, index) => ({
    jsonrpc: '2.0',
    id: index + 1,
    method: 'eth_call',
    params: [{ to: chain.nftAddress, data: ownerOfData(tokenId) }, 'latest'],
  }));

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) throw new Error(`rpc ${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : [payload];
  return rows.map((row, index) => parseOwnerOfResponse(tokenIds[index], row));
}

async function probeOwnerOfBatch(chain, tokenIds) {
  let lastError;
  for (const rpcUrl of chain.rpcUrls) {
    try {
      return await rpcBatch(rpcUrl, chain, tokenIds);
    } catch (error) {
      lastError = error;
    }
  }

  if (tokenIds.length > 1) {
    const middle = Math.ceil(tokenIds.length / 2);
    const [left, right] = await Promise.all([
      probeOwnerOfBatch(chain, tokenIds.slice(0, middle)),
      probeOwnerOfBatch(chain, tokenIds.slice(middle)),
    ]);
    return [...left, ...right];
  }

  return tokenIds.map((tokenId) => ({
    tokenId,
    nftStatus: 'unknown',
    error: lastError instanceof Error ? lastError.message : 'ownerOf probe failed',
  }));
}

async function probeOwnerOf(chain, tokenIds) {
  const output = new Map();
  for (let i = 0; i < tokenIds.length; i += RPC_BATCH_SIZE) {
    const batch = tokenIds.slice(i, i + RPC_BATCH_SIZE);
    const rows = await probeOwnerOfBatch(chain, batch);
    for (const row of rows) output.set(String(row.tokenId), row);
  }
  return output;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeoutMs || 30_000),
  });
  if (!response.ok) throw new Error(`${url} failed ${response.status}`);
  return response.json();
}

async function fetchImageManifest() {
  if (!R2_PUBLIC_BASE_URL) return null;
  try {
    return await fetchJson(`${R2_PUBLIC_BASE_URL}/poidh/v1/manifest.json`, { timeoutMs: 20_000 });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'image manifest failed' };
  }
}

async function fetchLegacyMintManifest() {
  if (!R2_PUBLIC_BASE_URL) return null;
  try {
    return await fetchJson(`${R2_PUBLIC_BASE_URL}/poidh/v1/mint-status.json`, { timeoutMs: 20_000 });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'mint-status manifest failed' };
  }
}

async function fetchClaimsForChain(chainKey) {
  const chain = POIDH_CHAINS[chainKey];
  const rows = await fetchJson(`${INDEXER_BASE_URL}/claim/${chain.chainId}`, { timeoutMs: 60_000 });
  if (!Array.isArray(rows)) throw new Error(`${chain.shortName} claims response was not an array`);
  return rows.map((claim) => ({ claim, chain, chainKey }));
}

function enrichClaim({ claim, chain, chainKey }, imageManifest, statusRecord) {
  const tokenId = String(claim.onChainId);
  const key = `${chain.chainId}:${tokenId}`;
  const cachedImageUrl = imageManifest?.images?.[key]?.url;
  const nftStatus = normalizeStatus(statusRecord?.nftStatus ?? statusRecord?.status);
  const protocolVersion = nftStatus === 'v3-nft'
    ? 'v3'
    : nftStatus === 'legacy-claim'
      ? 'legacy'
      : versionHintForClaim(chain, claim.onChainId) === 'v3-candidate'
        ? 'unknown'
        : 'legacy';

  return {
    ...claim,
    chainKey,
    chainName: chain.shortName,
    tokenId,
    claimId: tokenId,
    cachedImageUrl,
    mediaStatus: cachedImageUrl ? 'cached' : claim.url ? 'live-or-metadata' : 'missing',
    protocolVersion,
    versionHint: versionHintForClaim(chain, claim.onChainId),
    nftStatus,
    nftOwner: statusRecord?.owner || statusRecord?.nftOwner,
    statusSource: statusRecord ? 'ownerOf-cache' : 'unverified',
    explorerUrl: nftStatus === 'v3-nft' ? explorerTokenUrl(chain, tokenId) : explorerAddressUrl(chain),
    collectionUrl: explorerAddressUrl(chain),
    openseaUrl: nftStatus === 'v3-nft' ? openseaAssetUrl(chain, tokenId) : undefined,
  };
}

function buildStats(claims) {
  const stats = blankStats();
  stats.total = claims.length;
  for (const claim of claims) {
    stats.byChain[claim.chainKey] = (stats.byChain[claim.chainKey] || 0) + 1;
    stats.byNftStatus[claim.nftStatus] = (stats.byNftStatus[claim.nftStatus] || 0) + 1;
    stats.byProtocolVersion[claim.protocolVersion] = (stats.byProtocolVersion[claim.protocolVersion] || 0) + 1;
    if (claim.isAccepted) stats.accepted += 1;
    else stats.escrow += 1;
    if (claim.isVoting) stats.voting += 1;
    if (claim.cachedImageUrl) stats.cachedImages += 1;
  }
  return stats;
}

function sortClaims(a, b) {
  const chainDiff = CHAIN_ORDER.indexOf(a.chainKey) - CHAIN_ORDER.indexOf(b.chainKey);
  return chainDiff || Number(b.onChainId) - Number(a.onChainId);
}

async function syncClaims({ forceProbeUnknown = false } = {}) {
  if (cache.syncing) return cache;
  cache.syncing = true;
  const syncErrors = [];
  const startedAt = new Date().toISOString();

  try {
    const [imageManifest, legacyMintManifest, ...chainSettled] = await Promise.all([
      fetchImageManifest(),
      fetchLegacyMintManifest(),
      ...CHAIN_ORDER.map((chainKey) => fetchClaimsForChain(chainKey).then(
        (value) => ({ status: 'fulfilled', value, chainKey }),
        (reason) => ({ status: 'rejected', reason, chainKey }),
      )),
    ]);

    if (imageManifest?.error) syncErrors.push({ source: 'image-manifest', error: imageManifest.error });
    if (legacyMintManifest?.error) syncErrors.push({ source: 'mint-status-manifest', error: legacyMintManifest.error });

    const rawRows = [];
    for (const result of chainSettled) {
      if (result.status === 'fulfilled') rawRows.push(...result.value);
      else syncErrors.push({ source: result.chainKey, error: result.reason instanceof Error ? result.reason.message : 'claim fetch failed' });
    }

    const statusRecords = new Map();
    for (const [key, record] of Object.entries(legacyMintManifest?.records || {})) {
      statusRecords.set(key, {
        nftStatus: normalizeStatus(record.status),
        owner: record.owner,
        error: record.error,
      });
    }

    const probeByChain = new Map();
    for (const row of rawRows) {
      const key = `${row.chain.chainId}:${row.claim.onChainId}`;
      const record = statusRecords.get(key);
      const status = normalizeStatus(record?.nftStatus);
      const shouldProbe = !record || (forceProbeUnknown && status === 'unknown');
      if (!shouldProbe) continue;
      if (versionHintForClaim(row.chain, row.claim.onChainId) === 'legacy-candidate') {
        statusRecords.set(key, { nftStatus: 'legacy-claim', error: 'below known v3 claim-id range' });
        continue;
      }
      if (!probeByChain.has(row.chainKey)) probeByChain.set(row.chainKey, []);
      probeByChain.get(row.chainKey).push(String(row.claim.onChainId));
    }

    let probesRemaining = Math.max(0, MAX_OWNEROF_PROBES_PER_SYNC);
    for (const [chainKey, ids] of probeByChain.entries()) {
      if (probesRemaining <= 0) break;
      const uniqueIds = [...new Set(ids)].slice(0, probesRemaining);
      probesRemaining -= uniqueIds.length;
      const chain = POIDH_CHAINS[chainKey];
      const probed = await probeOwnerOf(chain, uniqueIds);
      for (const [tokenId, record] of probed.entries()) {
        statusRecords.set(`${chain.chainId}:${tokenId}`, {
          nftStatus: normalizeStatus(record.nftStatus),
          owner: record.owner,
          error: record.error,
        });
      }
    }

    const claims = rawRows
      .map((row) => enrichClaim(row, imageManifest && !imageManifest.error ? imageManifest : null, statusRecords.get(`${row.chain.chainId}:${row.claim.onChainId}`)))
      .sort(sortClaims);

    cache = {
      ready: true,
      syncing: false,
      syncedAt: new Date().toISOString(),
      syncStartedAt: startedAt,
      source: INDEXER_BASE_URL,
      errors: syncErrors,
      imageCache: imageManifest && !imageManifest.error
        ? { enabled: true, generatedAt: imageManifest.generatedAt, totalCached: imageManifest.totalCached, totalFailed: imageManifest.totalFailed }
        : { enabled: false, error: imageManifest?.error },
      nftStatusCache: legacyMintManifest && !legacyMintManifest.error
        ? {
            enabled: true,
            generatedAt: legacyMintManifest.generatedAt,
            totalChecked: legacyMintManifest.totalChecked,
            totalV3Nft: claims.filter((claim) => claim.nftStatus === 'v3-nft').length,
            totalLegacyClaim: claims.filter((claim) => claim.nftStatus === 'legacy-claim').length,
            totalUnknown: claims.filter((claim) => claim.nftStatus === 'unknown').length,
          }
        : { enabled: false, error: legacyMintManifest?.error },
      stats: buildStats(claims),
      claims,
    };

    return cache;
  } catch (error) {
    cache = {
      ...cache,
      syncing: false,
      errors: [{ source: 'sync', error: error instanceof Error ? error.message : 'sync failed' }],
    };
    throw error;
  }
}

function filteredClaims(url) {
  const params = url.searchParams;
  const chain = params.get('chain');
  const nftStatus = params.get('nftStatus') || params.get('status');
  const protocolVersion = params.get('protocolVersion') || params.get('version');
  const state = params.get('state');
  const q = (params.get('q') || params.get('search') || '').trim().toLowerCase();
  const requestedLimit = Number(params.get('limit') || 0) || cache.claims.length;
  const limit = Math.min(requestedLimit, 20000);
  const offset = Math.max(Number(params.get('offset') || 0) || 0, 0);

  const claims = cache.claims.filter((claim) => {
    if (chain && chain !== 'all' && claim.chainKey !== chain && String(claim.chainId) !== chain) return false;
    if (nftStatus && nftStatus !== 'all' && claim.nftStatus !== normalizeStatus(nftStatus)) return false;
    if (protocolVersion && protocolVersion !== 'all' && claim.protocolVersion !== protocolVersion) return false;
    if (state === 'accepted' && !claim.isAccepted) return false;
    if (state === 'escrow' && claim.isAccepted) return false;
    if (state === 'voting' && !claim.isVoting) return false;
    if (!q) return true;
    return [claim.title, claim.description, claim.tokenId, claim.owner, claim.issuer, claim.chainName, claim.bountyId, claim.chainId]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q));
  });

  return {
    total: claims.length,
    offset,
    limit,
    claims: claims.slice(offset, offset + limit),
  };
}

function tokensCompat(url) {
  const filtered = filteredClaims(url);
  const tokens = filtered.claims.map((claim) => ({
    ...claim,
    mintStatus: claim.nftStatus === 'v3-nft' ? 'minted' : claim.nftStatus === 'legacy-claim' ? 'indexed-only' : 'unknown',
    mintedOwner: claim.nftOwner,
  }));
  return {
    source: cache.source,
    fetchedAt: cache.syncedAt,
    total: filtered.total,
    totalUnfiltered: cache.claims.length,
    countsByChain: cache.stats.byChain,
    imageCache: cache.imageCache,
    mintStatusCache: cache.nftStatusCache,
    nftStatusCache: cache.nftStatusCache,
    stats: cache.stats,
    errors: cache.errors,
    tokens,
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    json(res, 200, {
      ok: true,
      ready: cache.ready,
      syncing: cache.syncing,
      startedAt: cache.startedAt,
      syncedAt: cache.syncedAt,
      totalClaims: cache.claims.length,
      errors: cache.errors,
    });
    return;
  }

  if (url.pathname === '/stats') {
    json(res, cache.ready ? 200 : 503, {
      ready: cache.ready,
      syncing: cache.syncing,
      syncedAt: cache.syncedAt,
      source: cache.source,
      imageCache: cache.imageCache,
      nftStatusCache: cache.nftStatusCache,
      stats: cache.stats,
      errors: cache.errors,
    });
    return;
  }

  if (url.pathname === '/claims') {
    if (!cache.ready) return json(res, 503, { error: 'sync not ready', syncing: cache.syncing, errors: cache.errors });
    const filtered = filteredClaims(url);
    json(res, 200, {
      source: cache.source,
      fetchedAt: cache.syncedAt,
      total: filtered.total,
      totalUnfiltered: cache.claims.length,
      offset: filtered.offset,
      limit: filtered.limit,
      countsByChain: cache.stats.byChain,
      imageCache: cache.imageCache,
      nftStatusCache: cache.nftStatusCache,
      stats: cache.stats,
      errors: cache.errors,
      claims: filtered.claims,
    });
    return;
  }

  if (url.pathname === '/tokens') {
    if (!cache.ready) return json(res, 503, { error: 'sync not ready', syncing: cache.syncing, errors: cache.errors });
    json(res, 200, tokensCompat(url));
    return;
  }

  if (url.pathname === '/sync') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
    if (SYNC_SECRET && req.headers['x-sync-secret'] !== SYNC_SECRET && url.searchParams.get('secret') !== SYNC_SECRET) {
      return json(res, 401, { error: 'unauthorized' });
    }
    syncClaims({ forceProbeUnknown: url.searchParams.get('probeUnknown') === '1' })
      .catch((error) => console.error('[sync] failed', error));
    json(res, 202, { ok: true, syncing: true });
    return;
  }

  json(res, 404, { error: 'not found', routes: ['/health', '/stats', '/claims', '/tokens', '/sync'] });
}

async function main() {
  if (process.env.POIDHMP_SYNC_ONCE === '1') {
    await syncClaims({ forceProbeUnknown: process.env.PROBE_UNKNOWN === '1' });
    console.log(JSON.stringify({ syncedAt: cache.syncedAt, stats: cache.stats, errors: cache.errors }, null, 2));
    return;
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error('[request] failed', error);
      json(res, 500, { error: error instanceof Error ? error.message : 'request failed' });
    });
  });

  server.listen(PORT, () => {
    console.log(`[poidhmp-api] listening on :${PORT}`);
  });

  syncClaims().catch((error) => console.error('[initial sync] failed', error));
  setInterval(() => {
    syncClaims().catch((error) => console.error('[scheduled sync] failed', error));
  }, SYNC_INTERVAL_MS).unref();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
