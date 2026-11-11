"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionState } from "@/lib/action-state";
import { readCostRows } from "@/lib/cost-rows";
import { learnedYield, weightedPricePerUnit, yieldWindow } from "@/lib/analytics";
import { MENU_YIELDS_SETTINGS_KEY, PACKAGING_DEFAULTS_SETTINGS_KEY, invalidateQueryCache } from "@/lib/data/queries";
import { INGREDIENT_COSTING_LABELS, type ExpenseKind, type IngredientCosting, type PaymentMethod } from "@/lib/data/types";
import { menusUsing, recalculateMenuCosts } from "@/lib/menu-cost";
import { formatBaht, formatUnitCost } from "@/lib/money";
import {
  DEFAULT_SHOP_ID,
  SHOPS_REGISTRY_SETTINGS_KEY,
  type ShopSummary,
  decodeShopText,
  encodeShopText,
  matchesPurchaseShop,
  matchesShopText,
  resolveInventoryShopId,
  stripShopPrefix,
} from "@/lib/shop-scope";
import { InputError, amountOrZero, dateField, dbError, id, money, oneOf, optionalText, quantity, runAction, text } from "@/lib/server-action";
import { bangkokDayKey, fromBangkokDateInput } from "@/lib/time";

type Row = Record<string, unknown>;
const POOLED_UNIT = "บาท";

function revalidateCosts() {
  invalidateQueryCache("expenses_win");
  invalidateQueryCache("expenses_superset");
  invalidateQueryCache("ing_purchases_win");
  invalidateQueryCache("recent_purchases");
  invalidateQueryCache("latest_purchases");
  invalidateQueryCache("pack_purchases");
  invalidateQueryCache("all_time");
  invalidateQueryCache("ingredients");
  invalidateQueryCache("packaging");
  invalidateQueryCache("packaging_defaults");
  invalidateQueryCache("recipes");
  invalidateQueryCache("menus");
  invalidateQueryCache("pooled_rate");
  revalidatePath("/ingredients");
  revalidatePath("/menus");
  revalidatePath("/sales");
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

function encodePurchaseVendorForShop(vendor: string | null, shopId: string): string | null {
  if (shopId === DEFAULT_SHOP_ID) return vendor;
  return encodeShopText(vendor ?? "", shopId);
}

async function insertIngredientPurchasesWithExpenseLinks(
  supabase: SupabaseClient,
  pairs: Array<{ purchase: Row; expense: Row }>,
) {
  if (pairs.length === 0) return { expenseIds: [] as string[], purchaseIds: [] as string[] };

  const expensesPayload = pairs.map((p) => ({ ...p.expense, id: String(p.expense.id ?? crypto.randomUUID()) }));
  const expenseIds = expensesPayload.map((row) => row.id);
  const { error: expErr } = await supabase
    .from("expenses")
    .insert(expensesPayload);
  if (expErr) dbError(expErr);

  const purchasesWithExpenseId = pairs.map((p, idx) => ({
    ...p.purchase,
    id: String(p.purchase.id ?? crypto.randomUUID()),
    expense_id: expenseIds[idx] ?? null,
  }));
  const purchaseIds = purchasesWithExpenseId.map((row) => row.id);

  let { error: purErr } = await supabase.from("ingredient_purchases").insert(purchasesWithExpenseId);
  if (
    purErr &&
    (purErr.code === "42703" || purErr.code === "PGRST204" || String(purErr.message ?? "").includes("expense_id"))
  ) {
    const fallback = await supabase
      .from("ingredient_purchases")
      .insert(purchasesWithExpenseId.map((row) => {
        const withoutExpenseId: Row = { ...row };
        delete withoutExpenseId.expense_id;
        return withoutExpenseId;
      }));
    purErr = fallback.error;
  }

  if (purErr) {
    if (expenseIds.length > 0) {
      await supabase.from("expenses").delete().in("id", expenseIds);
    }
    dbError(purErr);
  }
  return { expenseIds, purchaseIds };
}

const roundCost = (value: number) => (Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0);

/**
 * Adds an ingredient (master data only — never creates a fake purchase or expense row).
 * per_unit: bought by `purchase_unit` (กก., แผง, กระปุก, ลิตร), used in recipes by `base_unit` (กรัม, มล., ฟอง, ชิ้น),
 * 1 purchase_unit ≈ `units_per_purchase_unit` base_units, with optional `initial_price` per purchase unit.
 * pooled: recorded by amount only when bought and costed as a % of food sales.
 */
export async function createIngredient(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, inventoryShopId }) => {
    const name = text(form, "name", "ชื่อวัตถุดิบ", { max: 120 });
    const costing = oneOf(form, "costing", ["per_unit", "pooled"] as const, "วิธีคิดต้นทุน");

    let purchaseUnit: string | null = null;
    let baseUnit = POOLED_UNIT;
    let unitsPerPurchase = 1;
    let yieldAuto = false;
    let initialPrice = 0;
    let unitCost = 0;

    if (costing === "per_unit") {
      purchaseUnit = text(form, "purchase_unit", "หน่วยที่ซื้อ", { max: 30 });
      baseUnit = text(form, "base_unit", "หน่วยที่ใช้ในสูตร", { max: 30 });
      unitsPerPurchase = quantity(form, "units_per_purchase_unit", "จำนวนต่อหน่วยที่ซื้อ")!;
      yieldAuto = yieldAutoField(form);
      initialPrice = money(form, "initial_price", `ราคาต่อ${purchaseUnit}ตั้งต้น`);
      unitCost = initialPrice > 0 ? roundCost(initialPrice / unitsPerPurchase) : 0;
    }

    const insertPayload: Row = {
      owner_id: user.id,
      name: encodeShopText(name, inventoryShopId),
      costing,
      category: INGREDIENT_COSTING_LABELS[costing],
      purchase_unit: purchaseUnit,
      base_unit: baseUnit,
      units_per_purchase_unit: unitsPerPurchase,
      yield_auto: yieldAuto,
      price_per_purchase_unit_satang: initialPrice,
      weighted_unit_cost_satang: unitCost,
    };

    let { error } = await supabase.from("ingredients").insert(insertPayload);
    if (error && error.code === "22P02" && error.message.includes("bigint")) {
      const fallback = await supabase.from("ingredients").insert({
        ...insertPayload,
        price_per_purchase_unit_satang: Math.round(initialPrice),
        weighted_unit_cost_satang: Math.round(unitCost),
      });
      error = fallback.error;
    }
    if (error) dbError(error, { unique: `มีวัตถุดิบชื่อ “${name}” อยู่แล้ว` });
    revalidateCosts();

    if (costing === "per_unit" && unitCost > 0) {
      return {
        ok: true,
        message: `เพิ่ม “${name}” แล้ว · ตก${baseUnit}ละ ${formatUnitCost(unitCost)} (ตั้งเป็นต้นทุนเริ่มต้นแล้ว ยังไม่ถูกคิดเป็นบิลจ่ายเงิน)`,
      };
    }
    return {
      ok: true,
      message:
        costing === "per_unit"
          ? `เพิ่ม “${name}” แล้ว — ใส่ในสูตรเมนูและตั้งราคาหรือบันทึกการซื้อเพื่อคำนวณต้นทุน`
          : `เพิ่ม “${name}” แล้ว — บันทึกยอดซื้อเมื่อจ่ายตลาดจริงเพื่อคำนวณ %`,
    };
  });
}

/**
 * Updates an ingredient's master data (name, units, units per purchase unit, optional base purchase price, and auto-yield).
 * Does not create any purchase or expense records.
 */
export async function updateIngredient(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, inventoryShopId }) => {
    const ingredientId = id(form);
    const name = text(form, "name", "ชื่อวัตถุดิบ", { max: 120 });
    const { data, error: readError } = await supabase
      .from("ingredients")
      .select("name,costing,purchase_unit,base_unit,units_per_purchase_unit,price_per_purchase_unit_satang")
      .eq("id", ingredientId)
      .single();
    if (readError) dbError(readError);
    const current = data as Row;
    if (!matchesShopText(String(current.name ?? ""), inventoryShopId)) {
      throw new InputError("ไม่พบรายการในคลังวัตถุดิบของร้านปัจจุบัน");
    }
    const oldDecoded = decodeShopText(String(current.name ?? ""));
    const targetCatalogShopId = current.name ? oldDecoded.shopId : inventoryShopId;
    const cleanOldName = oldDecoded.text;
    const now = new Date().toISOString();
    let update: Row = { name: encodeShopText(name, targetCatalogShopId), updated_at: now };
    if (current.costing !== "pooled") {
      const units = quantity(form, "units_per_purchase_unit", "จำนวนต่อหน่วยที่ซื้อ")!;
      const rawPurchaseUnit = optionalText(form, "purchase_unit", "หน่วยที่ซื้อ", 30);
      const rawBaseUnit = optionalText(form, "base_unit", "หน่วยที่ใช้ในสูตร", 30);
      const effectivePurchaseUnit = rawPurchaseUnit || String(current.purchase_unit ?? "กก.");
      const rawPriceInput = String(form.get("price_per_purchase_unit") ?? "").trim();
      const pricePerPurchaseUnit =
        rawPriceInput !== ""
          ? money(form, "price_per_purchase_unit", `ราคาต่อ${effectivePurchaseUnit}`)
          : Number(current.price_per_purchase_unit_satang);

      update = {
        ...update,
        purchase_unit: effectivePurchaseUnit,
        base_unit: rawBaseUnit || String(current.base_unit ?? "ชิ้น"),
        units_per_purchase_unit: units,
        yield_auto: yieldAutoField(form),
        price_per_purchase_unit_satang: pricePerPurchaseUnit,
        weighted_unit_cost_satang: roundCost(pricePerPurchaseUnit / units),
      };
      if (units !== Number(current.units_per_purchase_unit)) update.yield_updated_at = now;
    }
    let { error } = await supabase.from("ingredients").update(update).eq("id", ingredientId);
    if (error && error.code === "22P02" && error.message.includes("bigint") && update.weighted_unit_cost_satang !== undefined) {
      const fallback = await supabase.from("ingredients").update({
        ...update,
        price_per_purchase_unit_satang: Math.round(Number(update.price_per_purchase_unit_satang ?? 0)),
        weighted_unit_cost_satang: Math.round(Number(update.weighted_unit_cost_satang)),
      }).eq("id", ingredientId);
      error = fallback.error;
    }
    if (error) dbError(error, { unique: `มีวัตถุดิบชื่อ “${name}” อยู่แล้ว` });

    // Keep linked expense descriptions in sync when the ingredient is renamed
    if (cleanOldName && cleanOldName !== name) {
      const [{ data: expRows }, { data: regRow }] = await Promise.all([
        supabase.from("expenses").select("id, description").eq("category", "วัตถุดิบ"),
        supabase.from("settings").select("value").eq("key", SHOPS_REGISTRY_SETTINGS_KEY).maybeSingle(),
      ]);
      const rawShops = ((regRow?.value as { shops?: ShopSummary[] } | null)?.shops ?? []) as ShopSummary[];
      for (const exp of (expRows ?? []) as Array<{ id: unknown; description: unknown }>) {
        const expDecoded = decodeShopText(String(exp.description ?? ""));
        const expInvShopId = resolveInventoryShopId(expDecoded.shopId, rawShops);
        if (expInvShopId !== targetCatalogShopId && expDecoded.shopId !== targetCatalogShopId) continue;
        if (expDecoded.text === `ซื้อ${cleanOldName}` || expDecoded.text.startsWith(`ซื้อ${cleanOldName} `)) {
          const suffix = expDecoded.text.slice(`ซื้อ${cleanOldName}`.length);
          const nextDesc = encodeShopText(`ซื้อ${name}${suffix}`, expDecoded.shopId);
          await supabase.from("expenses").update({ description: nextDesc, updated_at: now }).eq("id", String(exp.id));
        }
      }
    }

    await recalculateMenuCosts(supabase, await menusUsing(supabase, "ingredient_id", ingredientId));
    revalidateCosts();
    return { ok: true, message: "บันทึกแล้ว และคำนวณต้นทุนเมนูใหม่" };
  });
}

type PerUnitIngredient = { id: string; name: string; base_unit: string; purchase_unit: string | null; units_per_purchase_unit: number; yield_auto: boolean };

/** Units of `ingredientId` sold (confirmed sales) in [start, end), using today's recipe quantities and batch yields. */
async function piecesSold(supabase: SupabaseClient, ingredientId: string, start: Date, end: Date) {
  const [{ data: recipe, error }, yieldsSetting] = await Promise.all([
    supabase.from("menu_recipe_items").select("menu_id,quantity").eq("ingredient_id", ingredientId),
    supabase.from("settings").select("value").eq("key", MENU_YIELDS_SETTINGS_KEY).maybeSingle(),
  ]);
  if (error) dbError(error);
  const rawYields = (yieldsSetting?.data?.value ?? {}) as Record<string, unknown>;
  const perMenu = new Map<string, number>();
  for (const r of recipe as Row[]) {
    const menuId = String(r.menu_id);
    const yieldVal = Number(rawYields[menuId]);
    const divisor = Number.isFinite(yieldVal) && yieldVal > 0 ? yieldVal : 1;
    perMenu.set(menuId, (perMenu.get(menuId) ?? 0) + Number(r.quantity) / divisor);
  }
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
 * After a purchase of a per-unit ingredient:
 * price per purchase_unit = weighted average of the last 30 days; units per purchase_unit learned from sales when auto;
 * cost per base_unit = price per purchase_unit ÷ units per purchase_unit; then menus using it are re-costed.
 */
async function refreshPerUnitCost(supabase: SupabaseClient, ingredient: PerUnitIngredient) {
  const data = await readCostRows((from, to) => supabase.from("ingredient_purchases").select("id,purchased_at,price_satang,purchased_quantity")
    .eq("ingredient_id", ingredient.id).order("id").range(from, to));
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
  return `${stripShopPrefix(ingredient.name)} ตก${ingredient.base_unit}ละ ${formatUnitCost(unitCost)} (${units.toLocaleString("th-TH")} ${ingredient.base_unit}/${ingredient.purchase_unit ?? "หน่วย"})`;
}

/**
 * Records several ingredient purchases at once.
 * Per-unit rows: `qty_<id>` × `unit_price_<id>`. Pooled rows: `amount_<id>` (฿).
 * Note: Unit cost updates apply to the shared ingredient catalog, while the expense bill is booked to the active `shopId`.
 */
export async function recordIngredientPurchases(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, shopId, inventoryShopId }) => {
    const purchasedAt = dateField(form, "purchased_at", "วันที่ซื้อ").toISOString();
    const vendor = optionalText(form, "vendor", "ร้านค้า", 120);
    const encodedPurchaseVendor = encodePurchaseVendorForShop(vendor, shopId);
    const receiptPath = optionalText(form, "receipt_path", "สลิป", 300);
    const notesText = optionalText(form, "notes", "หมายเหตุ", 300);
    const rawMethod = String(form.get("payment_method") ?? "transfer");
    const paymentMethod: PaymentMethod = rawMethod === "cash" || rawMethod === "other" ? rawMethod : "transfer";

    const { data, error } = await supabase.from("ingredients")
      .select("id,name,costing,base_unit,purchase_unit,units_per_purchase_unit,yield_auto").eq("is_active", true);
    if (error) dbError(error);

    const pairs: Array<{ purchase: Row; expense: Row }> = [];
    const perUnit: PerUnitIngredient[] = [];
    for (const r of data as Row[]) {
      const ingredientId = String(r.id), rawName = String(r.name);
      if (!matchesShopText(rawName, inventoryShopId)) continue;
      const { text: name } = decodeShopText(rawName);
      const costing = String(r.costing) as IngredientCosting;
      if (costing === "pooled") {
        const amount = money(form, `amount_${ingredientId}`, `ราคา${name}`);
        if (amount > 0) {
          pairs.push({
            purchase: {
              owner_id: user.id,
              ingredient_id: ingredientId,
              purchased_at: purchasedAt,
              price_satang: amount,
              vendor: encodedPurchaseVendor,
              ...(receiptPath ? { receipt_path: receiptPath } : {}),
            },
            expense: {
              owner_id: user.id, spent_at: purchasedAt, category: "วัตถุดิบ", kind: "direct", amount_satang: amount,
              description: encodeShopText(`ซื้อ${name}`, shopId), payee: vendor, payment_method: paymentMethod,
              ...(receiptPath ? { receipt_path: receiptPath } : {}),
              ...(notesText ? { notes: notesText } : {}),
            },
          });
        }
        continue;
      }
      const qty = amountOrZero(form, `qty_${ingredientId}`, `จำนวน${name}`);
      if (!qty) continue;
      const unitPrice = money(form, `unit_price_${ingredientId}`, `ราคาต่อ${r.purchase_unit ?? "หน่วย"}ของ${name}`, { required: true, positive: true });
      const unit = String(r.purchase_unit ?? r.base_unit);
      const priceSatang = Math.round(qty * unitPrice);
      pairs.push({
        purchase: {
          owner_id: user.id, ingredient_id: ingredientId, purchased_at: purchasedAt, price_satang: priceSatang,
          purchased_quantity: qty, usable_quantity: qty, purchase_unit: unit, vendor: encodedPurchaseVendor,
          ...(receiptPath ? { receipt_path: receiptPath } : {}),
        },
        expense: {
          owner_id: user.id, spent_at: purchasedAt, category: "วัตถุดิบ", kind: "direct", amount_satang: priceSatang,
          description: encodeShopText(`ซื้อ${name} ${qty.toLocaleString("th-TH")} ${unit}`, shopId), payee: vendor, payment_method: paymentMethod,
          ...(receiptPath ? { receipt_path: receiptPath } : {}),
          ...(notesText ? { notes: notesText } : {}),
        },
      });
      perUnit.push({
        id: ingredientId, name, base_unit: String(r.base_unit), purchase_unit: unit,
        units_per_purchase_unit: Number(r.units_per_purchase_unit), yield_auto: Boolean(r.yield_auto),
      });
    }
    if (!pairs.length) throw new InputError("กรอกอย่างน้อย 1 รายการ");
    await insertIngredientPurchasesWithExpenseLinks(supabase, pairs);

    const notes: string[] = [];
    for (const ingredient of perUnit) notes.push(await refreshPerUnitCost(supabase, ingredient));
    revalidateCosts();
    return { ok: true, message: [`บันทึกการซื้อ ${pairs.length} รายการแล้ว · ลงในรายการค่าใช้จ่ายแล้ว`, ...notes].join(" · ") };
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

async function refreshPackagingCost(supabase: SupabaseClient, packagingItemId: string) {
  const purchases = await readCostRows((from, to) =>
    supabase
      .from("packaging_purchases")
      .select("id,price_satang,pack_quantity")
      .eq("packaging_item_id", packagingItemId)
      .order("id")
      .range(from, to),
  );
  let totalPrice = 0;
  let totalPieces = 0;
  for (const p of purchases as Row[]) {
    totalPrice += Number(p.price_satang);
    totalPieces += Number(p.pack_quantity);
  }
  const unitCost = totalPieces > 0 ? roundCost(totalPrice / totalPieces) : 0;
  let { error: updateError } = await supabase
    .from("packaging_items")
    .update({ unit_cost_satang: unitCost, updated_at: new Date().toISOString() })
    .eq("id", packagingItemId);
  if (updateError && updateError.code === "22P02" && updateError.message.includes("bigint")) {
    const fallback = await supabase
      .from("packaging_items")
      .update({ unit_cost_satang: Math.round(unitCost), updated_at: new Date().toISOString() })
      .eq("id", packagingItemId);
    updateError = fallback.error;
  }
  if (updateError) dbError(updateError);
  await recalculateMenuCosts(supabase, await menusUsing(supabase, "packaging_item_id", packagingItemId));
  return unitCost;
}

const PACKAGING_EXPENSE_CATEGORY = "บรรจุภัณฑ์";

function perOrderField(form: FormData) {
  const value = String(form.get("per_order") ?? "true");
  if (value !== "true" && value !== "false") throw new InputError("กรุณาเลือกวิธีคิดต้นทุน");
  return value === "true";
}

/** Reads optional "pack price + pieces per pack" for setting up a packaging item's default cost. Both empty = no default; one empty = error. */
function optionalPackDefaultFields(form: FormData): { priceSatang: number; packQuantity: number } | null {
  const hasPrice = String(form.get("pack_price") ?? "").trim() !== "";
  const hasQuantity = String(form.get("pack_quantity") ?? "").trim() !== "";
  if (!hasPrice && !hasQuantity) return null;
  if (hasPrice !== hasQuantity) throw new InputError("กรอกทั้งราคาต่อแพ็กและจำนวนในแพ็ก หรือเว้นว่างทั้งคู่");
  return {
    priceSatang: money(form, "pack_price", "ราคาต่อแพ็ก", { required: true, positive: true }),
    packQuantity: quantity(form, "pack_quantity", "จำนวนในแพ็ก")!,
  };
}

async function savePackagingDefaultConfig(
  supabase: SupabaseClient,
  ownerId: string,
  packagingId: string,
  config: { packPriceSatang: number; packQuantity: number } | null,
) {
  const { data: existing } = await supabase
    .from("settings")
    .select("value")
    .eq("key", PACKAGING_DEFAULTS_SETTINGS_KEY)
    .maybeSingle();
  const map: Record<string, unknown> = { ...((existing?.value ?? {}) as Record<string, unknown>) };
  if (config && config.packPriceSatang > 0 && config.packQuantity > 0) {
    map[packagingId] = {
      packPriceSatang: Math.round(config.packPriceSatang),
      packQuantity: config.packQuantity,
    };
  } else {
    delete map[packagingId];
  }
  await supabase.from("settings").upsert(
    { owner_id: ownerId, key: PACKAGING_DEFAULTS_SETTINGS_KEY, value: map, updated_at: new Date().toISOString() },
    { onConflict: "owner_id,key" },
  );
}

/**
 * Saves an actual packaging purchase and sets the item's cost per piece = Σ price ÷ Σ pieces of all its purchases.
 * Items not counted per order (e.g. bags) are booked as an operating expense (deducted from profit).
 * Items counted per order (e.g. boxes, spoons) are booked as a direct expense (already in menu cost, not deducted twice).
 * Note: The expense row is booked to `activeShopId` (the shop recording the purchase).
 */
async function recordPackagingPurchase(
  supabase: SupabaseClient,
  ownerId: string,
  item: PackagingItem,
  purchase: PackPurchase,
  activeShopId: string,
) {
  let expenseId: string | null = null;
  const purchaseId = crypto.randomUUID();
  const { text: cleanName } = decodeShopText(item.name);
  if (purchase.price > 0) {
    const packs = purchase.packCount > 1 ? `${purchase.packCount.toLocaleString("th-TH")} แพ็ก (${purchase.packQuantity.toLocaleString("th-TH")} ${item.unit})` : `${purchase.packQuantity.toLocaleString("th-TH")} ${item.unit}`;
    expenseId = crypto.randomUUID();
    const { error } = await supabase.from("expenses").insert({
      id: expenseId,
      owner_id: ownerId, spent_at: purchase.purchasedAt.toISOString(), category: PACKAGING_EXPENSE_CATEGORY,
      kind: item.per_order ? "direct" : "operating",
      amount_satang: purchase.price,
      description: encodeShopText(`ซื้อ${cleanName} ${packs}`, activeShopId),
      payee: purchase.vendor,
      payment_method: purchase.paymentMethod ?? "transfer",
      ...(purchase.receiptPath ? { receipt_path: purchase.receiptPath } : {}),
      ...(purchase.notes ? { notes: purchase.notes } : {}),
    });
    if (error) dbError(error);
  }
  const packPurchasePayload: Row = {
    id: purchaseId,
    owner_id: ownerId,
    packaging_item_id: item.id,
    purchased_at: purchase.purchasedAt.toISOString(),
    price_satang: purchase.price,
    pack_quantity: purchase.packQuantity,
    pack_count: purchase.packCount,
    vendor: encodePurchaseVendorForShop(purchase.vendor, activeShopId),
    expense_id: expenseId,
  };
  let { error } = await supabase.from("packaging_purchases").insert(packPurchasePayload);
  if (
    error &&
    (error.code === "42703" || error.code === "PGRST204" || String(error.message ?? "").includes("expense_id"))
  ) {
    const withoutExpenseId: Row = { ...packPurchasePayload };
    delete withoutExpenseId.expense_id;
    const fallback = await supabase.from("packaging_purchases").insert(withoutExpenseId);
    error = fallback.error;
  }
  if (error) {
    if (expenseId) await supabase.from("expenses").delete().eq("id", expenseId);
    dbError(error);
  }

  try {
    const unitCost = await refreshPackagingCost(supabase, item.id);
    return { unitCost, expenseId, purchaseId, packagingItemId: item.id };
  } catch (costError) {
    await supabase.from("packaging_purchases").delete().eq("id", purchaseId);
    if (expenseId) await supabase.from("expenses").delete().eq("id", expenseId);
    await refreshPackagingCost(supabase, item.id).catch(() => undefined);
    throw costError;
  }
}

const perPiece = (unitCost: number, unit: string) => `ตก${unit}ละ ${formatUnitCost(unitCost)}`;

/**
 * Adds a packaging item (master data only — never creates a fake purchase or expense row).
 * When pack price & pieces per pack are given, sets the item's initial unit cost and remembers the pack default for future restocks.
 */
export async function createPackaging(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, inventoryShopId }) => {
    const name = text(form, "name", "ชื่อบรรจุภัณฑ์", { max: 120 });
    const encodedName = encodeShopText(name, inventoryShopId);
    const unit = text(form, "unit", "หน่วย", { max: 30 });
    const perOrder = perOrderField(form);
    const packDefault = optionalPackDefaultFields(form);
    const unitCost = packDefault ? roundCost(packDefault.priceSatang / packDefault.packQuantity) : 0;

    let { data, error } = await supabase
      .from("packaging_items")
      .insert({ owner_id: user.id, name: encodedName, unit, per_order: perOrder, unit_cost_satang: unitCost })
      .select("id")
      .single();
    if (error && error.code === "22P02" && error.message.includes("bigint")) {
      const fallback = await supabase
        .from("packaging_items")
        .insert({ owner_id: user.id, name: encodedName, unit, per_order: perOrder, unit_cost_satang: Math.round(unitCost) })
        .select("id")
        .single();
      data = fallback.data;
      error = fallback.error;
    }
    if (error) dbError(error, { unique: `มีบรรจุภัณฑ์ชื่อ “${name}” อยู่แล้ว` });
    const packagingId = String((data as Row).id);

    if (packDefault) {
      await savePackagingDefaultConfig(supabase, user.id, packagingId, {
        packPriceSatang: packDefault.priceSatang,
        packQuantity: packDefault.packQuantity,
      });
    }

    revalidateCosts();
    return {
      ok: true,
      message:
        packDefault === null
          ? `เพิ่ม “${name}” แล้ว — ตั้งราคาหรือบันทึกการซื้อเพื่อคำนวณราคาต่อ${unit}`
          : `เพิ่ม “${name}” แล้ว · ${perPiece(unitCost, unit)} (ตั้งเป็นต้นทุนเริ่มต้นแล้ว ยังไม่ถูกคิดเป็นบิลจ่ายเงิน)`,
    };
  });
}

export async function updatePackaging(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, inventoryShopId }) => {
    const packagingId = id(form);
    const name = text(form, "name", "ชื่อบรรจุภัณฑ์", { max: 120 });
    const { data: currentPack } = await supabase
      .from("packaging_items")
      .select("name")
      .eq("id", packagingId)
      .maybeSingle();
    if (!currentPack || !matchesShopText(String((currentPack as Row).name ?? ""), inventoryShopId)) {
      throw new InputError("ไม่พบรายการในคลังวัตถุดิบของร้านปัจจุบัน");
    }
    const targetCatalogShopId = currentPack?.name
      ? decodeShopText(String((currentPack as Row).name)).shopId
      : inventoryShopId;
    const encodedName = encodeShopText(name, targetCatalogShopId);
    const unit = text(form, "unit", "หน่วย", { max: 30 });
    const perOrder = perOrderField(form);
    const hasPrice = String(form.get("pack_price") ?? "").trim() !== "";
    const hasQuantity = String(form.get("pack_quantity") ?? "").trim() !== "";
    const updateFields: Row = { name: encodedName, unit, per_order: perOrder, updated_at: new Date().toISOString() };
    let newPackDefault: { packPriceSatang: number; packQuantity: number } | null = null;

    if (hasPrice && hasQuantity) {
      const packPrice = money(form, "pack_price", "ราคาต่อแพ็ก", { required: true });
      const packQty = quantity(form, "pack_quantity", "จำนวนต่อแพ็ก")!;
      if (packQty > 0) {
        updateFields.unit_cost_satang = roundCost(packPrice / packQty);
        newPackDefault = { packPriceSatang: packPrice, packQuantity: packQty };
      }
    }
    let { error } = await supabase.from("packaging_items").update(updateFields).eq("id", packagingId);
    if (error && error.code === "22P02" && error.message.includes("bigint") && updateFields.unit_cost_satang !== undefined) {
      const fallback = await supabase
        .from("packaging_items")
        .update({ ...updateFields, unit_cost_satang: Math.round(Number(updateFields.unit_cost_satang)) })
        .eq("id", packagingId);
      error = fallback.error;
    }
    if (error) dbError(error, { unique: `มีบรรจุภัณฑ์ชื่อ “${name}” อยู่แล้ว` });
    if (newPackDefault) {
      await savePackagingDefaultConfig(supabase, user.id, packagingId, newPackDefault);
    }
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
  return runAction(async ({ supabase, user, shopId, inventoryShopId }) => {
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
      if (!matchesShopText(item.name, inventoryShopId)) continue;
      const cleanName = stripShopPrefix(item.name);
      const packs = amountOrZero(form, `packs_${item.id}`, `จำนวนแพ็กของ${cleanName}`);
      if (!packs) continue;
      if (!Number.isInteger(packs)) throw new InputError(`จำนวนแพ็กของ${cleanName}ต้องเป็นจำนวนเต็ม`);
      const packPrice = money(form, `price_${item.id}`, `ราคาต่อแพ็กของ${cleanName}`, { required: true });
      const perPack = quantity(form, `qty_${item.id}`, `จำนวนต่อแพ็กของ${cleanName}`)!;
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
    const saved: Array<{ expenseId: string | null; purchaseId: string; packagingItemId: string }> = [];
    try {
      for (const { item, purchase } of rows) {
        const result = await recordPackagingPurchase(supabase, user.id, item, purchase, shopId);
        saved.push(result);
        total += purchase.price;
      }
    } catch (error) {
      const purchaseIds = saved.map((row) => row.purchaseId);
      const expenseIds = saved.map((row) => row.expenseId).filter((value): value is string => Boolean(value));
      if (purchaseIds.length > 0) await supabase.from("packaging_purchases").delete().in("id", purchaseIds);
      if (expenseIds.length > 0) await supabase.from("expenses").delete().in("id", expenseIds);
      for (const packagingItemId of new Set(saved.map((row) => row.packagingItemId))) {
        await refreshPackagingCost(supabase, packagingItemId).catch(() => undefined);
      }
      throw error;
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

export type ItemizedPurchaseActionState = ActionState & { createdExpenseIds?: string[] };

/**
 * Unified server action that saves an itemized slip containing any mix of:
 * - Per-unit ingredients -> ingredient_purchases + expenses + refreshPerUnitCost
 * - Pooled ingredients -> ingredient_purchases + expenses + pooled %
 * - Packaging items -> packaging_purchases + expenses + packaging unit cost
 * - General/extra expenses -> expenses
 * All records use the slip's date (`spentAt`), vendor/payee, payment method, and shared `receiptPath`.
 */
export async function saveItemizedExpenseAction(payload: ItemizedPurchasePayload): Promise<ItemizedPurchaseActionState> {
  return runAction(async ({ supabase, user, shopId, inventoryShopId }) => {
    let purchasedAtDate: Date;
    try {
      purchasedAtDate = fromBangkokDateInput(payload.spentAt || bangkokDayKey(new Date()));
    } catch {
      throw new InputError("วันที่จ่ายไม่ถูกต้อง");
    }
    const purchasedAtIso = purchasedAtDate.toISOString();
    const vendor = payload.vendor?.trim() ? payload.vendor.trim().slice(0, 120) : null;
    const encodedPurchaseVendor = encodePurchaseVendorForShop(vendor, shopId);
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

    const ingPairs: Array<{ purchase: Row; expense: Row }> = [];
    const extraExpensesToInsert: Row[] = [];
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
        if (!r || !matchesShopText(String(r.name ?? ""), inventoryShopId)) {
          throw new InputError("รายการวัตถุดิบไม่ได้อยู่ในคลังของร้านปัจจุบัน");
        }
        const rawName = String(r.name);
        const { text: cleanName } = decodeShopText(rawName);
        const unit = String(r.purchase_unit ?? r.base_unit);
        const priceSatang = Math.round(item.quantity * item.unitPriceSatang);
        if (priceSatang <= 0) continue;
        totalSatang += priceSatang;

        ingPairs.push({
          purchase: {
            owner_id: user.id,
            ingredient_id: item.ingredientId,
            purchased_at: purchasedAtIso,
            price_satang: priceSatang,
            purchased_quantity: item.quantity,
            usable_quantity: item.quantity,
            purchase_unit: unit,
            vendor: encodedPurchaseVendor,
            ...(receiptPath ? { receipt_path: receiptPath } : {}),
          },
          expense: {
            owner_id: user.id,
            spent_at: purchasedAtIso,
            category: "วัตถุดิบ",
            kind: "direct",
            amount_satang: priceSatang,
            description: encodeShopText(`ซื้อ${cleanName} ${item.quantity.toLocaleString("th-TH")} ${unit}`, shopId),
            payee: vendor,
            payment_method: paymentMethod,
            ...(receiptPath ? { receipt_path: receiptPath } : {}),
            ...(notesText ? { notes: notesText } : {}),
          },
        });
        perUnitToRefresh.push({
          id: item.ingredientId,
          name: rawName,
          base_unit: String(r.base_unit),
          purchase_unit: unit,
          units_per_purchase_unit: Number(r.units_per_purchase_unit),
          yield_auto: Boolean(r.yield_auto),
        });
      }

      for (const item of pooledInput) {
        const r = ingMap.get(item.ingredientId);
        if (!r || !matchesShopText(String(r.name ?? ""), inventoryShopId)) {
          throw new InputError("รายการวัตถุดิบไม่ได้อยู่ในคลังของร้านปัจจุบัน");
        }
        const { text: cleanName } = decodeShopText(String(r.name));
        const amount = Math.round(item.amountSatang);
        if (amount <= 0) continue;
        totalSatang += amount;

        ingPairs.push({
          purchase: {
            owner_id: user.id,
            ingredient_id: item.ingredientId,
            purchased_at: purchasedAtIso,
            price_satang: amount,
            vendor: encodedPurchaseVendor,
            ...(receiptPath ? { receipt_path: receiptPath } : {}),
          },
          expense: {
            owner_id: user.id,
            spent_at: purchasedAtIso,
            category: "วัตถุดิบ",
            kind: "direct",
            amount_satang: amount,
            description: encodeShopText(`ซื้อ${cleanName}`, shopId),
            payee: vendor,
            payment_method: paymentMethod,
            ...(receiptPath ? { receipt_path: receiptPath } : {}),
            ...(notesText ? { notes: notesText } : {}),
          },
        });
      }
    }

    let validatedPackagingRows: Array<{ item: PackagingItem; input: NonNullable<ItemizedPurchasePayload["packagingItems"]>[number] }> = [];
    if (packagingInput.length > 0) {
      const { data: packRows, error: packErr } = await supabase
        .from("packaging_items")
        .select("id,name,unit,per_order")
        .eq("is_active", true);
      if (packErr) dbError(packErr);
      const packMap = new Map((packRows as PackagingItem[]).map((p) => [p.id, p]));

      validatedPackagingRows = packagingInput.map((pInput) => {
        const item = packMap.get(pInput.packagingId);
        if (!item || !matchesShopText(String(item.name ?? ""), inventoryShopId)) {
          throw new InputError("รายการบรรจุภัณฑ์ไม่ได้อยู่ในคลังของร้านปัจจุบัน");
        }
        return { item, input: pInput };
      });
    }

    for (const extra of extraInput) {
      const amount = Math.round(extra.amountSatang);
      if (amount <= 0) continue;
      totalSatang += amount;
      extraExpensesToInsert.push({
        owner_id: user.id,
        spent_at: purchasedAtIso,
        category: extra.category.trim().slice(0, 60),
        kind: extra.kind,
        amount_satang: amount,
        description: encodeShopText(extra.description.trim().slice(0, 200), shopId),
        payee: vendor,
        payment_method: paymentMethod,
        ...(receiptPath ? { receipt_path: receiptPath } : {}),
        ...(notesText ? { notes: notesText } : {}),
      });
    }

    let ingredientInsertResult = { expenseIds: [] as string[], purchaseIds: [] as string[] };
    const extraExpenseIds = extraExpensesToInsert.map(() => crypto.randomUUID());
    const packagingResults: Array<{ expenseId: string | null; purchaseId: string; packagingItemId: string }> = [];
    const notes: string[] = [];
    try {
      if (ingPairs.length > 0) {
        ingredientInsertResult = await insertIngredientPurchasesWithExpenseLinks(supabase, ingPairs);
      }

      if (extraExpensesToInsert.length > 0) {
        const { error: insertExpErr } = await supabase
          .from("expenses")
          .insert(extraExpensesToInsert.map((row, index) => ({ ...row, id: extraExpenseIds[index] })));
        if (insertExpErr) dbError(insertExpErr);
      }

      for (const { item, input: pInput } of validatedPackagingRows) {
        const packs = Math.round(pInput.packs);
        const totalPackPrice = Math.round(pInput.packPriceSatang * packs);
        const totalPackQty = pInput.perPackQuantity * packs;
        if (packs <= 0 || totalPackPrice <= 0 || totalPackQty <= 0) continue;
        totalSatang += totalPackPrice;

        const result = await recordPackagingPurchase(
          supabase,
          user.id,
          item,
          {
            purchasedAt: purchasedAtDate,
            vendor,
            packCount: packs,
            price: totalPackPrice,
            packQuantity: totalPackQty,
            receiptPath,
            paymentMethod,
            notes: notesText,
          },
          shopId,
        );
        packagingResults.push(result);
      }

      for (const ingredient of perUnitToRefresh) {
        notes.push(await refreshPerUnitCost(supabase, ingredient));
      }
    } catch (error) {
      const packagingPurchaseIds = packagingResults.map((row) => row.purchaseId);
      const packagingExpenseIds = packagingResults
        .map((row) => row.expenseId)
        .filter((value): value is string => Boolean(value));
      if (packagingPurchaseIds.length > 0) {
        await supabase.from("packaging_purchases").delete().in("id", packagingPurchaseIds);
      }
      if (ingredientInsertResult.purchaseIds.length > 0) {
        await supabase.from("ingredient_purchases").delete().in("id", ingredientInsertResult.purchaseIds);
      }
      const allExpenseIds = [
        ...packagingExpenseIds,
        ...ingredientInsertResult.expenseIds,
        ...extraExpenseIds,
      ];
      if (allExpenseIds.length > 0) await supabase.from("expenses").delete().in("id", allExpenseIds);
      for (const packagingItemId of new Set(packagingResults.map((row) => row.packagingItemId))) {
        await refreshPackagingCost(supabase, packagingItemId).catch(() => undefined);
      }
      for (const ingredient of perUnitToRefresh) {
        await refreshPerUnitCost(supabase, ingredient).catch(() => undefined);
      }
      throw error;
    }

    revalidateCosts();

    return {
      ok: true,
      createdExpenseIds: [
        ...ingredientInsertResult.expenseIds,
        ...extraExpenseIds,
        ...packagingResults.map((row) => row.expenseId).filter((value): value is string => Boolean(value)),
      ],
      message: [
        `บันทึก ${totalItemsCount} รายการ รวม ${formatBaht(totalSatang)} เรียบร้อยแล้ว`,
        ...notes,
      ].join(" · "),
    };
  });
}


export async function toggleIngredientActive(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, inventoryShopId }) => {
    const ingredientId = id(form);
    const active = form.get("is_active") === "true";
    const { data: ingRow } = await supabase
      .from("ingredients")
      .select("id,name")
      .eq("id", ingredientId)
      .maybeSingle();
    if (!ingRow || !matchesShopText(String((ingRow as Row).name ?? ""), inventoryShopId)) {
      throw new InputError("ไม่พบรายการในคลังวัตถุดิบของร้านปัจจุบัน");
    }
    const { error } = await supabase
      .from("ingredients")
      .update({ is_active: active, updated_at: new Date().toISOString() })
      .eq("id", ingredientId);
    if (error) dbError(error);
    revalidateCosts();
    return { ok: true, message: active ? "เปิดใช้งานวัตถุดิบแล้ว" : "ซ่อนวัตถุดิบจากการสั่งซื้อแล้ว" };
  });
}

/**
 * Deletes an ingredient safely:
 * 1) Automatically removes it from any menu recipes (`menu_recipe_items`) and recalculates those menus' costs.
 * 2) Removes any purchase history (`ingredient_purchases`) and corresponding auto-created expense rows (`expenses`).
 * 3) Deletes the ingredient row itself.
 */
export async function deleteIngredient(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, inventoryShopId }) => {
    const ingredientId = id(form);
    const { data: ingRow } = await supabase
      .from("ingredients")
      .select("id,name")
      .eq("id", ingredientId)
      .maybeSingle();
    if (!ingRow || !matchesShopText(String((ingRow as Row).name ?? ""), inventoryShopId)) {
      throw new InputError("ไม่พบรายการในคลังวัตถุดิบของร้านปัจจุบัน");
    }
    const ingName = String((ingRow as Row).name ?? "");
    const { text: cleanIngName } = decodeShopText(ingName);

    const affectedMenuIds = await menusUsing(supabase, "ingredient_id", ingredientId);
    if (affectedMenuIds.length > 0) {
      const { error: recipeDelErr } = await supabase
        .from("menu_recipe_items")
        .delete()
        .eq("ingredient_id", ingredientId);
      if (recipeDelErr) dbError(recipeDelErr);
    }

    const { data: initialPurchases, error: purReadErr } = await supabase
      .from("ingredient_purchases")
      .select("id,purchased_at,price_satang,vendor,expense_id")
      .eq("ingredient_id", ingredientId);
    let purchases = initialPurchases;
    if (
      purReadErr &&
      (purReadErr.code === "42703" || purReadErr.code === "PGRST204" || String(purReadErr.message ?? "").includes("expense_id"))
    ) {
      const fallback = await supabase
        .from("ingredient_purchases")
        .select("id,purchased_at,price_satang,vendor")
        .eq("ingredient_id", ingredientId);
      purchases = fallback.data as typeof purchases;
    }

    if (purchases && purchases.length > 0) {
      const directExpenseIds = (purchases as Row[])
        .map((p) => (p.expense_id ? String(p.expense_id) : ""))
        .filter(Boolean);
      const fallbackPurchases = (purchases as Row[]).filter((p) => !p.expense_id);

      const { error: purchaseDelErr } = await supabase
        .from("ingredient_purchases")
        .delete()
        .eq("ingredient_id", ingredientId);
      if (purchaseDelErr) dbError(purchaseDelErr);

      if (directExpenseIds.length > 0) {
        await supabase.from("expenses").delete().in("id", directExpenseIds);
      }

      if (cleanIngName && fallbackPurchases.length > 0) {
        for (const p of fallbackPurchases) {
          const { data: matchedExp } = await supabase
            .from("expenses")
            .select("id,description")
            .eq("category", "วัตถุดิบ")
            .eq("spent_at", String(p.purchased_at))
            .eq("amount_satang", Number(p.price_satang))
            .ilike("description", `%ซื้อ${cleanIngName}%`);
          const targetExp = ((matchedExp ?? []) as Row[]).find((exp) => {
            const expShopId = decodeShopText(String(exp.description ?? "")).shopId;
            return matchesPurchaseShop(
              { vendor: (p.vendor as string | null) ?? null, ingredientName: ingName },
              expShopId,
            );
          });
          if (targetExp) {
            await supabase.from("expenses").delete().eq("id", String(targetExp.id));
          }
        }
      }
    }

    const { error } = await supabase.from("ingredients").delete().eq("id", ingredientId);
    if (error) dbError(error);

    if (affectedMenuIds.length > 0) {
      await recalculateMenuCosts(supabase, affectedMenuIds);
    }

    revalidateCosts();
    return {
      ok: true,
      message:
        affectedMenuIds.length > 0
          ? `ลบวัตถุดิบแล้ว (ถอดออกจากสูตร ${affectedMenuIds.length} เมนู และคำนวณต้นทุนเมนูใหม่เรียบร้อย)`
          : "ลบวัตถุดิบแล้ว",
    };
  });
}

export async function togglePackagingActive(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, inventoryShopId }) => {
    const packagingId = id(form);
    const active = form.get("is_active") === "true";
    const { data: packRow } = await supabase
      .from("packaging_items")
      .select("id,name")
      .eq("id", packagingId)
      .maybeSingle();
    if (!packRow || !matchesShopText(String((packRow as Row).name ?? ""), inventoryShopId)) {
      throw new InputError("ไม่พบรายการในคลังวัตถุดิบของร้านปัจจุบัน");
    }
    const { error } = await supabase
      .from("packaging_items")
      .update({ is_active: active, updated_at: new Date().toISOString() })
      .eq("id", packagingId);
    if (error) dbError(error);
    revalidateCosts();
    return { ok: true, message: active ? "เปิดใช้งานบรรจุภัณฑ์แล้ว" : "ซ่อนบรรจุภัณฑ์แล้ว" };
  });
}

/**
 * Deletes a packaging item safely:
 * 1) Automatically removes it from any menu recipes (`menu_recipe_items`) and recalculates those menus' costs.
 * 2) Removes any purchase history (`packaging_purchases`) and linked `expenses` rows.
 * 3) Removes any `sale_packaging` tracking rows (historical `sales.packaging_cost_satang` totals remain intact).
 * 4) Deletes the packaging item row and cleans up its default pack setting.
 */
export async function deletePackaging(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, inventoryShopId }) => {
    const packagingId = id(form);
    const { data: packRow } = await supabase
      .from("packaging_items")
      .select("id,name")
      .eq("id", packagingId)
      .maybeSingle();
    if (!packRow || !matchesShopText(String((packRow as Row).name ?? ""), inventoryShopId)) {
      throw new InputError("ไม่พบรายการในคลังวัตถุดิบของร้านปัจจุบัน");
    }
    const affectedMenuIds = await menusUsing(supabase, "packaging_item_id", packagingId);
    if (affectedMenuIds.length > 0) {
      const { error: recipeDelErr } = await supabase
        .from("menu_recipe_items")
        .delete()
        .eq("packaging_item_id", packagingId);
      if (recipeDelErr) dbError(recipeDelErr);
    }

    const { data: initialPackPurchases, error: packPurReadErr } = await supabase
      .from("packaging_purchases")
      .select("id,expense_id,purchased_at,price_satang,vendor")
      .eq("packaging_item_id", packagingId);
    let packPurchases = initialPackPurchases;
    if (
      packPurReadErr &&
      (packPurReadErr.code === "42703" || packPurReadErr.code === "PGRST204" || String(packPurReadErr.message ?? "").includes("expense_id"))
    ) {
      const fallback = await supabase
        .from("packaging_purchases")
        .select("id,purchased_at,price_satang,vendor")
        .eq("packaging_item_id", packagingId);
      packPurchases = fallback.data as typeof packPurchases;
    }

    if (packPurchases && packPurchases.length > 0) {
      const purchaseRows = packPurchases as Row[];
      const expenseIds = new Set(purchaseRows
        .map((p) => (p.expense_id ? String(p.expense_id) : ""))
        .filter(Boolean));
      const cleanName = stripShopPrefix(String((packRow as Row).name ?? ""));
      for (const purchase of purchaseRows.filter((row) => !row.expense_id)) {
        const rawVendor = String(purchase.vendor ?? "");
        const purchaseShopId = rawVendor.startsWith("[s:")
          ? decodeShopText(rawVendor).shopId
          : decodeShopText(String((packRow as Row).name ?? "")).shopId;
        const { data: legacyExpenses, error: legacyExpenseError } = await supabase
          .from("expenses")
          .select("id,description")
          .eq("owner_id", user.id)
          .eq("category", PACKAGING_EXPENSE_CATEGORY)
          .eq("spent_at", String(purchase.purchased_at))
          .eq("amount_satang", Number(purchase.price_satang))
          .order("created_at", { ascending: true });
        if (legacyExpenseError) dbError(legacyExpenseError);
        const matched = ((legacyExpenses ?? []) as Row[]).find((expense) => {
          const decoded = decodeShopText(String(expense.description ?? ""));
          return (
            decoded.shopId === purchaseShopId &&
            (decoded.text === `ซื้อ${cleanName}` || decoded.text.startsWith(`ซื้อ${cleanName} `)) &&
            !expenseIds.has(String(expense.id))
          );
        });
        if (matched) expenseIds.add(String(matched.id));
      }
      const { error: packPurchaseDelErr } = await supabase
        .from("packaging_purchases")
        .delete()
        .eq("packaging_item_id", packagingId);
      if (packPurchaseDelErr) dbError(packPurchaseDelErr);
      if (expenseIds.size > 0) {
        const { error: expenseDeleteError } = await supabase.from("expenses").delete().in("id", Array.from(expenseIds));
        if (expenseDeleteError) dbError(expenseDeleteError);
      }
    }

    const { error: salePackagingDeleteError } = await supabase
      .from("sale_packaging")
      .delete()
      .eq("packaging_item_id", packagingId);
    if (salePackagingDeleteError) dbError(salePackagingDeleteError);

    const { error } = await supabase.from("packaging_items").delete().eq("id", packagingId);
    if (error) dbError(error);

    await savePackagingDefaultConfig(supabase, user.id, packagingId, null);

    if (affectedMenuIds.length > 0) {
      await recalculateMenuCosts(supabase, affectedMenuIds);
    }

    revalidateCosts();
    return {
      ok: true,
      message:
        affectedMenuIds.length > 0
          ? `ลบบรรจุภัณฑ์แล้ว (ถอดออกจากสูตร ${affectedMenuIds.length} เมนู และคำนวณต้นทุนเมนูใหม่เรียบร้อย)`
          : "ลบบรรจุภัณฑ์แล้ว",
    };
  });
}
