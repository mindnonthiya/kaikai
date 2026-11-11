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

  const activeShopId = shopsData.activeShopId;
  const snapshot = await fetchLoyaltyAdminData(activeShopId, profile.shopName);

  const rawTab = typeof resolvedParams.tab === "string" ? resolvedParams.tab.trim() : "";
  const initialTab: LoyaltyHubTab = VALID_TABS.has(rawTab as LoyaltyHubTab)
    ? (rawTab as LoyaltyHubTab)
    : "overview";

  return (
    <>
      <PageTitle
        eyebrow="ความภักดีลูกค้า"
        title="ระบบสะสมแต้ม"
        description="จัดการบัตรสะสมแต้ม LINE OA คิวอาร์โค้ด 1–10 กล่อง รายชื่อลูกค้า และคูปองส่วนลด"
      />

      <LoyaltyRewardsHub
        key={`rewards-hub-${activeShopId}`}
        shopName={profile.shopName}
        snapshot={snapshot}
        initialTab={initialTab}
      />
    </>
  );
}
