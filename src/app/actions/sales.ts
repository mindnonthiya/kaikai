"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { invalidateQueryCache } from "@/lib/data/queries";
import { InputError, dbError, id, runAction } from "@/lib/server-action";

/** Cancels a confirmed sale. The row is kept (with cancelled_at) so history and audit stay intact. */
export async function cancelSale(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const saleId = id(form);
    const now = new Date().toISOString();
    const { data, error } = await supabase.from("sales")
      .update({ status: "cancelled", cancelled_at: now, updated_at: now })
      .eq("id", saleId).eq("status", "confirmed")
      .select("id,net_revenue_satang");
    if (error) dbError(error);
    if (!data?.length) throw new InputError("รายการนี้ถูกยกเลิกไปแล้ว หรือไม่พบรายการ");
    await supabase.from("audit_logs").insert({ owner_id: user.id, entity_type: "sale", entity_id: saleId, action: "cancelled", new_data: { cancelled_at: now } });
    invalidateQueryCache("pooled_rate");
    revalidatePath("/sales");
    revalidatePath("/dashboard");
    revalidatePath("/reports");
    return { ok: true, message: "ยกเลิกรายการแล้ว" };
  });
}

/** Re-labels a sale's cash/other payments as transfer — for bills recorded with the wrong method. */
export async function markSalePaidByTransfer(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const saleId = id(form);
    const { data, error } = await supabase.from("payments")
      .update({ method: "transfer" })
      .eq("sale_id", saleId).neq("method", "transfer")
      .select("id");
    if (error) dbError(error);
    if (!data?.length) throw new InputError("บิลนี้เป็นเงินโอนอยู่แล้ว");
    await supabase.from("audit_logs").insert({ owner_id: user.id, entity_type: "sale", entity_id: saleId, action: "payment_method_changed", new_data: { method: "transfer" } });
    revalidatePath("/sales");
    revalidatePath("/dashboard");
    revalidatePath("/reports");
    revalidatePath("/bank-check");
    return { ok: true, message: "เปลี่ยนเป็นเงินโอนแล้ว" };
  });
}
