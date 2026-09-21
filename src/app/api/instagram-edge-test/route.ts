import { NextResponse } from 'next/server';

export const runtime = 'edge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const username = searchParams.get('username') || 'vinijr';

  const results: Record<string, unknown> = {};

  const targets = [
    {
      name: 'Mobile-Safari-Lookaside',
      url: `https://www.instagram.com/${username}/?from_lookaside=1`,
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    },
    {
      name: 'WhatsApp-Bot-Lookaside',
      url: `https://www.instagram.com/${username}/?from_lookaside=1`,
      ua: 'WhatsApp/2.21.12.21 A',
    },
    {
      name: 'Facebook-Bot-Lookaside',
      url: `https://www.instagram.com/${username}/?from_lookaside=1`,
      ua: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    },
    {
      name: 'Threads-Direct',
      url: `https://www.threads.net/@${username}`,
      ua: 'WhatsApp/2.21.12.21 A',
    }
  ];

  for (const t of targets) {
    try {
      const res = await fetch(t.url, {
        headers: {
          'User-Agent': t.ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
        },
      });
      const html = await res.text();
      const og = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i);
      const isPlaceholder = og && (og[1].includes('rsrc.php') || og[1].includes('kHwIMM5b8PW'));
      results[t.name] = {
        status: res.status,
        htmlLen: html.length,
        ogImage: og ? (isPlaceholder ? 'PLACEHOLDER' : og[1].slice(0, 100)) : null,
      };
    } catch(e: unknown) {
      results[t.name] = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return NextResponse.json({ runtime: 'edge', username, results });
}
