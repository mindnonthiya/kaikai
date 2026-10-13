// Recalculates menu cost. Used after menu, recipe, ingredient-purchase or packaging changes.
import type { SupabaseClient } from "@supabase/supabase-js";
import { recipeCostParts } from "@/lib/analytics";
import type { RecipeItemRecord } from "@/lib/data/types";
import { dbError } from "@/lib/server-action";

type Row = Record<string, unknown>;

/**
 * cost per dish = recipe ingredients + food cost typed by the owner + recipe packaging + labor + overhead.
 * Only packaging counted per order is included; bags etc. are booked as expenses when bought.
 * `packaging_cost_satang` keeps the packaging part so a sale can swap it for what was actually handed out.
 * Without `menuIds` every menu is recalculated.
 */
export async function recalculateMenuCosts(supabase: SupabaseClient, menuIds?: string[]) {
  if (menuIds && !menuIds.length) return;
  let menuQuery = supabase.from("menus").select("id,labor_cost_satang,overhead_cost_satang,manual_food_cost_satang");
  let recipeQuery = supabase.from("menu_recipe_items").select("menu_id,ingredient_id,packaging_item_id,quantity");
  if (menuIds) {
    menuQuery = menuQuery.in("id", menuIds);
    recipeQuery = recipeQuery.in("menu_id", menuIds);
  }
  const [menus, recipes, ingredients, packaging] = await Promise.all([
    menuQuery,
    recipeQuery,
    supabase.from("ingredients").select("id,weighted_unit_cost_satang"),
    supabase.from("packaging_items").select("id,unit_cost_satang,per_order"),
  ]);
  if (menus.error) dbError(menus.error);
  if (recipes.error) dbError(recipes.error);
  if (ingredients.error) dbError(ingredients.error);
  if (packaging.error) dbError(packaging.error);

  const ingredientCost = new Map((ingredients.data as Row[]).map((r) => [String(r.id), Number(r.weighted_unit_cost_satang)]));
  const packagingCost = new Map((packaging.data as Row[]).filter((r) => r.per_order !== false).map((r) => [String(r.id), Number(r.unit_cost_satang)]));
  const byMenu = new Map<string, RecipeItemRecord[]>();
  for (const r of recipes.data as Row[]) {
    const menuId = String(r.menu_id);
    const list = byMenu.get(menuId) ?? [];
    list.push({ id: "", menuId, ingredientId: r.ingredient_id ? String(r.ingredient_id) : null, packagingItemId: r.packaging_item_id ? String(r.packaging_item_id) : null, quantity: Number(r.quantity) });
    byMenu.set(menuId, list);
  }

  const now = new Date().toISOString();
  for (const menu of menus.data as Row[]) {
    const parts = recipeCostParts(byMenu.get(String(menu.id)) ?? [], ingredientCost, packagingCost);
    const total = parts.ingredients + Number(menu.manual_food_cost_satang) + parts.packaging + Number(menu.labor_cost_satang) + Number(menu.overhead_cost_satang);
    const { error } = await supabase.from("menus")
      .update({ current_cost_satang: total, packaging_cost_satang: parts.packaging, cost_calculated_at: now, updated_at: now })
      .eq("id", String(menu.id));
    if (error) dbError(error);
  }
}

/** Menu ids whose recipe uses the given ingredient or packaging item. */
export async function menusUsing(supabase: SupabaseClient, column: "ingredient_id" | "packaging_item_id", itemId: string) {
  const { data, error } = await supabase.from("menu_recipe_items").select("menu_id").eq(column, itemId);
  if (error) dbError(error);
  return [...new Set((data as Row[]).map((r) => String(r.menu_id)))];
}
