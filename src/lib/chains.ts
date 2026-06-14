export type PoidhChainKey = 'ethereum' | 'arbitrum' | 'base' | 'degen';

export type PoidhChain = {
  key: PoidhChainKey;
  name: string;
  shortName: string;
  chainId: number;
  currency: string;
  nftAddress: `0x${string}`;
  bountyAddress: `0x${string}`;
  rpcUrls: string[];
  explorerBase: string;
  explorerAddressPath: string;
  explorerTokenPath?: string;
  openseaSlug?: string;
  reservoirChain?: string;
  accent: string;
};

export const POIDH_CHAINS: Record<PoidhChainKey, PoidhChain> = {
  ethereum: {
    key: 'ethereum',
    name: 'Ethereum Mainnet',
    shortName: 'Ethereum',
    chainId: 1,
    currency: 'ETH',
    nftAddress: '0x9c5f45d5e1382e4058d334d93c6c01442012a4d9',
    bountyAddress: '0xe731dfadbff20542e10d09d26fc71445c70d4232',
    rpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
    explorerBase: 'https://etherscan.io',
    explorerAddressPath: '/address/',
    openseaSlug: 'ethereum',
    reservoirChain: 'ethereum',
    accent: '#8b9cff',
  },
  arbitrum: {
    key: 'arbitrum',
    name: 'Arbitrum One',
    shortName: 'Arbitrum',
    chainId: 42161,
    currency: 'ETH',
    nftAddress: '0x27e117cc9a8da363442e7bd0618939e3eeeacf6a',
    bountyAddress: '0x5555fa783936c260f77385b4e153b9725fef1719',
    rpcUrls: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
    explorerBase: 'https://arbiscan.io',
    explorerAddressPath: '/address/',
    openseaSlug: 'arbitrum',
    reservoirChain: 'arbitrum',
    accent: '#28a0f0',
  },
  base: {
    key: 'base',
    name: 'Base',
    shortName: 'Base',
    chainId: 8453,
    currency: 'ETH',
    nftAddress: '0x27e117cc9a8da363442e7bd0618939e3eeeacf6a',
    bountyAddress: '0x5555fa783936c260f77385b4e153b9725fef1719',
    rpcUrls: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
    explorerBase: 'https://basescan.org',
    explorerAddressPath: '/address/',
    openseaSlug: 'base',
    reservoirChain: 'base',
    accent: '#0052ff',
  },
  degen: {
    key: 'degen',
    name: 'Degen Chain',
    shortName: 'Degen',
    chainId: 666666666,
    currency: 'DEGEN',
    nftAddress: '0x39f04b7897dcaf9dc454e433f43fb1c3bb528e11',
    bountyAddress: '0x18e5585ca7ce31b90bc8bb7aaf84152857ce243f',
    rpcUrls: ['https://rpc.degen.tips', 'https://rpc.degen.chain.community'],
    explorerBase: 'https://explorer.degen.tips',
    explorerAddressPath: '/address/',
    explorerTokenPath: '/token/',
    accent: '#a855f7',
  },
};

export const CHAIN_ORDER: PoidhChainKey[] = ['base', 'arbitrum', 'ethereum', 'degen'];

export function getChain(key: string | null): PoidhChain | undefined {
  if (!key) return undefined;
  return POIDH_CHAINS[key as PoidhChainKey];
}

export function explorerAddressUrl(chain: PoidhChain, address = chain.nftAddress) {
  return `${chain.explorerBase}${chain.explorerAddressPath}${address}`;
}

export function explorerTokenUrl(chain: PoidhChain, tokenId?: string) {
  const base = `${chain.explorerBase}${chain.explorerTokenPath ?? '/token/'}${chain.nftAddress}`;
  if (!tokenId) return base;

  if (chain.key === 'degen') {
    return `${base}/instance/${tokenId}`;
  }

  return `${base}?a=${encodeURIComponent(tokenId)}`;
}

export function openseaAssetUrl(chain: PoidhChain, tokenId: string) {
  if (!chain.openseaSlug) return undefined;
  return `https://opensea.io/assets/${chain.openseaSlug}/${chain.nftAddress}/${tokenId}`;
}
