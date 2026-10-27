import { hasSupabaseEnv } from "@/lib/env";
import { fetchSaleSettings, fetchSales } from "@/lib/data/queries";
import { FULFILLMENT_LABELS, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS, isAddonCategory } from "@/lib/data/types";
import { satangToBahtInput } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { formatThaiDateTime, parseRange, resolveRange } from "@/lib/time";

export const dynamic = "force-dynamic";

const STATUS_LABELS = { confirmed: "ยืนยันแล้ว", cancelled: "ยกเลิก", refunded: "คืนเงิน", draft: "ร่าง" } as const;

/** Quotes a CSV cell and neutralises spreadsheet formulas (=, +, -, @) from user-entered text. */
function cell(value: string | number) {
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET(request: Request) {
  // Middleware already blocks signed-out users; this is a second check because the file holds sales data.
  if (hasSupabaseEnv) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return Response.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  }
  const key = parseRange(new URL(request.url).searchParams.get("range") ?? undefined, ["today", "7d", "month", "last-month"], "month");
  const saleSettings = await fetchSaleSettings();
  const range = resolveRange(key, new Date(), saleSettings.dayStartHour);
  const sales = await fetchSales(range.start, range.end);

  const headers = ["เลขที่", "วันเวลา", "ลูกค้า", "รายการ", "จำนวนกล่อง", "รับเอง/ส่ง", "ช่องทางชำระ", "สถานะรายการ", "สถานะชำระ", "ยอดสินค้า (บาท)", "ส่วนลด (บาท)", "ค่าส่ง (บาท)", "ค่าธรรมเนียม (บาท)", "ยอดสุทธิ (บาท)", "ต้นทุน (บาท)", "ต้นทุนบรรจุภัณฑ์ (บาท)", "กำไรขั้นต้น (บาท)"];
  const rows = [...sales].reverse().map((s) => [
    s.saleNumber, formatThaiDateTime(s.soldAt), s.customerName ?? "", s.items.map((i) => `${i.name} x${i.quantity}`).join(", "),
    s.items.filter((i) => !isAddonCategory(i.category)).reduce((n, i) => n + i.quantity, 0),
    FULFILLMENT_LABELS[s.fulfillment],
    [...new Set(s.payments.map((p) => PAYMENT_METHOD_LABELS[p.method]))].join(", "),
    STATUS_LABELS[s.status], PAYMENT_STATUS_LABELS[s.paymentStatus],
    satangToBahtInput(s.productRevenue), satangToBahtInput(s.discount), satangToBahtInput(s.delivery), satangToBahtInput(s.fee),
    satangToBahtInput(s.netRevenue), satangToBahtInput(s.cogs), satangToBahtInput(s.packagingCost), satangToBahtInput(s.grossProfit),
  ]);
  // BOM so Excel opens Thai text as UTF-8.
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n")}`;
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename=kaikai-sales-${key}.csv`,
      "cache-control": "no-store",
    },
  });
}
