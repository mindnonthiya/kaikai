import { PackageOpen, ShoppingBasket, Box } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { ActionForm } from "@/components/action-form";
import { addPurchase, saveIngredient, savePackaging } from "@/app/actions/ingredients";
import { fetchIngredients, fetchLastPurchaseDates, fetchPackaging, fetchRecentPurchases } from "@/lib/data/queries";
import { formatBaht, formatUnitCost, satangToBahtInput } from "@/lib/money";
import { bangkokDayKey, formatThaiShortDate } from "@/lib/time";

const UNITS = ["กรัม", "มิลลิลิตร", "ฟอง", "ชิ้น", "ลูก", "ห่อ"];
const ING_CATEGORIES = ["เนื้อสัตว์", "วัตถุดิบหลัก", "ผัก", "เครื่องปรุง", "อื่น ๆ"];

export default async function IngredientsPage() {
  const [ingredients, packaging, purchases, lastPurchase] = await Promise.all([fetchIngredients(), fetchPackaging(), fetchRecentPurchases(20), fetchLastPurchaseDates()]);
  const today = bangkokDayKey(new Date());

  return <>
    <PageTitle eyebrow="ต้นทุนพื้นฐาน" title="วัตถุดิบและบรรจุภัณฑ์" description="ต้นทุนเฉลี่ยถ่วงน้ำหนักจากประวัติการซื้อ ใช้คำนวณต้นทุนเมนูอัตโนมัติ" />
    <datalist id="units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
    <datalist id="ingredient-categories">{ING_CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>

    <div className="form-panels">
      <details className="panel form-panel" open={ingredients.length > 0}>
        <summary><ShoppingBasket size={18} /> บันทึกการซื้อวัตถุดิบ</summary>
        {ingredients.length
          ? <ActionForm action={addPurchase} submitLabel="บันทึกการซื้อ">
              <label>วัตถุดิบ<select name="ingredient_id" required defaultValue=""><option value="" disabled>เลือก…</option>{ingredients.map((i) => <option key={i.id} value={i.id}>{i.name} (หน่วย: {i.baseUnit})</option>)}</select></label>
              <label>วันที่ซื้อ<input type="date" name="purchased_at" defaultValue={today} max={today} /></label>
              <label>ราคารวม (บาท)<input name="price" inputMode="decimal" required placeholder="เช่น 940" /></label>
              <label>ปริมาณที่ซื้อ (หน่วยฐาน)<input name="purchased_quantity" inputMode="decimal" required placeholder="เช่น 10000 (กรัม)" /></label>
              <label>ใช้ได้จริงหลังตัดแต่ง (ไม่บังคับ)<input name="usable_quantity" inputMode="decimal" placeholder="เว้นว่าง = เท่ากับที่ซื้อ" /></label>
              <label>ร้านค้า (ไม่บังคับ)<input name="vendor" maxLength={120} placeholder="เช่น ตลาดสด" /></label>
            </ActionForm>
          : <p className="muted-note">เพิ่มวัตถุดิบก่อน แล้วจึงบันทึกการซื้อได้</p>}
      </details>
      <details className="panel form-panel" open={ingredients.length === 0}>
        <summary><PackageOpen size={18} /> เพิ่มวัตถุดิบใหม่</summary>
        <ActionForm action={saveIngredient} submitLabel="เพิ่มวัตถุดิบ">
          <label>ชื่อวัตถุดิบ<input name="name" maxLength={120} required placeholder="เช่น ไก่สะโพก" /></label>
          <label>หมวดหมู่<input name="category" list="ingredient-categories" maxLength={60} required defaultValue="วัตถุดิบหลัก" /></label>
          <label>หน่วยฐาน (ใช้ในสูตร)<input name="base_unit" list="units" maxLength={30} required defaultValue="กรัม" /></label>
        </ActionForm>
      </details>
    </div>

    <section className="panel table-panel spaced">
      <div className="table-title"><h2>วัตถุดิบ</h2><span>{ingredients.length} รายการ</span></div>
      <table className="data-table">
        <thead><tr><th>ชื่อ</th><th>หมวดหมู่</th><th className="num">ต้นทุนเฉลี่ย</th><th className="num">ต่อ 1,000 หน่วย</th><th>ซื้อล่าสุด</th></tr></thead>
        <tbody>
          {ingredients.map((i) => <tr key={i.id}>
            <td><strong>{i.name}</strong></td><td>{i.category}</td>
            <td className="num"><strong>{i.unitCost ? `${formatUnitCost(i.unitCost)}/${i.baseUnit}` : "—"}</strong></td>
            <td className="num">{i.unitCost ? `${formatBaht(Math.round(i.unitCost * 1000))}/1,000 ${i.baseUnit}` : "—"}</td>
            <td>{lastPurchase.get(i.id) ? formatThaiShortDate(lastPurchase.get(i.id)!) : <span className="status pending">ยังไม่มีการซื้อ</span>}</td>
          </tr>)}
          {!ingredients.length && <tr><td colSpan={5}><div className="empty-state">ยังไม่มีวัตถุดิบ</div></td></tr>}
        </tbody>
      </table>
    </section>

    <section className="panel table-panel spaced">
      <div className="table-title"><h2>บรรจุภัณฑ์</h2><span>{packaging.length} รายการ · แก้ราคาแล้วต้นทุนเมนูอัปเดตอัตโนมัติ</span></div>
      <table className="data-table">
        <thead><tr><th>ชื่อ</th><th>หน่วย</th><th className="num">ราคาต่อหน่วย</th><th>แก้ไข</th></tr></thead>
        <tbody>
          {packaging.map((p) => <tr key={p.id}>
            <td><strong>{p.name}</strong></td><td>{p.unit}</td><td className="num"><strong>{formatBaht(p.unitCost)}</strong></td>
            <td><details className="inline-details"><summary>แก้ราคา</summary>
              <ActionForm action={savePackaging} submitLabel="บันทึก" className="form-inline" resetOnSuccess={false}>
                <input type="hidden" name="id" value={p.id} /><input type="hidden" name="name" value={p.name} /><input type="hidden" name="unit" value={p.unit} />
                <label>ราคา (บาท)<input name="unit_cost" inputMode="decimal" defaultValue={satangToBahtInput(p.unitCost)} required /></label>
              </ActionForm>
            </details></td>
          </tr>)}
          {!packaging.length && <tr><td colSpan={4}><div className="empty-state">ยังไม่มีบรรจุภัณฑ์</div></td></tr>}
        </tbody>
      </table>
      <details className="form-panel inner">
        <summary><Box size={18} /> เพิ่มบรรจุภัณฑ์</summary>
        <ActionForm action={savePackaging} submitLabel="เพิ่มบรรจุภัณฑ์">
          <label>ชื่อ<input name="name" maxLength={120} required placeholder="เช่น กล่องอาหาร" /></label>
          <label>หน่วย<input name="unit" list="units" maxLength={30} required defaultValue="ชิ้น" /></label>
          <label>ราคาต่อหน่วย (บาท)<input name="unit_cost" inputMode="decimal" required placeholder="เช่น 4.50" /></label>
        </ActionForm>
      </details>
    </section>

    <section className="panel table-panel spaced">
      <div className="table-title"><h2>ประวัติการซื้อล่าสุด</h2><span>20 รายการล่าสุด</span></div>
      <table className="data-table">
        <thead><tr><th>วันที่</th><th>วัตถุดิบ</th><th className="num">ปริมาณ</th><th className="num">ราคารวม</th><th className="num">ต่อหน่วย</th><th>ร้านค้า</th></tr></thead>
        <tbody>
          {purchases.map((p) => <tr key={p.id}>
            <td>{formatThaiShortDate(p.purchasedAt)}</td><td><strong>{p.ingredientName}</strong></td>
            <td className="num">{p.usableQuantity.toLocaleString("th-TH")} {p.unit}{p.usableQuantity !== p.purchasedQuantity ? <small className="muted"> (ซื้อ {p.purchasedQuantity.toLocaleString("th-TH")})</small> : null}</td>
            <td className="num"><strong>{formatBaht(p.price)}</strong></td>
            <td className="num">{formatUnitCost(p.price / p.usableQuantity)}</td>
            <td>{p.vendor ?? "—"}</td>
          </tr>)}
          {!purchases.length && <tr><td colSpan={6}><div className="empty-state">ยังไม่มีประวัติการซื้อ</div></td></tr>}
        </tbody>
      </table>
    </section>
  </>;
}
