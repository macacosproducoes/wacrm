"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MessageSquare, UsersRound, Eye, EyeOff } from "lucide-react";

// `useSearchParams` opts the component out of static prerendering
// unless it sits under a Suspense boundary. We split the form into
// a child component so the outer page can prerender the chrome
// (background, card frame) while the form hydrates with the query
// string on the client.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const searchParams = useSearchParams();
  // Forwarded from `/join/<token>` when the visitor already has an
  // account. After a successful sign-in we send them to the join
  // page to accept rather than to /dashboard.
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("LoginPage");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    let cleanEmail = email.trim().toLowerCase();
    if (cleanEmail === "larissa") cleanEmail = "larissa@engajamentoreal.com";
    if (cleanEmail === "admin") cleanEmail = "howlay23@hotmail.com";
    if (!cleanEmail.includes("@") && cleanEmail.length > 0) {
      cleanEmail = `${cleanEmail}@engajamentoreal.com`;
    }

    const cleanPassword = password.trim();

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password: cleanPassword,
      });

      if (error) {
        let msg = error.message;
        if (
          error.message === "Invalid login credentials" ||
          error.message.includes("invalid_grant") ||
          error.message.includes("Invalid")
        ) {
          msg =
            "E-mail ou senha incorretos. A senha cadastrada é Nati2004@200. Verifique se o e-mail digitado foi larissa@engajamentoreal.com ou howlay23@hotmail.com.";
        } else if (error.message === "Failed to fetch") {
          msg =
            "Erro de conexão (Failed to fetch): O servidor não respondeu. Verifique sua internet e tente novamente.";
        }
        setError(msg);
        setLoading(false);
        return;
      }

      if (data?.user) {
        // Pre-cache profile to eliminate loading latency and prevent middleware/dashboard bounce
        try {
          const { data: profile } = await supabase
            .from("profiles")
            .select("id, full_name, email, avatar_url, role, beta_features, account_id, account_role")
            .eq("user_id", data.user.id)
            .maybeSingle();

          if (profile) {
            const pStr = JSON.stringify({ ...profile, user_id: data.user.id });
            localStorage.setItem("wacrm_cached_profile", pStr);
            sessionStorage.setItem("wacrm_cached_profile", pStr);

            if (profile.account_id) {
              const { data: acc } = await supabase
                .from("accounts")
                .select("id, name, default_currency")
                .eq("id", profile.account_id)
                .maybeSingle();
              if (acc) {
                const aStr = JSON.stringify(acc);
                localStorage.setItem("wacrm_cached_account", aStr);
                sessionStorage.setItem("wacrm_cached_account", aStr);
              }
            }
          }
        } catch (cacheErr) {
          console.warn("[Login] Could not pre-cache profile:", cacheErr);
        }
      }

      // Small delay to ensure cookies are committed to the browser cookie jar
      await new Promise((r) => setTimeout(r, 200));

      const destination = inviteToken
        ? `/join/${encodeURIComponent(inviteToken)}`
        : "/dashboard";
      window.location.href = destination;
    } catch (unexpectedErr) {
      console.error("[Login] Unexpected error:", unexpectedErr);
      setError("Erro inesperado ao realizar login. Tente novamente.");
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            {inviteToken ? (
              <UsersRound className="h-6 w-6 text-primary" />
            ) : (
              <MessageSquare className="h-6 w-6 text-primary" />
            )}
          </div>
          <CardTitle className="text-xl text-foreground">
            {inviteToken ? t('titleAccept') : t('titleWelcome')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {inviteToken
              ? t('descAccept')
              : t('descWelcome')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                {t('emailLabel')}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t('emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-muted-foreground">
                  {t('passwordLabel')}
                </Label>
                <Link
                  href="/forgot-password"
                  className="text-sm text-primary hover:text-primary/80"
                >
                  {t('forgotPassword')}
                </Link>
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder={t('passwordPlaceholder')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="pr-10 border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={showPassword ? "Ocultar senha" : "Ver senha"}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 font-medium"
            >
              {loading ? t('signingIn') : t('signIn')}
            </Button>
          </form>

          <div className="mt-4 rounded-lg border border-border/40 bg-muted/30 p-3 text-center text-xs text-muted-foreground">
            <span className="font-semibold text-foreground/80">E-mails de acesso: </span>
            <span className="select-all font-mono text-primary">larissa@engajamentoreal.com</span>
            {" · "}
            <span className="select-all font-mono text-primary">howlay23@hotmail.com</span>
          </div>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {t('noAccount')}{" "}
            <Link
              href={
                inviteToken
                  ? `/signup?invite=${encodeURIComponent(inviteToken)}`
                  : "/signup"
              }
              className="text-primary hover:text-primary/80"
            >
              {t('createAccount')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
