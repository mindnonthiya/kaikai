"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { recalculateMenuCosts } from "@/lib/menu-cost";
import { InputError, dbError, id, money, quantity, runAction, text } from "@/lib/server-action";

function revalidateMenus() {
  revalidatePath("/menus");
  revalidatePath("/sales/new");
  revalidatePath("/dashboard");
}

export async function saveMenu(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const menuId = String(form.get("id") ?? "") || null;
    const name = text(form, "name", "ชื่อเมนู", { max: 120 });
    const category = text(form, "category", "หมวดหมู่", { max: 60 });
    const price = money(form, "price", "ราคาขาย", { required: true, positive: true });
    const material = money(form, "material", "ต้นทุนวัตถุดิบและบรรจุภัณฑ์");
    const labor = money(form, "labor", "ค่าแรงต่อกล่อง");
    const overhead = money(form, "overhead", "ค่าโสหุ้ยต่อกล่อง");
    const now = new Date().toISOString();
    const fields = { name, category, selling_price_satang: price, labor_cost_satang: labor, overhead_cost_satang: overhead, updated_at: now };
    const unique = { unique: `มีเมนูชื่อ “${name}” อยู่แล้ว` };

    if (menuId) {
      const { count, error: countError } = await supabase.from("menu_recipe_items").select("id", { count: "exact", head: true }).eq("menu_id", menuId);
      if (countError) dbError(countError);
      const hasRecipe = (count ?? 0) > 0;
      const { error } = await supabase.from("menus")
        .update(hasRecipe ? fields : { ...fields, current_cost_satang: material + labor + overhead, cost_calculated_at: now })
        .eq("id", menuId);
      if (error) dbError(error, unique);
      if (hasRecipe) await recalculateMenuCosts(supabase, [menuId]);
    } else {
      const { error } = await supabase.from("menus").insert({ ...fields, owner_id: user.id, current_cost_satang: material + labor + overhead, cost_calculated_at: now, is_available: true });
      if (error) dbError(error, unique);
    }
    revalidateMenus();
    return { ok: true, message: menuId ? "บันทึกการแก้ไขแล้ว" : `เพิ่มเมนู “${name}” แล้ว` };
  });
}

export async function setMenuAvailability(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const menuId = id(form);
    const available = form.get("available") === "true";
    const { error } = await supabase.from("menus").update({ is_available: available, updated_at: new Date().toISOString() }).eq("id", menuId);
    if (error) dbError(error);
    revalidateMenus();
  });
}

export async function deleteMenu(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const menuId = id(form);
    const { error } = await supabase.from("menus").delete().eq("id", menuId);
    if (error) dbError(error, { foreignKey: "เมนูนี้มีประวัติการขายแล้ว จึงลบไม่ได้ — ใช้ “ปิดการขาย” แทน" });
    revalidateMenus();
  });
}

export async function addRecipeItem(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const menuId = id(form, "menu_id");
    const [kind, itemId] = String(form.get("item") ?? "").split(":");
    if (!itemId || (kind !== "ingredient" && kind !== "packaging")) throw new InputError("กรุณาเลือกวัตถุดิบหรือบรรจุภัณฑ์");
    const amount = quantity(form, "quantity", "ปริมาณ")!;
    const { error } = await supabase.from("menu_recipe_items").insert({
      owner_id: user.id,
      menu_id: menuId,
      ingredient_id: kind === "ingredient" ? itemId : null,
      packaging_item_id: kind === "packaging" ? itemId : null,
      quantity: amount,
    });
    if (error) dbError(error);
    await recalculateMenuCosts(supabase, [menuId]);
    revalidateMenus();
    return { ok: true, message: "เพิ่มในสูตรและคำนวณต้นทุนใหม่แล้ว" };
  });
}

export async function removeRecipeItem(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const itemId = id(form);
    const menuId = id(form, "menu_id");
    const { error } = await supabase.from("menu_recipe_items").delete().eq("id", itemId);
    if (error) dbError(error);
    await recalculateMenuCosts(supabase, [menuId]);
    revalidateMenus();
  });
}
