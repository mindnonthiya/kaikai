import { AppShell } from "@/components/app-shell";
import { fetchProfile, fetchShops } from "@/lib/data/queries";
import { hasSupabaseEnv } from "@/lib/env";

// Figures depend on the current time and the signed-in user — never prerender at build time.
export const dynamic = "force-dynamic";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const [profile, shopsData] = await Promise.all([fetchProfile(), fetchShops()]);
  return (
    <AppShell
      demoMode={!hasSupabaseEnv}
      shopName={profile.shopName}
      displayName={profile.displayName}
      avatarUrl={profile.avatarUrl}
      activeShopId={shopsData.activeShopId}
      shops={shopsData.shops}
    >
      {children}
    </AppShell>
  );
}
