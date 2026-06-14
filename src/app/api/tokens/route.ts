import { NextResponse } from 'next/server';
import { CHAIN_ORDER, POIDH_CHAINS, PoidhChainKey, explorerTokenUrl, openseaAssetUrl } from '@/lib/chains';

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
  explorerUrl: string;
  openseaUrl?: string;
};

async function fetchChainClaims(chainKey: PoidhChainKey): Promise<MarketplaceToken[]> {
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
    return {
      ...claim,
      chainKey,
      chainName: chain.shortName,
      tokenId,
      explorerUrl: explorerTokenUrl(chain, tokenId),
      openseaUrl: openseaAssetUrl(chain, tokenId),
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
    const settled = await Promise.allSettled(selectedChains.map(fetchChainClaims));
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
