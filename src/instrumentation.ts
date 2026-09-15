export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { startUazApiListener } = await import('@/lib/whatsapp/uazapi-manager');
      const { createClient } = await import('@supabase/supabase-js');

      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      );

      const { data: conns } = await supabase
        .from('whatsapp_connections')
        .select('account_id')
        .eq('provider', 'uazapi')
        .eq('is_active', true);

      if (conns && conns.length > 0) {
        for (const conn of conns) {
          void startUazApiListener(conn.account_id).catch(() => {});
        }
      }

      // Auto-resume Baileys sessions on server boot if saved credentials exist
      try {
        const { connectBaileys, hasSavedSession } = await import('@/lib/whatsapp/baileys/baileys-manager');
        const fs = await import('fs');
        const path = await import('path');
        const sessionsDir = path.join(process.cwd(), 'whatsapp_sessions');
        if (fs.existsSync(sessionsDir)) {
          const accounts = fs.readdirSync(sessionsDir);
          for (const accId of accounts) {
            if (hasSavedSession(accId)) {
              void connectBaileys(accId).catch(() => {});
            }
          }
        }
      } catch (baileysErr) {
        console.warn('[instrumentation] Failed to auto-resume Baileys:', baileysErr);
      }
    } catch (err) {
      console.warn('[instrumentation] Failed to auto-start WhatsApp listeners:', err);
    }
  }
}
