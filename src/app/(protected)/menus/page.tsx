import { ChefHat } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { ActionButton, ActionForm } from "@/components/action-form";
import { StepperInput } from "@/components/stepper-input";
import { deleteMenu, saveMenu, saveMenuRecipe, setMenuAvailability } from "@/app/actions/menus";
import { formatPercentBps, pooledCost } from "@/lib/analytics";
import { fetchIngredients, fetchMenus, fetchPackaging, fetchPooledRate, fetchRecipeItems } from "@/lib/data/queries";
import type { IngredientRecord, MenuRecord, PackagingRecord, RecipeItemRecord } from "@/lib/data/types";
import { ADDON_CATEGORY, DISH_CATEGORY, isAddonCategory } from "@/lib/data/types";
import { menuEmoji } from "@/lib/menu-emoji";
import { formatBaht, formatUnitCost, satangToBahtInput } from "@/lib/money";

function MenuFields({ menu }: { menu?: MenuRecord }) {
  const addon = menu ? isAddonCategory(menu.category) : false;
  return <>
    {menu && <input type="hidden" name="id" value={menu.id} />}
    <label>ชื่อเมนู<input name="name" defaultValue={menu?.name} maxLength={120} required placeholder="เช่น ข้าวไก่ต้มน้ำปลา" /></label>
    <label>ประเภท
      <select name="category" defaultValue={addon ? ADDON_CATEGORY : DISH_CATEGORY}>
        <option value={DISH_CATEGORY}>เมนูหลัก (นับเป็นกล่อง)</option>
        <option value={ADDON_CATEGORY}>ของเพิ่ม เช่น ไก่เพิ่ม ข้าวเปล่า</option>
      </select>
    </label>
    <label>ราคาขาย (บาท)<input name="price" inputMode="decimal" defaultValue={menu ? satangToBahtInput(menu.price) : ""} required placeholder="69" /></label>
    {!menu && <p className="field-hint wide">เมนูหลักใหม่ใส่บรรจุภัณฑ์ต่อออเดอร์ให้อย่างละ 1 อัตโนมัติ · ค่าแก๊ส/ค่าไฟลงเป็นค่าใช้จ่ายทีหลัง ไม่ต้องใส่ในเมนู</p>}
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
  const [menus, recipeItems, ingredients, packaging, pooledRate] = await Promise.all([fetchMenus(), fetchRecipeItems(), fetchIngredients(), fetchPackaging(), fetchPooledRate()]);
  const recipesByMenu = new Map<string, RecipeItemRecord[]>();
  for (const item of recipeItems) recipesByMenu.set(item.menuId, [...(recipesByMenu.get(item.menuId) ?? []), item]);
  const dishes = menus.filter((m) => !isAddonCategory(m.category));
  const addons = menus.filter((m) => isAddonCategory(m.category));

  const card = (menu: MenuRecord) => {
    const items = recipesByMenu.get(menu.id) ?? [];
    const pool = pooledCost(menu.price, pooledRate.bps);
    const total = menu.cost + pool;
    const profit = menu.price - total;
    const marginBps = menu.price ? Math.round((profit * 10_000) / menu.price) : 0;
    const fixedFood = Math.max(0, menu.cost - menu.packagingCost);
    return <article className={`menu-card ${menu.isAvailable ? "" : "is-off"}`} key={menu.id}>
      <div className="menu-card-head"><div className="menu-icon">{menuEmoji(menu.name, menu.category)}</div><span className={`status ${menu.isAvailable ? "success" : "muted"}`}>{menu.isAvailable ? "พร้อมขาย" : "ปิดการขาย"}</span></div>
      <h3>{menu.name}</h3>
      <p>{isAddonCategory(menu.category) ? "ของเพิ่ม · ไม่นับเป็นกล่อง" : "เมนูหลัก"}</p>
      <div className="menu-price"><div><span>ราคาขาย</span><strong>{formatBaht(menu.price)}</strong></div><div><span>ต้นทุน (ประมาณ)</span><strong>{formatBaht(total)}</strong></div></div>
      <p className="cost-split">ไก่/วัตถุดิบหลัก {formatBaht(fixedFood)} · บรรจุภัณฑ์ {formatBaht(menu.packagingCost)} · วัตถุดิบอื่น {formatPercentBps(pooledRate.bps)} = {formatBaht(pool)}</p>
      <div className={`menu-margin ${profit < 0 || marginBps < 2000 ? "warn" : ""}`}>{menu.cost === 0 ? "ยังไม่ได้ตั้งสูตร" : `กำไร ${formatBaht(profit)} · ${formatPercentBps(marginBps)}`}</div>
      <RecipeEditor menu={menu} items={items} ingredients={ingredients} packaging={packaging} />
      <details className="menu-details">
        <summary>แก้ไขเมนู</summary>
        <ActionForm action={saveMenu} submitLabel="บันทึก" className="form-grid compact" resetOnSuccess={false}><MenuFields menu={menu} /></ActionForm>
      </details>
      <div className="card-actions">
        <ActionButton action={setMenuAvailability} fields={{ id: menu.id, available: String(!menu.isAvailable) }} label={menu.isAvailable ? "ปิดการขาย" : "เปิดการขาย"} />
        <ActionButton action={deleteMenu} fields={{ id: menu.id }} label="ลบเมนู" confirmText={`ลบเมนู “${menu.name}”?`} className="link-button danger" />
      </div>
    </article>;
  };

  return <>
    <PageTitle eyebrow="สินค้า" title="เมนูและสูตรต้นทุน" description="ราคาขาย สูตรต่อกล่อง และกำไรโดยประมาณตามต้นทุนล่าสุด" />
    <details className="panel form-panel" open={menus.length === 0}>
      <summary><ChefHat size={18} /> สร้างเมนูใหม่</summary>
      <ActionForm action={saveMenu} submitLabel="สร้างเมนู"><MenuFields /></ActionForm>
    </details>
    <p className="muted-note">ต้นทุน = ไก่ตามจำนวนชิ้นในสูตร + บรรจุภัณฑ์ + วัตถุดิบอื่น {formatPercentBps(pooledRate.bps)} ของราคา ({pooledRate.source === "actual" ? "จากยอดซื้อจริง 30 วัน" : "ค่าเริ่มต้นในหน้าตั้งค่า"})</p>

    <h2 className="section-heading">เมนูหลัก</h2>
    <div className="section-grid">
      {dishes.map(card)}
      {!dishes.length && <div className="empty-state">ยังไม่มีเมนูหลัก — สร้างจากฟอร์มด้านบน</div>}
    </div>

    <h2 className="section-heading">ของเพิ่ม</h2>
    <div className="section-grid">
      {addons.map(card)}
      {!addons.length && <div className="empty-state">ยังไม่มีของเพิ่ม — สร้างเมนูแล้วเลือกประเภท “ของเพิ่ม” เช่น ไก่เพิ่ม ข้าวเปล่า</div>}
    </div>
  </>;
}
