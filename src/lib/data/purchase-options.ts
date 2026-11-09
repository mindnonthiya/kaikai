import type { PerUnitPurchaseItem, PooledPurchaseItem } from "@/components/ingredient-purchase-table";
import type { RestockItem } from "@/components/packaging-restock-table";
import { satangToBahtInput } from "@/lib/money";
import {
  fetchIngredients,
  fetchLatestPurchases,
  fetchPackaging,
  fetchPackagingDefaults,
  fetchPackagingPurchases,
  type PackagingDefaultConfig,
} from "./queries";
import type { PackagingPurchaseRecord, PackagingRecord } from "./types";

const bahtInput = (value: number) => (value > 0 ? satangToBahtInput(Math.round(value)) : "");
const trimZeros = (value: number) => String(Math.round(value * 10_000) / 10_000);

/**
 * Resolves the default pack price & pieces per pack for a packaging item:
 * 1) Uses the latest purchase record if one exists.
 * 2) Otherwise uses the owner's configured pack default (`packaging_defaults` setting) if set when creating/updating the item.
 * 3) Otherwise returns empty strings so the seller enters pack details on the next purchase.
 */
export function resolvePackagingDefaultPack(
  p: PackagingRecord,
  last?: PackagingPurchaseRecord,
  allPurchasesForItem?: PackagingPurchaseRecord[],
  configuredDefault?: PackagingDefaultConfig,
): { packPrice: string; perPack: string } {
  const purchase = last ?? allPurchasesForItem?.find((row) => row.packagingItemId === p.id);
  if (purchase && purchase.packCount > 0 && purchase.packQuantity > 0) {
    return {
      packPrice: satangToBahtInput(Math.round(purchase.price / purchase.packCount)),
      perPack: trimZeros(purchase.packQuantity / purchase.packCount),
    };
  }
  if (configuredDefault && configuredDefault.packPriceSatang > 0 && configuredDefault.packQuantity > 0) {
    return {
      packPrice: satangToBahtInput(Math.round(configuredDefault.packPriceSatang)),
      perPack: trimZeros(configuredDefault.packQuantity),
    };
  }
  return { packPrice: "", perPack: "" };
}

export type PurchaseCatalog = {
  perUnit: PerUnitPurchaseItem[];
  pooled: PooledPurchaseItem[];
  restockItems: RestockItem[];
};

export async function fetchPurchaseCatalog(): Promise<PurchaseCatalog> {
  const [ingredients, packaging, latest, packPurchases, packDefaults] = await Promise.all([
    fetchIngredients(),
    fetchPackaging(),
    fetchLatestPurchases(),
    fetchPackagingPurchases(),
    fetchPackagingDefaults(),
  ]);

  const latestPack = new Map<string, PackagingPurchaseRecord>();
  const allPackByItem = new Map<string, PackagingPurchaseRecord[]>();
  for (const p of packPurchases) {
    if (!latestPack.has(p.packagingItemId)) {
      latestPack.set(p.packagingItemId, p);
    }
    const list = allPackByItem.get(p.packagingItemId) ?? [];
    list.push(p);
    allPackByItem.set(p.packagingItemId, list);
  }

  const activePackaging = packaging.filter((p) => p.isActive);
  const restockItems: RestockItem[] = activePackaging.map((p) => {
    const last = latestPack.get(p.id);
    const defaults = resolvePackagingDefaultPack(p, last, allPackByItem.get(p.id), packDefaults.get(p.id));
    return {
      id: p.id,
      name: p.name,
      unit: p.unit,
      perOrder: p.perOrder,
      packPrice: defaults.packPrice,
      perPack: defaults.perPack,
    };
  });

  const activeIngredients = ingredients.filter((i) => i.isActive);
  const perUnit: PerUnitPurchaseItem[] = activeIngredients
    .filter((i) => i.costing === "per_unit")
    .map((i) => {
      const last = latest.get(i.id);
      const lastUnitPrice = last?.quantity ? last.price / last.quantity : i.pricePerPurchaseUnit;
      return {
        id: i.id,
        name: i.name,
        purchaseUnit: i.purchaseUnit,
        baseUnit: i.baseUnit,
        unitsPerPurchaseUnit: i.unitsPerPurchaseUnit,
        unitPrice: bahtInput(lastUnitPrice),
      };
    });

  const pooled: PooledPurchaseItem[] = activeIngredients
    .filter((i) => i.costing === "pooled")
    .map((i) => ({ id: i.id, name: i.name }));

  return { perUnit, pooled, restockItems };
}
