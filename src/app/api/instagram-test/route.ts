import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const CRAWLERS = [
  { name: 'facebookexternalhit', ua: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
  { name: 'whatsapp', ua: 'WhatsApp/2.21.12.21 A' },
  { name: 'twitterbot', ua: 'Twitterbot/1.0' },
  { name: 'telegrambot', ua: 'TelegramBot (like TwitterBot)' },
  { name: 'applebot', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1)' },
  { name: 'slackbot', ua: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' },
  { name: 'discordbot', ua: 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
  { name: 'googlebot', ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  { name: 'bingbot', ua: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)' },
  { name: 'duckduckbot', ua: 'DuckDuckBot/1.0; (+http://duckduckgo.com/duckduckbot.html)' },
];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const username = searchParams.get('username') || 'vinijr';

  const results: Record<string, unknown> = {};

  for (const c of CRAWLERS) {
    try {
      const url = `https://www.instagram.com/${username}/?from_lookaside=1`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': c.ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
        },
        signal: AbortSignal.timeout(4000),
      });
      const html = await res.text();
      const og = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i);
      const isPlaceholder = og && (og[1].includes('rsrc.php') || og[1].includes('kHwIMM5b8PW'));
      results[c.name] = {
        status: res.status,
        htmlLen: html.length,
        ogImage: og ? (isPlaceholder ? 'PLACEHOLDER' : og[1].slice(0, 100)) : null,
      };
      if (og && !isPlaceholder) {
        break; // Found working crawler!
      }
    } catch(e: unknown) {
      results[c.name] = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return NextResponse.json({ username, results });
}
