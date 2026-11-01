import Link from "next/link";
import { PageTitle } from "@/components/page-title";
import { RangeTabs } from "@/components/range-tabs";
import { ActionButton } from "@/components/action-form";
import { ExpenseReceiptButton } from "@/components/expense-receipt-button";
import { cancelSale } from "@/app/actions/sales";
import { syncHistoricalSalesCosts } from "@/app/actions/settings";
import { summarize } from "@/lib/analytics";
import { fetchSaleSettings, fetchSales } from "@/lib/data/queries";
import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS, isDishCategory, type SaleRecord } from "@/lib/data/types";
import { customerAmountDue, formatBaht } from "@/lib/money";
import { formatThaiShortDate, formatTime, parseRange, resolveRange } from "@/lib/time";

const RANGES = ["today", "7d", "month", "last-month", "all"] as const;

function statusBadge(sale: SaleRecord) {
  if (sale.status === "cancelled") return <span className="status muted">ยกเลิกแล้ว</span>;
  if (sale.status === "refunded") return <span className="status muted">คืนเงินแล้ว</span>;
  return <span className={`status ${sale.paymentStatus === "paid" ? "success" : "pending"}`}>{PAYMENT_STATUS_LABELS[sale.paymentStatus]}</span>;
}

export default async function SalesPage({ searchParams }: { searchParams: Promise<{ range?: string; q?: string }> }) {
  const params = await searchParams;
  const key = parseRange(params.range, [...RANGES], "7d");
  const q = (params.q ?? "").trim();
  const saleSettings = await fetchSaleSettings();
  const range = resolveRange(key, new Date(), saleSettings.dayStartHour);
  const all = await fetchSales(range.start, range.end);
  const uncalculatedCount = all.filter((s) => s.status === "confirmed" && s.cogs === 0 && s.items.some(i => isDishCategory(i.category, i.name))).length;
  const needle = q.toLowerCase().replace(/^#/, "");
  const sales = needle
    ? all.filter((s) => String(s.saleNumber) === needle || (s.customerName ?? "").toLowerCase().includes(needle) || s.items.some((i) => i.name.toLowerCase().includes(needle)))
    : all;
  const total = summarize(sales, []);

  return <>
    <PageTitle eyebrow="รายการทั้งหมด" title="ประวัติการขาย" description="ตรวจสอบรายการ สถานะการรับเงิน และยกเลิกรายการที่บันทึกผิด" action={<Link className="primary-button" href="/sales/new">+ เปิดบิล</Link>} />
    <RangeTabs basePath="/sales" options={[...RANGES]} active={key} extraParams={{ q }} />
    {uncalculatedCount > 0 && (
      <div className="warning-card" style={{ marginBottom: 16 }}>
        <div>
          <strong>พบ {uncalculatedCount} ออเดอร์ที่มีเมนูอาหารแต่ต้นทุนเป็นศูนย์</strong>
          <p>ตรวจสูตรก่อนคำนวณ หากมีต้นทุนจริงแต่ยังไม่ได้ระบุ กำไรจะสูงเกินจริง</p>
        </div>
        <ActionButton
          action={syncHistoricalSalesCosts}
          fields={{ force_all: "true" }}
          label="คำนวณต้นทุนให้ออเดอร์เก่าทันที"
          pendingLabel="กำลังคำนวณ…"
          className="primary-button"
        />
      </div>
    )}
    <section className="panel table-panel">
      <form className="table-toolbar" action="/sales">
        <input type="hidden" name="range" value={key} />
        <input id="sales-search" className="search-box" name="q" defaultValue={q} placeholder="ค้นหาเลขที่ ชื่อลูกค้า หรือชื่อเมนู…" />
        <button className="secondary-button">ค้นหา</button>
        {q && <Link className="link-button" href={`/sales?range=${key}`}>ล้าง</Link>}
      </form>
      <div className="table-summary" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
        <span>
          {total.saleCount.toLocaleString("th-TH")} รายการ · ยอดขาย {formatBaht(total.revenue)} · กำไรขั้นต้น {formatBaht(total.grossProfit)}
          {total.tipIncome > 0 ? ` · ทิปรวม +${formatBaht(total.tipIncome)}` : ""}
          {sales.length !== total.saleCount ? ` · ยกเลิก ${sales.length - total.saleCount} รายการ` : ""}
        </span>
        <ActionButton
          action={syncHistoricalSalesCosts}
          fields={{ force_all: "true" }}
          label="คำนวณต้นทุนทุกออเดอร์ใหม่ตามสูตรปัจจุบัน"
          pendingLabel="กำลังคำนวณ…"
          className="link-button"
        />
      </div>
      <table className="data-table">
        <thead><tr><th>เวลา / เลขที่</th><th>ลูกค้า</th><th>รายการ</th><th>ชำระด้วย / สลิป</th><th>สถานะ</th><th className="num">ยอดรวม</th><th className="num">กำไรขั้นต้น</th><th /></tr></thead>
        <tbody>
          {sales.map((sale) => <tr key={sale.id} className={sale.status === "cancelled" ? "row-muted" : undefined}>
            <td><strong>{formatTime(sale.soldAt)}</strong> <small className="muted">{formatThaiShortDate(sale.soldAt)}</small><br />#{sale.saleNumber}</td>
            <td>{sale.customerName ?? "ลูกค้าทั่วไป"}</td>
            <td>{sale.items.map((i) => `${i.name} ×${i.quantity}`).join(" · ")}
              {(sale.fulfillment === "delivery" || sale.packagingCost > 0 || (sale.tip !== undefined && sale.tip > 0)) && (
                <>
                  <br />
                  <small className="muted">
                    {sale.fulfillment === "delivery" ? `ส่ง ${formatBaht(sale.delivery)}` : "รับเอง"}
                    {sale.packagingCost > 0 ? ` · บรรจุภัณฑ์ ${formatBaht(sale.packagingCost)}` : ""}
                    {sale.tip !== undefined && sale.tip > 0 ? ` · ทิป/โอนเกิน +${formatBaht(sale.tip)}` : ""}
                  </small>
                </>
              )}
            </td>
            <td>
              {sale.payments.length ? [...new Set(sale.payments.map((p) => PAYMENT_METHOD_LABELS[p.method]))].join(", ") : "—"}
              {sale.slipPath && (
                <>
                  <br />
                  <ExpenseReceiptButton receiptPath={sale.slipPath} modalTitle={`สลิปบิล #${sale.saleNumber}`} />
                </>
              )}
            </td>
            <td>{statusBadge(sale)}</td>
            <td className="num"><strong>{formatBaht(customerAmountDue(sale))}</strong>
              {sale.fee > 0 && <><br /><small className="muted">หักค่าธรรมเนียม {formatBaht(sale.fee)} · สุทธิ {formatBaht(sale.netRevenue)}</small></>}
              {sale.discount > 0 && <><br /><small className="muted">ส่วนลด {formatBaht(sale.discount)}</small></>}
            </td>
            <td className="num">{formatBaht(sale.netRevenue - sale.cogs)}<br /><small className="muted">ต้นทุน {formatBaht(sale.cogs)}</small></td>
            <td className="num">{sale.status === "confirmed" && <ActionButton action={cancelSale} fields={{ id: sale.id }} label="ยกเลิก" pendingLabel="กำลังยกเลิก…" confirmText={`ยกเลิกรายการ #${sale.saleNumber} ยอด ${formatBaht(sale.netRevenue)}?\nรายการจะไม่ถูกนับในยอดขายและกำไรอีก`} className="link-button danger" />}</td>
          </tr>)}
          {!sales.length && <tr><td colSpan={8}><div className="empty-state">{q ? `ไม่พบรายการที่ตรงกับ “${q}”` : "ยังไม่มีรายการขายในช่วงนี้"}</div></td></tr>}
        </tbody>
      </table>
    </section>
  </>;
}
