import { NextResponse } from 'next/server';
import { createPublicClient, http } from 'viem';
import { getChain, explorerAddressUrl, explorerTokenUrl, openseaAssetUrl } from '@/lib/chains';
import { ERC721_ABI } from '@/lib/erc721';
import { resolveUri, safeString } from '@/lib/uri';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Metadata = {
  name?: string;
  description?: string;
  image?: string;
  animation_url?: string;
  external_url?: string;
  attributes?: unknown;
};

async function fetchJson(url: string): Promise<Metadata | undefined> {
  const res = await fetch(url, {
    headers: { accept: 'application/json,text/plain,*/*', 'user-agent': 'poidhmp/0.1' },
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new Error(`metadata fetch failed: ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text) as Metadata;
  } catch {
    return { description: text.slice(0, 500) };
  }
}

async function tryReadWithRpc<T>(rpcUrls: string[], read: (rpcUrl: string) => Promise<T>) {
  let lastError: unknown;
  for (const rpcUrl of rpcUrls) {
    try {
      return await read(rpcUrl);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('all RPCs failed');
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chain = getChain(searchParams.get('chain'));
  const tokenId = searchParams.get('tokenId')?.trim();

  if (!chain) {
    return NextResponse.json({ error: 'Unsupported chain' }, { status: 400 });
  }
  if (!tokenId || !/^\d+$/.test(tokenId)) {
    return NextResponse.json({ error: 'tokenId must be a non-negative integer' }, { status: 400 });
  }

  try {
    const token = BigInt(tokenId);
    const [owner, tokenUri, collectionName, collectionSymbol] = await tryReadWithRpc(chain.rpcUrls, async (rpcUrl) => {
      const client = createPublicClient({ transport: http(rpcUrl) });
      return Promise.all([
        client.readContract({ address: chain.nftAddress, abi: ERC721_ABI, functionName: 'ownerOf', args: [token] }),
        client.readContract({ address: chain.nftAddress, abi: ERC721_ABI, functionName: 'tokenURI', args: [token] }),
        client.readContract({ address: chain.nftAddress, abi: ERC721_ABI, functionName: 'name' }).catch(() => 'POIDH Claim'),
        client.readContract({ address: chain.nftAddress, abi: ERC721_ABI, functionName: 'symbol' }).catch(() => 'POIDH'),
      ]);
    });

    const resolvedTokenUri = resolveUri(tokenUri);
    let metadata: Metadata | undefined;
    let metadataError: string | undefined;
    if (resolvedTokenUri) {
      try {
        metadata = await fetchJson(resolvedTokenUri);
      } catch (error) {
        metadataError = error instanceof Error ? error.message : 'metadata fetch failed';
      }
    }

    const image = resolveUri(safeString(metadata?.image));
    const animationUrl = resolveUri(safeString(metadata?.animation_url));

    return NextResponse.json({
      chain: {
        key: chain.key,
        name: chain.name,
        chainId: chain.chainId,
        currency: chain.currency,
        nftAddress: chain.nftAddress,
        bountyAddress: chain.bountyAddress,
      },
      tokenId,
      owner,
      collectionName,
      collectionSymbol,
      tokenUri,
      resolvedTokenUri,
      metadata,
      metadataError,
      media: { image, animationUrl },
      links: {
        explorerCollection: explorerAddressUrl(chain),
        explorerToken: explorerTokenUrl(chain, tokenId),
        opensea: openseaAssetUrl(chain, tokenId),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'NFT lookup failed' },
      { status: 500 },
    );
  }
}
