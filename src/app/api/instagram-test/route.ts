import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const username = searchParams.get('username') || 'vinijr';

  const results: Record<string, unknown> = {};

  // Test 1: Yahoo search
  try {
    const res = await fetch(`https://search.yahoo.com/search?p=${encodeURIComponent(`site:instagram.com/${username}`)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(6000),
    });
    const html = await res.text();
    const imgs = [...html.matchAll(/https?:\/\/[^\s"'<>]+\.(?:jpg|png|webp|jpeg)[^\s"'<>]*/gi)].map(m => m[0]);
    results['yahoo'] = { status: res.status, htmlLen: html.length, sampleImgs: imgs.slice(0, 5) };
  } catch (e: unknown) {
    results['yahoo'] = { error: e instanceof Error ? e.message : String(e) };
  }

  // Test 2: DuckDuckGo HTML
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:instagram.com/${username}`)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(6000),
    });
    const html = await res.text();
    const imgs = [...html.matchAll(/https?:\/\/[^\s"'<>]+\.(?:jpg|png|webp|jpeg)[^\s"'<>]*/gi)].map(m => m[0]);
    results['duckduckgo'] = { status: res.status, htmlLen: html.length, sampleImgs: imgs.slice(0, 5) };
  } catch (e: unknown) {
    results['duckduckgo'] = { error: e instanceof Error ? e.message : String(e) };
  }

  // Test 3: Instagram embed page (which returned 200 earlier!)
  try {
    const res = await fetch(`https://www.instagram.com/${username}/embed/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'text/html,*/*',
      },
      signal: AbortSignal.timeout(6000),
    });
    const html = await res.text();
    const og = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i);
    const cdnImgs = [...html.matchAll(/https?:\/\/[^\s"'<>]*(?:cdninstagram|fbcdn)[^\s"'<>]*/gi)].map(m => m[0]);
    results['ig_embed'] = { status: res.status, htmlLen: html.length, ogImage: og ? og[1] : null, cdnImgs: cdnImgs.slice(0, 5) };
  } catch (e: unknown) {
    results['ig_embed'] = { error: e instanceof Error ? e.message : String(e) };
  }

  // Test 4: Instagram Reels / p embed
  try {
    const res = await fetch(`https://www.instagram.com/${username}/feed/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
      },
      signal: AbortSignal.timeout(6000),
    });
    results['ig_feed'] = { status: res.status };
  } catch (e: unknown) {
    results['ig_feed'] = { error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json({ username, results });
}
