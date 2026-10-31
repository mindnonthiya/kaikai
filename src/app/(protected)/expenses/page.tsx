import Link from "next/link";
import { UploadCloud, WalletCards } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { StatCard } from "@/components/stat-card";
import { RangeTabs } from "@/components/range-tabs";
import { ExpenseFormWithSlip } from "@/components/expense-form-with-slip";
import { ExpenseTable } from "@/components/expense-table";
import { isOperatingExpense } from "@/lib/analytics";
import { fetchPurchaseCatalog } from "@/lib/data/purchase-options";
import { fetchExpenses, fetchSaleSettings } from "@/lib/data/queries";
import { FUEL_CATEGORY } from "@/lib/data/types";
import { formatBaht } from "@/lib/money";
import { bangkokDayKey, parseRange, resolveRange } from "@/lib/time";

const RANGES = ["today", "7d", "month", "last-month"] as const;
const CATEGORIES = [FUEL_CATEGORY, "ค่าแก๊ส", "ค่าไฟ", "ค่าน้ำ", "บรรจุภัณฑ์", "วัตถุดิบ", "ค่าเช่า", "ค่าแรง", "การตลาด", "อุปกรณ์", "อื่น ๆ"];

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ range?: string; q?: string }> }) {
  const params = await searchParams;
  const key = parseRange(params.range, [...RANGES], "month");
  const q = (params.q ?? "").trim();
  const saleSettings = await fetchSaleSettings();
  const range = resolveRange(key, new Date(), saleSettings.dayStartHour);
  const [all, catalog] = await Promise.all([
    fetchExpenses(range.start, range.end),
    fetchPurchaseCatalog(),
  ]);
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
      description="แยกต้นทุนสินค้าและค่าใช้จ่ายดำเนินงานอย่างชัดเจน พร้อมแนบสลิปอ่านยอดและแยกวัตถุดิบ/บรรจุภัณฑ์ในสลิปเดียว"
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
    <details className="panel form-panel" open>
      <summary><WalletCards size={18} /> เพิ่มค่าใช้จ่าย / แนบสลิปซื้อวัตถุดิบและบรรจุภัณฑ์</summary>
      <ExpenseFormWithSlip
        today={today}
        maxDate={maxDate}
        categories={CATEGORIES}
        perUnit={catalog.perUnit}
        pooled={catalog.pooled}
        restockItems={catalog.restockItems}
      />
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
      <ExpenseTable
        expenses={expenses}
        searchQuery={q}
        categories={CATEGORIES}
        perUnit={catalog.perUnit}
        pooled={catalog.pooled}
        restockItems={catalog.restockItems}
        maxDate={maxDate}
      />
    </section>
  </>;
}
