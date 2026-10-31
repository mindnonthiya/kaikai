import Link from "next/link";
import { ArrowRight, CircleAlert, Landmark, TrendingUp, Wallet, WalletCards } from "lucide-react";
import { StatCard } from "@/components/stat-card";
import { SalesChart } from "@/components/sales-chart";
import { RangeTabs } from "@/components/range-tabs";
import { dailySeries, filterExpenses, filterSales, formatChange, formatPercentBps, menuCostWarnings, menuRanking, percentChange, summarize } from "@/lib/analytics";
import { fetchExpenses, fetchMenus, fetchPooledRate, fetchSaleSettings, fetchSales } from "@/lib/data/queries";
import { formatBaht } from "@/lib/money";
import { DAY_MS, bangkokDayKey, formatThaiLongDate, formatThaiShortDate, formatTime, parseRange, previousRange, resolveRange, startOfBangkokDay, startOfBangkokMonth } from "@/lib/time";

const RANGES = ["today", "yesterday", "7d", "month"] as const;
const COMPARE_LABEL = { today: "เมื่อวาน", yesterday: "วันก่อนหน้า", "7d": "7 วันก่อน", month: "ช่วงเดียวกันเดือนก่อน", "last-month": "เดือนก่อนหน้า" } as const;

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const key = parseRange((await searchParams).range, [...RANGES], "today");
  const now = new Date();
  const saleSettings = await fetchSaleSettings();
  const dayStartHour = saleSettings.dayStartHour ?? 0;
  const range = resolveRange(key, now, dayStartHour);
  const prev = previousRange(range);
  const today = startOfBangkokDay(now, dayStartHour);
  const chartStart = new Date(today.getTime() - 6 * DAY_MS);
  const monthStart = startOfBangkokMonth(now, 0, dayStartHour);
  const windowStart = new Date(Math.min(prev.start.getTime(), chartStart.getTime(), monthStart.getTime()));
  const windowEnd = new Date(today.getTime() + DAY_MS);

  const [sales, expenses, menus, pooled] = await Promise.all([fetchSales(windowStart, windowEnd), fetchExpenses(windowStart, windowEnd), fetchMenus(), fetchPooledRate(saleSettings)]);

  const month = summarize(filterSales(sales, monthStart, windowEnd), filterExpenses(expenses, monthStart, windowEnd));
  const current = summarize(filterSales(sales, range.start, range.end), filterExpenses(expenses, range.start, range.end));
  const previous = summarize(filterSales(sales, prev.start, prev.end), filterExpenses(expenses, prev.start, prev.end));
  const chart = dailySeries(sales, expenses, chartStart, 7, bangkokDayKey(now, dayStartHour), dayStartHour);
  const chartRevenue = chart.reduce((sum, p) => sum + p.revenue, 0);
  const ranking = menuRanking(filterSales(sales, range.start, range.end)).filter((row) => !row.isAddon && !row.isAdjustment).slice(0, 3);
  const recent = sales.filter((s) => s.status === "confirmed").slice(0, 4);
  const warnings = menuCostWarnings(menus, 2000, pooled.bps);
  const label = range.label;
  const totalExpenses = current.operatingExpenses + current.directExpenses;

  return <>
    <section className="page-heading">
      <div>
        <p className="eyebrow">{formatThaiLongDate(today)}</p>
        <h1>สวัสดี วันนี้ร้านเป็นอย่างไรบ้าง?</h1>
        <p>ตัวเลขจากรายการขายและค่าใช้จ่ายที่บันทึกไว้</p>
      </div>
      <div className="heading-actions">
        <Link href="/bank-check" className="secondary-button"><Landmark size={17} /> เทียบยอดกับแอปธนาคาร</Link>
        <Link href="/sales/new" className="primary-button">+ เปิดบิล</Link>
      </div>
    </section>
    <RangeTabs basePath="/dashboard" options={[...RANGES]} active={key} />
    <section className="stat-grid main-stats">
      <StatCard label={`ยอดขาย${label}`} value={formatBaht(current.revenue)} detail={formatChange(percentChange(current.revenue, previous.revenue), COMPARE_LABEL[key]) ?? `${current.saleCount.toLocaleString("th-TH")} รายการ`} tone="blue" icon={TrendingUp} />
      <StatCard label={`ค่าใช้จ่ายทั้งหมด${label}`} value={formatBaht(totalExpenses)} detail={current.directExpenses ? `ของสด/กล่อง ${formatBaht(current.directExpenses)} · ค่าร้าน ${formatBaht(current.operatingExpenses)}` : `ค่าใช้จ่ายดำเนินงาน ${formatBaht(current.operatingExpenses)}`} tone="amber" icon={WalletCards} />
      <StatCard label={`กำไรสุทธิ${label}`} value={formatBaht(current.netProfit)} detail={current.revenue ? `${formatPercentBps(current.netMarginBps)} ของยอดขาย` : "ยังไม่มียอดขาย"} tone="green" icon={Wallet} />
    </section>
    <section className="stat-grid mini-stats">
      <StatCard label="จำนวนกล่อง" value={`${current.boxes.toLocaleString("th-TH")} กล่อง`} detail={current.boxes ? `กำไรรวม ÷ กล่องอาหาร ${formatBaht(current.averageProfitPerBox)}${current.deliveryCount ? ` · ส่ง ${current.deliveryCount} ออเดอร์` : ""}` : undefined} />
      <StatCard label="ต้นทุนของที่ขาย" value={formatBaht(current.cogs)} detail="หักตามจำนวนจานที่ขายจริง" />
      <StatCard label="เงินเข้าบัญชี (สุทธิ)" value={formatBaht(current.netTransfer)} detail={`โอนเข้า ${formatBaht(current.payments.transfer)} − โอนออก ${formatBaht(current.expensePayments.transfer)}`} />
      <StatCard label="ค้างรับ" value={formatBaht(current.outstanding)} detail={current.outstanding ? "บิลที่ลูกค้ายังไม่โอนหรือโอนไม่ครบ" : "ได้รับเงินครบทุกบิล"} />
    </section>
    <section className="dashboard-grid">
      <article className="panel chart-panel"><div className="panel-head"><div><h2>ยอดขายและกำไร</h2><p>7 วันล่าสุด · {formatThaiShortDate(chartStart)} – {formatThaiShortDate(today)}</p></div><span className="metric-up">{formatBaht(chartRevenue)}</span></div><SalesChart points={chart} /></article>
      <article className="panel"><div className="panel-head"><div><h2>ภาพรวมเดือนนี้</h2><p>{formatThaiShortDate(monthStart)} – {formatThaiShortDate(today)}</p></div></div>
        <div className="month-total"><span>ยอดขาย</span><strong>{formatBaht(month.revenue)}</strong></div>
        <div className="month-total"><span>ค่าใช้จ่ายทั้งหมด</span><strong>{formatBaht(month.operatingExpenses + month.directExpenses)}</strong></div>
        <div className="month-total green"><span>กำไรสุทธิ</span><strong>{formatBaht(month.netProfit)}</strong></div>
        <div className="progress-row"><span>{month.saleCount.toLocaleString("th-TH")} รายการ · {month.boxes.toLocaleString("th-TH")} กล่อง</span><b>{month.revenue ? formatPercentBps(month.netMarginBps) : "–"}</b></div>
        <div className="progress"><i style={{ width: `${Math.min(100, Math.max(0, month.netMarginBps / 100))}%` }} /></div>
      </article>
    </section>
    <section className="dashboard-grid lower">
      <article className="panel"><div className="panel-head"><div><h2>รายการขายล่าสุด</h2><p>รายการที่เพิ่งบันทึก</p></div><Link href="/sales">ดูทั้งหมด <ArrowRight size={16} /></Link></div>
        <div className="sales-list">
          {recent.map((sale) => <div className="sale-row" key={sale.id}><div className="sale-time"><strong>{formatTime(sale.soldAt)}</strong><span>#{sale.saleNumber}</span></div><div className="sale-detail"><strong>{sale.customerName ?? "ลูกค้าทั่วไป"}</strong><span>{sale.items.map((i) => `${i.name} ×${i.quantity}`).join(" · ")}</span></div><div className="sale-amount"><strong>{formatBaht(sale.netRevenue)}</strong><span>{formatThaiShortDate(sale.soldAt)}</span></div></div>)}
          {!recent.length && <div className="empty-state">ยังไม่มีรายการขาย — <Link href="/sales/new" className="text-link">บันทึกยอดขายแรก</Link></div>}
        </div>
      </article>
      <article className="panel"><div className="panel-head"><div><h2>เมนูทำเงิน</h2><p>เรียงตามกำไรขั้นต้น{label}</p></div></div>
        <ol className="ranking">
          {ranking.map((row, index) => <li key={row.menuId}><b>{index + 1}</b><span>{row.name}<small>{row.quantity.toLocaleString("th-TH")} กล่อง</small></span><strong>{formatBaht(row.profit)}</strong></li>)}
          {!ranking.length && <li className="empty-state">ยังไม่มียอดขายในช่วงนี้</li>}
        </ol>
      </article>
    </section>
    {warnings.length > 0 && <div className="warning-card"><CircleAlert /><div><strong>ตรวจสอบต้นทุนเมนู</strong><p>{warnings.slice(0, 3).map(({ menu, marginBps }) => menu.cost === 0 ? `“${menu.name}” ยังไม่ได้ใส่ต้นทุน` : `“${menu.name}” กำไรเหลือ ${formatPercentBps(marginBps)}`).join(" · ")}{warnings.length > 3 ? ` และอีก ${warnings.length - 3} เมนู` : ""}</p></div><Link href="/menus">ดูรายละเอียด</Link></div>}
    {!menus.length && <div className="warning-card"><CircleAlert /><div><strong>เริ่มต้นใช้งาน</strong><p>สร้างเมนูแรกของร้านก่อน แล้วจึงบันทึกยอดขายได้</p></div><Link href="/menus">สร้างเมนู</Link></div>}
  </>;
}
