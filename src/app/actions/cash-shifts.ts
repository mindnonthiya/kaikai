"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { filterExpenses, filterSales, summarize } from "@/lib/analytics";
import { fetchExpenses, fetchSales, invalidateQueryCache } from "@/lib/data/queries";
import type { CashBreakdown } from "@/lib/data/types";
import { formatBaht } from "@/lib/money";
import { dateField, dbError, id, money, optionalText, runAction } from "@/lib/server-action";
import { DAY_MS, bangkokDayKey, startOfBangkokDay } from "@/lib/time";

function revalidateCashDrawer() {
  invalidateQueryCache("cash_shifts");
  revalidatePath("/cash-drawer");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
}

function parseBreakdown(form: FormData): { breakdown: CashBreakdown; totalSatang: number } | null {
  const b1000 = Math.max(0, parseInt(String(form.get("count_1000") ?? "0"), 10) || 0);
  const b500 = Math.max(0, parseInt(String(form.get("count_500") ?? "0"), 10) || 0);
  const b100 = Math.max(0, parseInt(String(form.get("count_100") ?? "0"), 10) || 0);
  const b50 = Math.max(0, parseInt(String(form.get("count_50") ?? "0"), 10) || 0);
  const b20 = Math.max(0, parseInt(String(form.get("count_20") ?? "0"), 10) || 0);
  const c10 = Math.max(0, parseInt(String(form.get("count_10") ?? "0"), 10) || 0);
  const c5 = Math.max(0, parseInt(String(form.get("count_5") ?? "0"), 10) || 0);
  const c2 = Math.max(0, parseInt(String(form.get("count_2") ?? "0"), 10) || 0);
  const c1 = Math.max(0, parseInt(String(form.get("count_1") ?? "0"), 10) || 0);

  const hasAny = b1000 || b500 || b100 || b50 || b20 || c10 || c5 || c2 || c1;
  if (!hasAny) return null;

  const totalBaht =
    b1000 * 1000 +
    b500 * 500 +
    b100 * 100 +
    b50 * 50 +
    b20 * 20 +
    c10 * 10 +
    c5 * 5 +
    c2 * 2 +
    c1 * 1;

  return {
    breakdown: { b1000, b500, b100, b50, b20, c10, c5, c2, c1 },
    totalSatang: totalBaht * 100,
  };
}

export async function openCashShift(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const openingCash = money(form, "opening_cash", "เงินทอนเริ่มต้น");
    const notes = optionalText(form, "notes", "หมายเหตุ", 300);
    const dateInput = dateField(form, "shift_date", "วันที่เปิดกะ");
    const shiftDate = bangkokDayKey(dateInput);

    // If an open shift exists for today, update its opening cash
    const { data: existing } = await supabase
      .from("cash_shifts")
      .select("id")
      .eq("owner_id", user.id)
      .eq("status", "open")
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      const { error } = await supabase
        .from("cash_shifts")
        .update({
          opening_cash_satang: openingCash,
          notes,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      if (error) dbError(error);
      revalidateCashDrawer();
      return { ok: true, message: `อัปเดตเงินทอนเริ่มต้นเป็น ${formatBaht(openingCash)} เรียบร้อยแล้ว` };
    }

    const { error } = await supabase.from("cash_shifts").insert({
      owner_id: user.id,
      shift_date: shiftDate,
      opened_at: new Date().toISOString(),
      opening_cash_satang: openingCash,
      status: "open",
      notes,
    });
    if (error) dbError(error);
    revalidateCashDrawer();
    return { ok: true, message: `เปิดกะเรียบร้อย บันทึกเงินทอนเริ่มต้น ${formatBaht(openingCash)}` };
  });
}

export async function closeCashShift(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const shiftId = form.get("id") ? id(form, "id") : null;
    let actualCash = money(form, "actual_cash", "เงินสดที่นับได้จริง");
    const notes = optionalText(form, "notes", "หมายเหตุ", 300);

    const breakdownResult = parseBreakdown(form);
    if (breakdownResult && (!actualCash || form.get("use_breakdown") === "true")) {
      actualCash = breakdownResult.totalSatang;
    }

    // Find shift
    let shiftRow: Record<string, unknown> | null = null;
    if (shiftId) {
      const { data } = await supabase.from("cash_shifts").select("*").eq("id", shiftId).maybeSingle();
      shiftRow = data as Record<string, unknown> | null;
    } else {
      const { data } = await supabase
        .from("cash_shifts")
        .select("*")
        .eq("owner_id", user.id)
        .eq("status", "open")
        .order("opened_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      shiftRow = data as Record<string, unknown> | null;
    }

    const now = new Date();
    const targetDate = shiftRow?.shift_date ? new Date(String(shiftRow.shift_date)) : now;
    const dayStart = startOfBangkokDay(targetDate);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);

    const [sales, expenses] = await Promise.all([
      fetchSales(dayStart, dayEnd),
      fetchExpenses(dayStart, dayEnd),
    ]);
    const summary = summarize(filterSales(sales, dayStart, dayEnd), filterExpenses(expenses, dayStart, dayEnd));

    const openingCash = shiftRow ? Number(shiftRow.opening_cash_satang) : money(form, "opening_cash", "เงินทอนเริ่มต้น");
    const cashSales = summary.payments.cash;
    const cashExpenses = summary.expensePayments.cash;
    const expectedCash = openingCash + cashSales - cashExpenses;
    const difference = actualCash - expectedCash;

    if (shiftRow) {
      const { error } = await supabase
        .from("cash_shifts")
        .update({
          closed_at: now.toISOString(),
          cash_sales_satang: cashSales,
          cash_expenses_satang: cashExpenses,
          expected_cash_satang: expectedCash,
          actual_cash_satang: actualCash,
          difference_satang: difference,
          status: "closed",
          notes,
          cash_breakdown: breakdownResult?.breakdown ?? null,
          updated_at: now.toISOString(),
        })
        .eq("id", shiftRow.id);
      if (error) dbError(error);
    } else {
      const { error } = await supabase.from("cash_shifts").insert({
        owner_id: user.id,
        shift_date: bangkokDayKey(targetDate),
        opened_at: dayStart.toISOString(),
        closed_at: now.toISOString(),
        opening_cash_satang: openingCash,
        cash_sales_satang: cashSales,
        cash_expenses_satang: cashExpenses,
        expected_cash_satang: expectedCash,
        actual_cash_satang: actualCash,
        difference_satang: difference,
        status: "closed",
        notes,
        cash_breakdown: breakdownResult?.breakdown ?? null,
      });
      if (error) dbError(error);
    }

    revalidateCashDrawer();

    if (difference === 0) {
      return { ok: true, message: `ปิดกะเรียบร้อย เงินสดในเก๊ะครบถ้วนพอดีเป๊ะ (${formatBaht(actualCash)})` };
    }
    if (difference < 0) {
      return {
        ok: true,
        message: `ปิดกะเรียบร้อย เงินสดขาดไป ${formatBaht(Math.abs(difference))} (ควรมี ${formatBaht(expectedCash)} แต่นับได้ ${formatBaht(actualCash)})`,
      };
    }
    return {
      ok: true,
      message: `ปิดกะเรียบร้อย เงินสดเกินมา ${formatBaht(difference)} (ควรมี ${formatBaht(expectedCash)} แต่นับได้ ${formatBaht(actualCash)})`,
    };
  });
}

export async function deleteCashShift(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const shiftId = id(form, "id");
    const { error } = await supabase.from("cash_shifts").delete().eq("id", shiftId);
    if (error) dbError(error);
    revalidateCashDrawer();
    return { ok: true, message: "ลบรายการตรวจนับเงินสดเรียบร้อยแล้ว" };
  });
}
