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
};

type ImageManifest = {
  generatedAt?: string;
  totalCached?: number;
  totalFailed?: number;
  images?: Record<string, { url?: string }>;
};

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

async function fetchChainClaims(chainKey: PoidhChainKey, manifest: ImageManifest | null): Promise<MarketplaceToken[]> {
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
    return {
      ...claim,
      chainKey,
      chainName: chain.shortName,
      tokenId,
      cachedImageUrl,
      explorerUrl: explorerAddressUrl(chain),
    };
  });
}

function newestFirst(a: MarketplaceToken, b: MarketplaceToken) {
  if (a.chainId !== b.chainId) return a.chainId - b.chainId;
  return b.onChainId - a.onChainId;
}

export async function GET(request: Request) {
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
    const manifest = await fetchImageManifest();
    const settled = await Promise.allSettled(selectedChains.map((key) => fetchChainClaims(key, manifest)));
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
