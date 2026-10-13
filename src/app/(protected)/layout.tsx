import { AppShell } from "@/components/app-shell";
import { fetchProfile } from "@/lib/data/queries";
import { hasSupabaseEnv } from "@/lib/env";

// Figures depend on the current time and the signed-in user — never prerender at build time.
export const dynamic = "force-dynamic";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const profile = await fetchProfile();
  return <AppShell demoMode={!hasSupabaseEnv} shopName={profile.shopName} displayName={profile.displayName}>{children}</AppShell>;
}
