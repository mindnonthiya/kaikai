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
    const foodCost = money(form, "food_cost", "ต้นทุนอาหารต่อจาน");
    const labor = money(form, "labor", "ค่าแรงต่อจาน");
    const overhead = money(form, "overhead", "ค่าโสหุ้ยต่อจาน");
    const fields = {
      name, category, selling_price_satang: price, manual_food_cost_satang: foodCost,
      labor_cost_satang: labor, overhead_cost_satang: overhead, updated_at: new Date().toISOString(),
    };
    const unique = { unique: `มีเมนูชื่อ “${name}” อยู่แล้ว` };

    let savedId = menuId;
    if (menuId) {
      const { error } = await supabase.from("menus").update(fields).eq("id", menuId);
      if (error) dbError(error, unique);
    } else {
      const { data, error } = await supabase.from("menus")
        .insert({ ...fields, owner_id: user.id, current_cost_satang: foodCost + labor + overhead, is_available: true })
        .select("id").single();
      if (error) dbError(error, unique);
      savedId = String((data as { id: string }).id);
    }
    await recalculateMenuCosts(supabase, [savedId!]);
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
