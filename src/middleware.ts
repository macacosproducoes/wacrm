import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import type { User } from '@supabase/supabase-js'

// Per-call timeout for Supabase auth in middleware. Vercel edge middleware has strict
// timeout limits (1.5s - 5s on Hobby, 10s on Pro). Capping at 2500ms ensures that if Supabase
// is cold, paused, or experiencing network latency, the request falls back gracefully instead
// of failing with Vercel's 504 "Routing Middleware for this page took too long to respond".
const AUTH_TIMEOUT_MS = 2500

async function getUserWithTimeout(
  supabase: ReturnType<typeof createServerClient>,
  token?: string,
  timeoutMs = AUTH_TIMEOUT_MS
): Promise<{ user: User | null; error: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<{ user: null; error: Error }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ user: null, error: new Error('Supabase auth timeout') })
      }, timeoutMs)
    })

    const authPromise = (
      token ? supabase.auth.getUser(token) : supabase.auth.getUser()
    ).then((res: { data: { user: User | null } | null; error: unknown }) => ({
      user: res.data?.user ?? null,
      error: res.error,
    }))

    return await Promise.race([authPromise, timeoutPromise])
  } catch (err) {
    return { user: null, error: err }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // 1. Immediate bypass for webhooks, cron jobs, and health check endpoints
  if (
    pathname.startsWith('/api/whatsapp/webhook') ||
    pathname.startsWith('/api/whatsapp/uazapi/webhook') ||
    pathname.startsWith('/api/automations/cron') ||
    pathname === '/api/health'
  ) {
    return NextResponse.next()
  }

  let supabaseResponse = NextResponse.next({ request })

  // 2. Check if the request carries any session credentials.
  // Supabase SSR writes cookies starting with 'sb-' (e.g. sb-<project>-auth-token).
  const hasAuthCookies = request.cookies
    .getAll()
    .some((c) => c.name.startsWith('sb-') || c.name.includes('auth-token'))
  const authHeader = request.headers.get('authorization')
  const hasAuthHeader = Boolean(authHeader?.startsWith('Bearer '))

  // Fast-path: If the client sends neither Supabase cookies nor a Bearer header,
  // we know with 100% certainty that the user is unauthenticated.
  // (In test environments, we allow mocked getUser calls even without cookies).
  const shouldCheckAuth =
    process.env.NODE_ENV === 'test' || hasAuthCookies || hasAuthHeader

  const protectedPaths = [
    '/dashboard',
    '/inbox',
    '/contacts',
    '/pipelines',
    '/broadcasts',
    '/automations',
    '/settings',
  ]
  const isProtectedPath = protectedPaths.some((path) => pathname.startsWith(path))
  const isAuthPage =
    pathname === '/login' || pathname === '/signup' || pathname === '/forgot-password'

  // If there are zero auth credentials:
  // - On protected paths: redirect to /login immediately (0 network calls, 0ms)
  // - On auth pages or public pages: pass through immediately (0 network calls, 0ms)
  if (!shouldCheckAuth) {
    if (isProtectedPath) {
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      return NextResponse.redirect(url)
    }

    if (
      pathname.startsWith('/api/whatsapp/') &&
      !pathname.includes('/webhook') &&
      !pathname.includes('/media')
    ) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    return supabaseResponse
  }

  // Fallback safety if environment variables are missing
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    console.error('[middleware] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY')
    if (isProtectedPath) {
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      return NextResponse.redirect(url)
    }
    return supabaseResponse
  }

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
        supabaseResponse = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        )
      },
    },
  })

  let { user, error: authError } = await getUserWithTimeout(supabase)

  if (!user && hasAuthHeader) {
    const token = authHeader!.slice(7).trim()
    const result = await getUserWithTimeout(supabase, token)
    if (result.user) {
      user = result.user
    }
  }

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && isAuthPage) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated
  if (!user && isProtectedPath) {
    const errorMessage = authError instanceof Error ? authError.message : String(authError ?? '')
    const isTimeout = errorMessage.includes('timeout')
    if (hasAuthCookies && isTimeout) {
      console.warn('[middleware] Auth check timed out with active cookies, passing through to client')
      return supabaseResponse
    }

    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks or media proxies)
  if (!user && pathname.startsWith('/api/whatsapp/') &&
      !pathname.includes('/webhook') &&
      !pathname.includes('/media')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|css|js|map|mp3|mp4|wav)$).*)',
  ],
}

