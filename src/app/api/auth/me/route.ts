import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { DEFAULT_CURRENCY } from '@/lib/currency';

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    let user: { id: string; email?: string } | null = null;

    // 1. Try Bearer token from header
    const authHeader = request.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token) {
        const admin = supabaseAdmin();
        const { data } = await admin.auth.getUser(token);
        if (data?.user) {
          user = data.user;
        }
      }
    }

    // 2. Try cookie session via createClient()
    if (!user) {
      try {
        const supabase = await createClient();
        const { data: { user: cookieUser } } = await supabase.auth.getUser();
        if (cookieUser) {
          user = cookieUser;
        }
      } catch {
        // Continue
      }
    }

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = supabaseAdmin();
    const { data: profile, error: profileErr } = await admin
      .from('profiles')
      .select('id, full_name, email, avatar_url, role, beta_features, account_id, account_role')
      .eq('user_id', user.id)
      .maybeSingle();

    if (profileErr || !profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    let account = null;
    if (profile.account_id) {
      const { data: acc } = await admin
        .from('accounts')
        .select('id, name, default_currency')
        .eq('id', profile.account_id)
        .maybeSingle();

      if (acc) {
        account = {
          id: acc.id,
          name: acc.name,
          default_currency: acc.default_currency ?? DEFAULT_CURRENCY,
        };
      }
    }

    return NextResponse.json(
      {
        user: { id: user.id, email: user.email },
        profile,
        account,
      },
      {
        headers: {
          'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        },
      }
    );
  } catch (err) {
    console.error('[/api/auth/me] error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
