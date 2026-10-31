import { ChefHat } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { ActionButton, ActionForm } from "@/components/action-form";
import { MenuImageField } from "@/components/menu-image-field";
import { StepperInput } from "@/components/stepper-input";
import { deleteMenu, saveMenu, saveMenuRecipe, setMenuAvailability } from "@/app/actions/menus";
import { formatPercentBps, pooledCost } from "@/lib/analytics";
import { fetchIngredients, fetchMenus, fetchPackaging, fetchPooledRate, fetchRecipeItems, fetchSaleSettings } from "@/lib/data/queries";
import type { IngredientRecord, MenuRecord, PackagingRecord, RecipeItemRecord } from "@/lib/data/types";
import { ADDON_CATEGORY, DISH_CATEGORY, SERVICE_CATEGORY, isAddonCategory, isDishCategory, isServiceCategory } from "@/lib/data/types";
import { formatBaht, formatUnitCost, satangToBahtInput } from "@/lib/money";

function MenuFields({ menu }: { menu?: MenuRecord }) {
  const isService = menu ? isServiceCategory(menu.category, menu.name) : false;
  const isAddon = menu ? (!isService && isAddonCategory(menu.category)) : false;
  const defaultCategory = isService ? SERVICE_CATEGORY : isAddon ? ADDON_CATEGORY : DISH_CATEGORY;
  return <>
    {menu && <input type="hidden" name="id" value={menu.id} />}
    <label>ชื่อเมนู / บริการ<input name="name" defaultValue={menu?.name} maxLength={120} required placeholder="เช่น ข้าวไก่ต้มน้ำปลา หรือ mj ส่งด่วน" /></label>
    <label>ประเภท
      <select name="category" defaultValue={defaultCategory}>
        <option value={DISH_CATEGORY}>เมนูหลัก (อาหาร · นับเป็นกล่อง)</option>
        <option value={ADDON_CATEGORY}>ของเพิ่ม เช่น ไก่เพิ่ม ข้าวเปล่า น้ำจิ้ม</option>
        <option value={SERVICE_CATEGORY}>จ็อบเสริม / บริการ (เช่น วิ่งส่งด่วน, ค่ารับหิ้ว)</option>
      </select>
    </label>
    <label>ราคาขาย / ค่าบริการ (บาท)<input name="price" inputMode="decimal" defaultValue={menu ? satangToBahtInput(menu.price) : ""} required placeholder="69" /></label>
    <MenuImageField currentImage={menu?.imagePath} />
    {!menu && <p className="field-hint wide">เมนูหลักใหม่ใส่บรรจุภัณฑ์ต่อออเดอร์ให้อัตโนมัติ · จ็อบเสริม/บริการไม่นับเป็นกล่องและไม่มีสูตรอาหาร</p>}
  </>;
}

type EditorRow = { key: string; name: string; unit: string; unitCost: number; quantity: number; note?: string };

function RecipeEditor({ menu, items, ingredients, packaging }: { menu: MenuRecord; items: RecipeItemRecord[]; ingredients: IngredientRecord[]; packaging: PackagingRecord[] }) {
  const qty = new Map<string, number>();
  for (const item of items) {
    const key = item.ingredientId ? `ing_${item.ingredientId}` : `pack_${item.packagingItemId}`;
    qty.set(key, (qty.get(key) ?? 0) + item.quantity);
  }
  const ingredientRows: EditorRow[] = ingredients
    .filter((i) => (i.costing === "per_unit" && i.isActive) || qty.has(`ing_${i.id}`))
    .map((i) => ({
      key: `ing_${i.id}`, name: i.name, unit: i.baseUnit, unitCost: i.costing === "per_unit" ? i.unitCost : 0, quantity: qty.get(`ing_${i.id}`) ?? 0,
      note: i.costing === "pooled" ? "คิดเป็น % แล้ว — ตั้งเป็น 0 ได้" : undefined,
    }));
  const packRows: EditorRow[] = packaging
    .filter((p) => (p.perOrder && p.isActive) || qty.has(`pack_${p.id}`))
    .map((p) => ({
      key: `pack_${p.id}`, name: p.name, unit: p.unit, unitCost: p.perOrder ? p.unitCost : 0, quantity: qty.get(`pack_${p.id}`) ?? 0,
      note: p.perOrder ? undefined : "ไม่คิดต่อออเดอร์",
    }));
  const rows = [...ingredientRows, ...packRows];
  const counted = rows.filter((r) => r.quantity > 0).length;

  return <details className="menu-details" open={items.length === 0 && rows.length > 0}>
    <summary>สูตรต่อ{isAddonCategory(menu.category) ? "ชิ้น" : "กล่อง"} {counted ? `(${counted} รายการ · ${formatBaht(menu.cost)})` : "(ยังไม่มี)"}</summary>
    {rows.length
      ? <ActionForm action={saveMenuRecipe} submitLabel="บันทึกสูตร" className="form-grid compact" resetOnSuccess={false}>
          <input type="hidden" name="menu_id" value={menu.id} />
          <div className="recipe-rows">
            {ingredientRows.length > 0 && <p className="recipe-group">วัตถุดิบ (นับต่อชิ้น)</p>}
            {ingredientRows.map((row) => <RecipeRow key={row.key} row={row} />)}
            {packRows.length > 0 && <p className="recipe-group">บรรจุภัณฑ์</p>}
            {packRows.map((row) => <RecipeRow key={row.key} row={row} />)}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.875rem", margin: "6px 0", cursor: "pointer" }}>
            <input type="checkbox" name="sync_past_sales" value="true" />
            <span>คำนวณต้นทุนย้อนหลังให้ออเดอร์เก่าที่เคยขายไปแล้วด้วย</span>
          </label>
          <p className="field-hint wide">{isAddonCategory(menu.category)
            ? "ของเพิ่ม: ไก่เพิ่ม = ไก่ 1 ชิ้น · ข้าวเปล่า = ช้อน 1 (ตอนขาย ช้อนคิดเป็น max(จำนวนกล่อง, ข้าวเปล่า))"
            : "เช่น เมนู 69 = ไก่ 5 ชิ้น · เมนู 89 = ไก่ 7 ชิ้น · กล่อง ช้อน ถ้วยน้ำจิ้ม อย่างละ 1"}</p>
        </ActionForm>
      : <p className="muted-note">เพิ่ม “ไก่” (นับต่อชิ้น) และบรรจุภัณฑ์ในหน้า “วัตถุดิบ” ก่อน แล้วจึงตั้งสูตรได้</p>}
  </details>;
}

function RecipeRow({ row }: { row: EditorRow }) {
  return <div className="recipe-row">
    <span><strong>{row.name}</strong><small>{row.note ?? (row.unitCost ? `${formatUnitCost(row.unitCost)}/${row.unit}` : "ยังไม่มีราคา")}</small></span>
    <StepperInput name={row.key} defaultValue={row.quantity} label={`${row.name} (${row.unit})`} />
    <small className="recipe-unit">{row.unit}</small>
  </div>;
}

export default async function MenusPage() {
  const [menus, recipeItems, ingredients, packaging, pooledRate, saleSettings] = await Promise.all([
    fetchMenus(), fetchRecipeItems(), fetchIngredients(), fetchPackaging(), fetchPooledRate(), fetchSaleSettings()
  ]);
  const showImages = saleSettings.showMenuImages ?? true;
  const recipesByMenu = new Map<string, RecipeItemRecord[]>();
  for (const item of recipeItems) recipesByMenu.set(item.menuId, [...(recipesByMenu.get(item.menuId) ?? []), item]);
  const dishes = menus.filter((m) => isDishCategory(m.category, m.name));
  const addons = menus.filter((m) => isAddonCategory(m.category) && !isServiceCategory(m.category, m.name));
  const services = menus.filter((m) => isServiceCategory(m.category, m.name));

  const card = (menu: MenuRecord) => {
    const isService = isServiceCategory(menu.category, menu.name);
    const isAddon = !isService && isAddonCategory(menu.category);
    const items = recipesByMenu.get(menu.id) ?? [];
    const pool = isService ? 0 : pooledCost(menu.price, pooledRate.bps);
    const total = menu.cost + pool;
    const profit = menu.price - total;
    const marginBps = menu.price ? Math.round((profit * 10_000) / menu.price) : 0;
    const fixedFood = Math.max(0, menu.cost - menu.packagingCost);
    return <article className={`menu-card ${menu.isAvailable ? "" : "is-off"}`} key={menu.id}>
      {showImages && menu.imagePath && (
        <div className="menu-card-photo-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={menu.imagePath} alt={menu.name} className="menu-card-photo" loading="lazy" />
        </div>
      )}
      <div className="menu-card-head">
        <span className={`category-pill ${isService ? "service" : ""}`}>
          {isService ? "จ็อบเสริม" : isAddon ? "ของเพิ่ม" : "เมนูหลัก"}
        </span>
        <span className={`status ${menu.isAvailable ? "success" : "muted"}`}>{menu.isAvailable ? "พร้อมขาย" : "ปิดการขาย"}</span>
      </div>
      <h3>{menu.name}</h3>
      <p>{isService ? "จ็อบเสริม / บริการ · ไม่นับเป็นกล่อง" : isAddon ? "ของเพิ่ม · ไม่นับเป็นกล่อง" : "เมนูหลัก"}</p>
      <div className="menu-price">
        <div><span>{isService ? "ค่าบริการ" : "ราคาขาย"}</span><strong>{formatBaht(menu.price)}</strong></div>
        <div><span>ต้นทุน (ประมาณ)</span><strong>{formatBaht(total)}</strong></div>
      </div>
      {!isService && (
        <p className="cost-split">ไก่/วัตถุดิบหลัก {formatBaht(fixedFood)} · บรรจุภัณฑ์ {formatBaht(menu.packagingCost)} · วัตถุดิบอื่น {formatPercentBps(pooledRate.bps)} = {formatBaht(pool)}</p>
      )}
      <div className={`menu-margin ${profit < 0 || marginBps < 2000 ? "warn" : ""}`}>
        {isService ? `กำไรขั้นต้น ${formatBaht(profit)}` : menu.cost === 0 ? "ยังไม่ได้ตั้งสูตร" : `กำไร ${formatBaht(profit)} · ${formatPercentBps(marginBps)}`}
      </div>
      {!isService ? (
        <RecipeEditor menu={menu} items={items} ingredients={ingredients} packaging={packaging} />
      ) : (
        <p className="muted-note" style={{ margin: "12px 0 6px" }}>งานบริการ/จ็อบเสริม — ไม่มีสูตรวัตถุดิบอาหารและบรรจุภัณฑ์</p>
      )}
      <details className="menu-details">
        <summary>แก้ไขรายการ</summary>
        <ActionForm action={saveMenu} submitLabel="บันทึก" className="form-grid compact" resetOnSuccess={false}><MenuFields menu={menu} /></ActionForm>
      </details>
      <div className="card-actions">
        <ActionButton action={setMenuAvailability} fields={{ id: menu.id, available: String(!menu.isAvailable) }} label={menu.isAvailable ? "ปิดการขาย" : "เปิดการขาย"} />
        <ActionButton action={deleteMenu} fields={{ id: menu.id }} label="ลบรายการ" confirmText={`ลบ “${menu.name}”?`} className="link-button danger" />
      </div>
    </article>;
  };

  return <>
    <PageTitle eyebrow="สินค้า" title="เมนูและสูตรต้นทุน" description="ราคาขาย สูตรต่อกล่อง และกำไรโดยประมาณตามต้นทุนล่าสุด" />
    <details className="panel form-panel" open={menus.length === 0}>
      <summary><ChefHat size={18} /> สร้างเมนู / จ็อบเสริมใหม่</summary>
      <ActionForm action={saveMenu} submitLabel="สร้างรายการ"><MenuFields /></ActionForm>
    </details>
    <p className="muted-note">ต้นทุนอาหาร = ไก่ตามจำนวนชิ้นในสูตร + บรรจุภัณฑ์ + วัตถุดิบอื่น {formatPercentBps(pooledRate.bps)} ของราคา ({pooledRate.source === "actual" ? "จากยอดซื้อจริง 30 วัน" : "ค่าเริ่มต้นในหน้าตั้งค่า"})</p>

    <h2 className="section-heading">เมนูหลัก (อาหาร)</h2>
    <div className="section-grid">
      {dishes.map(card)}
      {!dishes.length && <div className="empty-state">ยังไม่มีเมนูหลัก — สร้างจากฟอร์มด้านบน</div>}
    </div>

    <h2 className="section-heading">ของเพิ่ม</h2>
    <div className="section-grid">
      {addons.map(card)}
      {!addons.length && <div className="empty-state">ยังไม่มีของเพิ่ม — สร้างเมนูแล้วเลือกประเภท “ของเพิ่ม” เช่น ไก่เพิ่ม ข้าวเปล่า</div>}
    </div>

    <h2 className="section-heading">จ็อบเสริม / บริการ</h2>
    <p className="muted-note" style={{ marginTop: "-6px", marginBottom: "12px" }}>
      รายการบริการประจำ เช่น ค่าวิ่งส่งด่วน ค่ารับหิ้ว จะแสดงในหน้าเปิดบิลถาวรโดยไม่ต้องพิมพ์ซ้ำทุกรอบ และไม่นับเป็นกล่องอาหาร
    </p>
    <div className="section-grid">
      {services.map(card)}
      {!services.length && (
        <div className="empty-state">
          ยังไม่มีจ็อบเสริม — สร้างรายการใหม่แล้วเลือกประเภท “จ็อบเสริม / บริการ” เช่น “mj ส่งด่วน” หรือ “ค่ารับหิ้ว” เพื่อไว้กดเลือกในหน้าเปิดบิลได้ตลอด
        </div>
      )}
    </div>
  </>;
}
