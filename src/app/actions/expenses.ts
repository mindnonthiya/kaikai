"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { weightedPricePerUnit } from "@/lib/analytics";
import { invalidateQueryCache } from "@/lib/data/queries";
import { syncHistoricalCosts } from "@/lib/historical-cost-sync";
import { menusUsing, recalculateMenuCosts } from "@/lib/menu-cost";
import { dateField, dbError, id, money, oneOf, optionalText, runAction, text } from "@/lib/server-action";

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

export async function deleteExpense(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const expenseId = id(form);
    const { data: existing } = await supabase
      .from("expenses")
      .select("id, spent_at, category, amount_satang, description, receipt_path")
      .eq("id", expenseId)
      .maybeSingle();

    const affectedPackagingItemIds = new Set<string>();
    const affectedPerUnitIngs: Array<{ id: string; units_per_purchase_unit: number }> = [];
    let didDeletePurchase = false;

    // 1. Clean up linked packaging_purchases row if this expense came from a packaging purchase
    const { data: linkedPacks } = await supabase
      .from("packaging_purchases")
      .select("id, packaging_item_id")
      .eq("expense_id", expenseId);

    if (linkedPacks && linkedPacks.length > 0) {
      for (const p of linkedPacks) {
        affectedPackagingItemIds.add(String((p as { packaging_item_id: unknown }).packaging_item_id));
      }
      await supabase
        .from("packaging_purchases")
        .delete()
        .in("id", linkedPacks.map((p) => String((p as { id: unknown }).id)));
      didDeletePurchase = true;
    } else if (existing && existing.category === "บรรจุภัณฑ์") {
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
        didDeletePurchase = true;
      }
    }

    // 2. Clean up matching ingredient_purchases row if this expense came from an ingredient purchase
    if (existing && existing.category === "วัตถุดิบ" && String(existing.description ?? "").startsWith("ซื้อ")) {
      const desc = String(existing.description);
      const { data: ings } = await supabase
        .from("ingredients")
        .select("id, name, costing, units_per_purchase_unit");
      if (ings && ings.length > 0) {
        const sortedIngs = [...ings].sort((a, b) => String(b.name).length - String(a.name).length);
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
            didDeletePurchase = true;
            if (String(matchedIng.costing) === "per_unit") {
              affectedPerUnitIngs.push({
                id: String(matchedIng.id),
                units_per_purchase_unit: Number(matchedIng.units_per_purchase_unit) || 1,
              });
            }
          }
        }
      }
    }

    // 3. Delete the expense row itself
    const { error } = await supabase.from("expenses").delete().eq("id", expenseId);
    if (error) dbError(error);

    // 4. Remove storage file if no other expenses share this receipt_path
    const receiptPath = existing && typeof (existing as { receipt_path?: unknown }).receipt_path === "string"
      ? (existing as { receipt_path: string }).receipt_path
      : null;
    if (receiptPath) {
      const { count } = await supabase
        .from("expenses")
        .select("id", { count: "exact", head: true })
        .eq("receipt_path", receiptPath);
      if (!count || count === 0) {
        await supabase.storage.from("sale-slips").remove([receiptPath]).catch(() => undefined);
      }
    }

    // 5. Recompute packaging unit cost for any affected packaging items that still have purchase history
    for (const packItemId of affectedPackagingItemIds) {
      const { data: purchases } = await supabase
        .from("packaging_purchases")
        .select("price_satang, pack_quantity")
        .eq("packaging_item_id", packItemId);
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

    // 6. Recompute per-unit ingredient cost for any affected per-unit ingredients that still have purchase history
    for (const ing of affectedPerUnitIngs) {
      const { data: purchases } = await supabase
        .from("ingredient_purchases")
        .select("purchased_at, price_satang, purchased_quantity")
        .eq("ingredient_id", ing.id)
        .order("purchased_at", { ascending: false })
        .limit(200);
      if (purchases && purchases.length > 0) {
        const mapped = (purchases as Array<{ purchased_at: unknown; price_satang: unknown; purchased_quantity: unknown }>).map((p) => ({
          purchasedAt: String(p.purchased_at),
          price: Number(p.price_satang),
          quantity: p.purchased_quantity === null ? null : Number(p.purchased_quantity),
        }));
        const pricePerUnit = roundCost(weightedPricePerUnit(mapped));
        const unitCost = roundCost(pricePerUnit / ing.units_per_purchase_unit);
        await supabase
          .from("ingredients")
          .update({
            price_per_purchase_unit_satang: pricePerUnit,
            weighted_unit_cost_satang: unitCost,
            updated_at: new Date().toISOString(),
          })
          .eq("id", ing.id);
        await recalculateMenuCosts(supabase, await menusUsing(supabase, "ingredient_id", ing.id));
      }
    }

    if (didDeletePurchase) {
      await syncHistoricalCosts(supabase, { ownerId: user.id }).catch(() => undefined);
    }

    revalidateExpenses();
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
