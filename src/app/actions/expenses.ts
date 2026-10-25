"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { invalidateQueryCache } from "@/lib/data/queries";
import { dateField, dbError, id, money, oneOf, optionalText, runAction, text } from "@/lib/server-action";

const KINDS = ["direct", "operating", "one_time", "recurring"] as const;
const METHODS = ["cash", "transfer", "other"] as const;

function revalidateExpenses() {
  invalidateQueryCache("pooled_rate");
  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
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
    const { error } = await supabase.from("expenses").insert({
      owner_id: user.id, spent_at: spentAt.toISOString(), description, category, kind, amount_satang: amount, payee, payment_method: paymentMethod,
    });
    if (error) dbError(error);
    revalidateExpenses();
    return { ok: true, message: "บันทึกค่าใช้จ่ายแล้ว" };
  });
}

export async function deleteExpense(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const { error } = await supabase.from("expenses").delete().eq("id", id(form));
    if (error) dbError(error);
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
