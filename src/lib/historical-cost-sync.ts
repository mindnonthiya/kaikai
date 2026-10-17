import type { SupabaseClient } from "@supabase/supabase-js";
import { recalculateMenuCosts } from "@/lib/menu-cost";

type Row = Record<string, unknown>;

export interface SyncHistoricalCostsOptions {
  ownerId: string;
  menuId?: string;
  forceAll?: boolean;
}

export interface SyncHistoricalCostsResult {
  affectedSalesCount: number;
  updatedItemsCount: number;
}

/**
 * Retroactively syncs current menu recipe costs to historical sales.
 * Solves the issue where orders recorded prior to configuring recipes
 * (or before adding packaging/ingredients) retain obsolete or 0 cost.
 */
export async function syncHistoricalCosts(
  supabase: SupabaseClient,
  options: SyncHistoricalCostsOptions
): Promise<SyncHistoricalCostsResult> {
  const { ownerId, menuId, forceAll = false } = options;

  // 1) Ensure menu costs are updated from recipes first
  try {
    if (menuId) {
      await recalculateMenuCosts(supabase, [menuId]);
    } else {
      await recalculateMenuCosts(supabase);
    }
  } catch (err) {
    console.warn("recalculateMenuCosts warning during historical sync:", err);
  }

  // 2) Fetch current menus with cost > 0 for this owner
  let menuQuery = supabase
    .from("menus")
    .select("id, name, current_cost_satang, packaging_cost_satang, selling_price_satang")
    .eq("owner_id", ownerId);

  if (menuId) {
    menuQuery = menuQuery.eq("id", menuId);
  }

  const { data: menus, error: menuErr } = await menuQuery;
  if (menuErr) throw menuErr;

  const menuMap = new Map((menus as Row[]).map((m) => [String(m.id), m]));
  const nameMap = new Map((menus as Row[]).map((m) => [String(m.name).trim().toLowerCase(), m]));

  // 3) Fetch relevant sale_items
  let itemQuery = supabase
    .from("sale_items")
    .select("id, sale_id, menu_id, menu_name_snapshot, quantity, unit_price_satang, line_cost_satang, unit_cost_satang")
    .eq("owner_id", ownerId);

  if (menuId) {
    itemQuery = itemQuery.eq("menu_id", menuId);
  }

  const { data: items, error: itemErr } = await itemQuery;
  if (itemErr) throw itemErr;

  const affectedSaleIds = new Set<string>();
  let updatedItemsCount = 0;

  for (const item of (items as Row[])) {
    const hasExistingCost = Number(item.line_cost_satang) > 0 && Number(item.unit_cost_satang) > 0;
    // If not forceAll and not targeting a specific menu, skip items that already have positive cost
    if (!forceAll && !menuId && hasExistingCost) continue;

    const m = menuMap.get(String(item.menu_id)) ?? nameMap.get(String(item.menu_name_snapshot).trim().toLowerCase());
    if (!m || Number(m.current_cost_satang) <= 0) continue;

    const qty = Number(item.quantity) || 1;
    const unitCost = Number(m.current_cost_satang);
    const packCost = Number(m.packaging_cost_satang) || 0;
    const ingredientCost = Math.max(0, unitCost - packCost);
    const unitPrice = Number(item.unit_price_satang) || Number(m.selling_price_satang) || 0;
    const lineCost = unitCost * qty;

    // Skip if already up-to-date
    if (
      Number(item.unit_cost_satang) === unitCost &&
      Number(item.line_cost_satang) === lineCost &&
      Number(item.packaging_cost_satang) === packCost
    ) {
      continue;
    }

    const { error: updateErr } = await supabase
      .from("sale_items")
      .update({
        ingredient_cost_satang: ingredientCost,
        packaging_cost_satang: packCost,
        unit_cost_satang: unitCost,
        unit_profit_satang: unitPrice - unitCost,
        line_cost_satang: lineCost,
      })
      .eq("id", String(item.id));

    if (updateErr) throw updateErr;

    affectedSaleIds.add(String(item.sale_id));
    updatedItemsCount++;
  }

  // 4) Check for any sales with cogs = 0 or null (only in global sync)
  if (!menuId) {
    const { data: zeroCogsSales } = await supabase
      .from("sales")
      .select("id")
      .eq("owner_id", ownerId)
      .eq("status", "confirmed")
      .or("cogs_satang.eq.0,cogs_satang.is.null");

    for (const z of (zeroCogsSales ?? []) as Row[]) {
      affectedSaleIds.add(String(z.id));
    }
  }

  // 5) Recalculate totals for all affected parent sales
  for (const saleId of affectedSaleIds) {
    const { data: saleItems, error: siErr } = await supabase
      .from("sale_items")
      .select("line_cost_satang, packaging_cost_satang, quantity")
      .eq("sale_id", saleId);

    if (siErr) continue;

    let totalCogs = 0;
    let totalPack = 0;
    for (const si of (saleItems as Row[])) {
      totalCogs += Number(si.line_cost_satang) || 0;
      totalPack += (Number(si.packaging_cost_satang) || 0) * (Number(si.quantity) || 1);
    }

    const { data: saleData } = await supabase
      .from("sales")
      .select("net_revenue_satang")
      .eq("id", saleId)
      .maybeSingle();

    const net = Number((saleData as Row)?.net_revenue_satang ?? 0);

    const { error: saleUpdateErr } = await supabase
      .from("sales")
      .update({
        cogs_satang: totalCogs,
        packaging_cost_satang: totalPack,
        gross_profit_satang: net - totalCogs,
      })
      .eq("id", saleId);

    if (saleUpdateErr) throw saleUpdateErr;
  }

  return {
    affectedSalesCount: affectedSaleIds.size,
    updatedItemsCount,
  };
}
