import { NextResponse } from 'next/server';
import { CHAIN_ORDER, POIDH_CHAINS, PoidhChainKey, explorerAddressUrl } from '@/lib/chains';

export const runtime = 'nodejs';
export const revalidate = 300;

const INDEXER_BASE_URL = 'https://indexer.poidh.xyz';

type IndexerClaim = {
  id: number;
  chainId: number;
  onChainId: number;
  title: string;
  description: string;
  url: string | null;
  issuer: string;
  isAccepted: boolean;
  isVoting: boolean;
  bountyId: number;
  owner: string;
};

type MarketplaceToken = IndexerClaim & {
  chainKey: PoidhChainKey;
  chainName: string;
  tokenId: string;
  cachedImageUrl?: string;
  explorerUrl: string;
  openseaUrl?: string;
  nftStatus: 'v3-nft' | 'legacy-claim' | 'unknown';
  protocolVersion: 'v3' | 'legacy' | 'unknown';
  nftOwner?: string;
  mintStatus: 'minted' | 'indexed-only' | 'unknown';
  mintedOwner?: string;
};

type ImageManifest = {
  generatedAt?: string;
  totalCached?: number;
  totalFailed?: number;
  images?: Record<string, { url?: string }>;
};

type MintStatusManifest = {
  generatedAt?: string;
  totalChecked?: number;
  totalMinted?: number;
  totalIndexedOnly?: number;
  totalUnknown?: number;
  records?: Record<string, { status?: 'minted' | 'indexed-only' | 'unknown'; owner?: string; error?: string }>;
};

async function proxyRailwayApi(request: Request) {
  const apiBase = process.env.POIDHMP_API_BASE_URL?.replace(/\/$/, '');
  if (!apiBase) return null;

  try {
    const upstream = new URL(`${apiBase}/tokens`);
    const incoming = new URL(request.url);
    incoming.searchParams.forEach((value, key) => upstream.searchParams.set(key, value));

    const response = await fetch(upstream, {
      headers: { accept: 'application/json', 'user-agent': 'poidhmp-web/0.5' },
      next: { revalidate },
    });
    const data = await response.json();
    return NextResponse.json(data, {
      status: response.status,
      headers: { 'x-poidhmp-source': 'railway' },
    });
  } catch {
    return null;
  }
}

async function fetchImageManifest(): Promise<ImageManifest | null> {
  const baseUrl = process.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl) return null;

  try {
    const response = await fetch(`${baseUrl}/poidh/v1/manifest.json`, {
      headers: { accept: 'application/json', 'user-agent': 'poidhmp/0.3' },
      next: { revalidate },
    });
    if (!response.ok) return null;
    return (await response.json()) as ImageManifest;
  } catch {
    return null;
  }
}


async function fetchMintStatusManifest(): Promise<MintStatusManifest | null> {
  const baseUrl = process.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl) return null;

  try {
    const response = await fetch(`${baseUrl}/poidh/v1/mint-status.json`, {
      headers: { accept: 'application/json', 'user-agent': 'poidhmp/0.4' },
      next: { revalidate },
    });
    if (!response.ok) return null;
    return (await response.json()) as MintStatusManifest;
  } catch {
    return null;
  }
}

async function fetchChainClaims(chainKey: PoidhChainKey, manifest: ImageManifest | null, mintManifest: MintStatusManifest | null): Promise<MarketplaceToken[]> {
  const chain = POIDH_CHAINS[chainKey];
  const response = await fetch(`${INDEXER_BASE_URL}/claim/${chain.chainId}`, {
    headers: { accept: 'application/json', 'user-agent': 'poidhmp/0.2' },
    next: { revalidate },
  });

  if (!response.ok) {
    throw new Error(`Indexer ${chain.shortName} claims failed: ${response.status}`);
  }

  const claims = (await response.json()) as IndexerClaim[];

  return claims.map((claim) => {
    const tokenId = String(claim.onChainId);
    const cachedImageUrl = manifest?.images?.[`${claim.chainId}:${tokenId}`]?.url;
    const mintRecord = mintManifest?.records?.[`${claim.chainId}:${tokenId}`];
    return {
      ...claim,
      chainKey,
      chainName: chain.shortName,
      tokenId,
      cachedImageUrl,
      nftStatus: mintRecord?.status === 'minted' ? 'v3-nft' : mintRecord?.status === 'indexed-only' ? 'legacy-claim' : 'unknown',
      protocolVersion: mintRecord?.status === 'minted' ? 'v3' : mintRecord?.status === 'indexed-only' ? 'legacy' : 'unknown',
      nftOwner: mintRecord?.owner,
      mintStatus: mintRecord?.status ?? 'unknown',
      mintedOwner: mintRecord?.owner,
      explorerUrl: explorerAddressUrl(chain),
    };
  });
}

function newestFirst(a: MarketplaceToken, b: MarketplaceToken) {
  if (a.chainId !== b.chainId) return a.chainId - b.chainId;
  return b.onChainId - a.onChainId;
}

export async function GET(request: Request) {
  const proxied = await proxyRailwayApi(request);
  if (proxied) return proxied;

  const { searchParams } = new URL(request.url);
  const chainParam = searchParams.get('chain');
  const acceptedParam = searchParams.get('accepted');

  const selectedChains = chainParam && chainParam !== 'all'
    ? CHAIN_ORDER.filter((key) => key === chainParam)
    : CHAIN_ORDER;

  if (selectedChains.length === 0) {
    return NextResponse.json({ error: 'Unsupported chain' }, { status: 400 });
  }

  try {
    const [manifest, mintManifest] = await Promise.all([fetchImageManifest(), fetchMintStatusManifest()]);
    const settled = await Promise.allSettled(selectedChains.map((key) => fetchChainClaims(key, manifest, mintManifest)));
    const tokens = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    const errors = settled.flatMap((result, index) =>
      result.status === 'rejected'
        ? [{ chain: selectedChains[index], error: result.reason instanceof Error ? result.reason.message : 'fetch failed' }]
        : [],
    );

    const filtered = tokens
      .filter((token) => acceptedParam === 'true' ? token.isAccepted : acceptedParam === 'false' ? !token.isAccepted : true)
      .sort(newestFirst);

    const countsByChain = CHAIN_ORDER.reduce<Record<string, number>>((acc, key) => {
      const chain = POIDH_CHAINS[key];
      acc[key] = tokens.filter((token) => token.chainId === chain.chainId).length;
      return acc;
    }, {});

    return NextResponse.json({
      source: INDEXER_BASE_URL,
      fetchedAt: new Date().toISOString(),
      total: filtered.length,
      totalUnfiltered: tokens.length,
      countsByChain,
      imageCache: manifest
        ? { enabled: true, generatedAt: manifest.generatedAt, totalCached: manifest.totalCached, totalFailed: manifest.totalFailed }
        : { enabled: false },
      mintStatusCache: mintManifest
        ? { enabled: true, generatedAt: mintManifest.generatedAt, totalChecked: mintManifest.totalChecked, totalMinted: mintManifest.totalMinted, totalIndexedOnly: mintManifest.totalIndexedOnly, totalUnknown: mintManifest.totalUnknown }
        : { enabled: false },
      errors,
      tokens: filtered,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Token index fetch failed' },
      { status: 500 },
    );
  }
}
