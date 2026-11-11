import { PageTitle } from "@/components/page-title";
import { LoyaltyRewardsHub, type LoyaltyHubTab } from "@/components/loyalty-rewards-hub";
import { fetchLoyaltyAdminData } from "@/app/actions/loyalty";
import { fetchProfile, fetchShops } from "@/lib/data/queries";

export const dynamic = "force-dynamic";

const VALID_TABS = new Set<LoyaltyHubTab>(["overview", "qr", "members", "coupons", "settings"]);

export default async function RewardsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [profile, shopsData, resolvedParams] = await Promise.all([
    fetchProfile(),
    fetchShops(),
    searchParams ? searchParams : Promise.resolve({} as Record<string, string | string[] | undefined>),
  ]);

  const rawTab = typeof resolvedParams.tab === "string" ? resolvedParams.tab.trim() : "";
  const initialTab: LoyaltyHubTab = VALID_TABS.has(rawTab as LoyaltyHubTab)
    ? (rawTab as LoyaltyHubTab)
    : "overview";

  const activeShopId = shopsData.activeShopId;
  const snapshot = await fetchLoyaltyAdminData(activeShopId, profile.shopName, initialTab);

  return (
    <>
      <PageTitle
        eyebrow="ระบบสมาชิก"
        title="แต้มสะสม"
      />

      <LoyaltyRewardsHub
        key={`rewards-hub-${activeShopId}`}
        shopId={activeShopId}
        shopName={profile.shopName}
        snapshot={snapshot}
        initialTab={initialTab}
      />
    </>
  );
}
