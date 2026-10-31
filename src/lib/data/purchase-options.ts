import type { PerUnitPurchaseItem, PooledPurchaseItem } from "@/components/ingredient-purchase-table";
import type { RestockItem } from "@/components/packaging-restock-table";
import { satangToBahtInput } from "@/lib/money";
import {
  fetchIngredients,
  fetchLatestPurchases,
  fetchPackaging,
  fetchPackagingPurchases,
} from "./queries";
import type { PackagingPurchaseRecord } from "./types";

const bahtInput = (value: number) => (value > 0 ? satangToBahtInput(Math.round(value)) : "");
const trimZeros = (value: number) => String(Math.round(value * 10_000) / 10_000);

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
    return {
      id: p.id,
      name: p.name,
      unit: p.unit,
      perOrder: p.perOrder,
      packPrice: last ? satangToBahtInput(Math.round(last.price / last.packCount)) : "",
      perPack: last ? trimZeros(last.packQuantity / last.packCount) : "",
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
