"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { invalidateQueryCache } from "@/lib/data/queries";
import { InputError, dbError, id, runAction } from "@/lib/server-action";

/** Invalidates server-side sales & pooled-rate cache after client-side RPC sale creation. */
export async function revalidateSalesAction(): Promise<void> {
  invalidateQueryCache("pooled_rate");
  invalidateQueryCache("all_time");
  revalidatePath("/sales");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  revalidatePath("/bank-check");
}

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

    // Release slip file hashes & reference numbers on cancelled bills so the same slip can be re-recorded
    // while keeping storage_path intact for viewing on the cancelled record.
    const { data: attachedSlips } = await supabase
      .from("slip_uploads")
      .select("id, file_hash_sha256")
      .eq("sale_id", saleId);
    if (attachedSlips && attachedSlips.length > 0) {
      await Promise.all(
        attachedSlips.map((slip, idx) =>
          supabase
            .from("slip_uploads")
            .update({
              file_hash_sha256: `${String(slip.file_hash_sha256 ?? "")}#cancelled#${saleId.slice(0, 8)}#${idx}`,
              ocr_reference_number: null,
            })
            .eq("id", slip.id)
        )
      );
    }
    await supabase.from("payments").update({ reference_number: null }).eq("sale_id", saleId);

    await supabase.from("audit_logs").insert({ owner_id: user.id, entity_type: "sale", entity_id: saleId, action: "cancelled", new_data: { cancelled_at: now } });
    invalidateQueryCache("pooled_rate");
    invalidateQueryCache("all_time");
    revalidatePath("/sales");
    revalidatePath("/dashboard");
    revalidatePath("/reports");
    revalidatePath("/bank-check");
    return { ok: true, message: "ยกเลิกรายการแล้ว (ปลดล็อกสลิปให้ใช้ซ้ำได้)" };
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

/** Marks an unpaid or partially paid sale as fully paid by recording the remaining customer-due balance. */
export async function markSalePaid(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const saleId = id(form);
    const rawMethod = String(form.get("method") ?? "").trim() || "transfer";
    const method = rawMethod === "cash" || rawMethod === "other" ? rawMethod : "transfer";
    const now = new Date().toISOString();

    const { data: sale, error: saleErr } = await supabase
      .from("sales")
      .select("id, net_revenue_satang, payment_fee_satang, payment_status, status, payments(amount_satang)")
      .eq("id", saleId)
      .maybeSingle();
    if (saleErr) dbError(saleErr);
    if (!sale || sale.status !== "confirmed") {
      throw new InputError("ไม่พบบิลที่ต้องการรับชำระ");
    }
    if (sale.payment_status === "paid") {
      throw new InputError("บิลนี้รับชำระครบแล้ว");
    }

    const existingPayments = Array.isArray(sale.payments) ? sale.payments : [];
    const alreadyPaid = existingPayments.reduce((sum, p) => sum + Number((p as { amount_satang?: number }).amount_satang ?? 0), 0);
    const customerDue = Number(sale.net_revenue_satang ?? 0) + Number(sale.payment_fee_satang ?? 0);
    const remaining = Math.max(0, customerDue - alreadyPaid);

    if (remaining > 0) {
      const { error: payErr } = await supabase.from("payments").insert({
        sale_id: saleId,
        owner_id: user.id,
        method,
        amount_satang: remaining,
        paid_at: now,
      });
      if (payErr) dbError(payErr);
    }

    const { error: updateErr } = await supabase
      .from("sales")
      .update({ payment_status: "paid", updated_at: now })
      .eq("id", saleId);
    if (updateErr) dbError(updateErr);

    await supabase.from("audit_logs").insert({
      owner_id: user.id,
      entity_type: "sale",
      entity_id: saleId,
      action: "payment_settled",
      new_data: { method, amount_satang: remaining, settled_at: now },
    });

    invalidateQueryCache("all_time");
    revalidatePath("/sales");
    revalidatePath("/dashboard");
    revalidatePath("/reports");
    revalidatePath("/bank-check");
    return { ok: true, message: "บันทึกการรับเงินครบถ้วนแล้ว" };
  });
}
