import { ChefHat } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { ActionButton, ActionForm } from "@/components/action-form";
import { addRecipeItem, deleteMenu, removeRecipeItem, saveMenu, setMenuAvailability } from "@/app/actions/menus";
import { formatPercentBps, recipeMaterialCost } from "@/lib/analytics";
import { fetchIngredients, fetchMenus, fetchPackaging, fetchRecipeItems } from "@/lib/data/queries";
import type { IngredientRecord, MenuRecord, PackagingRecord, RecipeItemRecord } from "@/lib/data/types";
import { ADDON_CATEGORY, isAddonCategory } from "@/lib/data/types";
import { menuEmoji } from "@/lib/menu-emoji";
import { formatBaht, formatUnitCost, satangToBahtInput } from "@/lib/money";

const CATEGORIES = ["เมนูหลัก", "กับข้าว", ADDON_CATEGORY, "เครื่องดื่ม", "ของหวาน"];

function MenuFields({ menu, hasRecipe }: { menu?: MenuRecord; hasRecipe: boolean }) {
  return <>
    {menu && <input type="hidden" name="id" value={menu.id} />}
    <label>ชื่อเมนู<input name="name" defaultValue={menu?.name} maxLength={120} required placeholder="เช่น ข้าวไก่ต้มน้ำปลา" /></label>
    <label>หมวดหมู่<input name="category" defaultValue={menu?.category ?? "เมนูหลัก"} list="menu-categories" maxLength={60} required />
      <small className="field-hint">ของเพิ่ม เช่น ไก่เพิ่ม ข้าวเปล่า ให้ใช้หมวด “{ADDON_CATEGORY}”</small>
    </label>
    <label>ราคาขาย (บาท)<input name="price" inputMode="decimal" defaultValue={menu ? satangToBahtInput(menu.price) : ""} required placeholder="69" /></label>
    <label>ต้นทุนอาหาร/จาน (บาท · ไม่รวมบรรจุภัณฑ์)
      <input name="food_cost" inputMode="decimal" defaultValue={menu?.manualFoodCost ? satangToBahtInput(menu.manualFoodCost) : ""} placeholder="เช่น 25 (ไก่ + ข้าว + น้ำจิ้ม)" />
      <small className="field-hint">{hasRecipe ? "บวกเพิ่มจากวัตถุดิบในสูตร — เว้นว่างได้ถ้าใส่วัตถุดิบครบแล้ว" : "ประมาณได้ กล่อง/ช้อนให้ใส่ใน “สูตรต้นทุน” ด้านล่าง"}</small>
    </label>
    <label>ค่าแรง/จาน (บาท)<input name="labor" inputMode="decimal" defaultValue={menu?.laborCost ? satangToBahtInput(menu.laborCost) : ""} placeholder="0" /></label>
    <label>ค่าโสหุ้ย/จาน เช่น แก๊ส ไฟ (บาท)<input name="overhead" inputMode="decimal" defaultValue={menu?.overheadCost ? satangToBahtInput(menu.overheadCost) : ""} placeholder="0" /></label>
  </>;
}

function RecipeSection({ menu, items, ingredients, packaging }: { menu: MenuRecord; items: RecipeItemRecord[]; ingredients: IngredientRecord[]; packaging: PackagingRecord[] }) {
  const ingredientById = new Map(ingredients.map((i) => [i.id, i]));
  const packagingById = new Map(packaging.map((p) => [p.id, p]));
  const perOrder = packaging.filter((p) => p.perOrder);
  const material = recipeMaterialCost(items, new Map(ingredients.map((i) => [i.id, i.unitCost])), new Map(perOrder.map((p) => [p.id, p.unitCost])));
  return <details className="menu-details" open={items.length === 0 && perOrder.length > 0}>
    <summary>สูตรต้นทุน / บรรจุภัณฑ์ {items.length ? `(${items.length} รายการ · ${formatBaht(material)})` : "(ยังไม่มี)"}</summary>
    {items.length > 0 && <ul className="recipe-list">
      {items.map((item) => {
        const ing = item.ingredientId ? ingredientById.get(item.ingredientId) : undefined;
        const pack = item.packagingItemId ? packagingById.get(item.packagingItemId) : undefined;
        const name = ing?.name ?? pack?.name ?? "รายการที่ถูกลบ";
        const unit = ing?.baseUnit ?? pack?.unit ?? "";
        const counted = !pack || pack.perOrder;
        const cost = counted ? Math.round(item.quantity * (ing?.unitCost ?? pack?.unitCost ?? 0)) : 0;
        return <li key={item.id}><span>{pack ? "📦 " : ""}{name}<small>{item.quantity.toLocaleString("th-TH")} {unit}{counted ? "" : " · ไม่คิดต่อออเดอร์"}</small></span><strong>{formatBaht(cost)}</strong><ActionButton action={removeRecipeItem} fields={{ id: item.id, menu_id: menu.id }} label="ลบ" className="link-button danger" /></li>;
      })}
    </ul>}
    {ingredients.length + perOrder.length > 0
      ? <ActionForm action={addRecipeItem} submitLabel="เพิ่มในสูตร" className="form-grid compact">
          <input type="hidden" name="menu_id" value={menu.id} />
          <label>บรรจุภัณฑ์ / วัตถุดิบ<select name="item" required defaultValue="">
            <option value="" disabled>เลือก…</option>
            {perOrder.length > 0 && <optgroup label="บรรจุภัณฑ์ (คิดต่อจาน)">{perOrder.map((p) => <option key={p.id} value={`packaging:${p.id}`}>{p.name} ({formatUnitCost(p.unitCost)}/{p.unit})</option>)}</optgroup>}
            {ingredients.length > 0 && <optgroup label="วัตถุดิบ">{ingredients.map((i) => <option key={i.id} value={`ingredient:${i.id}`}>{i.name} ({formatUnitCost(i.unitCost)}/{i.baseUnit})</option>)}</optgroup>}
          </select></label>
          <label>จำนวนต่อจาน<input name="quantity" inputMode="decimal" required defaultValue="1" /></label>
          <p className="field-hint wide">บรรจุภัณฑ์ในสูตร = ค่าเริ่มต้นต่อจาน ตอนขายระบบนับให้ และกด +/− แก้ได้ถ้าให้ไม่ตรง</p>
        </ActionForm>
      : <p className="muted-note">เพิ่มบรรจุภัณฑ์ (เช่น กล่อง ช้อน) ในหน้า “วัตถุดิบ” ก่อน แล้วจึงใส่ในสูตรได้</p>}
  </details>;
}

export default async function MenusPage() {
  const [menus, recipeItems, ingredients, packaging] = await Promise.all([fetchMenus(), fetchRecipeItems(), fetchIngredients(), fetchPackaging()]);
  const recipesByMenu = new Map<string, RecipeItemRecord[]>();
  for (const item of recipeItems) recipesByMenu.set(item.menuId, [...(recipesByMenu.get(item.menuId) ?? []), item]);

  return <>
    <PageTitle eyebrow="สินค้า" title="เมนูและสูตรต้นทุน" description="ราคาขาย สูตร และกำไรต่อกล่องตามต้นทุนล่าสุด" />
    <datalist id="menu-categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
    <details className="panel form-panel" open={menus.length === 0}>
      <summary><ChefHat size={18} /> สร้างเมนูใหม่</summary>
      <ActionForm action={saveMenu} submitLabel="สร้างเมนู"><MenuFields hasRecipe={false} /></ActionForm>
    </details>
    <div className="section-grid spaced">
      {menus.map((menu) => {
        const items = recipesByMenu.get(menu.id) ?? [];
        const profit = menu.price - menu.cost;
        const marginBps = menu.price ? Math.round((profit * 10_000) / menu.price) : 0;
        return <article className={`menu-card ${menu.isAvailable ? "" : "is-off"}`} key={menu.id}>
          <div className="menu-card-head"><div className="menu-icon">{menuEmoji(menu.name, menu.category)}</div><span className={`status ${menu.isAvailable ? "success" : "muted"}`}>{menu.isAvailable ? "พร้อมขาย" : "ปิดการขาย"}</span></div>
          <h3>{menu.name}</h3>
          <p>{menu.category}{isAddonCategory(menu.category) ? " · ปุ่มเล็กตอนขาย" : ""}</p>
          <div className="menu-price"><div><span>ราคาขาย</span><strong>{formatBaht(menu.price)}</strong></div><div><span>ต้นทุน/จาน</span><strong>{formatBaht(menu.cost)}</strong></div></div>
          {menu.cost > 0 && <p className="cost-split">อาหาร {formatBaht(Math.max(0, menu.cost - menu.packagingCost - menu.laborCost - menu.overheadCost))} · บรรจุภัณฑ์ {formatBaht(menu.packagingCost)}{menu.laborCost + menu.overheadCost > 0 ? ` · อื่น ๆ ${formatBaht(menu.laborCost + menu.overheadCost)}` : ""}</p>}
          <div className={`menu-margin ${profit < 0 || marginBps < 2000 ? "warn" : ""}`}>{menu.cost === 0 ? "ยังไม่ได้ใส่ต้นทุน" : `กำไร ${formatBaht(profit)} · ${formatPercentBps(marginBps)}`}</div>
          <RecipeSection menu={menu} items={items} ingredients={ingredients} packaging={packaging} />
          <details className="menu-details">
            <summary>แก้ไขเมนู</summary>
            <ActionForm action={saveMenu} submitLabel="บันทึก" className="form-grid compact" resetOnSuccess={false}><MenuFields menu={menu} hasRecipe={items.length > 0} /></ActionForm>
          </details>
          <div className="card-actions">
            <ActionButton action={setMenuAvailability} fields={{ id: menu.id, available: String(!menu.isAvailable) }} label={menu.isAvailable ? "ปิดการขาย" : "เปิดการขาย"} />
            <ActionButton action={deleteMenu} fields={{ id: menu.id }} label="ลบเมนู" confirmText={`ลบเมนู “${menu.name}”?`} className="link-button danger" />
          </div>
        </article>;
      })}
      {!menus.length && <div className="empty-state">ยังไม่มีเมนู — สร้างเมนูแรกจากฟอร์มด้านบน</div>}
    </div>
  </>;
}
