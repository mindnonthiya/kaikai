import Link from "next/link";
import { ArrowRight, CircleAlert, PackageCheck, TrendingUp, Wallet } from "lucide-react";
import { StatCard } from "@/components/stat-card";
import { SalesChart } from "@/components/sales-chart";
import { dashboardStats as s, demoSales } from "@/lib/demo-data";
import { formatBaht } from "@/lib/money";

export default function DashboardPage() {
  return <>
    <section className="page-heading"><div><p className="eyebrow">วันอังคารที่ 13 ตุลาคม</p><h1>สวัสดี วันนี้ร้านเป็นอย่างไรบ้าง?</h1><p>ตัวเลขสำคัญของร้าน อัปเดตล่าสุดเมื่อสักครู่</p></div><Link href="/sales/new" className="primary-button">+ เพิ่มยอดขาย</Link></section>
    <div className="range-tabs" role="tablist"><button className="active">วันนี้</button><button>เมื่อวาน</button><button>7 วัน</button><button>เดือนนี้</button><button>กำหนดเอง</button></div>
    <section className="stat-grid main-stats">
      <StatCard label="ยอดขายวันนี้" value={formatBaht(s.revenue)} detail="↑ 12% จากเมื่อวาน" tone="blue" icon={TrendingUp} />
      <StatCard label="กำไรสุทธิวันนี้" value={formatBaht(s.netProfit)} detail="37.2% ของยอดขาย" tone="green" icon={Wallet} />
      <StatCard label="จำนวนกล่อง" value={`${s.boxes} กล่อง`} detail={`เฉลี่ย ${formatBaht(s.averageProfit)}/กล่อง`} tone="amber" icon={PackageCheck} />
    </section>
    <section className="stat-grid mini-stats">
      <StatCard label="ต้นทุนสินค้าที่ขาย" value={formatBaht(s.cogs)} />
      <StatCard label="กำไรขั้นต้น" value={formatBaht(s.grossProfit)} />
      <StatCard label="ค่าใช้จ่าย" value={formatBaht(s.expenses)} />
      <StatCard label="เงินโอนเข้า" value={formatBaht(s.transfers)} />
    </section>
    <section className="dashboard-grid">
      <article className="panel chart-panel"><div className="panel-head"><div><h2>ยอดขายและกำไร</h2><p>แนวโน้ม 7 วันล่าสุด</p></div><span className="metric-up">+18.4%</span></div><SalesChart /></article>
      <article className="panel"><div className="panel-head"><div><h2>ภาพรวมเดือนนี้</h2><p>1–13 ตุลาคม</p></div></div><div className="month-total"><span>ยอดขาย</span><strong>{formatBaht(s.monthRevenue)}</strong></div><div className="month-total green"><span>กำไรสุทธิ</span><strong>{formatBaht(s.monthNetProfit)}</strong></div><div className="progress-row"><span>เป้าหมายยอดขาย ฿30,000</span><b>42%</b></div><div className="progress"><i style={{ width: "42%" }} /></div></article>
    </section>
    <section className="dashboard-grid lower">
      <article className="panel"><div className="panel-head"><div><h2>รายการขายล่าสุด</h2><p>รายการที่เพิ่งบันทึก</p></div><Link href="/sales">ดูทั้งหมด <ArrowRight size={16} /></Link></div><div className="sales-list">{demoSales.slice(0, 3).map((sale) => <div className="sale-row" key={sale.id}><div className="sale-time"><strong>{sale.time}</strong><span>{sale.id}</span></div><div className="sale-detail"><strong>{sale.customer}</strong><span>{sale.items}</span></div><div className="sale-amount"><strong>{formatBaht(sale.total)}</strong><span>{sale.payment}</span></div></div>)}</div></article>
      <article className="panel"><div className="panel-head"><div><h2>เมนูทำเงิน</h2><p>เรียงตามกำไรวันนี้</p></div></div><ol className="ranking"><li><b>1</b><span>ข้าวไก่ต้มน้ำปลา<small>42 กล่อง</small></span><strong>{formatBaht(114450)}</strong></li><li><b>2</b><span>ข้าวไก่พิเศษ<small>28 กล่อง</small></span><strong>{formatBaht(94640)}</strong></li><li><b>3</b><span>ไก่เป็นกับข้าว<small>9 กล่อง</small></span><strong>{formatBaht(36450)}</strong></li></ol></article>
    </section>
    <div className="warning-card"><CircleAlert /><div><strong>ตรวจสอบต้นทุนเมนู</strong><p>วัตถุดิบ “ไก่สะโพก” ปรับราคาขึ้น 8% ต้นทุนเมนูหลักเพิ่มประมาณ ฿2.10 ต่อกล่อง</p></div><Link href="/menus">ดูรายละเอียด</Link></div>
  </>;
}
