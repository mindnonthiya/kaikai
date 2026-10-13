"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { menusUsing, recalculateMenuCosts } from "@/lib/menu-cost";
import { dateField, dbError, id, money, optionalText, quantity, runAction, text } from "@/lib/server-action";

type Row = Record<string, unknown>;

function revalidateCosts() {
  revalidatePath("/ingredients");
  revalidatePath("/menus");
  revalidatePath("/sales/new");
}

export async function saveIngredient(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const name = text(form, "name", "ชื่อวัตถุดิบ", { max: 120 });
    const category = text(form, "category", "หมวดหมู่", { max: 60 });
    const baseUnit = text(form, "base_unit", "หน่วยฐาน", { max: 30 });
    const { error } = await supabase.from("ingredients").insert({ owner_id: user.id, name, category, base_unit: baseUnit });
    if (error) dbError(error, { unique: `มีวัตถุดิบชื่อ “${name}” อยู่แล้ว` });
    revalidateCosts();
    return { ok: true, message: `เพิ่ม “${name}” แล้ว — บันทึกการซื้อเพื่อคำนวณต้นทุน` };
  });
}

/**
 * Records a purchase, then sets the ingredient's weighted average cost
 * = total price of all purchases ÷ total usable quantity, and re-costs menus that use it.
 */
export async function addPurchase(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const ingredientId = id(form, "ingredient_id");
    const purchasedAt = dateField(form, "purchased_at", "วันที่ซื้อ");
    const price = money(form, "price", "ราคารวม", { required: true });
    const purchased = quantity(form, "purchased_quantity", "ปริมาณที่ซื้อ")!;
    const usable = quantity(form, "usable_quantity", "ปริมาณที่ใช้ได้จริง", { required: false }) ?? purchased;
    const vendor = optionalText(form, "vendor", "ร้านค้า", 120);

    const { data: ingredient, error: ingredientError } = await supabase.from("ingredients").select("base_unit").eq("id", ingredientId).single();
    if (ingredientError) dbError(ingredientError);

    const { error } = await supabase.from("ingredient_purchases").insert({
      owner_id: user.id, ingredient_id: ingredientId, purchased_at: purchasedAt.toISOString(),
      price_satang: price, purchased_quantity: purchased, usable_quantity: usable, purchase_unit: String((ingredient as Row).base_unit), vendor,
    });
    if (error) dbError(error);

    const { data: purchases, error: sumError } = await supabase.from("ingredient_purchases").select("price_satang,usable_quantity").eq("ingredient_id", ingredientId);
    if (sumError) dbError(sumError);
    let totalPrice = 0, totalQuantity = 0;
    for (const p of purchases as Row[]) { totalPrice += Number(p.price_satang); totalQuantity += Number(p.usable_quantity); }
    const unitCost = totalQuantity > 0 ? Math.round((totalPrice / totalQuantity) * 1_000_000) / 1_000_000 : 0;
    const { error: updateError } = await supabase.from("ingredients").update({ weighted_unit_cost_satang: unitCost, updated_at: new Date().toISOString() }).eq("id", ingredientId);
    if (updateError) dbError(updateError);

    await recalculateMenuCosts(supabase, await menusUsing(supabase, "ingredient_id", ingredientId));
    revalidateCosts();
    return { ok: true, message: "บันทึกการซื้อและอัปเดตต้นทุนเฉลี่ยแล้ว" };
  });
}

export async function savePackaging(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const packagingId = String(form.get("id") ?? "") || null;
    const name = text(form, "name", "ชื่อบรรจุภัณฑ์", { max: 120 });
    const unit = text(form, "unit", "หน่วย", { max: 30 });
    const unitCost = money(form, "unit_cost", "ราคาต่อหน่วย", { required: true });
    const unique = { unique: `มีบรรจุภัณฑ์ชื่อ “${name}” อยู่แล้ว` };
    if (packagingId) {
      const { error } = await supabase.from("packaging_items").update({ name, unit, unit_cost_satang: unitCost, updated_at: new Date().toISOString() }).eq("id", packagingId);
      if (error) dbError(error, unique);
      await recalculateMenuCosts(supabase, await menusUsing(supabase, "packaging_item_id", packagingId));
    } else {
      const { error } = await supabase.from("packaging_items").insert({ owner_id: user.id, name, unit, unit_cost_satang: unitCost });
      if (error) dbError(error, unique);
    }
    revalidateCosts();
    return { ok: true, message: packagingId ? "อัปเดตราคาและต้นทุนเมนูแล้ว" : `เพิ่ม “${name}” แล้ว` };
  });
}
