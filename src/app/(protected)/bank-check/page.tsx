import Link from "next/link";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, Landmark } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { StatCard } from "@/components/stat-card";
import { BankCheckList } from "@/components/bank-check-list";
import { filterExpenses, filterSales } from "@/lib/analytics";
import { buildBankCheck } from "@/lib/bank-check";
import { fetchExpenses, fetchSales } from "@/lib/data/queries";
import { formatBaht } from "@/lib/money";
import { DAY_MS, bangkokDayKey, formatThaiLongDate, formatTime, fromBangkokDateInput, startOfBangkokDay } from "@/lib/time";

export default async function BankCheckPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const params = await searchParams;
  const now = new Date();
  const today = startOfBangkokDay(now);

  let dayStart = today;
  if (params.date) {
    try {
      dayStart = fromBangkokDateInput(params.date);
    } catch {
      dayStart = today;
    }
  }
  // The future has no statement to compare against.
  if (dayStart.getTime() > today.getTime()) dayStart = today;
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const dateKey = bangkokDayKey(dayStart);
  const todayKey = bangkokDayKey(today);
  const prevKey = bangkokDayKey(new Date(dayStart.getTime() - DAY_MS));
  const nextKey = bangkokDayKey(dayEnd);
  const isToday = dateKey === todayKey;

  const [sales, expenses] = await Promise.all([fetchSales(dayStart, dayEnd), fetchExpenses(dayStart, dayEnd)]);
  const check = buildBankCheck(filterSales(sales, dayStart, dayEnd), filterExpenses(expenses, dayStart, dayEnd));
  const outstandingTotal = check.outstanding.reduce((s, o) => s + o.amount, 0);

  return (
    <>
      <PageTitle
        eyebrow={formatThaiLongDate(dayStart)}
        title="เทียบยอดกับแอปธนาคาร"
        description="ติ๊กทีละรายการให้ตรงกับ statement ในแอปธนาคาร เพื่อหาว่ายอดต่างกันเพราะรายการไหน"
        action={
          <form method="get" action="/bank-check" className="day-filter">
            <Link href={`/bank-check?date=${prevKey}`} className="day-step" aria-label="วันก่อนหน้า"><ChevronLeft size={18} /></Link>
            <label htmlFor="bank-check-date" className="sr-only">เลือกวันที่</label>
            <input id="bank-check-date" type="date" name="date" defaultValue={dateKey} max={todayKey} />
            <button type="submit" className="secondary-button">ดู</button>
            <Link href={`/bank-check?date=${nextKey}`} className="day-step" aria-label="วันถัดไป" aria-disabled={isToday} tabIndex={isToday ? -1 : undefined}><ChevronRight size={18} /></Link>
          </form>
        }
      />

      <section className="stat-grid main-stats">
        <StatCard label="เงินโอนเข้า (ตามระบบ)" value={formatBaht(check.totalIn)} detail={`${check.incoming.length} บิลที่รับเงินโอน`} tone="green" icon={ArrowDownLeft} />
        <StatCard label="เงินโอนออก (ตามระบบ)" value={formatBaht(check.totalOut)} detail={`${check.outgoing.length} รายการค่าใช้จ่าย`} tone="amber" icon={ArrowUpRight} />
        <StatCard label="สุทธิเข้าบัญชี" value={formatBaht(check.net)} detail="ควรเท่ากับยอดเปลี่ยนแปลงในบัญชีของวันนี้" tone="blue" icon={Landmark} />
      </section>

      <BankCheckList key={dateKey} dateKey={dateKey} incoming={check.incoming} outgoing={check.outgoing} totalIn={check.totalIn} totalOut={check.totalOut} />

      <section className="dashboard-grid bank-lists">
        <article className="panel">
          <div className="panel-head">
            <div><h2>ค้างรับ</h2><p>นับเป็นยอดขายแล้ว แต่เงินยังไม่เข้าบัญชี · รวม {formatBaht(outstandingTotal)}</p></div>
            <Link href="/sales">ดูบิล <ArrowRight size={16} /></Link>
          </div>
          <ul className="bank-side-list">
            {check.outstanding.map((o) => (
              <li key={o.id}>
                <span><strong>#{o.saleNumber} · {o.customerName ?? "ลูกค้าทั่วไป"}</strong><small>{formatTime(o.soldAt)}</small></span>
                <strong>{formatBaht(o.amount)}</strong>
              </li>
            ))}
            {!check.outstanding.length && <li className="empty-state">ได้รับเงินครบทุกบิล</li>}
          </ul>
        </article>
        <article className="panel">
          <div className="panel-head">
            <div><h2>ไม่ผ่านบัญชีธนาคาร</h2><p>บันทึกเป็นเงินสด/อื่น ๆ — ถ้าจริง ๆ โอน ให้แก้วิธีชำระ</p></div>
            <Link href="/expenses">ค่าใช้จ่าย <ArrowRight size={16} /></Link>
          </div>
          <ul className="bank-side-list">
            {check.notViaBank.map((l) => (
              <li key={l.id}>
                <span><strong>{l.label}</strong><small>{l.detail}</small></span>
                <strong className={`bank-line-amount ${l.direction}`}>{l.direction === "in" ? "+" : "−"}{formatBaht(l.amount)}</strong>
              </li>
            ))}
            {!check.notViaBank.length && <li className="empty-state">ทุกรายการผ่านบัญชีธนาคาร</li>}
          </ul>
        </article>
      </section>

      <section className="panel spaced-panel">
        <div className="panel-head"><div><h2>ยอดไม่ตรง? ลองเช็กสิ่งเหล่านี้</h2></div></div>
        <ul className="bank-tips">
          <li><b>จ่ายด้วยเงินส่วนตัว/บัญชีอื่น</b> — บันทึกเป็นค่าใช้จ่ายของร้าน แต่เงินไม่ได้ออกจากบัญชีนี้</li>
          <li><b>กด “ชำระแล้ว” ก่อนเงินเข้า</b> — ลูกค้ายังไม่โอนจริง หรือโอนไม่ครบ</li>
          <li><b>บันทึกบิล/ค่าใช้จ่ายซ้ำ</b> — ดูรายการที่ยอดเท่ากันและเวลาใกล้กัน</li>
          <li><b>ลืมบันทึก</b> — มีเงินเข้าหรือออกในแอป แต่ไม่มีในรายการด้านบน</li>
          <li><b>ค่าธรรมเนียม/ยอดเศษ</b> — แอปเดลิเวอรีหักค่าธรรมเนียมก่อนโอนเข้า</li>
        </ul>
      </section>
    </>
  );
}
