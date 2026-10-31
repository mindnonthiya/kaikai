// Recalculates menu cost. Used after menu, recipe, ingredient-purchase or packaging changes.
import type { SupabaseClient } from "@supabase/supabase-js";
import { readCostRows } from "@/lib/cost-rows";
import { recipeCostParts } from "@/lib/analytics";
import type { RecipeItemRecord } from "@/lib/data/types";
import { dbError } from "@/lib/server-action";

/**
 * cost per dish = per-piece ingredients in the recipe (chicken) + per-order packaging.
 * Pooled ingredients (rice, herbs, sauce) are not here — they are added at sale time as a % of the price.
 * Packaging not counted per order (bags etc.) is booked as an expense when bought.
 * `packaging_cost_satang` keeps the packaging part so a sale can swap it for what was actually handed out.
 * Without `menuIds` every menu is recalculated.
 */
export async function recalculateMenuCosts(supabase: SupabaseClient, menuIds?: string[]) {
  if (menuIds && !menuIds.length) return;
  const [menuRows, recipeRows, ingredientRows, packagingRows] = await Promise.all([
    readCostRows((from, to) => {
      let q = supabase.from("menus").select("id,current_cost_satang,packaging_cost_satang");
      if (menuIds) q = q.in("id", menuIds);
      return q.order("id").range(from, to);
    }),
    readCostRows((from, to) => {
      let q = supabase.from("menu_recipe_items").select("id,menu_id,ingredient_id,packaging_item_id,quantity");
      if (menuIds) q = q.in("menu_id", menuIds);
      return q.order("id").range(from, to);
    }),
    readCostRows((from, to) => supabase.from("ingredients").select("id,costing,weighted_unit_cost_satang").order("id").range(from, to)),
    readCostRows((from, to) => supabase.from("packaging_items").select("id,unit_cost_satang,per_order").order("id").range(from, to)),
  ]);
  const ingredientCost = new Map(ingredientRows.filter((r) => r.costing !== "pooled").map((r) => [String(r.id), Number(r.weighted_unit_cost_satang)]));
  const packagingCost = new Map(packagingRows.filter((r) => r.per_order !== false).map((r) => [String(r.id), Number(r.unit_cost_satang)]));
  const byMenu = new Map<string, RecipeItemRecord[]>();
  for (const r of recipeRows) {
    const menuId = String(r.menu_id);
    const list = byMenu.get(menuId) ?? [];
    list.push({ id: "", menuId, ingredientId: r.ingredient_id ? String(r.ingredient_id) : null, packagingItemId: r.packaging_item_id ? String(r.packaging_item_id) : null, quantity: Number(r.quantity) });
    byMenu.set(menuId, list);
  }

  const now = new Date().toISOString();
  const updates: Promise<unknown>[] = [];
  for (const menu of menuRows) {
    const parts = recipeCostParts(byMenu.get(String(menu.id)) ?? [], ingredientCost, packagingCost);
    const total = Math.round(parts.ingredients + parts.packaging);
    const pack = Math.round(parts.packaging);

    if (Number(menu.current_cost_satang) === total && Number(menu.packaging_cost_satang) === pack) {
      continue;
    }

    updates.push(
      (async () => {
        const { error } = await supabase.from("menus")
          .update({ current_cost_satang: total, packaging_cost_satang: pack, cost_calculated_at: now, updated_at: now })
          .eq("id", String(menu.id));
        if (error) dbError(error);
      })()
    );
  }
  await Promise.all(updates);
}

/** Menu ids whose recipe uses the given ingredient or packaging item. */
export async function menusUsing(supabase: SupabaseClient, column: "ingredient_id" | "packaging_item_id", itemId: string) {
  const data = await readCostRows((from, to) => supabase.from("menu_recipe_items")
    .select("id,menu_id").eq(column, itemId).order("id").range(from, to));
  return [...new Set(data.map((r) => String(r.menu_id)))];
}
