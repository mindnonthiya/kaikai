import { Box, PackageOpen, PackagePlus, ShoppingBasket } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { ActionForm } from "@/components/action-form";
import { PackPriceFields } from "@/components/pack-price-fields";
import { addPackagingPurchase, addPurchase, createPackaging, saveIngredient, updatePackaging } from "@/app/actions/ingredients";
import { fetchIngredients, fetchLastPurchaseDates, fetchPackaging, fetchPackagingPurchases, fetchRecentPurchases } from "@/lib/data/queries";
import type { PackagingPurchaseRecord } from "@/lib/data/types";
import { formatBaht, formatUnitCost } from "@/lib/money";
import { bangkokDayKey, formatThaiShortDate } from "@/lib/time";

const UNITS = ["กรัม", "มิลลิลิตร", "ฟอง", "ชิ้น", "ลูก", "ห่อ"];
const PACK_UNITS = ["ชิ้น", "ชุด", "คู่", "ใบ", "ถุง"];
const ING_CATEGORIES = ["เนื้อสัตว์", "วัตถุดิบหลัก", "ผัก", "เครื่องปรุง", "อื่น ๆ"];

function PerOrderSelect({ value = true }: { value?: boolean }) {
  return <label>คิดต้นทุนอย่างไร
    <select name="per_order" defaultValue={String(value)}>
      <option value="true">คิดต่อจาน/ออเดอร์ เช่น กล่อง ช้อน ถ้วยน้ำจิ้ม</option>
      <option value="false">ไม่คิดต่อออเดอร์ — ลงเป็นค่าใช้จ่ายตอนซื้อ เช่น ถุง</option>
    </select>
  </label>;
}

const packText = (p: PackagingPurchaseRecord) => `${formatBaht(p.price)} / ${p.packQuantity.toLocaleString("th-TH")} ${p.unit}`;

export default async function IngredientsPage() {
  const [ingredients, packaging, purchases, lastPurchase, packPurchases] = await Promise.all([
    fetchIngredients(), fetchPackaging(), fetchRecentPurchases(20), fetchLastPurchaseDates(), fetchPackagingPurchases(),
  ]);
  const today = bangkokDayKey(new Date());
  const latestPack = new Map<string, PackagingPurchaseRecord>();
  for (const p of packPurchases) if (!latestPack.has(p.packagingItemId)) latestPack.set(p.packagingItemId, p);

  return <>
    <PageTitle eyebrow="ต้นทุนพื้นฐาน" title="วัตถุดิบและบรรจุภัณฑ์" description="กรอกราคาที่ซื้อมาทั้งแพ็ก ระบบหารให้ว่าตกชิ้นละเท่าไร แล้วใช้คำนวณต้นทุนเมนูอัตโนมัติ" />
    <datalist id="units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
    <datalist id="pack-units">{PACK_UNITS.map((u) => <option key={u} value={u} />)}</datalist>
    <datalist id="ingredient-categories">{ING_CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>

    <h2 className="section-heading">บรรจุภัณฑ์</h2>
    <div className="form-panels">
      <details className="panel form-panel" open={packaging.length > 0}>
        <summary><ShoppingBasket size={18} /> บันทึกการซื้อบรรจุภัณฑ์</summary>
        {packaging.length
          ? <ActionForm action={addPackagingPurchase} submitLabel="บันทึกการซื้อ">
              <label>บรรจุภัณฑ์<select name="packaging_item_id" required defaultValue="">
                <option value="" disabled data-unit="ชิ้น">เลือก…</option>
                {packaging.map((p) => <option key={p.id} value={p.id} data-unit={p.unit}>{p.name}{p.unitCost ? ` (ตอนนี้ ${formatUnitCost(p.unitCost)}/${p.unit})` : ""}</option>)}
              </select></label>
              <label>วันที่ซื้อ<input type="date" name="purchased_at" defaultValue={today} max={today} /></label>
              <PackPriceFields unitInputName="packaging_item_id" />
              <label>ร้านค้า (ไม่บังคับ)<input name="vendor" maxLength={120} placeholder="เช่น แม็คโคร" /></label>
            </ActionForm>
          : <p className="muted-note">เพิ่มบรรจุภัณฑ์ก่อน แล้วจึงบันทึกการซื้อครั้งถัดไปได้</p>}
      </details>
      <details className="panel form-panel" open={packaging.length === 0}>
        <summary><PackagePlus size={18} /> เพิ่มบรรจุภัณฑ์ใหม่</summary>
        <ActionForm action={createPackaging} submitLabel="เพิ่มบรรจุภัณฑ์">
          <label>ชื่อ<input name="name" maxLength={120} required placeholder="เช่น กล่อง + ฝา" /></label>
          <label>หน่วย<input name="unit" list="pack-units" maxLength={30} required defaultValue="ชิ้น" /></label>
          <PerOrderSelect />
          <label>วันที่ซื้อ<input type="date" name="purchased_at" defaultValue={today} max={today} /></label>
          <PackPriceFields unitInputName="unit" required={false} />
          <label>ร้านค้า (ไม่บังคับ)<input name="vendor" maxLength={120} placeholder="เช่น แม็คโคร" /></label>
          <p className="field-hint wide">ราคาแพ็กเว้นว่างได้ ถ้ายังไม่รู้ ค่อยบันทึกการซื้อทีหลัง</p>
        </ActionForm>
      </details>
    </div>

    <section className="panel table-panel spaced">
      <div className="table-title"><h2>รายการบรรจุภัณฑ์</h2><span>{packaging.length} รายการ · ราคาต่อชิ้นเฉลี่ยจากทุกครั้งที่ซื้อ</span></div>
      <table className="data-table">
        <thead><tr><th>ชื่อ</th><th>คิดต้นทุน</th><th className="num">ราคาต่อหน่วย</th><th>ซื้อล่าสุด</th><th>แก้ไข</th></tr></thead>
        <tbody>
          {packaging.map((p) => {
            const last = latestPack.get(p.id);
            return <tr key={p.id}>
              <td><strong>{p.name}</strong></td>
              <td><span className={`status ${p.perOrder ? "success" : "muted"}`}>{p.perOrder ? "ต่อออเดอร์" : "ลงค่าใช้จ่าย"}</span></td>
              <td className="num"><strong>{p.unitCost ? `${formatUnitCost(p.unitCost)}/${p.unit}` : "—"}</strong></td>
              <td>{last ? <>{packText(last)}<br /><small className="muted">{formatThaiShortDate(last.purchasedAt)}</small></> : <span className="status pending">ยังไม่มีการซื้อ</span>}</td>
              <td><details className="inline-details"><summary>แก้ไข</summary>
                <ActionForm action={updatePackaging} submitLabel="บันทึก" className="form-grid compact" resetOnSuccess={false}>
                  <input type="hidden" name="id" value={p.id} />
                  <label>ชื่อ<input name="name" defaultValue={p.name} maxLength={120} required /></label>
                  <label>หน่วย<input name="unit" list="pack-units" defaultValue={p.unit} maxLength={30} required /></label>
                  <PerOrderSelect value={p.perOrder} />
                </ActionForm>
              </details></td>
            </tr>;
          })}
          {!packaging.length && <tr><td colSpan={5}><div className="empty-state">ยังไม่มีบรรจุภัณฑ์ — เพิ่มจากฟอร์มด้านบน เช่น กล่อง + ฝา 65 บาท ได้ 25 ชุด</div></td></tr>}
        </tbody>
      </table>
      <p className="table-footnote">“ต่อออเดอร์” = ผูกกับสูตรเมนู แล้วระบบนับให้ตอนขาย · “ลงค่าใช้จ่าย” = ตอนบันทึกการซื้อ ระบบลงในหน้าค่าใช้จ่ายให้เอง ไม่ต้องลงซ้ำ</p>
    </section>

    {packPurchases.length > 0 && <section className="panel table-panel spaced">
      <div className="table-title"><h2>ประวัติการซื้อบรรจุภัณฑ์</h2><span>20 รายการล่าสุด</span></div>
      <table className="data-table">
        <thead><tr><th>วันที่</th><th>บรรจุภัณฑ์</th><th className="num">ซื้อ</th><th className="num">ต่อหน่วย</th><th>ร้านค้า</th></tr></thead>
        <tbody>
          {packPurchases.slice(0, 20).map((p) => <tr key={p.id}>
            <td>{formatThaiShortDate(p.purchasedAt)}</td>
            <td><strong>{p.itemName}</strong>{p.expenseId && <><br /><small className="muted">ลงค่าใช้จ่ายแล้ว</small></>}</td>
            <td className="num">{packText(p)}</td>
            <td className="num">{formatUnitCost(p.price / p.packQuantity)}</td>
            <td>{p.vendor ?? "—"}</td>
          </tr>)}
        </tbody>
      </table>
    </section>}

    <h2 className="section-heading">วัตถุดิบ</h2>
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
          : <p className="muted-note">เพิ่มวัตถุดิบก่อน แล้วจึงบันทึกการซื้อได้ · ถ้ายังไม่อยากลงละเอียด ใส่ “ต้นทุนอาหาร/จาน” ในหน้าเมนูแทนได้</p>}
      </details>
      <details className="panel form-panel">
        <summary><PackageOpen size={18} /> เพิ่มวัตถุดิบใหม่</summary>
        <ActionForm action={saveIngredient} submitLabel="เพิ่มวัตถุดิบ">
          <label>ชื่อวัตถุดิบ<input name="name" maxLength={120} required placeholder="เช่น ไก่สะโพก" /></label>
          <label>หมวดหมู่<input name="category" list="ingredient-categories" maxLength={60} required defaultValue="วัตถุดิบหลัก" /></label>
          <label>หน่วยฐาน (ใช้ในสูตร)<input name="base_unit" list="units" maxLength={30} required defaultValue="กรัม" /></label>
        </ActionForm>
      </details>
    </div>

    <section className="panel table-panel spaced">
      <div className="table-title"><h2>รายการวัตถุดิบ</h2><span>{ingredients.length} รายการ</span></div>
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

    {purchases.length > 0 && <section className="panel table-panel spaced">
      <div className="table-title"><h2><Box size={18} /> ประวัติการซื้อวัตถุดิบ</h2><span>20 รายการล่าสุด</span></div>
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
        </tbody>
      </table>
    </section>}
  </>;
}
