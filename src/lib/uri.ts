export function resolveUri(uri: string | undefined | null): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith('ipfs://ipfs/')) return `https://ipfs.io/ipfs/${uri.slice('ipfs://ipfs/'.length)}`;
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}`;
  if (uri.startsWith('ar://')) return `https://arweave.net/${uri.slice('ar://'.length)}`;
  return uri;
}

export function compactAddress(address: string | undefined) {
  if (!address) return '—';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
