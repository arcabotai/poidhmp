'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { CHAIN_ORDER, POIDH_CHAINS, PoidhChainKey, explorerAddressUrl, explorerTokenUrl, openseaAssetUrl } from '@/lib/chains';
import { compactAddress } from '@/lib/uri';

type LookupResult = {
  chain: { key: string; name: string; chainId: number; currency: string; nftAddress: string; bountyAddress: string };
  tokenId: string;
  owner: string;
  collectionName?: string;
  collectionSymbol?: string;
  tokenUri?: string;
  resolvedTokenUri?: string;
  metadata?: { name?: string; description?: string; image?: string; animation_url?: string; external_url?: string; attributes?: unknown };
  metadataError?: string;
  media?: { image?: string; animationUrl?: string };
  links: { explorerCollection: string; explorerToken: string; opensea?: string };
};

type MarketplaceToken = {
  id: number;
  chainId: number;
  chainKey: PoidhChainKey;
  chainName: string;
  onChainId: number;
  tokenId: string;
  title: string;
  description: string;
  url: string | null;
  issuer: string;
  isAccepted: boolean;
  isVoting: boolean;
  bountyId: number;
  owner: string;
  cachedImageUrl?: string;
  explorerUrl: string;
  openseaUrl?: string;
};

type TokensResponse = {
  source: string;
  fetchedAt: string;
  total: number;
  totalUnfiltered: number;
  countsByChain: Record<string, number>;
  errors: { chain: string; error: string }[];
  tokens: MarketplaceToken[];
};

const featuredIds: Record<PoidhChainKey, string[]> = {
  base: ['987', '1000', '1200'],
  arbitrum: ['181', '200', '250'],
  ethereum: ['1', '2', '10'],
  degen: ['1198', '1250', '1500'],
};

const statusLabels = {
  all: 'All NFTs',
  accepted: 'Accepted / owned',
  escrow: 'In escrow / unaccepted',
} as const;

type StatusFilter = keyof typeof statusLabels;

export default function Home() {
  const [chainKey, setChainKey] = useState<PoidhChainKey>('base');
  const [tokenId, setTokenId] = useState('987');
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [tokensData, setTokensData] = useState<TokensResponse | null>(null);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [marketChain, setMarketChain] = useState<'all' | PoidhChainKey>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(36);

  const chain = POIDH_CHAINS[chainKey];
  const quickIds = useMemo(() => featuredIds[chainKey], [chainKey]);

  useEffect(() => {
    let cancelled = false;
    async function loadTokens() {
      setTokensLoading(true);
      setTokensError(null);
      try {
        const response = await fetch('/api/tokens');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to fetch marketplace tokens');
        if (!cancelled) setTokensData(data as TokensResponse);
      } catch (err) {
        if (!cancelled) setTokensError(err instanceof Error ? err.message : 'Failed to fetch marketplace tokens');
      } finally {
        if (!cancelled) setTokensLoading(false);
      }
    }
    loadTokens();
    return () => { cancelled = true; };
  }, []);

  const filteredTokens = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tokensData?.tokens ?? []).filter((token) => {
      if (marketChain !== 'all' && token.chainKey !== marketChain) return false;
      if (statusFilter === 'accepted' && !token.isAccepted) return false;
      if (statusFilter === 'escrow' && token.isAccepted) return false;
      if (!q) return true;
      return [token.title, token.description, token.tokenId, token.owner, token.issuer, token.chainName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [marketChain, query, statusFilter, tokensData]);

  async function lookup(event?: FormEvent) {
    event?.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`/api/nft?chain=${chainKey}&tokenId=${encodeURIComponent(tokenId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Lookup failed');
      setResult(data as LookupResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lookup failed');
    } finally {
      setLoading(false);
    }
  }

  function inspectToken(token: MarketplaceToken) {
    setChainKey(token.chainKey);
    setTokenId(token.tokenId);
    setTimeout(() => document.getElementById('lookup')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 20);
  }

  const loadedTotal = tokensData?.total ?? 0;
  const acceptedTotal = tokensData?.tokens.filter((token) => token.isAccepted).length ?? 0;

  return (
    <main className="container">
      <section className="hero">
        <div className="card heroMain">
          <div className="kicker">poidh marketplace / claim NFT discovery</div>
          <h1>pics sold, or it didn’t happen.</h1>
          <p className="subtitle">
            A clean market surface for POIDH v3 claim NFTs. Now backed by Kenny’s official indexer at indexer.poidh.xyz, not random RPC archaeology.
          </p>
          <div className="nav">
            <a className="button primary" href="#market">Browse NFTs</a>
            <a className="button" href="#lookup">Look up NFT</a>
            <a className="button" href="https://indexer.poidh.xyz/swagger" target="_blank" rel="noreferrer">Indexer API</a>
            <span className="pill">{tokensLoading ? 'loading…' : `${loadedTotal.toLocaleString()} indexed NFTs`}</span>
          </div>
        </div>
        <aside className="card side">
          <div className="stat"><b>{tokensLoading ? '…' : loadedTotal.toLocaleString()}</b><span>claim NFTs from official indexer</span></div>
          <div className="stat"><b>{tokensLoading ? '…' : acceptedTotal.toLocaleString()}</b><span>accepted / user-owned claims</span></div>
          <div className="stat"><b>4</b><span>chains indexed</span></div>
          <div className="notice">Still no custody and no fake listings. This is the real inventory layer before native sales.</div>
        </aside>
      </section>

      <section className="section">
        <div className="sectionHead">
          <div>
            <div className="kicker">canonical contracts</div>
            <h2>Claim NFT collections</h2>
          </div>
          <p className="muted">Contracts confirmed by Kenny. NFT inventory fetched from `https://indexer.poidh.xyz/claim/:chainId`.</p>
        </div>
        <div className="grid">
          {CHAIN_ORDER.map((key) => {
            const item = POIDH_CHAINS[key];
            return (
              <article className="card chainCard" key={item.key} style={{ ['--accent' as string]: item.accent }}>
                <div className="chainTop">
                  <span className="pill">{item.currency} · {item.chainId}</span>
                  <h3>{item.shortName}</h3>
                  <p className="muted">{tokensData?.countsByChain?.[key]?.toLocaleString() ?? '—'} indexed claims</p>
                  <div className="code">{item.nftAddress}</div>
                </div>
                <div className="links">
                  <a className="button" href={explorerAddressUrl(item)} target="_blank" rel="noreferrer">Explorer</a>
                  {item.openseaSlug ? <a className="button" href={`https://opensea.io/assets/${item.openseaSlug}/${item.nftAddress}`} target="_blank" rel="noreferrer">OpenSea</a> : null}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="section" id="market">
        <div className="sectionHead">
          <div>
            <div className="kicker">official indexer inventory</div>
            <h2>Browse all POIDH NFTs</h2>
          </div>
          <p className="muted">Loaded from Railway-hosted POIDH indexer. Cached for 5 minutes by POIDHMP.</p>
        </div>
        <div className="card filters">
          <select value={marketChain} onChange={(e) => { setMarketChain(e.target.value as 'all' | PoidhChainKey); setVisibleCount(36); }}>
            <option value="all">All chains</option>
            {CHAIN_ORDER.map((key) => <option key={key} value={key}>{POIDH_CHAINS[key].name}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value as StatusFilter); setVisibleCount(36); }}>
            {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <input value={query} onChange={(e) => { setQuery(e.target.value); setVisibleCount(36); }} placeholder="Search title, owner, token ID…" />
          <span className="pill">{filteredTokens.length.toLocaleString()} shown</span>
        </div>
        {tokensError ? <div className="notice error" style={{ marginTop: 14 }}>{tokensError}</div> : null}
        {tokensData?.errors?.length ? <div className="notice" style={{ marginTop: 14 }}>Partial indexer errors: {tokensData.errors.map((e) => `${e.chain}: ${e.error}`).join('; ')}</div> : null}
        {tokensLoading ? <div className="notice" style={{ marginTop: 14 }}>Loading official POIDH indexer inventory…</div> : null}
        <div className="nftGrid">
          {filteredTokens.slice(0, visibleCount).map((token) => (
            <article className="card nftCard" key={`${token.chainKey}-${token.tokenId}`}>
              <div className="thumb">
                {token.cachedImageUrl || token.url ? (
                  <img
                    src={token.cachedImageUrl || `/api/media?url=${encodeURIComponent(token.url ?? '')}`}
                    alt={token.title || `POIDH #${token.tokenId}`}
                    loading="lazy"
                    onLoad={(event) => event.currentTarget.parentElement?.classList.remove('thumbBroken')}
                    onError={(event) => {
                      event.currentTarget.style.display = 'none';
                      event.currentTarget.parentElement?.classList.add('thumbBroken');
                    }}
                  />
                ) : <span className="muted">No image</span>}
              </div>
              <div className="nftBody">
                <div className="nftMeta">
                  <span className="pill">{token.chainName} #{token.tokenId}</span>
                  <span className={token.isAccepted ? 'status accepted' : 'status escrow'}>{token.isAccepted ? 'accepted' : 'escrow'}</span>
                </div>
                <h3>{token.title || `POIDH claim #${token.tokenId}`}</h3>
                <p className="muted">{token.description || 'No description.'}</p>
                <div className="miniKv"><span>Owner</span><span>{compactAddress(token.owner)}</span></div>
                <div className="links">
                  <button className="button primary" type="button" onClick={() => inspectToken(token)}>Inspect</button>
                  <a className="button" href={token.explorerUrl} target="_blank" rel="noreferrer">Explorer</a>
                  {token.openseaUrl ? <a className="button" href={token.openseaUrl} target="_blank" rel="noreferrer">Market</a> : null}
                </div>
              </div>
            </article>
          ))}
        </div>
        {filteredTokens.length > visibleCount ? (
          <div className="loadMore">
            <button className="button primary" type="button" onClick={() => setVisibleCount((count) => count + 36)}>Load more NFTs</button>
          </div>
        ) : null}
      </section>

      <section className="section" id="lookup">
        <div className="sectionHead">
          <div>
            <div className="kicker">live contract lookup</div>
            <h2>Inspect a claim NFT</h2>
          </div>
          <p className="muted">Reads `ownerOf` + `tokenURI`, resolves metadata, then gives market links.</p>
        </div>
        <form className="card lookup" onSubmit={lookup}>
          <div className="formRow">
            <div className="field">
              <label>Chain</label>
              <select value={chainKey} onChange={(e) => { const next = e.target.value as PoidhChainKey; setChainKey(next); setTokenId(featuredIds[next][0]); }}>
                {CHAIN_ORDER.map((key) => <option key={key} value={key}>{POIDH_CHAINS[key].name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Token ID</label>
              <input inputMode="numeric" pattern="[0-9]*" value={tokenId} onChange={(e) => setTokenId(e.target.value)} placeholder="e.g. 987" />
            </div>
          </div>
          <button className="button primary" type="submit" disabled={loading}>{loading ? 'Looking…' : 'Inspect NFT'}</button>
        </form>
        <div className="links" style={{ marginTop: 12 }}>
          {quickIds.map((id) => <button className="button" key={id} onClick={() => setTokenId(id)} type="button">try #{id}</button>)}
          <a className="button" href={explorerTokenUrl(chain, tokenId || undefined)} target="_blank" rel="noreferrer">token explorer</a>
          {openseaAssetUrl(chain, tokenId || '0') ? <a className="button" href={openseaAssetUrl(chain, tokenId || '0')} target="_blank" rel="noreferrer">market link</a> : null}
        </div>

        {error ? <div className="notice error" style={{ marginTop: 14 }}>{error}</div> : null}
        {result ? (
          <article className="card result">
            <div className="mediaBox">
              {result.media?.image ? <img src={result.media.image} alt={result.metadata?.name || `POIDH claim #${result.tokenId}`} /> : <span className="muted">No image found in metadata</span>}
            </div>
            <div className="details">
              <div className="kicker">{result.collectionSymbol || 'POIDH'} · token #{result.tokenId}</div>
              <h3>{result.metadata?.name || result.collectionName || `POIDH claim #${result.tokenId}`}</h3>
              <p className="muted">{result.metadata?.description || result.metadataError || 'Metadata loaded without a description.'}</p>
              <div className="kv"><span>Owner</span><a href={`${POIDH_CHAINS[result.chain.key as PoidhChainKey].explorerBase}/address/${result.owner}`} target="_blank" rel="noreferrer">{compactAddress(result.owner)}</a></div>
              <div className="kv"><span>Chain</span><span>{result.chain.name}</span></div>
              <div className="kv"><span>NFT</span><span>{compactAddress(result.chain.nftAddress)}</span></div>
              <div className="kv"><span>Metadata</span>{result.resolvedTokenUri ? <a href={result.resolvedTokenUri} target="_blank" rel="noreferrer">open tokenURI</a> : <span>—</span>}</div>
              <div className="links">
                <a className="button primary" href={result.links.explorerToken} target="_blank" rel="noreferrer">Explorer token</a>
                {result.links.opensea ? <a className="button" href={result.links.opensea} target="_blank" rel="noreferrer">Open marketplace</a> : null}
                {result.metadata?.external_url ? <a className="button" href={result.metadata.external_url} target="_blank" rel="noreferrer">External URL</a> : null}
              </div>
            </div>
          </article>
        ) : null}
      </section>

      <section className="section card" style={{ padding: 24 }}>
        <div className="kicker">next phase</div>
        <h2>Native listings later.</h2>
        <p className="muted">
          This launch keeps the bounty protocol untouched. The next PR can add a tiny marketplace contract: list, cancel, buy. Until then this site gives POIDH a clean NFT market front door using the official indexer.
        </p>
      </section>

      <footer className="footer">Built by Cad from Arca · data from indexer.poidh.xyz · no token, no goblin claims</footer>
    </main>
  );
}
