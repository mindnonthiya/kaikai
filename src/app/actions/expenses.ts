"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionState } from "@/lib/action-state";
import { readCostRows } from "@/lib/cost-rows";
import { weightedPricePerUnit } from "@/lib/analytics";
import { invalidateQueryCache } from "@/lib/data/queries";
import type { ExpenseKind, PaymentMethod } from "@/lib/data/types";
import { menusUsing, recalculateMenuCosts } from "@/lib/menu-cost";
import { InputError, dateField, dbError, id, money, oneOf, optionalText, runAction, text } from "@/lib/server-action";
import { bangkokDayKey, fromBangkokDateInput } from "@/lib/time";
import { saveItemizedExpenseAction, type ItemizedPurchasePayload } from "./ingredients";

const KINDS = ["direct", "operating", "one_time", "recurring"] as const;
const METHODS = ["cash", "transfer", "other"] as const;
const roundCost = (value: number) => (Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0);

function revalidateExpenses() {
  invalidateQueryCache("ingredients");
  invalidateQueryCache("packaging");
  invalidateQueryCache("recipes");
  invalidateQueryCache("menus");
  invalidateQueryCache("pooled_rate");
  revalidatePath("/expenses");
  revalidatePath("/expenses/import-slips");
  revalidatePath("/ingredients");
  revalidatePath("/menus");
  revalidatePath("/sales");
  revalidatePath("/sales/new");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  revalidatePath("/bank-check");
}

export async function revalidateExpensesAction(): Promise<ActionState> {
  return runAction(async () => {
    revalidateExpenses();
    return { ok: true };
  });
}

export async function saveExpense(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const spentAt = dateField(form, "spent_at", "วันที่จ่าย");
    const description = text(form, "description", "รายละเอียด", { max: 200 });
    const category = text(form, "category", "หมวดหมู่", { max: 60 });
    const kind = oneOf(form, "kind", KINDS, "ประเภทค่าใช้จ่าย");
    const amount = money(form, "amount", "จำนวนเงิน", { required: true, positive: true });
    const payee = optionalText(form, "payee", "ผู้รับเงิน", 120);
    const paymentMethod = oneOf(form, "payment_method", METHODS, "วิธีชำระ");
    const receiptPath = optionalText(form, "receipt_path", "สลิป", 300);
    const notes = optionalText(form, "notes", "หมายเหตุ", 300);
    const { error } = await supabase.from("expenses").insert({
      owner_id: user.id,
      spent_at: spentAt.toISOString(),
      description,
      category,
      kind,
      amount_satang: amount,
      payee,
      payment_method: paymentMethod,
      ...(receiptPath ? { receipt_path: receiptPath } : {}),
      ...(notes ? { notes } : {}),
    });
    if (error) dbError(error);
    revalidateExpenses();
    return { ok: true, message: "บันทึกค่าใช้จ่ายแล้ว" };
  });
}

async function deleteExpensesByIds(
  supabase: SupabaseClient,
  ownerId: string,
  expenseIds: string[],
  options?: { keepStorageFiles?: boolean }
) {
  const uniqueIds = Array.from(new Set(expenseIds.map((x) => x.trim()).filter(Boolean)));
  if (uniqueIds.length === 0) throw new InputError("กรุณาเลือกรายการที่ต้องการลบ");

  const { data: existingRows, error: readErr } = await supabase
    .from("expenses")
    .select("id, spent_at, category, amount_satang, description, receipt_path")
    .in("id", uniqueIds);
  if (readErr) dbError(readErr);

  const rows = (existingRows ?? []) as Array<{
    id: string;
    spent_at: string;
    category: string;
    amount_satang: number;
    description: string;
    receipt_path: string | null;
  }>;

  const affectedPackagingItemIds = new Set<string>();
  const affectedPerUnitIngMap = new Map<string, number>();
  const receiptPathsToCheck = new Set<string>();

  // 1. Clean up linked packaging_purchases rows by expense_id in batch
  const { data: linkedPacks } = await supabase
    .from("packaging_purchases")
    .select("id, packaging_item_id, expense_id")
    .in("expense_id", uniqueIds);

  const handledExpenseIdsForPack = new Set<string>();
  if (linkedPacks && linkedPacks.length > 0) {
    for (const p of linkedPacks) {
      affectedPackagingItemIds.add(String((p as { packaging_item_id: unknown }).packaging_item_id));
      if ((p as { expense_id?: unknown }).expense_id) {
        handledExpenseIdsForPack.add(String((p as { expense_id: unknown }).expense_id));
      }
    }
    await supabase
      .from("packaging_purchases")
      .delete()
      .in("id", linkedPacks.map((p) => String((p as { id: unknown }).id)));
  }

  // Fallback for backfilled packaging_purchases where expense_id was null
  for (const existing of rows) {
    if (existing.receipt_path) receiptPathsToCheck.add(existing.receipt_path);
    if (existing.category === "บรรจุภัณฑ์" && !handledExpenseIdsForPack.has(existing.id)) {
      const { data: fallbackPacks } = await supabase
        .from("packaging_purchases")
        .select("id, packaging_item_id")
        .eq("purchased_at", existing.spent_at)
        .eq("price_satang", existing.amount_satang)
        .is("expense_id", null)
        .order("created_at", { ascending: true })
        .limit(1);
      if (fallbackPacks && fallbackPacks.length > 0) {
        const p = fallbackPacks[0] as { id: unknown; packaging_item_id: unknown };
        affectedPackagingItemIds.add(String(p.packaging_item_id));
        await supabase.from("packaging_purchases").delete().eq("id", String(p.id));
      }
    }
  }

  // 2. Clean up matching ingredient_purchases rows
  const ingExpenseRows = rows.filter(
    (r) => r.category === "วัตถุดิบ" && String(r.description ?? "").startsWith("ซื้อ")
  );
  if (ingExpenseRows.length > 0) {
    const { data: ings } = await supabase
      .from("ingredients")
      .select("id, name, costing, units_per_purchase_unit");
    if (ings && ings.length > 0) {
      const sortedIngs = [...ings].sort((a, b) => String(b.name).length - String(a.name).length);
      for (const existing of ingExpenseRows) {
        const desc = String(existing.description);
        const matchedIng = sortedIngs.find((ing) => {
          const name = String(ing.name);
          return desc === `ซื้อ${name}` || desc.startsWith(`ซื้อ${name} `);
        });
        if (matchedIng) {
          let query = supabase
            .from("ingredient_purchases")
            .select("id")
            .eq("ingredient_id", String(matchedIng.id))
            .eq("purchased_at", existing.spent_at)
            .eq("price_satang", existing.amount_satang);

          if (existing.receipt_path) {
            query = query.eq("receipt_path", existing.receipt_path);
          } else {
            query = query.is("receipt_path", null);
          }

          const { data: ingPurchases } = await query
            .order("created_at", { ascending: true })
            .limit(1);
          if (ingPurchases && ingPurchases.length > 0) {
            await supabase
              .from("ingredient_purchases")
              .delete()
              .eq("id", String((ingPurchases[0] as { id: unknown }).id));
            if (String(matchedIng.costing) === "per_unit") {
              affectedPerUnitIngMap.set(
                String(matchedIng.id),
                Number(matchedIng.units_per_purchase_unit) || 1
              );
            }
          }
        }
      }
    }
  }

  // 3. Delete all selected expense rows in one query
  const { error } = await supabase.from("expenses").delete().in("id", uniqueIds);
  if (error) dbError(error);

  // 4. Remove storage files if no other expenses share their receipt_path
  if (!options?.keepStorageFiles) {
    for (const receiptPath of receiptPathsToCheck) {
      const { count } = await supabase
        .from("expenses")
        .select("id", { count: "exact", head: true })
        .eq("receipt_path", receiptPath);
      if (!count || count === 0) {
        await supabase.storage.from("sale-slips").remove([receiptPath]).catch(() => undefined);
      }
    }
  }

  // 5. Recompute packaging unit cost once per affected packaging item
  for (const packItemId of affectedPackagingItemIds) {
    const purchases = await readCostRows((from, to) => supabase.from("packaging_purchases")
      .select("id,price_satang,pack_quantity").eq("packaging_item_id", packItemId).order("id").range(from, to));
    if (purchases && purchases.length > 0) {
      let totalPrice = 0;
      let totalPieces = 0;
      for (const p of purchases as Array<{ price_satang: unknown; pack_quantity: unknown }>) {
        totalPrice += Number(p.price_satang);
        totalPieces += Number(p.pack_quantity);
      }
      if (totalPieces > 0) {
        const unitCost = roundCost(totalPrice / totalPieces);
        await supabase
          .from("packaging_items")
          .update({ unit_cost_satang: unitCost, updated_at: new Date().toISOString() })
          .eq("id", packItemId);
        await recalculateMenuCosts(supabase, await menusUsing(supabase, "packaging_item_id", packItemId));
      }
    }
  }

  // 6. Recompute per-unit ingredient cost once per affected per-unit ingredient
  for (const [ingId, unitsPerPurchaseUnit] of affectedPerUnitIngMap.entries()) {
    const purchases = await readCostRows((from, to) => supabase.from("ingredient_purchases")
      .select("id,purchased_at,price_satang,purchased_quantity").eq("ingredient_id", ingId).order("id").range(from, to));
    if (purchases && purchases.length > 0) {
      const mapped = (purchases as Array<{ purchased_at: unknown; price_satang: unknown; purchased_quantity: unknown }>).map((p) => ({
        purchasedAt: String(p.purchased_at),
        price: Number(p.price_satang),
        quantity: p.purchased_quantity === null ? null : Number(p.purchased_quantity),
      }));
      const pricePerUnit = roundCost(weightedPricePerUnit(mapped));
      const unitCost = roundCost(pricePerUnit / unitsPerPurchaseUnit);
      await supabase
        .from("ingredients")
        .update({
          price_per_purchase_unit_satang: pricePerUnit,
          weighted_unit_cost_satang: unitCost,
          updated_at: new Date().toISOString(),
        })
        .eq("id", ingId);
      await recalculateMenuCosts(supabase, await menusUsing(supabase, "ingredient_id", ingId));
    }
  }

  revalidateExpenses();
}

export async function deleteExpense(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const expenseId = id(form);
    await deleteExpensesByIds(supabase, user.id, [expenseId]);
  });
}

export async function deleteExpensesBulkAction(expenseIds: string[]): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    await deleteExpensesByIds(supabase, user.id, expenseIds);
    return { ok: true, message: `ลบ ${expenseIds.length} รายการเรียบร้อยแล้ว` };
  });
}

export type UpdateExpensePayload = {
  id: string;
  spentAt: string; // YYYY-MM-DD
  description: string;
  category: string;
  kind: ExpenseKind;
  amountSatang: number;
  payee?: string | null;
  paymentMethod: PaymentMethod;
};

/**
 * Updates an existing expense row and keeps any linked packaging_purchases / ingredient_purchases row in sync.
 */
export async function updateExpenseAction(payload: UpdateExpensePayload): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const expenseId = payload.id?.trim();
    if (!expenseId) throw new InputError("ไม่พบรหัสรายการค่าใช้จ่าย");
    const description = payload.description?.trim().slice(0, 200);
    if (!description) throw new InputError("กรุณากรอกรายละเอียด");
    const category = payload.category?.trim().slice(0, 60);
    if (!category) throw new InputError("กรุณากรอกหมวดหมู่");
    const kind: ExpenseKind = KINDS.includes(payload.kind) ? payload.kind : "operating";
    const paymentMethod: PaymentMethod = METHODS.includes(payload.paymentMethod) ? payload.paymentMethod : "transfer";
    const amountSatang = Math.round(Number(payload.amountSatang) || 0);
    if (amountSatang <= 0) throw new InputError("จำนวนเงินต้องมากกว่า 0");
    const payee = payload.payee?.trim() ? payload.payee.trim().slice(0, 120) : null;

    let spentAtDate: Date;
    try {
      spentAtDate = fromBangkokDateInput(payload.spentAt || bangkokDayKey(new Date()));
    } catch {
      throw new InputError("วันที่จ่ายไม่ถูกต้อง");
    }
    const spentAtIso = spentAtDate.toISOString();

    const { data: existing, error: readErr } = await supabase
      .from("expenses")
      .select("id, spent_at, category, amount_satang, description, receipt_path")
      .eq("id", expenseId)
      .maybeSingle();
    if (readErr) dbError(readErr);
    if (!existing) throw new InputError("ไม่พบรายการค่าใช้จ่ายที่ต้องการแก้ไข");

    // 1. Sync linked packaging_purchases if any
    const { data: linkedPacks } = await supabase
      .from("packaging_purchases")
      .select("id, packaging_item_id")
      .eq("expense_id", expenseId);

    if (linkedPacks && linkedPacks.length > 0) {
      const p = linkedPacks[0] as { id: unknown; packaging_item_id: unknown };
      const packItemId = String(p.packaging_item_id);
      await supabase
        .from("packaging_purchases")
        .update({
          purchased_at: spentAtIso,
          price_satang: amountSatang,
          vendor: payee,
        })
        .eq("id", String(p.id));

      const purchases = await readCostRows((from, to) => supabase.from("packaging_purchases")
      .select("id,price_satang,pack_quantity").eq("packaging_item_id", packItemId).order("id").range(from, to));
      if (purchases && purchases.length > 0) {
        let totalPrice = 0;
        let totalPieces = 0;
        for (const row of purchases as Array<{ price_satang: unknown; pack_quantity: unknown }>) {
          totalPrice += Number(row.price_satang);
          totalPieces += Number(row.pack_quantity);
        }
        if (totalPieces > 0) {
          const unitCost = roundCost(totalPrice / totalPieces);
          await supabase
            .from("packaging_items")
            .update({ unit_cost_satang: unitCost, updated_at: new Date().toISOString() })
            .eq("id", packItemId);
          await recalculateMenuCosts(supabase, await menusUsing(supabase, "packaging_item_id", packItemId));
        }
      }
    }

    // 2. Sync matching ingredient_purchases if any
    if (existing.category === "วัตถุดิบ" && String(existing.description ?? "").startsWith("ซื้อ")) {
      const oldDesc = String(existing.description);
      const { data: ings } = await supabase
        .from("ingredients")
        .select("id, name, costing, units_per_purchase_unit");
      if (ings && ings.length > 0) {
        const sortedIngs = [...ings].sort((a, b) => String(b.name).length - String(a.name).length);
        const matchedIng = sortedIngs.find((ing) => {
          const name = String(ing.name);
          return oldDesc === `ซื้อ${name}` || oldDesc.startsWith(`ซื้อ${name} `);
        });
        if (matchedIng) {
          let query = supabase
            .from("ingredient_purchases")
            .select("id")
            .eq("ingredient_id", String(matchedIng.id))
            .eq("purchased_at", existing.spent_at)
            .eq("price_satang", existing.amount_satang);

          if (existing.receipt_path) {
            query = query.eq("receipt_path", existing.receipt_path);
          }

          const { data: ingPurchases } = await query
            .order("created_at", { ascending: false })
            .limit(1);

          if (ingPurchases && ingPurchases.length > 0) {
            await supabase
              .from("ingredient_purchases")
              .update({
                purchased_at: spentAtIso,
                price_satang: amountSatang,
                vendor: payee,
              })
              .eq("id", String((ingPurchases[0] as { id: unknown }).id));

            if (String(matchedIng.costing) === "per_unit") {
              const ingId = String(matchedIng.id);
              const unitsPerPurchaseUnit = Number(matchedIng.units_per_purchase_unit) || 1;
              const purchases = await readCostRows((from, to) => supabase.from("ingredient_purchases")
      .select("id,purchased_at,price_satang,purchased_quantity").eq("ingredient_id", ingId).order("id").range(from, to));
              if (purchases && purchases.length > 0) {
                const mapped = (purchases as Array<{ purchased_at: unknown; price_satang: unknown; purchased_quantity: unknown }>).map((p) => ({
                  purchasedAt: String(p.purchased_at),
                  price: Number(p.price_satang),
                  quantity: p.purchased_quantity === null ? null : Number(p.purchased_quantity),
                }));
                const pricePerUnit = roundCost(weightedPricePerUnit(mapped));
                const unitCost = roundCost(pricePerUnit / unitsPerPurchaseUnit);
                await supabase
                  .from("ingredients")
                  .update({
                    price_per_purchase_unit_satang: pricePerUnit,
                    weighted_unit_cost_satang: unitCost,
                    updated_at: new Date().toISOString(),
                  })
                  .eq("id", ingId);
                await recalculateMenuCosts(supabase, await menusUsing(supabase, "ingredient_id", ingId));
              }
            }
          }
        }
      }
    }

    // 3. Update the expense row itself
    const { error: updateErr } = await supabase
      .from("expenses")
      .update({
        spent_at: spentAtIso,
        description,
        category,
        kind,
        amount_satang: amountSatang,
        payee,
        payment_method: paymentMethod,
        updated_at: new Date().toISOString(),
      })
      .eq("id", expenseId);
    if (updateErr) dbError(updateErr);

    revalidateExpenses();
    return { ok: true, message: "บันทึกการแก้ไขเรียบร้อยแล้ว" };
  });
}

/**
 * Replaces one or more existing expense rows (e.g. from the same slip) with a new itemized breakdown,
 * preserving the existing receipt_path in Supabase Storage.
 */
export async function replaceExpenseWithItemizedAction(
  expenseIdsToReplace: string[],
  payload: ItemizedPurchasePayload
): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const uniqueIds = Array.from(new Set(expenseIdsToReplace.map((x) => x.trim()).filter(Boolean)));
    if (uniqueIds.length === 0) throw new InputError("ไม่พบรายการเดิมที่ต้องการแก้ไข");

    // 1. Delete old rows while keeping the slip file in storage
    await deleteExpensesByIds(supabase, user.id, uniqueIds, { keepStorageFiles: true });

    // 2. Save the new itemized breakdown
    const res = await saveItemizedExpenseAction(payload);
    if (!res.ok) {
      throw new InputError(res.error ?? "บันทึกรายการใหม่ไม่สำเร็จ");
    }
    revalidateExpenses();
    return {
      ok: true,
      message: `อัปเดตรายการในสลิปใหม่เรียบร้อยแล้ว · ${res.message ?? ""}`,
    };
  });
}

/** Fixes the payment method of an existing expense, e.g. one saved as cash that was really a transfer. */
export async function setExpensePaymentMethod(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const paymentMethod = oneOf(form, "payment_method", METHODS, "วิธีชำระ");
    const { error } = await supabase.from("expenses")
      .update({ payment_method: paymentMethod, updated_at: new Date().toISOString() })
      .eq("id", id(form));
    if (error) dbError(error);
    revalidateExpenses();
    revalidatePath("/bank-check");
    return { ok: true, message: "เปลี่ยนวิธีชำระแล้ว" };
  });
}
