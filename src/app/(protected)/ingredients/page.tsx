import { PageTitle } from "@/components/page-title";
import { formatBaht } from "@/lib/money";

const ingredients = [
  ["ไก่สะโพก", "เนื้อสัตว์", 9400, "กก.", "12 ต.ค. 69"], ["ข้าวหอมมะลิ", "วัตถุดิบหลัก", 4850, "กก.", "10 ต.ค. 69"],
  ["น้ำปลา", "เครื่องปรุง", 620, "100 มล.", "8 ต.ค. 69"], ["กระเทียม", "เครื่องปรุง", 1250, "100 กรัม", "8 ต.ค. 69"],
  ["กล่องอาหาร", "บรรจุภัณฑ์", 450, "ชิ้น", "11 ต.ค. 69"], ["ช้อน + ส้อม", "บรรจุภัณฑ์", 180, "ชุด", "11 ต.ค. 69"],
];

export default function IngredientsPage() {
  return <><PageTitle eyebrow="ต้นทุนพื้นฐาน" title="วัตถุดิบและบรรจุภัณฑ์" description="ต้นทุนเฉลี่ยถ่วงน้ำหนักจากประวัติการซื้อ" action={<button className="primary-button">+ เพิ่มรายการซื้อ</button>} /><section className="panel table-panel"><div className="table-toolbar"><input className="search-box" placeholder="ค้นหาวัตถุดิบ…" /><button className="secondary-button">หมวดหมู่</button></div><table className="data-table"><thead><tr><th>ชื่อ</th><th>หมวดหมู่</th><th>ต้นทุนเฉลี่ย</th><th>หน่วย</th><th>ซื้อล่าสุด</th><th>สถานะ</th></tr></thead><tbody>{ingredients.map((row) => <tr key={String(row[0])}><td><strong>{row[0]}</strong></td><td>{row[1]}</td><td><strong>{formatBaht(Number(row[2]))}</strong></td><td>ต่อ {row[3]}</td><td>{row[4]}</td><td><span className="status success">ใช้งาน</span></td></tr>)}</tbody></table></section></>;
}
