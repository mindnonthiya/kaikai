import { Download, TrendingUp } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { StatCard } from "@/components/stat-card";
import { RangeTabs } from "@/components/range-tabs";
import { dailySeries, expensesByCategory, filterExpenses, filterSales, formatChange, formatPercentBps, menuRanking, percentChange, summarize } from "@/lib/analytics";
import { fetchExpenses, fetchIngredientPurchases, fetchSales } from "@/lib/data/queries";
import { UTILITY_CATEGORIES } from "@/lib/data/types";
import { formatBaht } from "@/lib/money";
import { DAY_MS, parseRange, previousRange, resolveRange } from "@/lib/time";

const RANGES = ["7d", "month", "last-month"] as const;

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const key = parseRange((await searchParams).range, [...RANGES], "month");
  const range = resolveRange(key);
  const prev = previousRange(range);
  const [sales, expenses, purchases] = await Promise.all([fetchSales(prev.start, range.end), fetchExpenses(prev.start, range.end), fetchIngredientPurchases(range.start, range.end)]);
  const curSales = filterSales(sales, range.start, range.end);
  const curExpenses = filterExpenses(expenses, range.start, range.end);
  const current = summarize(curSales, curExpenses);
  const previous = summarize(filterSales(sales, prev.start, prev.end), filterExpenses(expenses, prev.start, prev.end));
  const days = Math.round((range.end.getTime() - range.start.getTime()) / DAY_MS);
  const daily = dailySeries(curSales, curExpenses, range.start, days).reverse();
  const menus = menuRanking(curSales);
  const categories = expensesByCategory(curExpenses);

  // Estimated ingredient cost (inside each sale) vs what was actually bought in the period.
  const actualPerUnit = purchases.filter((p) => p.costing === "per_unit").reduce((sum, p) => sum + p.price, 0);
  const actualPooled = purchases.filter((p) => p.costing === "pooled").reduce((sum, p) => sum + p.price, 0);
  const actualFood = actualPerUnit + actualPooled;
  const foodGap = current.foodCost - actualFood;
  const netFromPurchases = current.netProfit + foodGap;
  const perBox = (value: number) => (current.boxes ? formatBaht(Math.round(value / current.boxes)) : "—");
  const missingUtilities = UTILITY_CATEGORIES.filter((c) => !curExpenses.some((e) => e.category.trim() === c));

  return <>
    <PageTitle eyebrow="ผลประกอบการ" title="รายงาน" description="สรุปยอดขายและกำไรเพื่อใช้ตัดสินใจ" action={<a className="primary-button" href={`/api/reports/export?range=${key}`}><Download size={17} /> ส่งออก CSV</a>} />
    <RangeTabs basePath="/reports" options={[...RANGES]} active={key} />
    <div className="stat-grid main-stats">
      <StatCard label="ยอดขาย" value={formatBaht(current.revenue)} detail={formatChange(percentChange(current.revenue, previous.revenue), "ช่วงก่อน") ?? `${current.saleCount} รายการ`} tone="blue" icon={TrendingUp} />
      <StatCard label="กำไรขั้นต้น" value={formatBaht(current.grossProfit)} detail={current.revenue ? `${formatPercentBps(current.grossMarginBps)} margin` : undefined} tone="green" />
      <StatCard label="กำไรสุทธิ" value={formatBaht(current.netProfit)} detail={`หลังหักค่าใช้จ่ายดำเนินงาน ${formatBaht(current.operatingExpenses)}`} tone="amber" />
    </div>
    <div className="stat-grid mini-stats">
      <StatCard label="เงินโอนเข้า" value={formatBaht(current.payments.transfer)} detail={current.payments.cash + current.payments.other ? `+ เงินสด/อื่น ๆ ${formatBaht(current.payments.cash + current.payments.other)}` : undefined} />
      <StatCard label="เงินเข้าบัญชี (สุทธิ)" value={formatBaht(current.netTransfer)} detail="โอนเข้า − โอนออก" />
      <StatCard label="ค้างรับ" value={formatBaht(current.outstanding)} />
      <StatCard label="จำนวนกล่อง" value={current.boxes.toLocaleString("th-TH")} detail={current.addons ? `+ ของเพิ่ม ${current.addons.toLocaleString("th-TH")} รายการ` : undefined} />
    </div>
    <div className="stat-grid mini-stats">
      <StatCard label="ค่าส่งที่เก็บได้" value={formatBaht(current.deliveryIncome)} detail={`${current.deliveryCount.toLocaleString("th-TH")} ออเดอร์ส่ง`} />
      <StatCard label="ค่าน้ำมัน" value={formatBaht(current.fuelExpenses)} detail="จากหน้าค่าใช้จ่าย หมวดค่าน้ำมัน" />
      <StatCard label="กำไรจากการส่ง" value={formatBaht(current.deliveryIncome - current.fuelExpenses)} detail="ค่าส่ง − ค่าน้ำมัน" />
      <StatCard label="ต้นทุนบรรจุภัณฑ์" value={formatBaht(current.packagingCost)} detail={current.boxes ? `เฉลี่ย ${formatBaht(Math.round(current.packagingCost / current.boxes))}/กล่อง` : "รวมอยู่ในต้นทุนสินค้าแล้ว"} />
    </div>
    <div className="stat-grid mini-stats">
      <StatCard label="ค่าใช้จ่ายดำเนินงาน/กล่อง" value={perBox(current.operatingExpenses)} detail={`รวม ${formatBaht(current.operatingExpenses)} ÷ ${current.boxes.toLocaleString("th-TH")} กล่อง`} />
      <StatCard label="กำไรสุทธิ/กล่อง" value={perBox(current.netProfit)} detail="หลังหักค่าใช้จ่ายดำเนินงาน" />
      <StatCard label="ต้นทุนวัตถุดิบ (ประมาณ)" value={formatBaht(current.foodCost)} detail="คำนวณจากสูตร + % ตอนขาย" />
      <StatCard label="ซื้อวัตถุดิบจริง" value={formatBaht(actualFood)} detail={actualFood ? `ไก่ ${formatBaht(actualPerUnit)} · อื่น ๆ ${formatBaht(actualPooled)}` : "ยังไม่มีการซื้อในช่วงนี้"} />
    </div>

    <section className="panel spaced">
      <div className="panel-head"><div><h2>กำไรสุทธิจากยอดซื้อจริง</h2><p>ใช้ยอดซื้อวัตถุดิบในช่วงนี้แทนต้นทุนประมาณ — ดูเทียบกันทั้งเดือนจะแม่นกว่ารายวัน (ซื้อมาตุนได้)</p></div></div>
      <div className="summary-row"><span>กำไรสุทธิ (ต้นทุนประมาณ)</span><strong>{formatBaht(current.netProfit)}</strong></div>
      <div className="summary-row"><span>{foodGap >= 0 ? "ซื้อจริงน้อยกว่าประมาณ" : "ซื้อจริงมากกว่าประมาณ"}</span><strong>{foodGap >= 0 ? "+" : "−"}{formatBaht(Math.abs(foodGap))}</strong></div>
      <div className="summary-total"><span>กำไรสุทธิจากยอดซื้อจริง</span><strong>{formatBaht(netFromPurchases)}</strong></div>
      {missingUtilities.length > 0 && <p className="muted-note">ช่วงนี้ยังไม่มี {missingUtilities.join(" / ")} — บิลมาแล้วลงในหน้าค่าใช้จ่าย กำไรสุทธิจะลดลงตามจริง</p>}
    </section>

    <section className="panel table-panel spaced">
      <div className="table-title"><h2>กำไรแยกตามเมนู</h2><span>ใช้ราคาและต้นทุน ณ เวลาที่ขาย</span></div>
      <table className="data-table">
        <thead><tr><th>เมนู</th><th className="num">จำนวน</th><th className="num">ยอดขาย</th><th className="num">ต้นทุน</th><th className="num">กำไร</th><th className="num">Margin</th></tr></thead>
        <tbody>
          {menus.map((m) => <tr key={m.menuId}><td><strong>{m.name}</strong>{m.isAddon && <> <span className="status muted">เพิ่มเติม</span></>}</td><td className="num">{m.quantity.toLocaleString("th-TH")}</td><td className="num">{formatBaht(m.revenue)}</td><td className="num">{formatBaht(m.cost)}</td><td className="num"><strong>{formatBaht(m.profit)}</strong></td><td className="num">{formatPercentBps(m.marginBps)}</td></tr>)}
          {!menus.length && <tr><td colSpan={6}><div className="empty-state">ยังไม่มียอดขายในช่วงนี้</div></td></tr>}
        </tbody>
      </table>
      <p className="table-footnote">ต้นทุนรายเมนูใช้บรรจุภัณฑ์ตามสูตร ส่วนยอดด้านบนใช้บรรจุภัณฑ์ที่ให้จริงแต่ละออเดอร์ และยอดรายเมนูยังไม่หักส่วนลด ไม่รวมค่าส่ง ผลรวมจึงอาจต่างกันเล็กน้อย</p>
    </section>

    <section className="panel table-panel spaced">
      <div className="table-title"><h2>ยอดขายรายวัน</h2><span>{days} วัน</span></div>
      <table className="data-table">
        <thead><tr><th>วันที่</th><th className="num">รายการ</th><th className="num">ยอดขาย</th><th className="num">กำไรขั้นต้น</th><th className="num">ค่าใช้จ่ายดำเนินงาน</th><th className="num">กำไรสุทธิ</th></tr></thead>
        <tbody>
          {daily.map((d) => <tr key={d.key} className={d.saleCount || d.operatingExpenses ? undefined : "row-muted"}><td>{d.shortDate}</td><td className="num">{d.saleCount}</td><td className="num">{formatBaht(d.revenue)}</td><td className="num">{formatBaht(d.grossProfit)}</td><td className="num">{formatBaht(d.operatingExpenses)}</td><td className={`num ${d.netProfit < 0 ? "negative" : ""}`}><strong>{formatBaht(d.netProfit)}</strong></td></tr>)}
        </tbody>
      </table>
    </section>

    <section className="panel table-panel spaced">
      <div className="table-title"><h2>ค่าใช้จ่ายตามหมวด</h2><span>รวมทุกประเภท {formatBaht(current.operatingExpenses + current.directExpenses)}</span></div>
      <table className="data-table">
        <thead><tr><th>หมวดหมู่</th><th className="num">รายการ</th><th className="num">จำนวนเงิน</th><th className="num">สัดส่วน</th></tr></thead>
        <tbody>
          {categories.map((c) => <tr key={c.category}><td><strong>{c.category}</strong></td><td className="num">{c.count}</td><td className="num">{formatBaht(c.amount)}</td><td className="num"><span className="share-bar"><i style={{ width: `${c.shareBps / 100}%` }} /></span>{formatPercentBps(c.shareBps)}</td></tr>)}
          {!categories.length && <tr><td colSpan={4}><div className="empty-state">ยังไม่มีค่าใช้จ่ายในช่วงนี้</div></td></tr>}
        </tbody>
      </table>
    </section>
  </>;
}
