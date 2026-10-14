"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import {
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  isAccountRole,
  type AccountRole,
} from "@/lib/auth/roles";

interface Profile {
  id: string;
  user_id?: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  /**
   * Opted-in beta feature keys for this account. No current feature
   * reads this — Flows was the last user and went to soft-GA in PR
   * #134 — but the column survives for future beta gates.
   */
  beta_features: string[];
  account_id: string | null;
  account_role: AccountRole | null;
}

interface AccountSummary {
  id: string;
  name: string;
  /** Default deal currency (ISO-4217). NOT NULL DEFAULT 'USD' in the
   *  DB (migration 021); narrowed to DEFAULT_CURRENCY when absent. */
  default_currency: string;
}

/**
 * Whether we managed to establish what this user may do.
 *
 * `unlinked` and `error` are the states worth surfacing: every RLS
 * policy checks `is_account_member(account_id, …)` and every `useCan`
 * gate returns false without a role, so in both the app silently
 * becomes read-only — the whole UI renders, and nothing saves. That is
 * indistinguishable from a bug unless we say so (issue #471).
 */
export type AccountStatus =
  /** Profile row still in flight. */
  | "loading"
  /** Account + role resolved; normal operation. */
  | "ready"
  /** Signed in, but no profile row / no account / no role on it. */
  | "unlinked"
  /** The profile lookup itself failed after retrying. */
  | "error";

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  /**
   * Session-level loading. Flips to false as soon as we know whether
   * a user is signed in, *without* waiting for the profile row. Use
   * this for chrome (sidebar / header) that can render with just the
   * user object.
   */
  loading: boolean;
  /**
   * Profile-row loading. Stays true until `fetchProfile` settles
   * (success, missing row, or error). Code that branches on
   * `profile.beta_features` MUST gate on this — otherwise it sees the
   * `{ loading: false, profile: null }` window during initial load
   * and may take the "not opted in" branch incorrectly.
   */
  profileLoading: boolean;
  signOut: () => Promise<void>;
  /** Re-fetch the current user's profile row — call after a save from
   *  the settings form so header/sidebar reflect the change without a
   *  full page reload. */
  refreshProfile: () => Promise<void>;

  // ----------------------------------------------------------
  // Account-scoped context (added by the account-sharing series)
  //
  // All of these are nullable until `profileLoading` is false.
  // After the profile resolves they're guaranteed to be set,
  // because migration 017 made `account_id` / `account_role`
  // NOT NULL on `profiles`.
  // ----------------------------------------------------------

  /**
   * Outcome of resolving this user's account + role. Anything other
   * than `ready` means writes will be rejected — render
   * `<AccountAccessAlert />` (already mounted in the dashboard shell)
   * rather than letting the user discover it one failed save at a time.
   */
  accountStatus: AccountStatus;
  /** Underlying message when `accountStatus` is 'error' / 'unlinked'. */
  accountStatusDetail: string | null;
  /** Account id the current user belongs to. Null while loading. */
  accountId: string | null;
  /** Role within that account. Null while loading. */
  accountRole: AccountRole | null;
  /** Lightweight account meta — id + name + default_currency. Null while loading. */
  account: AccountSummary | null;
  /** Account default deal currency. Falls back to DEFAULT_CURRENCY
   *  while loading or when no account is resolved, so callers can use
   *  it unconditionally. */
  defaultCurrency: string;
  /** True if `accountRole === 'owner'`. */
  isOwner: boolean;
  /** True if `accountRole === 'admin'` (does NOT include owner — use canManageMembers for "admin or above"). */
  isAdmin: boolean;
  /** True if `accountRole === 'agent'`. */
  isAgent: boolean;
  /** True if `accountRole === 'viewer'`. */
  isViewer: boolean;
  /** True if the caller can manage members (admin+). */
  canManageMembers: boolean;
  /** True if the caller can edit account-wide settings (admin+). */
  canEditSettings: boolean;
  /** True if the caller can send messages and edit operational data (agent+). */
  canSendMessages: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const CACHE_PROFILE_KEY = "wacrm_cached_profile";
const CACHE_ACCOUNT_KEY = "wacrm_cached_account";

function getCachedAuth(): { profile: Profile | null; account: AccountSummary | null } {
  if (typeof window === "undefined") return { profile: null, account: null };
  try {
    const p = localStorage.getItem(CACHE_PROFILE_KEY) ?? sessionStorage.getItem(CACHE_PROFILE_KEY);
    const a = localStorage.getItem(CACHE_ACCOUNT_KEY) ?? sessionStorage.getItem(CACHE_ACCOUNT_KEY);
    return {
      profile: p ? JSON.parse(p) : null,
      account: a ? JSON.parse(a) : null,
    };
  } catch {
    return { profile: null, account: null };
  }
}

/** Attempts at the profile lookup, including the first. */
const PROFILE_FETCH_ATTEMPTS = 3;
const PROFILE_FETCH_TIMEOUT_MS = 10000;
const PROFILE_FETCH_RETRY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shape of the `profiles` select below. */
interface ProfileRow {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  beta_features: string[] | null;
  account_id: string | null;
  account_role: string | null;
}

/**
 * AuthProvider — wrap this around the dashboard layout.
 * Makes ONE getSession() call for the whole tree instead of one per
 * component, avoiding internal lock contention in the Supabase client.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [cached] = useState(() => getCachedAuth());
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(cached.profile);
  const [account, setAccount] = useState<AccountSummary | null>(cached.account);
  // If we have cached profile, skip the loading screen completely for 0ms dashboard entry
  const [loading, setLoading] = useState(!cached.profile);
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(!cached.profile);

  // Tracks the user ID we've successfully initiated/completed fetching
  // a profile for. This prevents redundant re-fetches and toggling
  // profileLoading back to true on window focus events/token refresh.
  const lastFetchedUserIdRef = useRef<string | null>(null);

  // Shared across init, auth-state-change listener, and the exposed
  // refreshProfile() callback. Reads the current session's user id and
  // pulls the matching profile row along with its account summary.
  const fetchProfile = useCallback(async (userId: string) => {
    const supabase = createClient();
    if (!profile && !cached.profile) setProfileLoading(true);
    setStatusDetail(null);
    lastFetchedUserIdRef.current = userId;
    try {
      let data: ProfileRow | null = null;
      let accountRow: AccountSummary | null = null;

      // 1. Try Supabase client query with 3.5s timeout
      try {
        const timeoutPromise = new Promise<{ data: null; error: { message: string } }>((resolve) =>
          setTimeout(() => resolve({ data: null, error: { message: "timeout" } }), 3500)
        );

        const queryPromise = supabase
          .from("profiles")
          .select("id, full_name, email, avatar_url, role, beta_features, account_id, account_role")
          .eq("user_id", userId)
          .maybeSingle();

        const result = await Promise.race([queryPromise, timeoutPromise]);
        if (!result.error && result.data) {
          data = result.data;
        }
      } catch (clientErr) {
        console.warn("[AuthProvider] Supabase client query warning:", clientErr);
      }

      // 2. Fast Resilient Server Fallback via /api/auth/me
      if (!data) {
        try {
          const apiRes = await fetch("/api/auth/me", { cache: "no-store" });
          if (apiRes.ok) {
            const apiJson = await apiRes.json();
            if (apiJson?.profile) {
              data = apiJson.profile;
              if (apiJson.account) {
                accountRow = apiJson.account;
              }
            }
          }
        } catch (apiErr) {
          console.warn("[AuthProvider] /api/auth/me fallback error:", apiErr);
        }
      }

      // 3. Fallback to /api/account if accountRow is still missing
      if (data && !accountRow && data.account_id) {
        try {
          const { data: acc } = await supabase
            .from("accounts")
            .select("id, name, default_currency")
            .eq("id", data.account_id)
            .maybeSingle();
          if (acc) {
            accountRow = {
              id: acc.id,
              name: acc.name,
              default_currency: acc.default_currency ?? DEFAULT_CURRENCY,
            };
          } else {
            const res = await fetch("/api/account").then((r) => r.json());
            if (res?.account) {
              accountRow = {
                id: res.account.id,
                name: res.account.name,
                default_currency: res.account.default_currency ?? DEFAULT_CURRENCY,
              };
            }
          }
        } catch {
          // Handled safely
        }
      }

      if (data) {
        const accountRole = isAccountRole(data.account_role) ? data.account_role : null;
        const newProfile: Profile = {
          id: data.id,
          user_id: userId,
          full_name: data.full_name,
          email: data.email,
          avatar_url: data.avatar_url,
          role: data.role,
          beta_features: data.beta_features ?? [],
          account_id: data.account_id ?? null,
          account_role: accountRole,
        };
        setProfile(newProfile);
        if (accountRow) setAccount(accountRow);

        try {
          const pStr = JSON.stringify(newProfile);
          localStorage.setItem(CACHE_PROFILE_KEY, pStr);
          sessionStorage.setItem(CACHE_PROFILE_KEY, pStr);
          if (accountRow) {
            const aStr = JSON.stringify(accountRow);
            localStorage.setItem(CACHE_ACCOUNT_KEY, aStr);
            sessionStorage.setItem(CACHE_ACCOUNT_KEY, aStr);
          }
        } catch {}

        if (!data.account_id || !accountRole) {
          setStatusDetail(`profile ${data.id} has no ${!data.account_id ? "account_id" : "account_role"}`);
        }
      } else if (!cached.profile) {
        lastFetchedUserIdRef.current = null;
        setStatusDetail("no profiles row for the signed-in user");
      }
    } catch (err) {
      console.error("[AuthProvider] fetchProfile threw:", err);
      if (!cached.profile) {
        lastFetchedUserIdRef.current = null;
        setStatusDetail(err instanceof Error ? err.message : "profile fetch failed");
      }
    } finally {
      setProfileLoading(false);
    }
  }, [cached.profile, profile]);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;

    const safetyTimer = setTimeout(() => {
      if (mounted) {
        console.warn("[AuthProvider] getSession() timed out after 3s");
        setLoading(false);
        setProfileLoading(false);
      }
    }, 3000);

    const init = async () => {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (error) console.error("[AuthProvider] getSession error:", error.message);

        if (!mounted) return;
        const currentUser = session?.user ?? null;
        setUser(currentUser);

        // STRICT MULTI-TENANT CACHE VALIDATION:
        // If the session user does not match the cached profile's user_id, purge the cache!
        if (currentUser && cached.profile?.user_id && cached.profile.user_id !== currentUser.id) {
          console.warn("[SECURITY / TENANCY] Purging stale sessionStorage from previous user session");
          try {
            sessionStorage.removeItem(CACHE_PROFILE_KEY);
            sessionStorage.removeItem(CACHE_ACCOUNT_KEY);
            sessionStorage.removeItem("wacrm_dashboard_summary");
          } catch {}
          setProfile(null);
          setAccount(null);
          setProfileLoading(true);
        }

        if (currentUser) {
          // Don't block session loading on profile fetch — chrome
          // (header, sidebar) can render from the user object alone,
          // profile enriches async. Callers that need to branch on
          // profile data gate on `profileLoading` instead.
          fetchProfile(currentUser.id);
        } else {
          // No user → no profile to load. Flip profileLoading off so
          // pages that gate on it don't wait forever on the logged-out
          // path (the route guard or redirect should fire instead).
          setProfileLoading(false);
        }
      } catch (err) {
        console.error("[AuthProvider] init threw:", err);
      } finally {
        if (mounted) setLoading(false);
        clearTimeout(safetyTimer);
      }
    };

    init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      const currentUser = session?.user ?? null;
      setUser(currentUser);

      if (currentUser) {
        if (currentUser.id !== lastFetchedUserIdRef.current) {
          try {
            sessionStorage.removeItem(CACHE_PROFILE_KEY);
            sessionStorage.removeItem(CACHE_ACCOUNT_KEY);
            sessionStorage.removeItem("wacrm_dashboard_summary");
          } catch {}
          setProfile(null);
          setAccount(null);
          setProfileLoading(true);
          fetchProfile(currentUser.id);
        }
      } else {
        lastFetchedUserIdRef.current = null;
        try {
          sessionStorage.removeItem(CACHE_PROFILE_KEY);
          sessionStorage.removeItem(CACHE_ACCOUNT_KEY);
          sessionStorage.removeItem("wacrm_dashboard_summary");
        } catch {}
        setProfile(null);
        setAccount(null);
        setProfileLoading(false);
      }

      setLoading(false);
    });

    return () => {
      mounted = false;
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
  }, [fetchProfile]);

  const signOut = useCallback(async () => {
    try {
      localStorage.removeItem(CACHE_PROFILE_KEY);
      localStorage.removeItem(CACHE_ACCOUNT_KEY);
      sessionStorage.removeItem(CACHE_PROFILE_KEY);
      sessionStorage.removeItem(CACHE_ACCOUNT_KEY);
      sessionStorage.removeItem("wacrm_dashboard_summary");
    } catch {}
    const supabase = createClient();
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setAccount(null);
    window.location.href = "/login";
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!user?.id) return;
    await fetchProfile(user.id);
  }, [user?.id, fetchProfile]);

  // Derive the role booleans once per profile change rather than on
  // every consumer render. Cheap regardless, but the memo also gives
  // each derived value a stable identity for React.memo / useEffect
  // dependencies downstream.
  const activeProfile = profile || (cached.profile?.user_id === user?.id ? cached.profile : null);
  const derived = useMemo(() => {
    const role = activeProfile?.account_role ?? null;
    return {
      accountRole: role,
      accountId: activeProfile?.account_id ?? null,
      isOwner: role === "owner",
      isAdmin: role === "admin",
      isAgent: role === "agent",
      isViewer: role === "viewer",
      canManageMembers: role ? canManageMembersFor(role) : false,
      canEditSettings: role ? canEditSettingsFor(role) : false,
      canSendMessages: role ? canSendMessagesFor(role) : false,
    };
  }, [activeProfile?.account_role, activeProfile?.account_id]);

  // Signed out is not a broken account — the shell redirects to /login
  // before anything reads this.
  const accountStatus: AccountStatus = !user
    ? "loading"
    : profileLoading && !activeProfile
      ? "loading"
      : !activeProfile
        ? "error"
        : derived.accountId && derived.accountRole
          ? "ready"
          : "unlinked";

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        signOut,
        refreshProfile,
        account,
        defaultCurrency: account?.default_currency ?? DEFAULT_CURRENCY,
        accountStatus,
        accountStatusDetail: statusDetail,
        ...derived,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * useAuth — read the shared auth state from context.
 * Must be used inside an <AuthProvider>.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider (shouldn't
    // happen in normal flow, but don't crash the page). Account state
    // collapses to least-privileged null — every `canX` boolean is
    // false so UI gates fail closed.
    return {
      user: null,
      profile: null,
      loading: false,
      profileLoading: false,
      signOut: async () => {
        window.location.href = "/login";
      },
      refreshProfile: async () => {},
      account: null,
      defaultCurrency: DEFAULT_CURRENCY,
      // Outside the provider there is nothing to resolve yet — 'loading'
      // keeps the access alert from firing on, say, the login page.
      accountStatus: "loading",
      accountStatusDetail: null,
      accountId: null,
      accountRole: null,
      isOwner: false,
      isAdmin: false,
      isAgent: false,
      isViewer: false,
      canManageMembers: false,
      canEditSettings: false,
      canSendMessages: false,
    };
  }
  return ctx;
}
