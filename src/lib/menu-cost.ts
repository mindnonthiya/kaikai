// Recalculates menu cost from its recipe. Used after recipe, ingredient-purchase or packaging-price changes.
import type { SupabaseClient } from "@supabase/supabase-js";
import { recipeMaterialCost } from "@/lib/analytics";
import { dbError } from "@/lib/server-action";

type Row = Record<string, unknown>;

/**
 * For each menu that has recipe lines: cost = recipe material cost + labor + overhead.
 * Menus without a recipe keep their manually entered cost.
 */
export async function recalculateMenuCosts(supabase: SupabaseClient, menuIds?: string[]) {
  let recipeQuery = supabase.from("menu_recipe_items").select("menu_id,ingredient_id,packaging_item_id,quantity");
  if (menuIds) {
    if (!menuIds.length) return;
    recipeQuery = recipeQuery.in("menu_id", menuIds);
  }
  const [recipes, ingredients, packaging] = await Promise.all([
    recipeQuery,
    supabase.from("ingredients").select("id,weighted_unit_cost_satang"),
    supabase.from("packaging_items").select("id,unit_cost_satang"),
  ]);
  if (recipes.error) dbError(recipes.error);
  if (ingredients.error) dbError(ingredients.error);
  if (packaging.error) dbError(packaging.error);

  const ingredientCost = new Map((ingredients.data as Row[]).map((r) => [String(r.id), Number(r.weighted_unit_cost_satang)]));
  const packagingCost = new Map((packaging.data as Row[]).map((r) => [String(r.id), Number(r.unit_cost_satang)]));
  const byMenu = new Map<string, { ingredientId: string | null; packagingItemId: string | null; quantity: number; id: string; menuId: string }[]>();
  for (const r of recipes.data as Row[]) {
    const menuId = String(r.menu_id);
    const list = byMenu.get(menuId) ?? [];
    list.push({ id: "", menuId, ingredientId: r.ingredient_id ? String(r.ingredient_id) : null, packagingItemId: r.packaging_item_id ? String(r.packaging_item_id) : null, quantity: Number(r.quantity) });
    byMenu.set(menuId, list);
  }
  const targetIds = [...byMenu.keys()];
  if (!targetIds.length) return;

  const { data: menus, error } = await supabase.from("menus").select("id,labor_cost_satang,overhead_cost_satang").in("id", targetIds);
  if (error) dbError(error);
  const now = new Date().toISOString();
  for (const menu of menus as Row[]) {
    const material = recipeMaterialCost(byMenu.get(String(menu.id)) ?? [], ingredientCost, packagingCost);
    const total = material + Number(menu.labor_cost_satang) + Number(menu.overhead_cost_satang);
    const { error: updateError } = await supabase.from("menus").update({ current_cost_satang: total, cost_calculated_at: now, updated_at: now }).eq("id", String(menu.id));
    if (updateError) dbError(updateError);
  }
}

/** Menu ids whose recipe uses the given ingredient or packaging item. */
export async function menusUsing(supabase: SupabaseClient, column: "ingredient_id" | "packaging_item_id", itemId: string) {
  const { data, error } = await supabase.from("menu_recipe_items").select("menu_id").eq(column, itemId);
  if (error) dbError(error);
  return [...new Set((data as Row[]).map((r) => String(r.menu_id)))];
}
