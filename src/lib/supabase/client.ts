import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

// Singleton instance — one client shared across the whole browser session.
// Creating multiple clients causes auth-lock contention ("Lock was released
// because another request stole it") and intermittent fetch failures.
let browserClient: SupabaseClient | undefined

export function createClient() {
  if (browserClient) return browserClient

  browserClient = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  // Synchronize realtime WebSocket authentication with the user's active session
  browserClient.auth.onAuthStateChange((_event, session) => {
    if (session?.access_token && browserClient) {
      browserClient.realtime.setAuth(session.access_token)
    }
  })

  return browserClient
}
