import Link from "next/link";
import { PageTitle } from "@/components/page-title";
import { SaleComposer, type MenuOption, type PackagingOption } from "./sale-composer";
import { fetchMenus, fetchPackaging, fetchPooledRate, fetchRecipeItems, fetchSaleSettings } from "@/lib/data/queries";
import { pooledCost } from "@/lib/analytics";
import { isAddonCategory } from "@/lib/data/types";
import { menuEmoji } from "@/lib/menu-emoji";

export default async function NewSalePage() {
  const [allMenus, recipeItems, allPackaging, settings] = await Promise.all([fetchMenus(), fetchRecipeItems(), fetchPackaging(), fetchSaleSettings()]);
  const pooled = await fetchPooledRate(settings);
  const packaging: PackagingOption[] = allPackaging
    .filter((p) => p.perOrder && p.isActive)
    .map((p) => ({ id: p.id, name: p.name, unit: p.unit, unitCost: p.unitCost }));
  const packagingIds = new Set(packaging.map((p) => p.id));
  const menus: MenuOption[] = allMenus
    .filter((menu) => menu.isAvailable)
    .map((menu) => ({
      id: menu.id, name: menu.name, category: menu.category, price: menu.price,
      // Cost without packaging (counted separately and adjustable) + other ingredients as a % of the price.
      foodCost: Math.max(0, menu.cost - menu.packagingCost) + pooledCost(menu.price, pooled.bps),
      emoji: menuEmoji(menu.name, menu.category),
      isAddon: isAddonCategory(menu.category),
      packaging: recipeItems
        .filter((item) => item.menuId === menu.id && item.packagingItemId && packagingIds.has(item.packagingItemId))
        .map((item) => ({ packagingId: item.packagingItemId!, quantity: item.quantity })),
    }));
  return <>
    <PageTitle eyebrow="บันทึกรายการ" title="เพิ่มยอดขาย" description="เลือกเมนู ตรวจบรรจุภัณฑ์ เลือกรับเอง/ส่ง แล้วบันทึก" action={<Link className="secondary-button" href="/sales">ประวัติการขาย</Link>} />
    <SaleComposer menus={menus} packaging={packaging} defaultDeliveryFee={settings.defaultDeliveryFee} pooledBps={pooled.bps} />
  </>;
}
