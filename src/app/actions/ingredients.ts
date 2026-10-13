"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionState } from "@/lib/action-state";
import { menusUsing, recalculateMenuCosts } from "@/lib/menu-cost";
import { formatUnitCost } from "@/lib/money";
import { InputError, dateField, dbError, id, money, optionalText, quantity, runAction, text } from "@/lib/server-action";

type Row = Record<string, unknown>;

function revalidateCosts() {
  revalidatePath("/ingredients");
  revalidatePath("/menus");
  revalidatePath("/sales/new");
  revalidatePath("/expenses");
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

type PackagingItem = { id: string; name: string; unit: string; per_order: boolean };
type PackPurchase = { purchasedAt: Date; price: number; packQuantity: number; vendor: string | null };

const PACKAGING_EXPENSE_CATEGORY = "บรรจุภัณฑ์";

function perOrderField(form: FormData) {
  const value = String(form.get("per_order") ?? "true");
  if (value !== "true" && value !== "false") throw new InputError("กรุณาเลือกวิธีคิดต้นทุน");
  return value === "true";
}

/** Reads "pack price + pieces per pack". Both empty = no purchase; one of them empty = error. */
function packPurchaseFields(form: FormData, required: boolean): PackPurchase | null {
  const hasPrice = String(form.get("pack_price") ?? "").trim() !== "";
  const hasQuantity = String(form.get("pack_quantity") ?? "").trim() !== "";
  if (!required && !hasPrice && !hasQuantity) return null;
  if (hasPrice !== hasQuantity && !required) throw new InputError("กรอกทั้งราคาที่ซื้อและจำนวนในแพ็ก หรือเว้นว่างทั้งคู่");
  return {
    purchasedAt: dateField(form, "purchased_at", "วันที่ซื้อ"),
    price: money(form, "pack_price", "ราคาที่ซื้อ", { required: true }),
    packQuantity: quantity(form, "pack_quantity", "จำนวนในแพ็ก")!,
    vendor: optionalText(form, "vendor", "ร้านค้า", 120),
  };
}

/**
 * Saves a pack purchase and sets the item's cost per piece = Σ price ÷ Σ pieces of all its purchases.
 * Items not counted per order (e.g. bags) are also booked as an operating expense, so profit stays correct.
 */
async function recordPackagingPurchase(supabase: SupabaseClient, ownerId: string, item: PackagingItem, purchase: PackPurchase) {
  let expenseId: string | null = null;
  if (!item.per_order && purchase.price > 0) {
    const { data, error } = await supabase.from("expenses").insert({
      owner_id: ownerId, spent_at: purchase.purchasedAt.toISOString(), category: PACKAGING_EXPENSE_CATEGORY, kind: "operating", amount_satang: purchase.price,
      description: `ซื้อ${item.name} ${purchase.packQuantity.toLocaleString("th-TH")} ${item.unit}`, payee: purchase.vendor,
    }).select("id").single();
    if (error) dbError(error);
    expenseId = String((data as Row).id);
  }
  const { error } = await supabase.from("packaging_purchases").insert({
    owner_id: ownerId, packaging_item_id: item.id, purchased_at: purchase.purchasedAt.toISOString(), price_satang: purchase.price,
    pack_quantity: purchase.packQuantity, vendor: purchase.vendor, expense_id: expenseId,
  });
  if (error) {
    if (expenseId) await supabase.from("expenses").delete().eq("id", expenseId);
    dbError(error);
  }

  const { data: purchases, error: sumError } = await supabase.from("packaging_purchases").select("price_satang,pack_quantity").eq("packaging_item_id", item.id);
  if (sumError) dbError(sumError);
  let totalPrice = 0, totalPieces = 0;
  for (const p of purchases as Row[]) { totalPrice += Number(p.price_satang); totalPieces += Number(p.pack_quantity); }
  const unitCost = totalPieces > 0 ? Math.round((totalPrice / totalPieces) * 1_000_000) / 1_000_000 : 0;
  const { error: updateError } = await supabase.from("packaging_items").update({ unit_cost_satang: unitCost, updated_at: new Date().toISOString() }).eq("id", item.id);
  if (updateError) dbError(updateError);
  await recalculateMenuCosts(supabase, await menusUsing(supabase, "packaging_item_id", item.id));
  return unitCost;
}

const perPiece = (unitCost: number, unit: string) => `ตก${unit}ละ ${formatUnitCost(unitCost)}`;

/** Adds a packaging item, optionally with its first pack purchase in the same form. */
export async function createPackaging(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const name = text(form, "name", "ชื่อบรรจุภัณฑ์", { max: 120 });
    const unit = text(form, "unit", "หน่วย", { max: 30 });
    const perOrder = perOrderField(form);
    const purchase = packPurchaseFields(form, false);
    const { data, error } = await supabase.from("packaging_items").insert({ owner_id: user.id, name, unit, per_order: perOrder, unit_cost_satang: 0 }).select("id").single();
    if (error) dbError(error, { unique: `มีบรรจุภัณฑ์ชื่อ “${name}” อยู่แล้ว` });
    const item = { id: String((data as Row).id), name, unit, per_order: perOrder };
    const unitCost = purchase ? await recordPackagingPurchase(supabase, user.id, item, purchase) : null;
    revalidateCosts();
    return { ok: true, message: unitCost === null ? `เพิ่ม “${name}” แล้ว — บันทึกการซื้อเพื่อคำนวณราคาต่อ${unit}` : `เพิ่ม “${name}” แล้ว · ${perPiece(unitCost, unit)}` };
  });
}

export async function updatePackaging(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const packagingId = id(form);
    const name = text(form, "name", "ชื่อบรรจุภัณฑ์", { max: 120 });
    const unit = text(form, "unit", "หน่วย", { max: 30 });
    const perOrder = perOrderField(form);
    const { error } = await supabase.from("packaging_items").update({ name, unit, per_order: perOrder, updated_at: new Date().toISOString() }).eq("id", packagingId);
    if (error) dbError(error, { unique: `มีบรรจุภัณฑ์ชื่อ “${name}” อยู่แล้ว` });
    await recalculateMenuCosts(supabase, await menusUsing(supabase, "packaging_item_id", packagingId));
    revalidateCosts();
    return { ok: true, message: "บันทึกแล้ว และคำนวณต้นทุนเมนูใหม่" };
  });
}

export async function addPackagingPurchase(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const packagingId = id(form, "packaging_item_id");
    const purchase = packPurchaseFields(form, true)!;
    const { data, error } = await supabase.from("packaging_items").select("id,name,unit,per_order").eq("id", packagingId).single();
    if (error) dbError(error);
    const item = data as PackagingItem;
    const unitCost = await recordPackagingPurchase(supabase, user.id, item, purchase);
    revalidateCosts();
    return { ok: true, message: `บันทึกการซื้อแล้ว · ${perPiece(unitCost, item.unit)}${item.per_order ? "" : " · ลงในค่าใช้จ่ายให้แล้ว"}` };
  });
}
