import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { safeNextPath } from "@/lib/auth";
import { hasSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/**
 * Landing URL for links in Supabase emails (signup confirmation, password reset).
 * Handles both the PKCE `?code=` flow and the `?token_hash=&type=` flow, then redirects to `next`.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNextPath(searchParams.get("next"));
  const failed = NextResponse.redirect(new URL("/login?error=link", origin));
  if (!hasSupabaseEnv) return failed;

  const supabase = await createClient();
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return failed;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) return failed;
  } else {
    return failed;
  }
  return NextResponse.redirect(new URL(type === "recovery" ? "/reset-password" : next, origin));
}
