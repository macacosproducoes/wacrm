// ===============================================================

// Server-side account context — for API routes and server
// components. Reads the caller's profile + account in one round
// trip and verifies role on demand.
//
// Calling convention
// ------------------
// API routes don't need to redo `supabase.auth.getUser()` — they
// receive a fully-loaded context from `requireRole`:
//
//   try {
//     const ctx = await requireRole("admin");
//   } catch (err) {
//     return toErrorResponse(err);
//   }
// ===============================================================

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";

// -------------------------------------------------------------
// Errors
// -------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

// -------------------------------------------------------------
// Account context
// -------------------------------------------------------------

export interface AccountContext {
  /** Supabase SSR client, RLS scoped to the calling user. */
  supabase: SupabaseClient;
  /** `auth.uid()` for the caller. Always defined when this resolves. */
  userId: string;
  /** Caller's account_id from their profile row. */
  accountId: string;
  /** Caller's role within their account. */
  role: AccountRole;
  /** Lightweight account meta — id + name. */
  account: { id: string; name: string };
}

export async function getCurrentAccount(): Promise<AccountContext> {
  const supabase = await createClient();
  let user: { id: string; email?: string } | null = null;

  // 1. Try Bearer token from request headers
  try {
    const reqHeaders = await headers();
    const authHeader = reqHeaders.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      if (token && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        const admin = createAdminClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL,
          process.env.SUPABASE_SERVICE_ROLE_KEY

        );
        const { data: userData } = await admin.auth.getUser(token);
        if (userData && userData.user) {
          user = userData.user;
        }
      }
    }
  } catch {
    // headers() might not be available in non-request contexts
  }


  if (!user) {
    const {
      data: { user: cookieUser },
      error: userErr,
    } = await supabase.auth.getUser();
    if (cookieUser && !userErr) {
      user = cookieUser;
    }
  }

  if (!user) {
    throw new UnauthorizedError();
  }

  let profileData: { account_id?: string; account_role?: string } | null = null;
  const { data, error } = await supabase
    .from("profiles")
    .select("account_id, account_role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (data && data.account_id && data.account_role) {
    profileData = data;
  } else if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const admin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { data: adminProf } = await admin
      .from("profiles")
      .select("account_id, account_role")
      .eq("user_id", user.id)
      .maybeSingle();
    if (adminProf && adminProf.account_id && adminProf.account_role) {
      profileData = adminProf;
    }
  }

  if (!profileData || !profileData.account_id || !profileData.account_role) {
    throw new ForbiddenError("Profile is not linked to an account");
  }

  if (!isAccountRole(profileData.account_role)) {
    throw new ForbiddenError(`Unknown account role: ${profileData.account_role}`);
  }

  let account: { id: string; name: string } | null = null;
  const { data: acc } = await supabase
    .from("accounts")
    .select("id, name")
    .eq("id", profileData.account_id)
    .maybeSingle();

  if (acc) {
    account = acc;
  } else if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const admin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { data: adminAcc } = await admin
      .from("accounts")
      .select("id, name")
      .eq("id", profileData.account_id)
      .maybeSingle();
    if (adminAcc) {
      account = adminAcc;
    }
  }

  if (!account) {
    throw new ForbiddenError("Profile is not linked to an account");
  }

  return {
    supabase,
    userId: user.id,
    accountId: profileData.account_id,
    role: profileData.account_role as AccountRole,
    account: {id: account.id, name: account.name },
  };
}

export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`,
    );
  }
  return ctx;
}
