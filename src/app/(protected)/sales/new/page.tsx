import Link from "next/link";
import { Sparkles } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { SaleComposer, type MenuOption, type PackagingOption } from "./sale-composer";
import { fetchMenus, fetchPackaging, fetchPooledRate, fetchPricePresets, fetchRecipeItems, fetchSaleSettings } from "@/lib/data/queries";
import { pooledCost } from "@/lib/analytics";
import { isAddonCategory, isServiceCategory } from "@/lib/data/types";

export default async function NewSalePage() {
  const [allMenus, recipeItems, allPackaging, settings, presets] = await Promise.all([
    fetchMenus(),
    fetchRecipeItems(),
    fetchPackaging(),
    fetchSaleSettings(),
    fetchPricePresets(),
  ]);
  const pooled = await fetchPooledRate(settings);
  const packaging: PackagingOption[] = allPackaging
    .filter((p) => p.perOrder && p.isActive)
    .map((p) => ({ id: p.id, name: p.name, unit: p.unit, unitCost: p.unitCost }));
  const packagingIds = new Set(packaging.map((p) => p.id));
  const menus: MenuOption[] = allMenus
    .filter((menu) => menu.isAvailable)
    .map((menu) => {
      const isService = isServiceCategory(menu.category, menu.name);
      const isAddon = !isService && isAddonCategory(menu.category);
      return {
        id: menu.id,
        name: menu.name,
        category: menu.category,
        price: menu.price,
        foodCost: isService ? 0 : Math.max(0, menu.cost - menu.packagingCost) + pooledCost(menu.price, pooled.bps),
        imagePath: menu.imagePath,
        isAddon,
        isService,
        packaging: isService || isAddon
          ? []
          : recipeItems
              .filter((item) => item.menuId === menu.id && item.packagingItemId && packagingIds.has(item.packagingItemId))
              .map((item) => ({ packagingId: item.packagingItemId!, quantity: item.quantity })),
      };
    });
  return <>
    <PageTitle
      eyebrow="บันทึกรายการ"
      title="เปิดบิล"
      description="เลือกเมนู ตรวจบรรจุภัณฑ์ เลือกรับเอง/ส่ง แล้วบันทึก"
      action={
        <div style={{ display: "flex", gap: "8px" }}>
          <Link className="primary-button" href="/sales/import-slips" style={{ background: "linear-gradient(135deg, #059669 0%, #047857 100%)", borderColor: "transparent", color: "#fff" }}>
            <Sparkles size={16} /> นำเข้าสลิปเป็นชุด ⚡
          </Link>
          <Link className="secondary-button" href="/sales">ประวัติการขาย</Link>
        </div>
      }
    />
    <SaleComposer
      menus={menus}
      packaging={packaging}
      defaultDeliveryFee={settings.defaultDeliveryFee}
      pooledBps={pooled.bps}
      showMenuImages={settings.showMenuImages ?? true}
      presets={presets}
    />
  </>;
}

