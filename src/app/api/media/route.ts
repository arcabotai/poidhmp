import { NextResponse } from 'next/server';
import { resolveUri, safeString } from '@/lib/uri';

export const runtime = 'nodejs';
export const revalidate = 86400;

const ALLOWED_HOSTS = new Set([
  'beige-impossible-dragon-883.mypinata.cloud',
  'ipfs.io',
  'arweave.net',
  'images.pexels.com',
]);

function isAllowedHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (ALLOWED_HOSTS.has(url.hostname) || url.hostname.endsWith('.mypinata.cloud'));
  } catch {
    return false;
  }
}

function normalizeInput(value: string | null) {
  if (!value) return undefined;
  const resolved = resolveUri(value);
  if (!resolved || !isAllowedHttpUrl(resolved)) return undefined;
  return resolved;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sourceUrl = normalizeInput(searchParams.get('url'));

  if (!sourceUrl) {
    return NextResponse.json({ error: 'Missing or unsupported media URL' }, { status: 400 });
  }

  try {
    const response = await fetch(sourceUrl, {
      headers: { accept: 'image/*,application/json,text/plain,*/*', 'user-agent': 'poidhmp-media/0.1' },
      next: { revalidate },
    });

    if (!response.ok) {
      return NextResponse.json({ error: `Source fetch failed: ${response.status}` }, { status: response.status });
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.startsWith('image/')) {
      return NextResponse.redirect(sourceUrl, 302);
    }

    const text = await response.text();
    let imageUrl: string | undefined;
    try {
      const metadata = JSON.parse(text) as Record<string, unknown>;
      imageUrl = resolveUri(safeString(metadata.image) ?? safeString(metadata.image_url) ?? safeString(metadata.thumbnail));
    } catch {
      imageUrl = undefined;
    }

    if (!imageUrl || !isAllowedHttpUrl(imageUrl)) {
      return NextResponse.json({ error: 'No supported image found in metadata' }, { status: 404 });
    }

    return NextResponse.redirect(imageUrl, 302);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Media resolution failed' },
      { status: 500 },
    );
  }
}
