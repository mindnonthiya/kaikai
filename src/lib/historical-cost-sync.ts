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

const rows = (val: unknown): Row[] => (Array.isArray(val) ? (val as Row[]) : val ? [val as Row] : []);

/**
 * Retroactively syncs current menu recipe costs to historical sales.
 * Solves the issue where orders recorded prior to configuring recipes
 * (or before adding packaging/ingredients) retain obsolete or 0 cost.
 * Uses fast concurrent batch updates and skips items already up-to-date.
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

  // Fast path: If Postgres RPC function recalculate_historical_sales_costs exists, call it!
  if (typeof supabase.rpc === "function") {
    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc("recalculate_historical_sales_costs", {
        p_menu_id: menuId || null,
        p_force_all: forceAll,
      });
      if (!rpcErr && rpcData && typeof rpcData === "object") {
        const resObj = rpcData as Record<string, unknown>;
        return {
          affectedSalesCount: Number(resObj.affected_sales_count) || 0,
          updatedItemsCount: Number(resObj.updated_items_count) || 0,
        };
      }
    } catch {
      // Proceed to high-performance batch fallback below
    }
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

  const menuMap = new Map(rows(menus).map((m) => [String(m.id), m]));
  const nameMap = new Map(rows(menus).map((m) => [String(m.name).trim().toLowerCase(), m]));

  // 3) Fetch relevant sale_items (including packaging_cost_satang)
  let itemQuery = supabase
    .from("sale_items")
    .select("id, sale_id, menu_id, menu_name_snapshot, quantity, unit_price_satang, line_cost_satang, unit_cost_satang, packaging_cost_satang")
    .eq("owner_id", ownerId);

  if (menuId) {
    itemQuery = itemQuery.eq("menu_id", menuId);
  }

  const { data: rawItems, error: itemErr } = await itemQuery;
  if (itemErr) throw itemErr;

  const affectedSaleIds = new Set<string>();
  const itemsToUpdate: { id: string; payload: Record<string, unknown> }[] = [];
  const saleItemsBySaleId = new Map<string, { lineCost: number; packCost: number; quantity: number }[]>();

  for (const item of rows(rawItems)) {
    const qty = Number(item.quantity) || 1;
    let unitCost = Number(item.unit_cost_satang) || 0;
    let packCost = Number(item.packaging_cost_satang) || 0;
    let lineCost = Number(item.line_cost_satang) || 0;

    const hasExistingCost = lineCost > 0 && unitCost > 0;
    const m = menuMap.get(String(item.menu_id)) ?? nameMap.get(String(item.menu_name_snapshot).trim().toLowerCase());
    const shouldRecalculate = (forceAll || !hasExistingCost || Boolean(menuId)) && m && Number(m.current_cost_satang) > 0;

    if (shouldRecalculate && m) {
      const newUnitCost = Number(m.current_cost_satang);
      const newPackCost = Number(m.packaging_cost_satang) || 0;
      const newIngredientCost = Math.max(0, newUnitCost - newPackCost);
      const unitPrice = Number(item.unit_price_satang) || Number(m.selling_price_satang) || 0;
      const newLineCost = newUnitCost * qty;

      const isAlreadyUpToDate =
        unitCost === newUnitCost &&
        lineCost === newLineCost &&
        packCost === newPackCost;

      if (!isAlreadyUpToDate) {
        itemsToUpdate.push({
          id: String(item.id),
          payload: {
            ingredient_cost_satang: newIngredientCost,
            packaging_cost_satang: newPackCost,
            unit_cost_satang: newUnitCost,
            unit_profit_satang: unitPrice - newUnitCost,
            line_cost_satang: newLineCost,
          },
        });
        affectedSaleIds.add(String(item.sale_id));
        unitCost = newUnitCost;
        packCost = newPackCost;
        lineCost = newLineCost;
      }
    }

    const saleId = String(item.sale_id);
    const list = saleItemsBySaleId.get(saleId) ?? [];
    list.push({ lineCost, packCost, quantity: qty });
    saleItemsBySaleId.set(saleId, list);
  }

  // Batch update sale items in concurrent chunks
  const CHUNK_SIZE = 25;
  for (let i = 0; i < itemsToUpdate.length; i += CHUNK_SIZE) {
    const chunk = itemsToUpdate.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map((it) =>
        supabase.from("sale_items").update(it.payload).eq("id", it.id)
      )
    );
  }

  // 4) Check for any sales with cogs = 0 or null (only in global sync)
  if (!menuId) {
    const { data: zeroCogsSales } = await supabase
      .from("sales")
      .select("id")
      .eq("owner_id", ownerId)
      .eq("status", "confirmed")
      .or("cogs_satang.eq.0,cogs_satang.is.null");

    for (const z of rows(zeroCogsSales)) {
      affectedSaleIds.add(String(z.id));
    }
  }

  // 5) Recalculate totals for all affected parent sales
  const updateSale = async (saleId: string) => {
    const itemsList = saleItemsBySaleId.get(saleId);
    let totalCogs = 0;
    let totalPack = 0;

    if (itemsList && itemsList.length > 0 && !menuId) {
      for (const it of itemsList) {
        totalCogs += it.lineCost;
        totalPack += it.packCost * it.quantity;
      }
    } else {
      const { data: saleItems, error: siErr } = await supabase
        .from("sale_items")
        .select("line_cost_satang, packaging_cost_satang, quantity")
        .eq("sale_id", saleId);

      if (siErr) return;

      for (const si of rows(saleItems)) {
        totalCogs += Number(si.line_cost_satang) || 0;
        totalPack += (Number(si.packaging_cost_satang) || 0) * (Number(si.quantity) || 1);
      }
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
  };

  const saleIdsArray = Array.from(affectedSaleIds);
  const CHUNK = 10;
  for (let i = 0; i < saleIdsArray.length; i += CHUNK) {
    await Promise.all(saleIdsArray.slice(i, i + CHUNK).map(updateSale));
  }

  return {
    affectedSalesCount: affectedSaleIds.size,
    updatedItemsCount: itemsToUpdate.length,
  };
}
