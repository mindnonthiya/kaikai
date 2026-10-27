import Link from "next/link";
import { WalletCards } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { StatCard } from "@/components/stat-card";
import { RangeTabs } from "@/components/range-tabs";
import { ActionButton, ActionForm } from "@/components/action-form";
import { deleteExpense, saveExpense } from "@/app/actions/expenses";
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
    <PageTitle eyebrow="เงินออก" title="ค่าใช้จ่าย" description="แยกต้นทุนสินค้าและค่าใช้จ่ายดำเนินงานอย่างชัดเจน" />
    <details className="panel form-panel">
      <summary><WalletCards size={18} /> เพิ่มค่าใช้จ่าย</summary>
      <ActionForm action={saveExpense} submitLabel="บันทึกค่าใช้จ่าย">
        <label>รายละเอียด<input name="description" maxLength={200} required placeholder="เช่น เติมน้ำมันมอเตอร์ไซค์" /></label>
        <label>จำนวนเงิน (บาท)<input name="amount" inputMode="decimal" required placeholder="เช่น 100" /></label>
        <label>หมวดหมู่<input name="category" list="expense-categories" maxLength={60} required placeholder={`เช่น ${FUEL_CATEGORY}`} /></label>
        <label>ประเภท<select name="kind" defaultValue="operating">
          <option value="operating">ดำเนินงาน เช่น ค่าน้ำมัน แก๊ส (หักจากกำไร)</option>
          <option value="recurring">ประจำ เช่น ค่าเช่า (หักจากกำไร)</option>
          <option value="one_time">ครั้งเดียว เช่น ซื้ออุปกรณ์ (หักจากกำไร)</option>
          <option value="direct">ต้นทุนโดยตรง (อยู่ในต้นทุนเมนูแล้ว ไม่หักซ้ำ)</option>
        </select></label>
        <label>วันที่จ่าย<input type="date" name="spent_at" defaultValue={today} max={maxDate} /></label>
        <label>วิธีชำระ<select name="payment_method" defaultValue="transfer"><option value="transfer">เงินโอน</option><option value="cash">เงินสด</option><option value="other">อื่น ๆ</option></select></label>
        <label>ผู้รับเงิน (ไม่บังคับ)<input name="payee" maxLength={120} placeholder="เช่น ปั๊ม ปตท." /></label>
        <p className="field-hint wide">ค่าไฟ / ค่าแก๊ส ลงที่นี่ตอนบิลมา (หมวด “ค่าไฟ” “ค่าแก๊ส”) · ซื้อไก่ ข้าว ผัก เครื่องปรุง กล่อง ช้อน ถุง ให้บันทึกที่หน้า <Link href="/ingredients" className="text-link">วัตถุดิบและบรรจุภัณฑ์</Link> แทน ระบบคิดต้นทุนหรือลงค่าใช้จ่ายให้เอง ไม่ต้องลงซ้ำ</p>
      </ActionForm>
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
        <thead><tr><th>วันที่</th><th>รายละเอียด</th><th>ประเภท</th><th>ผู้รับเงิน</th><th>วิธีชำระ</th><th className="num">จำนวน</th><th /></tr></thead>
        <tbody>
          {expenses.map((e) => <tr key={e.id}>
            <td>{formatThaiShortDate(e.spentAt)}</td>
            <td><strong>{e.description}</strong><br /><small className="muted">{e.category}</small></td>
            <td><span className={`status ${e.kind === "direct" ? "muted" : "pending"}`}>{EXPENSE_KIND_LABELS[e.kind]}</span></td>
            <td>{e.payee ?? "—"}</td>
            <td>{e.paymentMethod ? PAYMENT_METHOD_LABELS[e.paymentMethod] : "—"}</td>
            <td className="num"><strong>{formatBaht(e.amount)}</strong></td>
            <td className="num"><ActionButton action={deleteExpense} fields={{ id: e.id }} label="ลบ" confirmText={`ลบ “${e.description}” ${formatBaht(e.amount)}?`} className="link-button danger" /></td>
          </tr>)}
          {!expenses.length && <tr><td colSpan={7}><div className="empty-state">{q ? `ไม่พบรายการที่ตรงกับ “${q}”` : "ยังไม่มีค่าใช้จ่ายในช่วงนี้"}</div></td></tr>}
        </tbody>
      </table>
    </section>
  </>;
}
