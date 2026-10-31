"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionState } from "@/lib/action-state";
import { learnedYield, weightedPricePerUnit, yieldWindow } from "@/lib/analytics";
import { invalidateQueryCache } from "@/lib/data/queries";
import { INGREDIENT_COSTING_LABELS, type ExpenseKind, type IngredientCosting, type PaymentMethod } from "@/lib/data/types";
import { syncHistoricalCosts } from "@/lib/historical-cost-sync";
import { menusUsing, recalculateMenuCosts } from "@/lib/menu-cost";
import { formatBaht, formatUnitCost } from "@/lib/money";
import { InputError, amountOrZero, dateField, dbError, id, money, oneOf, optionalText, quantity, runAction, text } from "@/lib/server-action";
import { bangkokDayKey, fromBangkokDateInput } from "@/lib/time";

type Row = Record<string, unknown>;
const POOLED_UNIT = "บาท";

function revalidateCosts() {
  invalidateQueryCache("ingredients");
  invalidateQueryCache("packaging");
  invalidateQueryCache("recipes");
  invalidateQueryCache("menus");
  invalidateQueryCache("pooled_rate");
  revalidatePath("/ingredients");
  revalidatePath("/menus");
  revalidatePath("/sales/new");
  revalidatePath("/expenses");
  revalidatePath("/expenses/import-slips");
  revalidatePath("/reports");
  revalidatePath("/dashboard");
  revalidatePath("/settings");
  revalidatePath("/bank-check");
}

function yieldAutoField(form: FormData) {
  return form.get("yield_auto") === "true" || form.get("yield_auto") === "on";
}

/**
 * Adds an ingredient.
 * per_unit (chicken): bought by `purchase_unit` (กก.), used in recipes by `base_unit` (ชิ้น), 1 กก. ≈ `units_per_purchase_unit` pieces.
 * pooled (rice, herbs, sauce): recorded by amount only and costed as a % of food sales.
 */
export async function createIngredient(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const name = text(form, "name", "ชื่อวัตถุดิบ", { max: 120 });
    const costing = oneOf(form, "costing", ["per_unit", "pooled"] as const, "วิธีคิดต้นทุน");
    const fields = costing === "per_unit"
      ? {
        purchase_unit: text(form, "purchase_unit", "หน่วยที่ซื้อ", { max: 30 }),
        base_unit: text(form, "base_unit", "หน่วยที่ใช้ในสูตร", { max: 30 }),
        units_per_purchase_unit: quantity(form, "units_per_purchase_unit", "จำนวนต่อหน่วยที่ซื้อ")!,
        yield_auto: yieldAutoField(form),
      }
      : { purchase_unit: null, base_unit: POOLED_UNIT, units_per_purchase_unit: 1, yield_auto: false };
    const { error } = await supabase.from("ingredients").insert({ owner_id: user.id, name, costing, category: INGREDIENT_COSTING_LABELS[costing], ...fields });
    if (error) dbError(error, { unique: `มีวัตถุดิบชื่อ “${name}” อยู่แล้ว` });
    revalidateCosts();
    return { ok: true, message: costing === "per_unit" ? `เพิ่ม “${name}” แล้ว — ใส่ในสูตรเมนูและบันทึกการซื้อเพื่อคำนวณต้นทุน` : `เพิ่ม “${name}” แล้ว — บันทึกยอดซื้อเพื่อคำนวณ %` };
  });
}

/** Renames an ingredient; for per-piece items also sets pieces per purchase unit and whether it is learned automatically. */
export async function updateIngredient(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const ingredientId = id(form);
    const name = text(form, "name", "ชื่อวัตถุดิบ", { max: 120 });
    const { data, error: readError } = await supabase.from("ingredients").select("costing,units_per_purchase_unit,price_per_purchase_unit_satang").eq("id", ingredientId).single();
    if (readError) dbError(readError);
    const current = data as Row;
    const now = new Date().toISOString();
    let update: Row = { name, updated_at: now };
    if (current.costing !== "pooled") {
      const units = quantity(form, "units_per_purchase_unit", "จำนวนต่อหน่วยที่ซื้อ")!;
      update = {
        ...update, units_per_purchase_unit: units, yield_auto: yieldAutoField(form),
        weighted_unit_cost_satang: roundCost(Number(current.price_per_purchase_unit_satang) / units),
      };
      if (units !== Number(current.units_per_purchase_unit)) update.yield_updated_at = now;
    }
    let { error } = await supabase.from("ingredients").update(update).eq("id", ingredientId);
    if (error && error.code === "22P02" && error.message.includes("bigint") && update.weighted_unit_cost_satang !== undefined) {
      const fallback = await supabase.from("ingredients").update({
        ...update,
        weighted_unit_cost_satang: Math.round(Number(update.weighted_unit_cost_satang)),
      }).eq("id", ingredientId);
      error = fallback.error;
    }
    if (error) dbError(error, { unique: `มีวัตถุดิบชื่อ “${name}” อยู่แล้ว` });
    await recalculateMenuCosts(supabase, await menusUsing(supabase, "ingredient_id", ingredientId));
    revalidateCosts();
    return { ok: true, message: "บันทึกแล้ว และคำนวณต้นทุนเมนูใหม่" };
  });
}

const roundCost = (value: number) => (Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0);

type PerUnitIngredient = { id: string; name: string; base_unit: string; purchase_unit: string | null; units_per_purchase_unit: number; yield_auto: boolean };

/** Pieces of `ingredientId` sold (confirmed sales) in [start, end), using today's recipe quantities. */
async function piecesSold(supabase: SupabaseClient, ingredientId: string, start: Date, end: Date) {
  const { data: recipe, error } = await supabase.from("menu_recipe_items").select("menu_id,quantity").eq("ingredient_id", ingredientId);
  if (error) dbError(error);
  const perMenu = new Map<string, number>();
  for (const r of recipe as Row[]) perMenu.set(String(r.menu_id), (perMenu.get(String(r.menu_id)) ?? 0) + Number(r.quantity));
  if (!perMenu.size) return 0;
  let pieces = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error: salesError } = await supabase.from("sale_items").select("menu_id,quantity,sales!inner(sold_at,status)")
      .in("menu_id", [...perMenu.keys()]).eq("sales.status", "confirmed")
      .gte("sales.sold_at", start.toISOString()).lt("sales.sold_at", end.toISOString()).range(from, from + 999);
    if (salesError) dbError(salesError);
    const page = data as Row[];
    for (const item of page) pieces += Number(item.quantity) * (perMenu.get(String(item.menu_id)) ?? 0);
    if (page.length < 1000) return pieces;
  }
}

/**
 * After a purchase of a per-piece ingredient:
 * price per กก. = weighted average of the last 30 days; pieces per กก. learned from sales when auto;
 * cost per piece = price per กก. ÷ pieces per กก.; then menus using it are re-costed.
 */
async function refreshPerUnitCost(supabase: SupabaseClient, ingredient: PerUnitIngredient) {
  const { data, error } = await supabase.from("ingredient_purchases").select("purchased_at,price_satang,purchased_quantity")
    .eq("ingredient_id", ingredient.id).order("purchased_at", { ascending: false }).limit(200);
  if (error) dbError(error);
  const purchases = (data as Row[]).map((p) => ({
    purchasedAt: String(p.purchased_at), price: Number(p.price_satang),
    quantity: p.purchased_quantity === null ? null : Number(p.purchased_quantity),
  }));
  const pricePerUnit = roundCost(weightedPricePerUnit(purchases));
  let units = Number(ingredient.units_per_purchase_unit) || 1;
  let learned = false;
  if (ingredient.yield_auto) {
    const window = yieldWindow(purchases);
    if (window) {
      const value = learnedYield(await piecesSold(supabase, ingredient.id, window.start, window.end), window.quantity, units);
      if (value !== null) { units = value; learned = true; }
    }
  }
  const now = new Date().toISOString();
  const unitCost = roundCost(pricePerUnit / units);
  let { error: updateError } = await supabase.from("ingredients").update({
    price_per_purchase_unit_satang: pricePerUnit, units_per_purchase_unit: units, weighted_unit_cost_satang: unitCost, updated_at: now,
    ...(learned ? { yield_updated_at: now } : {}),
  }).eq("id", ingredient.id);
  if (updateError && updateError.code === "22P02" && updateError.message.includes("bigint")) {
    const fallbackUpdate = await supabase.from("ingredients").update({
      price_per_purchase_unit_satang: Math.round(pricePerUnit), units_per_purchase_unit: units, weighted_unit_cost_satang: Math.round(unitCost), updated_at: now,
      ...(learned ? { yield_updated_at: now } : {}),
    }).eq("id", ingredient.id);
    updateError = fallbackUpdate.error;
  }
  if (updateError) dbError(updateError);
  await recalculateMenuCosts(supabase, await menusUsing(supabase, "ingredient_id", ingredient.id));
  return `${ingredient.name} ตก${ingredient.base_unit}ละ ${formatUnitCost(unitCost)} (${units.toLocaleString("th-TH")} ${ingredient.base_unit}/${ingredient.purchase_unit ?? "หน่วย"})`;
}

/**
 * Records several ingredient purchases at once.
 * Per-piece rows: `qty_<id>` (กก.) × `unit_price_<id>` (฿ per กก.). Pooled rows: `amount_<id>` (฿).
 */
export async function recordIngredientPurchases(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const purchasedAt = dateField(form, "purchased_at", "วันที่ซื้อ").toISOString();
    const vendor = optionalText(form, "vendor", "ร้านค้า", 120);
    const receiptPath = optionalText(form, "receipt_path", "สลิป", 300);
    const notesText = optionalText(form, "notes", "หมายเหตุ", 300);
    const rawMethod = String(form.get("payment_method") ?? "transfer");
    const paymentMethod: PaymentMethod = rawMethod === "cash" || rawMethod === "other" ? rawMethod : "transfer";

    const { data, error } = await supabase.from("ingredients")
      .select("id,name,costing,base_unit,purchase_unit,units_per_purchase_unit,yield_auto").eq("is_active", true);
    if (error) dbError(error);

    const rows: Row[] = [];
    const perUnit: PerUnitIngredient[] = [];
    const expensesToInsert: Row[] = [];
    for (const r of data as Row[]) {
      const ingredientId = String(r.id), name = String(r.name);
      const costing = String(r.costing) as IngredientCosting;
      if (costing === "pooled") {
        const amount = money(form, `amount_${ingredientId}`, `ราคา${name}`);
        if (amount > 0) {
          rows.push({ owner_id: user.id, ingredient_id: ingredientId, purchased_at: purchasedAt, price_satang: amount, vendor });
          expensesToInsert.push({
            owner_id: user.id, spent_at: purchasedAt, category: "วัตถุดิบ", kind: "direct", amount_satang: amount,
            description: `ซื้อ${name}`, payee: vendor, payment_method: paymentMethod,
            ...(receiptPath ? { receipt_path: receiptPath } : {}),
            ...(notesText ? { notes: notesText } : {}),
          });
        }
        continue;
      }
      const qty = amountOrZero(form, `qty_${ingredientId}`, `จำนวน${name}`);
      if (!qty) continue;
      const unitPrice = money(form, `unit_price_${ingredientId}`, `ราคาต่อ${r.purchase_unit ?? "หน่วย"}ของ${name}`, { required: true, positive: true });
      const unit = String(r.purchase_unit ?? r.base_unit);
      const priceSatang = Math.round(qty * unitPrice);
      rows.push({
        owner_id: user.id, ingredient_id: ingredientId, purchased_at: purchasedAt, price_satang: priceSatang,
        purchased_quantity: qty, usable_quantity: qty, purchase_unit: unit, vendor,
      });
      expensesToInsert.push({
        owner_id: user.id, spent_at: purchasedAt, category: "วัตถุดิบ", kind: "direct", amount_satang: priceSatang,
        description: `ซื้อ${name} ${qty.toLocaleString("th-TH")} ${unit}`, payee: vendor, payment_method: paymentMethod,
        ...(receiptPath ? { receipt_path: receiptPath } : {}),
        ...(notesText ? { notes: notesText } : {}),
      });
      perUnit.push({
        id: ingredientId, name, base_unit: String(r.base_unit), purchase_unit: unit,
        units_per_purchase_unit: Number(r.units_per_purchase_unit), yield_auto: Boolean(r.yield_auto),
      });
    }
    if (!rows.length) throw new InputError("กรอกอย่างน้อย 1 รายการ");
    const { error: insertError } = await supabase.from("ingredient_purchases").insert(rows);
    if (insertError) dbError(insertError);
    if (expensesToInsert.length) {
      const { error: expenseError } = await supabase.from("expenses").insert(expensesToInsert);
      if (expenseError) dbError(expenseError);
    }

    const notes: string[] = [];
    for (const ingredient of perUnit) notes.push(await refreshPerUnitCost(supabase, ingredient));
    revalidateCosts();
    return { ok: true, message: [`บันทึกการซื้อ ${rows.length} รายการแล้ว · ลงในรายการค่าใช้จ่ายแล้ว`, ...notes].join(" · ") };
  });
}

type PackagingItem = { id: string; name: string; unit: string; per_order: boolean };
type PackPurchase = {
  purchasedAt: Date;
  price: number;
  packQuantity: number;
  packCount: number;
  vendor: string | null;
  receiptPath?: string | null;
  paymentMethod?: PaymentMethod;
  notes?: string | null;
};

const PACKAGING_EXPENSE_CATEGORY = "บรรจุภัณฑ์";

function perOrderField(form: FormData) {
  const value = String(form.get("per_order") ?? "true");
  if (value !== "true" && value !== "false") throw new InputError("กรุณาเลือกวิธีคิดต้นทุน");
  return value === "true";
}

/** Reads "pack price + pieces per pack" of the create form. Both empty = no purchase; one of them empty = error. */
function firstPackFields(form: FormData): PackPurchase | null {
  const hasPrice = String(form.get("pack_price") ?? "").trim() !== "";
  const hasQuantity = String(form.get("pack_quantity") ?? "").trim() !== "";
  if (!hasPrice && !hasQuantity) return null;
  if (hasPrice !== hasQuantity) throw new InputError("กรอกทั้งราคาที่ซื้อและจำนวนในแพ็ก หรือเว้นว่างทั้งคู่");
  return {
    purchasedAt: dateField(form, "purchased_at", "วันที่ซื้อ"),
    price: money(form, "pack_price", "ราคาที่ซื้อ", { required: true }),
    packQuantity: quantity(form, "pack_quantity", "จำนวนในแพ็ก")!,
    packCount: 1,
    vendor: optionalText(form, "vendor", "ร้านค้า", 120),
  };
}

/**
 * Saves a packaging purchase and sets the item's cost per piece = Σ price ÷ Σ pieces of all its purchases.
 * Items not counted per order (e.g. bags) are booked as an operating expense (deducted from profit).
 * Items counted per order (e.g. boxes, spoons) are booked as a direct expense (already in menu cost, not deducted twice).
 */
async function recordPackagingPurchase(supabase: SupabaseClient, ownerId: string, item: PackagingItem, purchase: PackPurchase) {
  let expenseId: string | null = null;
  if (purchase.price > 0) {
    const packs = purchase.packCount > 1 ? `${purchase.packCount.toLocaleString("th-TH")} แพ็ก (${purchase.packQuantity.toLocaleString("th-TH")} ${item.unit})` : `${purchase.packQuantity.toLocaleString("th-TH")} ${item.unit}`;
    const { data, error } = await supabase.from("expenses").insert({
      owner_id: ownerId, spent_at: purchase.purchasedAt.toISOString(), category: PACKAGING_EXPENSE_CATEGORY,
      kind: item.per_order ? "direct" : "operating",
      amount_satang: purchase.price,
      description: `ซื้อ${item.name} ${packs}`,
      payee: purchase.vendor,
      payment_method: purchase.paymentMethod ?? "transfer",
      ...(purchase.receiptPath ? { receipt_path: purchase.receiptPath } : {}),
      ...(purchase.notes ? { notes: purchase.notes } : {}),
    }).select("id").single();
    if (error) dbError(error);
    expenseId = String((data as Row).id);
  }
  const { error } = await supabase.from("packaging_purchases").insert({
    owner_id: ownerId, packaging_item_id: item.id, purchased_at: purchase.purchasedAt.toISOString(), price_satang: purchase.price,
    pack_quantity: purchase.packQuantity, pack_count: purchase.packCount, vendor: purchase.vendor, expense_id: expenseId,
  });
  if (error) {
    if (expenseId) await supabase.from("expenses").delete().eq("id", expenseId);
    dbError(error);
  }

  const { data: purchases, error: sumError } = await supabase.from("packaging_purchases").select("price_satang,pack_quantity").eq("packaging_item_id", item.id);
  if (sumError) dbError(sumError);
  let totalPrice = 0, totalPieces = 0;
  for (const p of purchases as Row[]) { totalPrice += Number(p.price_satang); totalPieces += Number(p.pack_quantity); }
  const unitCost = totalPieces > 0 ? roundCost(totalPrice / totalPieces) : 0;
  let { error: updateError } = await supabase.from("packaging_items").update({ unit_cost_satang: unitCost, updated_at: new Date().toISOString() }).eq("id", item.id);
  if (updateError && updateError.code === "22P02" && updateError.message.includes("bigint")) {
    const fallback = await supabase.from("packaging_items").update({ unit_cost_satang: Math.round(unitCost), updated_at: new Date().toISOString() }).eq("id", item.id);
    updateError = fallback.error;
  }
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
    const purchase = firstPackFields(form);
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

/**
 * Restocks several packaging items at once.
 * Each row: `packs_<id>` = number of packs (0 = skip), `price_<id>` = price per pack, `qty_<id>` = pieces per pack.
 */
export async function restockPackaging(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const purchasedAt = dateField(form, "purchased_at", "วันที่ซื้อ");
    const vendor = optionalText(form, "vendor", "ร้านค้า", 120);
    const receiptPath = optionalText(form, "receipt_path", "สลิป", 300);
    const notesText = optionalText(form, "notes", "หมายเหตุ", 300);
    const rawMethod = String(form.get("payment_method") ?? "transfer");
    const paymentMethod: PaymentMethod = rawMethod === "cash" || rawMethod === "other" ? rawMethod : "transfer";

    const { data, error } = await supabase.from("packaging_items").select("id,name,unit,per_order").eq("is_active", true);
    if (error) dbError(error);
    const rows: Array<{ item: PackagingItem; purchase: PackPurchase }> = [];
    for (const item of data as PackagingItem[]) {
      const packs = amountOrZero(form, `packs_${item.id}`, `จำนวนแพ็กของ${item.name}`);
      if (!packs) continue;
      if (!Number.isInteger(packs)) throw new InputError(`จำนวนแพ็กของ${item.name}ต้องเป็นจำนวนเต็ม`);
      const packPrice = money(form, `price_${item.id}`, `ราคาต่อแพ็กของ${item.name}`, { required: true });
      const perPack = quantity(form, `qty_${item.id}`, `จำนวนต่อแพ็กของ${item.name}`)!;
      rows.push({
        item,
        purchase: {
          purchasedAt,
          vendor,
          packCount: packs,
          price: packPrice * packs,
          packQuantity: perPack * packs,
          receiptPath,
          paymentMethod,
          notes: notesText,
        },
      });
    }
    if (!rows.length) throw new InputError("เลือกจำนวนแพ็กอย่างน้อย 1 รายการ");
    let total = 0;
    for (const { item, purchase } of rows) {
      await recordPackagingPurchase(supabase, user.id, item, purchase);
      total += purchase.price;
    }
    revalidateCosts();
    return { ok: true, message: `บันทึกการซื้อ ${rows.length} รายการ รวม ${formatBaht(total)} · ลงในรายการค่าใช้จ่ายแล้ว` };
  });
}

export type ItemizedPurchasePayload = {
  spentAt: string; // YYYY-MM-DD
  vendor?: string | null;
  paymentMethod?: PaymentMethod;
  receiptPath?: string | null;
  notes?: string | null;
  perUnitItems?: Array<{
    ingredientId: string;
    quantity: number;
    unitPriceSatang: number;
  }>;
  pooledItems?: Array<{
    ingredientId: string;
    amountSatang: number;
  }>;
  packagingItems?: Array<{
    packagingId: string;
    packs: number;
    packPriceSatang: number;
    perPackQuantity: number;
  }>;
  extraExpenses?: Array<{
    description: string;
    category: string;
    kind: ExpenseKind;
    amountSatang: number;
  }>;
};

/**
 * Unified server action that saves an itemized slip containing any mix of:
 * - Per-unit ingredients (e.g. chicken kg × price) -> ingredient_purchases + expenses + refreshPerUnitCost
 * - Pooled ingredients (e.g. chili, garlic, rice, fish sauce) -> ingredient_purchases + expenses + pooled %
 * - Packaging items (e.g. boxes, spoons, bags) -> packaging_purchases + expenses + packaging unit cost
 * - General/extra expenses (e.g. ice, delivery fuel, etc.) -> expenses
 * All records use the slip's date (`spentAt`), vendor/payee, payment method, and shared `receiptPath`.
 */
export async function saveItemizedExpenseAction(payload: ItemizedPurchasePayload): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    let purchasedAtDate: Date;
    try {
      purchasedAtDate = fromBangkokDateInput(payload.spentAt || bangkokDayKey(new Date()));
    } catch {
      throw new InputError("วันที่จ่ายไม่ถูกต้อง");
    }
    const purchasedAtIso = purchasedAtDate.toISOString();
    const vendor = payload.vendor?.trim() ? payload.vendor.trim().slice(0, 120) : null;
    const paymentMethod: PaymentMethod =
      payload.paymentMethod === "cash" || payload.paymentMethod === "other" ? payload.paymentMethod : "transfer";
    const receiptPath = payload.receiptPath?.trim() ? payload.receiptPath.trim().slice(0, 300) : null;
    const notesText = payload.notes?.trim() ? payload.notes.trim().slice(0, 300) : null;

    const perUnitInput = (payload.perUnitItems ?? []).filter((i) => i.quantity > 0 && i.unitPriceSatang > 0);
    const pooledInput = (payload.pooledItems ?? []).filter((i) => i.amountSatang > 0);
    const packagingInput = (payload.packagingItems ?? []).filter(
      (i) => i.packs > 0 && i.packPriceSatang > 0 && i.perPackQuantity > 0
    );
    const extraInput = (payload.extraExpenses ?? []).filter(
      (i) => i.amountSatang > 0 && i.description.trim().length > 0 && i.category.trim().length > 0
    );

    const totalItemsCount =
      perUnitInput.length + pooledInput.length + packagingInput.length + extraInput.length;
    if (totalItemsCount === 0) {
      throw new InputError("กรุณากรอกรายการอย่างน้อย 1 รายการ");
    }

    const ingredientPurchasesToInsert: Row[] = [];
    const expensesToInsert: Row[] = [];
    const perUnitToRefresh: PerUnitIngredient[] = [];
    let totalSatang = 0;

    if (perUnitInput.length > 0 || pooledInput.length > 0) {
      const { data: ingRows, error: ingErr } = await supabase
        .from("ingredients")
        .select("id,name,costing,base_unit,purchase_unit,units_per_purchase_unit,yield_auto")
        .eq("is_active", true);
      if (ingErr) dbError(ingErr);
      const ingMap = new Map((ingRows as Row[]).map((r) => [String(r.id), r]));

      for (const item of perUnitInput) {
        const r = ingMap.get(item.ingredientId);
        if (!r) continue;
        const name = String(r.name);
        const unit = String(r.purchase_unit ?? r.base_unit);
        const priceSatang = Math.round(item.quantity * item.unitPriceSatang);
        if (priceSatang <= 0) continue;
        totalSatang += priceSatang;

        ingredientPurchasesToInsert.push({
          owner_id: user.id,
          ingredient_id: item.ingredientId,
          purchased_at: purchasedAtIso,
          price_satang: priceSatang,
          purchased_quantity: item.quantity,
          usable_quantity: item.quantity,
          purchase_unit: unit,
          vendor,
        });
        expensesToInsert.push({
          owner_id: user.id,
          spent_at: purchasedAtIso,
          category: "วัตถุดิบ",
          kind: "direct",
          amount_satang: priceSatang,
          description: `ซื้อ${name} ${item.quantity.toLocaleString("th-TH")} ${unit}`,
          payee: vendor,
          payment_method: paymentMethod,
          ...(receiptPath ? { receipt_path: receiptPath } : {}),
          ...(notesText ? { notes: notesText } : {}),
        });
        perUnitToRefresh.push({
          id: item.ingredientId,
          name,
          base_unit: String(r.base_unit),
          purchase_unit: unit,
          units_per_purchase_unit: Number(r.units_per_purchase_unit),
          yield_auto: Boolean(r.yield_auto),
        });
      }

      for (const item of pooledInput) {
        const r = ingMap.get(item.ingredientId);
        if (!r) continue;
        const name = String(r.name);
        const amount = Math.round(item.amountSatang);
        if (amount <= 0) continue;
        totalSatang += amount;

        ingredientPurchasesToInsert.push({
          owner_id: user.id,
          ingredient_id: item.ingredientId,
          purchased_at: purchasedAtIso,
          price_satang: amount,
          vendor,
        });
        expensesToInsert.push({
          owner_id: user.id,
          spent_at: purchasedAtIso,
          category: "วัตถุดิบ",
          kind: "direct",
          amount_satang: amount,
          description: `ซื้อ${name}`,
          payee: vendor,
          payment_method: paymentMethod,
          ...(receiptPath ? { receipt_path: receiptPath } : {}),
          ...(notesText ? { notes: notesText } : {}),
        });
      }
    }

    for (const extra of extraInput) {
      const amount = Math.round(extra.amountSatang);
      if (amount <= 0) continue;
      totalSatang += amount;
      expensesToInsert.push({
        owner_id: user.id,
        spent_at: purchasedAtIso,
        category: extra.category.trim().slice(0, 60),
        kind: extra.kind,
        amount_satang: amount,
        description: extra.description.trim().slice(0, 200),
        payee: vendor,
        payment_method: paymentMethod,
        ...(receiptPath ? { receipt_path: receiptPath } : {}),
        ...(notesText ? { notes: notesText } : {}),
      });
    }

    if (ingredientPurchasesToInsert.length > 0) {
      const { error: insertIngErr } = await supabase
        .from("ingredient_purchases")
        .insert(ingredientPurchasesToInsert);
      if (insertIngErr) dbError(insertIngErr);
    }

    if (expensesToInsert.length > 0) {
      const { error: insertExpErr } = await supabase.from("expenses").insert(expensesToInsert);
      if (insertExpErr) dbError(insertExpErr);
    }

    if (packagingInput.length > 0) {
      const { data: packRows, error: packErr } = await supabase
        .from("packaging_items")
        .select("id,name,unit,per_order")
        .eq("is_active", true);
      if (packErr) dbError(packErr);
      const packMap = new Map((packRows as PackagingItem[]).map((p) => [p.id, p]));

      for (const pInput of packagingInput) {
        const item = packMap.get(pInput.packagingId);
        if (!item) continue;
        const packs = Math.round(pInput.packs);
        const totalPackPrice = Math.round(pInput.packPriceSatang * packs);
        const totalPackQty = pInput.perPackQuantity * packs;
        if (packs <= 0 || totalPackPrice <= 0 || totalPackQty <= 0) continue;
        totalSatang += totalPackPrice;

        await recordPackagingPurchase(supabase, user.id, item, {
          purchasedAt: purchasedAtDate,
          vendor,
          packCount: packs,
          price: totalPackPrice,
          packQuantity: totalPackQty,
          receiptPath,
          paymentMethod,
          notes: notesText,
        });
      }
    }

    const notes: string[] = [];
    for (const ingredient of perUnitToRefresh) {
      notes.push(await refreshPerUnitCost(supabase, ingredient));
    }

    await syncHistoricalCosts(supabase, { ownerId: user.id }).catch(() => undefined);
    revalidateCosts();

    return {
      ok: true,
      message: [
        `บันทึก ${totalItemsCount} รายการ รวม ${formatBaht(totalSatang)} เรียบร้อยแล้ว`,
        ...notes,
      ].join(" · "),
    };
  });
}
