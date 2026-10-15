import Link from "next/link";
import { Box, PackageOpen, PackagePlus, ShoppingBasket } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { ActionForm } from "@/components/action-form";
import { IngredientKindFields } from "@/components/ingredient-kind-fields";
import { IngredientPurchaseTable } from "@/components/ingredient-purchase-table";
import { PackPriceFields } from "@/components/pack-price-fields";
import { PackagingRestockTable, type RestockItem } from "@/components/packaging-restock-table";
import { createIngredient, createPackaging, recordIngredientPurchases, restockPackaging, updateIngredient, updatePackaging } from "@/app/actions/ingredients";
import { formatPercentBps } from "@/lib/analytics";
import { fetchIngredients, fetchLatestPurchases, fetchPackaging, fetchPackagingPurchases, fetchPooledRate, fetchRecentPurchases } from "@/lib/data/queries";
import type { PackagingPurchaseRecord } from "@/lib/data/types";
import { formatBaht, formatUnitCost, satangToBahtInput } from "@/lib/money";
import { bangkokDayKey, formatThaiShortDate } from "@/lib/time";

const PACK_UNITS = ["ชิ้น", "ชุด", "คู่", "ใบ", "ถุง"];

function PerOrderSelect({ value = true }: { value?: boolean }) {
  return <label>คิดต้นทุนอย่างไร
    <select name="per_order" defaultValue={String(value)}>
      <option value="true">คิดต่อจาน/ออเดอร์ เช่น กล่อง ช้อน ถ้วยน้ำจิ้ม</option>
      <option value="false">ไม่คิดต่อออเดอร์ — ลงเป็นค่าใช้จ่ายตอนซื้อ เช่น ถุง</option>
    </select>
  </label>;
}

const packText = (p: PackagingPurchaseRecord) => p.packCount > 1
  ? `${p.packCount.toLocaleString("th-TH")} แพ็ก · ${formatBaht(p.price)} / ${p.packQuantity.toLocaleString("th-TH")} ${p.unit}`
  : `${formatBaht(p.price)} / ${p.packQuantity.toLocaleString("th-TH")} ${p.unit}`;

/** Satang (may be fractional) → baht input text, e.g. 12500 → "125.00". */
const bahtInput = (value: number) => (value > 0 ? satangToBahtInput(Math.round(value)) : "");
const trimZeros = (value: number) => String(Math.round(value * 10_000) / 10_000);

export default async function IngredientsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const params = await searchParams;
  const activeTab = params.tab === "packaging" ? "packaging" : "ingredients";

  const [ingredients, packaging, purchases, latest, packPurchases, pooledRate] = await Promise.all([
    fetchIngredients(), fetchPackaging(), fetchRecentPurchases(20), fetchLatestPurchases(), fetchPackagingPurchases(), fetchPooledRate(),
  ]);
  const today = bangkokDayKey(new Date());
  const latestPack = new Map<string, PackagingPurchaseRecord>();
  for (const p of packPurchases) if (!latestPack.has(p.packagingItemId)) latestPack.set(p.packagingItemId, p);

  const activePackaging = packaging.filter((p) => p.isActive);
  const restockItems: RestockItem[] = activePackaging.map((p) => {
    const last = latestPack.get(p.id);
    return {
      id: p.id, name: p.name, unit: p.unit, perOrder: p.perOrder,
      packPrice: last ? satangToBahtInput(Math.round(last.price / last.packCount)) : "",
      perPack: last ? trimZeros(last.packQuantity / last.packCount) : "",
    };
  });

  const active = ingredients.filter((i) => i.isActive);
  const perUnit = active.filter((i) => i.costing === "per_unit").map((i) => {
    const last = latest.get(i.id);
    const lastUnitPrice = last?.quantity ? last.price / last.quantity : i.pricePerPurchaseUnit;
    return { id: i.id, name: i.name, purchaseUnit: i.purchaseUnit, baseUnit: i.baseUnit, unitsPerPurchaseUnit: i.unitsPerPurchaseUnit, unitPrice: bahtInput(lastUnitPrice) };
  });
  const pooled = active.filter((i) => i.costing === "pooled").map((i) => ({ id: i.id, name: i.name }));

  return <>
    <PageTitle
      eyebrow="ต้นทุนพื้นฐาน"
      title="วัตถุดิบและบรรจุภัณฑ์"
      description={activeTab === "packaging"
        ? "บันทึกราคาซื้อกล่อง ช้อน ถ้วยน้ำจิ้ม ระบบคำนวณต้นทุนต่อหน่วยให้อัตโนมัติ"
        : "บันทึกตอนซื้อของสด ระบบคำนวณต้นทุนต่อชิ้นและ % วัตถุดิบอื่นให้ แล้วใช้คิดต้นทุนเมนูอัตโนมัติ"}
    />
    <datalist id="pack-units">{PACK_UNITS.map((u) => <option key={u} value={u} />)}</datalist>

    {/* แถบสลับหมวด: วัตถุดิบ | บรรจุภัณฑ์ */}
    <div className="segmented-tab-nav" role="tablist" aria-label="เลือกหมวดหมู่">
      <Link
        href="/ingredients?tab=ingredients"
        className={`segmented-tab ${activeTab === "ingredients" ? "active" : ""}`}
        role="tab"
        aria-selected={activeTab === "ingredients"}
      >
        <span>วัตถุดิบ</span>
        <span className="tab-count-badge">{ingredients.length}</span>
      </Link>
      <Link
        href="/ingredients?tab=packaging"
        className={`segmented-tab ${activeTab === "packaging" ? "active" : ""}`}
        role="tab"
        aria-selected={activeTab === "packaging"}
      >
        <span>บรรจุภัณฑ์</span>
        <span className="tab-count-badge">{packaging.length}</span>
      </Link>
    </div>

    {activeTab === "ingredients" && (
      <div className="tab-pane">
        <div className="form-panels">
          <details className="panel form-panel" open={active.length > 0}>
            <summary><ShoppingBasket size={18} /> บันทึกการซื้อวัตถุดิบ</summary>
            {active.length
              ? <ActionForm action={recordIngredientPurchases} submitLabel="บันทึกการซื้อ">
                  <label>วันที่ซื้อ<input type="date" name="purchased_at" defaultValue={today} max={today} /></label>
                  <label>ร้านค้า (ไม่บังคับ)<input name="vendor" maxLength={120} placeholder="เช่น ตลาดสด" /></label>
                  <IngredientPurchaseTable key={perUnit.map((i) => `${i.id}:${i.unitPrice}:${i.unitsPerPurchaseUnit}`).join("|") + pooled.length} perUnit={perUnit} pooled={pooled} />
                </ActionForm>
              : <p className="muted-note">เพิ่มวัตถุดิบก่อน เช่น “ไก่” แบบนับต่อชิ้น และ “ข้าวสาร” “ผัก/เครื่องปรุง” แบบคิดเป็น %</p>}
          </details>
          <details className="panel form-panel" open={active.length === 0}>
            <summary><PackageOpen size={18} /> เพิ่มวัตถุดิบใหม่</summary>
            <ActionForm action={createIngredient} submitLabel="เพิ่มวัตถุดิบ">
              <label>ชื่อวัตถุดิบ<input name="name" maxLength={120} required placeholder="เช่น ไก่ หรือ ผักและเครื่องปรุง" /></label>
              <IngredientKindFields />
            </ActionForm>
          </details>
        </div>

        <section className="panel table-panel spaced">
          <div className="table-title">
            <h2>รายการวัตถุดิบ</h2>
            <span>{ingredients.length} รายการ · วัตถุดิบอื่นตอนนี้ {formatPercentBps(pooledRate.bps)} ของยอดขาย ({pooledRate.source === "actual" ? "จากยอดซื้อจริง" : "ค่าเริ่มต้นในตั้งค่า"})</span>
          </div>
          <table className="data-table">
            <thead><tr><th>ชื่อ</th><th>วิธีคิด</th><th className="num">ราคาซื้อ</th><th className="num">ต้นทุนต่อชิ้น</th><th>ซื้อล่าสุด</th><th>แก้ไข</th></tr></thead>
            <tbody>
              {ingredients.map((i) => {
                const last = latest.get(i.id);
                const perPiece = i.costing === "per_unit";
                return <tr key={i.id}>
                  <td><strong>{i.name}</strong></td>
                  <td><span className={`status ${perPiece ? "success" : "muted"}`}>{perPiece ? "นับต่อชิ้น" : "คิดเป็น %"}</span></td>
                  <td className="num">{perPiece
                    ? <>{i.pricePerPurchaseUnit ? `${formatUnitCost(i.pricePerPurchaseUnit)}/${i.purchaseUnit}` : "—"}<br />
                        <small className="muted">{i.unitsPerPurchaseUnit.toLocaleString("th-TH")} {i.baseUnit}/{i.purchaseUnit} · {i.yieldAuto ? "อัตโนมัติ" : "กำหนดเอง"}{i.yieldUpdatedAt ? ` · ปรับ ${formatThaiShortDate(i.yieldUpdatedAt)}` : ""}</small></>
                    : <small className="muted">รวมใน %</small>}</td>
                  <td className="num"><strong>{perPiece && i.unitCost ? `${formatUnitCost(i.unitCost)}/${i.baseUnit}` : "—"}</strong></td>
                  <td>{last ? <>{formatThaiShortDate(last.purchasedAt)}<br /><small className="muted">{formatBaht(last.price)}{last.quantity ? ` · ${last.quantity.toLocaleString("th-TH")} ${i.purchaseUnit}` : ""}</small></> : <span className="status pending">ยังไม่มีการซื้อ</span>}</td>
                  <td><details className="inline-details"><summary>แก้ไข</summary>
                    <ActionForm action={updateIngredient} submitLabel="บันทึก" className="form-grid compact" resetOnSuccess={false}>
                      <input type="hidden" name="id" value={i.id} />
                      <label>ชื่อ<input name="name" defaultValue={i.name} maxLength={120} required /></label>
                      {perPiece && <>
                        <label>{i.baseUnit} ต่อ 1 {i.purchaseUnit}<input name="units_per_purchase_unit" inputMode="decimal" defaultValue={trimZeros(i.unitsPerPurchaseUnit)} required /></label>
                        <label className="check-label"><input type="checkbox" name="yield_auto" value="true" defaultChecked={i.yieldAuto} /> ปรับอัตโนมัติจากยอดขาย</label>
                      </>}
                    </ActionForm>
                  </details></td>
                </tr>;
              })}
              {!ingredients.length && <tr><td colSpan={6}><div className="empty-state">ยังไม่มีวัตถุดิบ</div></td></tr>}
            </tbody>
          </table>
          <p className="table-footnote">นับต่อชิ้น: ราคาซื้อ = ราคาเฉลี่ยต่อ กก. 30 วันล่าสุด ÷ จำนวนชิ้นต่อ กก. · คิดเป็น %: ยอดซื้อ 30 วัน ÷ ยอดขายอาหาร (ใช้ค่าเริ่มต้นในหน้าตั้งค่า จนกว่าจะมีข้อมูล 7 วัน)</p>
        </section>

        {purchases.length > 0 && <section className="panel table-panel spaced">
          <div className="table-title"><h2><Box size={18} /> ประวัติการซื้อวัตถุดิบ</h2><span>20 รายการล่าสุด</span></div>
          <table className="data-table">
            <thead><tr><th>วันที่</th><th>วัตถุดิบ</th><th className="num">ปริมาณ</th><th className="num">ราคารวม</th><th className="num">ต่อหน่วย</th><th>ร้านค้า</th></tr></thead>
            <tbody>
              {purchases.map((p) => <tr key={p.id}>
                <td>{formatThaiShortDate(p.purchasedAt)}</td><td><strong>{p.ingredientName}</strong></td>
                <td className="num">{p.purchasedQuantity ? `${p.purchasedQuantity.toLocaleString("th-TH")} ${p.unit ?? ""}` : "—"}</td>
                <td className="num"><strong>{formatBaht(p.price)}</strong></td>
                <td className="num">{p.purchasedQuantity ? `${formatUnitCost(p.price / p.purchasedQuantity)}/${p.unit ?? "หน่วย"}` : "—"}</td>
                <td>{p.vendor ?? "—"}</td>
              </tr>)}
            </tbody>
          </table>
        </section>}
      </div>
    )}

    {activeTab === "packaging" && (
      <div className="tab-pane">
        <div className="form-panels">
          <details className="panel form-panel" open={activePackaging.length > 0}>
            <summary><ShoppingBasket size={18} /> บันทึกการซื้อบรรจุภัณฑ์</summary>
            {activePackaging.length
              ? <ActionForm action={restockPackaging} submitLabel="บันทึกการซื้อ">
                  <label>วันที่ซื้อ<input type="date" name="purchased_at" defaultValue={today} max={today} /></label>
                  <label>ร้านค้า (ไม่บังคับ)<input name="vendor" maxLength={120} placeholder="เช่น แม็คโคร" /></label>
                  <PackagingRestockTable key={restockItems.map((i) => `${i.id}:${i.packPrice}:${i.perPack}`).join("|")} items={restockItems} />
                  <p className="field-hint wide">กด + จำนวนแพ็กที่ซื้อ ราคา/แพ็กและจำนวนต่อแพ็กใช้ของครั้งก่อน แก้ได้ถ้าราคาเปลี่ยน</p>
                </ActionForm>
              : <p className="muted-note">เพิ่มบรรจุภัณฑ์ก่อน แล้วจึงบันทึกการซื้อครั้งถัดไปได้</p>}
          </details>
          <details className="panel form-panel" open={activePackaging.length === 0}>
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
      </div>
    )}
  </>;
}
