import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/server-action";
import { recalculateMenuCosts } from "@/lib/menu-cost";

export interface SyncHistoricalCostsOptions {
  ownerId: string;
  menuId?: string;
  forceAll?: boolean;
}

export interface SyncHistoricalCostsResult {
  affectedSalesCount: number;
  updatedItemsCount: number;
}

export type RecalculatedItemCost = {
  unitCost: number;
  ingredientCost: number;
  packagingCost: number;
  unitProfit: number;
  lineCost: number;
};

/**
 * Cost of one sale line from the current menu cost, in satang (same formula as create_sale).
 * `pooledCost` is the per-unit "other ingredients" cost stored on the sale item when it was sold;
 * it is not part of menus.current_cost_satang, so it must be added back here.
 */
export function recalculatedItemCost(input: {
  menuCost: number;
  menuPackagingCost: number;
  pooledCost: number;
  unitPrice: number;
  quantity: number;
}): RecalculatedItemCost {
  const { menuCost, menuPackagingCost, pooledCost, unitPrice, quantity } = input;
  const unitCost = menuCost + pooledCost;
  return {
    unitCost,
    ingredientCost: Math.max(0, menuCost - menuPackagingCost) + pooledCost,
    packagingCost: menuPackagingCost,
    unitProfit: unitPrice - unitCost,
    lineCost: unitCost * quantity,
  };
}

/**
 * Sale totals from its items, in satang (same formula as create_sale):
 * cogs = Σ food cost (line cost − default packaging) + packaging.
 * Packaging is what was actually handed out (sale_packaging) when recorded, otherwise the menus' default.
 */
export function saleCostTotals(
  items: Array<{ lineCost: number; packCost: number; quantity: number }>,
  actualPackaging: number | null | undefined,
) {
  let food = 0;
  let defaultPack = 0;
  for (const item of items) {
    const pack = item.packCost * item.quantity;
    food += Math.max(0, item.lineCost - pack);
    defaultPack += pack;
  }
  const packaging = actualPackaging ?? defaultPack;
  return { cogs: food + packaging, packaging };
}

/** Explicitly apply current costs to historical bills. Purchase quantities and recipes are never inferred. */
export async function syncHistoricalCosts(
  supabase: SupabaseClient,
  { menuId, forceAll = false }: SyncHistoricalCostsOptions,
): Promise<SyncHistoricalCostsResult> {
  await recalculateMenuCosts(supabase, menuId ? [menuId] : undefined);
  const { data, error } = await supabase.rpc("recalculate_order_costs", {
    p_menu_id: menuId ?? null, p_force_all: forceAll,
  });
  if (error) dbError(error);
  if (!data || typeof data !== "object") throw new Error("ไม่พบผลการคำนวณต้นทุนย้อนหลัง");
  const result = data as Record<string, unknown>;
  return { affectedSalesCount: Number(result.affected_sales_count) || 0, updatedItemsCount: Number(result.updated_items_count) || 0 };
}
