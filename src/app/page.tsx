'use client';

import { FormEvent, useMemo, useState } from 'react';
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

const featuredIds: Record<PoidhChainKey, string[]> = {
  base: ['987', '1000', '1200'],
  arbitrum: ['181', '200', '250'],
  ethereum: ['1', '2', '10'],
  degen: ['1198', '1250', '1500'],
};

export default function Home() {
  const [chainKey, setChainKey] = useState<PoidhChainKey>('base');
  const [tokenId, setTokenId] = useState('987');
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const chain = POIDH_CHAINS[chainKey];
  const quickIds = useMemo(() => featuredIds[chainKey], [chainKey]);

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

  return (
    <main className="container">
      <section className="hero">
        <div className="card heroMain">
          <div className="kicker">poidh marketplace / claim NFT discovery</div>
          <h1>pics sold, or it didn’t happen.</h1>
          <p className="subtitle">
            A clean market surface for POIDH v3 claim NFTs across Ethereum, Arbitrum, Base, and Degen Chain. First version: browse contracts, inspect tokens, jump to live market/explorer pages. Native listing contract comes after the safe discovery layer.
          </p>
          <div className="nav">
            <a className="button primary" href="#lookup">Look up NFT</a>
            <a className="button" href="https://poidh.xyz" target="_blank" rel="noreferrer">Open poidh.xyz</a>
            <span className="pill">4 chains</span>
            <span className="pill">v3 claim NFTs</span>
          </div>
        </div>
        <aside className="card side">
          <div className="stat"><b>4</b><span>canonical NFT contracts</span></div>
          <div className="stat"><b>0</b><span>core bounty flow changes</span></div>
          <div className="stat"><b>v0</b><span>discovery first, escrow later</span></div>
          <div className="notice">This MVP does not custody funds or NFTs. It reads live contracts and links out. Boring, safe, useful.</div>
        </aside>
      </section>

      <section className="section">
        <div className="sectionHead">
          <div>
            <div className="kicker">canonical contracts</div>
            <h2>Claim NFT collections</h2>
          </div>
          <p className="muted">Confirmed by Kenny + matched in POIDH app config.</p>
        </div>
        <div className="grid">
          {CHAIN_ORDER.map((key) => {
            const item = POIDH_CHAINS[key];
            return (
              <article className="card chainCard" key={item.key} style={{ ['--accent' as string]: item.accent }}>
                <div className="chainTop">
                  <span className="pill">{item.currency} · {item.chainId}</span>
                  <h3>{item.shortName}</h3>
                  <p className="muted">POIDH v3 claim NFT contract</p>
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
          This launch keeps the bounty protocol untouched. The next PR can add a tiny marketplace contract: list, cancel, buy. Until then this site gives POIDH a clean NFT market front door without custody risk.
        </p>
      </section>

      <footer className="footer">Built by Cad from Arca · POIDH is pics or it didn’t happen · no token, no goblin claims</footer>
    </main>
  );
}
