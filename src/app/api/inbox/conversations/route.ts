import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * GET /api/inbox/conversations
 * Returns conversations for the authenticated user's account with embedded contacts and tags.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = supabaseAdmin();

    const { data: profile } = await admin
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!profile?.account_id) {
      return NextResponse.json({ conversations: [] });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const id = searchParams.get('id');

    let query = admin
      .from('conversations')
      .select('*, contact:contacts(*, contact_tags(tags(*)))')
      .eq('account_id', profile.account_id)
      .order('updated_at', { ascending: false });

    if (id) {
      query = query.eq('id', id);
    } else if (status && status !== 'all' && status !== 'unread') {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching conversations via admin API:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Flatten tags matching normalizeConversation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const normalized = (data || []).map((conv: any) => {
      const contact = conv.contact;
      if (!contact) return conv;
      const contactTags = contact.contact_tags || [];
      return {
        ...conv,
        contact: {
          ...contact,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tags: contactTags.map((ct: any) => ct.tags).filter(Boolean),
        },
      };
    });

    return NextResponse.json({
      conversation: normalized[0] || null,
      conversations: normalized,
    });
  } catch (err) {
    console.error('Internal error in conversations API:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
