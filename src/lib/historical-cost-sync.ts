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

/**
 * Retroactively syncs current menu recipe costs to historical sales.
 * Solves the issue where orders recorded prior to configuring recipes
 * (or before adding packaging/ingredients) retain obsolete or 0 cost.
 * Keeps each item's pooled-ingredient cost and the packaging actually used on the order.
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

  // 3) Fetch relevant sale_items (including packaging and pooled cost).
  //    Databases without migration 202610260001 have no pooled_cost_satang column yet.
  const ITEM_COLUMNS = "id, sale_id, menu_id, menu_name_snapshot, quantity, unit_price_satang, line_cost_satang, unit_cost_satang, packaging_cost_satang";
  const fetchItems = (columns: string) => {
    let query = supabase.from("sale_items").select(columns).eq("owner_id", ownerId);
    if (menuId) query = query.eq("menu_id", menuId);
    return query;
  };

  let { data: rawItems, error: itemErr } = await fetchItems(`${ITEM_COLUMNS}, pooled_cost_satang`);
  if (itemErr) ({ data: rawItems, error: itemErr } = await fetchItems(ITEM_COLUMNS));
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
    const m = item.menu_id
      ? menuMap.get(String(item.menu_id))
      : nameMap.get(String(item.menu_name_snapshot).trim().toLowerCase());
    const shouldRecalculate = (forceAll || !hasExistingCost || Boolean(menuId)) && m && Number(m.current_cost_satang) > 0;

    if (shouldRecalculate && m) {
      const next = recalculatedItemCost({
        menuCost: Number(m.current_cost_satang),
        menuPackagingCost: Number(m.packaging_cost_satang) || 0,
        pooledCost: Number(item.pooled_cost_satang) || 0,
        unitPrice: Number(item.unit_price_satang) || Number(m.selling_price_satang) || 0,
        quantity: qty,
      });

      const isAlreadyUpToDate =
        unitCost === next.unitCost &&
        lineCost === next.lineCost &&
        packCost === next.packagingCost;

      if (!isAlreadyUpToDate) {
        itemsToUpdate.push({
          id: String(item.id),
          payload: {
            ingredient_cost_satang: next.ingredientCost,
            packaging_cost_satang: next.packagingCost,
            unit_cost_satang: next.unitCost,
            unit_profit_satang: next.unitProfit,
            line_cost_satang: next.lineCost,
          },
        });
        affectedSaleIds.add(String(item.sale_id));
        unitCost = next.unitCost;
        packCost = next.packagingCost;
        lineCost = next.lineCost;
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
    let itemsList = saleItemsBySaleId.get(saleId);

    if (!itemsList || itemsList.length === 0 || menuId) {
      const { data: saleItems, error: siErr } = await supabase
        .from("sale_items")
        .select("line_cost_satang, packaging_cost_satang, quantity")
        .eq("sale_id", saleId);

      if (siErr) return;

      itemsList = rows(saleItems).map((si) => ({
        lineCost: Number(si.line_cost_satang) || 0,
        packCost: Number(si.packaging_cost_satang) || 0,
        quantity: Number(si.quantity) || 1,
      }));
    }

    // Packaging actually handed out with the order, when the seller recorded it.
    const { data: packRows, error: packErr } = await supabase
      .from("sale_packaging")
      .select("line_cost_satang")
      .eq("sale_id", saleId);
    const recordedPack = packErr ? [] : rows(packRows);
    const actualPackaging = recordedPack.length
      ? recordedPack.reduce((sum, p) => sum + (Number(p.line_cost_satang) || 0), 0)
      : null;

    const { cogs: totalCogs, packaging: totalPack } = saleCostTotals(itemsList, actualPackaging);

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
