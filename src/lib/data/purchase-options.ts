import type { PerUnitPurchaseItem, PooledPurchaseItem } from "@/components/ingredient-purchase-table";
import type { RestockItem } from "@/components/packaging-restock-table";
import { satangToBahtInput } from "@/lib/money";
import {
  fetchIngredients,
  fetchLatestPurchases,
  fetchPackaging,
  fetchPackagingPurchases,
} from "./queries";
import type { PackagingPurchaseRecord, PackagingRecord } from "./types";

const bahtInput = (value: number) => (value > 0 ? satangToBahtInput(Math.round(value)) : "");
const trimZeros = (value: number) => String(Math.round(value * 10_000) / 10_000);

/**
 * Resolves default packPrice and perPack for a packaging item:
 * 1. Latest row in packaging_purchases (if any)
 * 2. Inferred from packaging_items.unitCost (unit_cost_satang) so deleting purchase history never wipes out known prices
 */
export function resolvePackagingDefaultPack(
  p: PackagingRecord,
  last?: PackagingPurchaseRecord
): { packPrice: string; perPack: string } {
  if (last && last.packCount > 0 && last.packQuantity > 0) {
    return {
      packPrice: satangToBahtInput(Math.round(last.price / last.packCount)),
      perPack: trimZeros(last.packQuantity / last.packCount),
    };
  }

  if (p.unitCost > 0) {
    const name = p.name.trim();
    let inferredPerPack = 25;
    if (name.includes("ถ้วย")) {
      inferredPerPack = 50;
    } else if (name.includes("กล่อง") || name.includes("ช้อน") || name.includes("ส้อม") || name.includes("ซ้อม")) {
      inferredPerPack = 25;
    } else {
      const candidates = [25, 50, 100, 20, 10, 1];
      const cleanMatch = candidates.find((size) => Math.round(p.unitCost * size) % 100 === 0);
      inferredPerPack = cleanMatch ?? 1;
    }
    const inferredPackPriceSatang = Math.round(p.unitCost * inferredPerPack);
    if (inferredPackPriceSatang > 0) {
      return {
        packPrice: satangToBahtInput(inferredPackPriceSatang),
        perPack: trimZeros(inferredPerPack),
      };
    }
  }

  return { packPrice: "", perPack: "" };
}

export type PurchaseCatalog = {
  perUnit: PerUnitPurchaseItem[];
  pooled: PooledPurchaseItem[];
  restockItems: RestockItem[];
};

export async function fetchPurchaseCatalog(): Promise<PurchaseCatalog> {
  const [ingredients, packaging, latest, packPurchases] = await Promise.all([
    fetchIngredients(),
    fetchPackaging(),
    fetchLatestPurchases(),
    fetchPackagingPurchases(),
  ]);

  const latestPack = new Map<string, PackagingPurchaseRecord>();
  for (const p of packPurchases) {
    if (!latestPack.has(p.packagingItemId)) {
      latestPack.set(p.packagingItemId, p);
    }
  }

  const activePackaging = packaging.filter((p) => p.isActive);
  const restockItems: RestockItem[] = activePackaging.map((p) => {
    const last = latestPack.get(p.id);
    const defaults = resolvePackagingDefaultPack(p, last);
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
