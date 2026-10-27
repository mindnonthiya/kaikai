import Link from "next/link";
import { UploadCloud, WalletCards } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { StatCard } from "@/components/stat-card";
import { RangeTabs } from "@/components/range-tabs";
import { ActionButton } from "@/components/action-form";
import { ExpenseFormWithSlip } from "@/components/expense-form-with-slip";
import { ExpenseReceiptButton } from "@/components/expense-receipt-button";
import { deleteExpense } from "@/app/actions/expenses";
import { isOperatingExpense } from "@/lib/analytics";
import { fetchExpenses, fetchSaleSettings } from "@/lib/data/queries";
import { EXPENSE_KIND_LABELS, FUEL_CATEGORY, PAYMENT_METHOD_LABELS } from "@/lib/data/types";
import { formatBaht } from "@/lib/money";
import { bangkokDayKey, formatThaiShortDate, parseRange, resolveRange } from "@/lib/time";

const RANGES = ["today", "7d", "month", "last-month"] as const;
const CATEGORIES = [FUEL_CATEGORY, "ค่าแก๊ส", "ค่าไฟ", "ค่าน้ำ", "บรรจุภัณฑ์", "ค่าเช่า", "ค่าแรง", "การตลาด", "อุปกรณ์", "อื่น ๆ"];

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ range?: string; q?: string }> }) {
  const params = await searchParams;
  const key = parseRange(params.range, [...RANGES], "month");
  const q = (params.q ?? "").trim();
  const saleSettings = await fetchSaleSettings();
  const range = resolveRange(key, new Date(), saleSettings.dayStartHour);
  const all = await fetchExpenses(range.start, range.end);
  const needle = q.toLowerCase();
  const expenses = needle ? all.filter((e) => [e.description, e.category, e.payee ?? ""].some((v) => v.toLowerCase().includes(needle))) : all;
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  const operating = expenses.filter(isOperatingExpense).reduce((s, e) => s + e.amount, 0);
  const direct = total - operating;
  const now = new Date();
  const today = bangkokDayKey(now, saleSettings.dayStartHour);
  const maxDate = bangkokDayKey(now);

  return <>
    <PageTitle
      eyebrow="เงินออก"
      title="ค่าใช้จ่าย"
      description="แยกต้นทุนสินค้าและค่าใช้จ่ายดำเนินงานอย่างชัดเจน พร้อมแนบสลิปอ่านยอดอัตโนมัติ"
      action={
        <Link className="secondary-button" href="/expenses/import-slips">
          <UploadCloud size={17} /> นำเข้าสลิปเป็นชุด
        </Link>
      }
    />
    <div className="sales-mode-bar" style={{ marginBottom: "14px" }}>
      <div className="sales-mode-tabs">
        <span className="sales-mode-tab active">รายการและบันทึกเดี่ยว</span>
        <Link href="/expenses/import-slips" className="sales-mode-tab">
          นำเข้าสลิปค่าใช้จ่ายเป็นชุด
        </Link>
      </div>
    </div>
    <details className="panel form-panel">
      <summary><WalletCards size={18} /> เพิ่มค่าใช้จ่าย (แนบสลิปอ่านยอดอัตโนมัติได้)</summary>
      <ExpenseFormWithSlip today={today} maxDate={maxDate} categories={CATEGORIES} />
      <datalist id="expense-categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
    </details>
    <RangeTabs basePath="/expenses" options={[...RANGES]} active={key} extraParams={{ q }} />
    <div className="stat-grid main-stats expense-stats">
      <StatCard label={`รวม${range.label}`} value={formatBaht(total)} detail={`${expenses.length} รายการ`} tone="amber" />
      <StatCard label="หักจากกำไร" value={formatBaht(operating)} detail="ดำเนินงาน · ประจำ · ครั้งเดียว" />
      <StatCard label="ต้นทุนโดยตรง" value={formatBaht(direct)} detail="รวมอยู่ในต้นทุนเมนูแล้ว ไม่หักซ้ำ" />
    </div>
    <section className="panel table-panel spaced">
      <form className="table-toolbar" action="/expenses">
        <input type="hidden" name="range" value={key} />
        <input id="expense-search" className="search-box" name="q" defaultValue={q} placeholder="ค้นหารายละเอียด หมวดหมู่ หรือผู้รับเงิน…" />
        <button className="secondary-button">ค้นหา</button>
        {q && <Link className="link-button" href={`/expenses?range=${key}`}>ล้าง</Link>}
      </form>
      <table className="data-table">
        <thead><tr><th>วันที่</th><th>รายละเอียด</th><th>ประเภท</th><th>ผู้รับเงิน</th><th>วิธีชำระ / สลิป</th><th className="num">จำนวน</th><th /></tr></thead>
        <tbody>
          {expenses.map((e) => <tr key={e.id}>
            <td>{formatThaiShortDate(e.spentAt)}</td>
            <td><strong>{e.description}</strong><br /><small className="muted">{e.category}</small></td>
            <td><span className={`status ${e.kind === "direct" ? "muted" : "pending"}`}>{EXPENSE_KIND_LABELS[e.kind]}</span></td>
            <td>{e.payee ?? "—"}</td>
            <td>
              {e.paymentMethod ? PAYMENT_METHOD_LABELS[e.paymentMethod] : "—"}
              {e.receiptPath && (
                <>
                  <br />
                  <ExpenseReceiptButton receiptPath={e.receiptPath} />
                </>
              )}
            </td>
            <td className="num"><strong>{formatBaht(e.amount)}</strong></td>
            <td className="num"><ActionButton action={deleteExpense} fields={{ id: e.id }} label="ลบ" confirmText={`ลบ “${e.description}” ${formatBaht(e.amount)}?`} className="link-button danger" /></td>
          </tr>)}
          {!expenses.length && <tr><td colSpan={7}><div className="empty-state">{q ? `ไม่พบรายการที่ตรงกับ “${q}”` : "ยังไม่มีค่าใช้จ่ายในช่วงนี้"}</div></td></tr>}
        </tbody>
      </table>
    </section>
  </>;
}
