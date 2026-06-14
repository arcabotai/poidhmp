#!/usr/bin/env node
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import pLimit from 'p-limit';
import sharp from 'sharp';

const INDEXER_BASE_URL = 'https://indexer.poidh.xyz';
const CHAINS = [
  { key: 'base', chainId: 8453 },
  { key: 'arbitrum', chainId: 42161 },
  { key: 'ethereum', chainId: 1 },
  { key: 'degen', chainId: 666666666 },
];

const args = new Map(process.argv.slice(2).map((arg, index, all) => {
  if (!arg.startsWith('--')) return [arg, true];
  const [key, inline] = arg.split('=');
  return [key, inline ?? all[index + 1] ?? true];
}));

const limitArg = Number(args.get('--limit') ?? 0);
const concurrency = Number(args.get('--concurrency') ?? 8);
const force = args.has('--force');
const dryRun = args.has('--dry-run');
const fetchTimeoutMs = Number(args.get('--fetch-timeout-ms') ?? 30_000);
const itemTimeoutMs = Number(args.get('--item-timeout-ms') ?? 90_000);
const maxImageBytes = Number(args.get('--max-image-bytes') ?? 30_000_000);

const required = ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
}

const bucket = process.env.R2_BUCKET;
const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL.replace(/\/$/, '');
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function resolveUri(value) {
  if (!value || typeof value !== 'string') return undefined;
  if (value.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${value.slice('ipfs://'.length).replace(/^ipfs\//, '')}`;
  if (value.startsWith('ar://')) return `https://arweave.net/${value.slice('ar://'.length)}`;
  if (value.startsWith('http://')) return `https://${value.slice('http://'.length)}`;
  if (value.startsWith('https://')) return value;
  return undefined;
}

async function fetchJson(url) {
  const signal = AbortSignal.timeout(fetchTimeoutMs);
  const response = await fetch(url, { signal, headers: { accept: 'application/json,*/*', 'user-agent': 'poidhmp-image-sync/0.1' } });
  if (!response.ok) throw new Error(`fetch ${response.status}`);
  return response.json();
}

async function fetchBuffer(url) {
  const signal = AbortSignal.timeout(fetchTimeoutMs);
  const response = await fetch(url, { signal, headers: { accept: 'image/*,*/*', 'user-agent': 'poidhmp-image-sync/0.1' } });
  if (!response.ok) throw new Error(`image fetch ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxImageBytes) throw new Error(`image too large: ${contentLength} bytes`);
  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxImageBytes) throw new Error(`image too large: ${buffer.byteLength} bytes`);
  return { buffer, contentType };
}

async function withTimeout(promise, ms, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function objectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') return false;
    return false;
  }
}

async function putObject(key, body, contentType, cacheControl = 'public, max-age=31536000, immutable') {
  if (dryRun) return;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl,
  }));
}

async function resolveImageFromClaim(claim) {
  const metadataUrl = resolveUri(claim.url);
  if (!metadataUrl) throw new Error('missing claim url');

  const metadata = await fetchJson(metadataUrl);
  const imageCandidate = metadata.image || metadata.image_url || metadata.thumbnail || metadata.thumbnail_url;
  const imageUrl = resolveUri(String(imageCandidate || ''));
  if (!imageUrl) throw new Error('metadata has no supported image');
  return { metadataUrl, imageUrl };
}

async function cacheClaim(claim) {
  const tokenId = String(claim.onChainId);
  const imageKey = `poidh/v1/${claim.chainId}/${tokenId}.webp`;
  const metaKey = `poidh/v1/${claim.chainId}/${tokenId}.json`;
  const publicUrl = `${publicBaseUrl}/${imageKey}`;

  if (!force && await objectExists(imageKey)) {
    return { ok: true, skipped: true, chainId: claim.chainId, tokenId, imageKey, publicUrl };
  }

  const { metadataUrl, imageUrl } = await resolveImageFromClaim(claim);
  const { buffer } = await fetchBuffer(imageUrl);
  const thumb = await sharp(buffer, { animated: false, limitInputPixels: 80_000_000 })
    .rotate()
    .resize({ width: 512, height: 512, fit: 'cover', withoutEnlargement: true })
    .webp({ quality: 76, effort: 4 })
    .toBuffer();

  const metadata = {
    chainId: claim.chainId,
    tokenId,
    claimId: claim.id,
    bountyId: claim.bountyId,
    title: claim.title,
    sourceMetadataUrl: metadataUrl,
    sourceImageUrl: imageUrl,
    cachedImageUrl: publicUrl,
    imageKey,
    cachedAt: new Date().toISOString(),
  };

  await putObject(imageKey, thumb, 'image/webp');
  await putObject(metaKey, JSON.stringify(metadata, null, 2), 'application/json');

  return { ok: true, skipped: false, chainId: claim.chainId, tokenId, imageKey, publicUrl };
}

async function main() {
  const chainClaims = await Promise.all(CHAINS.map(async (chain) => {
    const claims = await fetchJson(`${INDEXER_BASE_URL}/claim/${chain.chainId}`);
    return claims.map((claim) => ({ ...claim, chainKey: chain.key }));
  }));
  let claims = chainClaims.flat();
  claims.sort((a, b) => a.chainId - b.chainId || b.onChainId - a.onChainId);
  if (limitArg > 0) claims = claims.slice(0, limitArg);

  console.log(`Syncing ${claims.length} POIDH images to R2 bucket ${bucket} (${dryRun ? 'dry-run' : 'live'})`);
  const limiter = pLimit(concurrency);
  const results = [];
  let done = 0;

  await Promise.all(claims.map((claim) => limiter(async () => {
    try {
      const result = await withTimeout(cacheClaim(claim), itemTimeoutMs, `${claim.chainId}:${claim.onChainId}`);
      results.push(result);
    } catch (error) {
      results.push({ ok: false, chainId: claim.chainId, tokenId: String(claim.onChainId), error: error instanceof Error ? error.message : String(error) });
    } finally {
      done += 1;
      if (done % 10 === 0 || done === claims.length) {
        const ok = results.filter((r) => r.ok).length;
        const failed = results.filter((r) => !r.ok).length;
        console.log(`progress ${done}/${claims.length} ok=${ok} failed=${failed}`);
      }
    }
  })));

  const cached = results.filter((r) => r.ok);
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: INDEXER_BASE_URL,
    totalAttempted: claims.length,
    totalCached: cached.length,
    totalFailed: results.length - cached.length,
    publicBaseUrl,
    images: Object.fromEntries(cached.map((r) => [`${r.chainId}:${r.tokenId}`, { url: r.publicUrl, key: r.imageKey, skipped: !!r.skipped }])),
    failures: results.filter((r) => !r.ok),
  };

  await putObject('poidh/v1/manifest.json', JSON.stringify(manifest, null, 2), 'application/json', 'public, max-age=300');
  console.log(JSON.stringify({ totalAttempted: manifest.totalAttempted, totalCached: manifest.totalCached, totalFailed: manifest.totalFailed, manifestUrl: `${publicBaseUrl}/poidh/v1/manifest.json` }, null, 2));

  if (manifest.totalFailed > 0 && manifest.totalCached === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
