import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const username = searchParams.get('username') || 'virginia';

  const results: Record<string, unknown> = {};

  // 1. Direct Instagram lookaside with Mobile Safari
  try {
    const igUrl = `https://www.instagram.com/${username}/?from_lookaside=1`;
    const res = await fetch(igUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(6000),
    });
    const html = await res.text();
    const og = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i);
    results['direct_ig_lookaside'] = {
      status: res.status,
      htmlLen: html.length,
      ogImage: og ? og[1].slice(0, 100) : null,
      isPlaceholder: og ? (og[1].includes('rsrc.php') || og[1].includes('kHwIMM5b8PW')) : false,
      sampleHtml: html.slice(0, 200),
    };
  } catch (e: unknown) {
    results['direct_ig_lookaside'] = { error: e instanceof Error ? e.message : String(e) };
  }

  // 2. Direct Instagram standard profile
  try {
    const igUrl = `https://www.instagram.com/${username}/`;
    const res = await fetch(igUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(6000),
    });
    const html = await res.text();
    const og = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i);
    results['direct_ig_standard'] = {
      status: res.status,
      htmlLen: html.length,
      ogImage: og ? og[1].slice(0, 100) : null,
      isPlaceholder: og ? (og[1].includes('rsrc.php') || og[1].includes('kHwIMM5b8PW')) : false,
    };
  } catch (e: unknown) {
    results['direct_ig_standard'] = { error: e instanceof Error ? e.message : String(e) };
  }

  // 3. Threads.net
  try {
    const threadsUrl = `https://www.threads.net/@${username}`;
    const res = await fetch(threadsUrl, {
      headers: {
        'User-Agent': 'WhatsApp/2.21.12.21 A',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
      },
      signal: AbortSignal.timeout(6000),
    });
    const html = await res.text();
    const og = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i);
    results['threads'] = {
      status: res.status,
      htmlLen: html.length,
      ogImage: og ? og[1].slice(0, 100) : null,
      isPlaceholder: og ? (og[1].includes('rsrc.php') || og[1].includes('kHwIMM5b8PW')) : false,
    };
  } catch (e: unknown) {
    results['threads'] = { error: e instanceof Error ? e.message : String(e) };
  }

  return NextResponse.json({ username, results });
}
