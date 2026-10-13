import Link from "next/link";
import { PageTitle } from "@/components/page-title";
import { demoSales } from "@/lib/demo-data";
import { formatBaht } from "@/lib/money";

export default function SalesPage() {
  return <><PageTitle eyebrow="รายการทั้งหมด" title="ประวัติการขาย" description="ตรวจสอบ แก้ไข และติดตามสถานะการรับเงิน" action={<Link className="primary-button" href="/sales/new">+ เพิ่มยอดขาย</Link>} /><section className="panel table-panel"><div className="table-toolbar"><input className="search-box" placeholder="ค้นหาเลขที่รายการหรือลูกค้า…" /><button className="secondary-button">ตัวกรอง</button></div><table className="data-table"><thead><tr><th>เวลา / เลขที่</th><th>ลูกค้า</th><th>รายการ</th><th>ชำระด้วย</th><th>สถานะ</th><th>ยอดรวม</th></tr></thead><tbody>{demoSales.map((sale) => <tr key={sale.id}><td><strong>{sale.time}</strong><br />{sale.id}</td><td>{sale.customer}</td><td>{sale.items}</td><td>{sale.payment}</td><td><span className={`status ${sale.status === "ชำระแล้ว" ? "success" : "pending"}`}>{sale.status}</span></td><td><strong>{formatBaht(sale.total)}</strong></td></tr>)}</tbody></table></section></>;
}
