import { ChefHat } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { ActionButton, ActionForm } from "@/components/action-form";
import { MenuImageField } from "@/components/menu-image-field";
import { RecipeEditorForm, type EditorIngredientRow, type EditorPackRow } from "@/components/recipe-editor-form";
import { deleteMenu, saveMenu, setMenuAvailability } from "@/app/actions/menus";
import { formatPercentBps, pooledCost, recipeIngredientBreakdown } from "@/lib/analytics";
import { fetchIngredients, fetchMenus, fetchPackaging, fetchPooledRate, fetchRecipeItems, fetchSaleSettings } from "@/lib/data/queries";
import type { IngredientRecord, MenuRecord, PackagingRecord, RecipeItemRecord } from "@/lib/data/types";
import { ADDON_CATEGORY, DEFAULT_UNIT_LABEL, DISH_CATEGORY, SERVICE_CATEGORY, isAddonCategory, isDishCategory, isServiceCategory } from "@/lib/data/types";
import { formatBaht, satangToBahtInput } from "@/lib/money";

function MenuFields({ menu, unitLabel }: { menu?: MenuRecord; unitLabel: string }) {
  const isService = menu ? isServiceCategory(menu.category, menu.name) : false;
  const isAddon = menu ? (!isService && isAddonCategory(menu.category)) : false;
  const defaultCategory = isService ? SERVICE_CATEGORY : isAddon ? ADDON_CATEGORY : DISH_CATEGORY;
  return <>
    {menu && <input type="hidden" name="id" value={menu.id} />}
    <label>ชื่อเมนู / ท็อปปิ้ง / บริการ<input name="name" defaultValue={menu?.name} maxLength={120} required placeholder="เช่น ชื่อเมนูอาหาร, เครื่องดื่ม, ท็อปปิ้งเพิ่ม, ค่าส่งด่วน" /></label>
    <label>ประเภท
      <select name="category" defaultValue={defaultCategory}>
        <option value={DISH_CATEGORY}>เมนูหลัก (สินค้าหลักของร้าน · นับเป็น{unitLabel})</option>
        <option value={ADDON_CATEGORY}>ท็อปปิ้ง / ไส้เพิ่ม / ของเพิ่ม (ไม่นับเป็น{unitLabel}หลัก)</option>
        <option value={SERVICE_CATEGORY}>จ็อบเสริม / บริการ (เช่น วิ่งส่งด่วน, ค่ารับหิ้ว)</option>
      </select>
    </label>
    <label>ราคาขาย / ค่าบริการ (บาท)<input name="price" inputMode="decimal" defaultValue={menu ? satangToBahtInput(menu.price) : ""} required placeholder="69" /></label>
    <MenuImageField currentImage={menu?.imagePath} />
    {!menu && <p className="field-hint wide">เพิ่มเมนูแล้ว ตั้งสูตรปริมาณวัตถุดิบ (กรัม/มล./ชิ้น) ในการ์ดของเมนูนั้นได้เลย · ท็อปปิ้งและจ็อบเสริมไม่นับรวมเป็นจำนวน{unitLabel}หลัก</p>}
  </>;
}

function RecipeEditor({
  menu,
  items,
  ingredients,
  packaging,
  pooledBps,
  unitLabel,
}: {
  menu: MenuRecord;
  items: RecipeItemRecord[];
  ingredients: IngredientRecord[];
  packaging: PackagingRecord[];
  pooledBps: number;
  unitLabel: string;
}) {
  const qty = new Map<string, number>();
  for (const item of items) {
    const key = item.ingredientId ? `ing_${item.ingredientId}` : `pack_${item.packagingItemId}`;
    qty.set(key, (qty.get(key) ?? 0) + item.quantity);
  }
  const ingredientRows: EditorIngredientRow[] = ingredients
    .filter((i) => (i.costing === "per_unit" && i.isActive) || qty.has(`ing_${i.id}`))
    .map((i) => ({
      id: i.id,
      key: `ing_${i.id}`,
      name: i.name,
      unit: i.baseUnit,
      unitCost: i.costing === "per_unit" ? i.unitCost : 0,
      quantity: qty.get(`ing_${i.id}`) ?? 0,
      costing: i.costing,
      note: i.costing === "pooled" ? "คิดเป็น % แล้ว — ตั้งเป็น 0 ได้" : undefined,
    }));
  const packRows: EditorPackRow[] = packaging
    .filter((p) => (p.perOrder && p.isActive) || qty.has(`pack_${p.id}`))
    .map((p) => ({
      id: p.id,
      key: `pack_${p.id}`,
      name: p.name,
      unit: p.unit,
      unitCost: p.perOrder ? p.unitCost : 0,
      quantity: qty.get(`pack_${p.id}`) ?? 0,
      note: p.perOrder ? undefined : "ไม่คิดต่อออเดอร์",
    }));
  const rows = [...ingredientRows, ...packRows];
  const counted = rows.filter((r) => r.quantity > 0).length;
  const serveUnit = isAddonCategory(menu.category) ? "ชิ้น" : unitLabel;

  return <details className="menu-details" open={items.length === 0 && rows.length > 0}>
    <summary>
      สูตรต่อ{serveUnit} {counted ? `(${counted} รายการ · ${formatBaht(menu.cost)})` : "(ยังไม่มี)"}
    </summary>
    {rows.length
      ? <RecipeEditorForm
          menu={menu}
          ingredientRows={ingredientRows}
          packRows={packRows}
          ingredients={ingredients}
          pooledBps={pooledBps}
          unitLabel={unitLabel}
        />
      : <p className="muted-note">เพิ่มวัตถุดิบและบรรจุภัณฑ์ในหน้า “วัตถุดิบ” ก่อน แล้วจึงตั้งสูตรได้</p>}
  </details>;
}

export default async function MenusPage() {
  const [menus, recipeItems, ingredients, packaging, pooledRate, saleSettings] = await Promise.all([
    fetchMenus(), fetchRecipeItems(), fetchIngredients(), fetchPackaging(), fetchPooledRate(), fetchSaleSettings()
  ]);
  const showImages = saleSettings.showMenuImages ?? true;
  const unitLabel = saleSettings.unitLabel || DEFAULT_UNIT_LABEL;
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
    const breakdownRows = !isService ? recipeIngredientBreakdown(items, ingredients, menu.recipeYield).rows : [];

    return <article className={`menu-card ${menu.isAvailable ? "" : "is-off"}`} key={menu.id}>
      {showImages && menu.imagePath && (
        <div className="menu-card-photo-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={menu.imagePath} alt={menu.name} className="menu-card-photo" loading="lazy" />
        </div>
      )}
      <div className="menu-card-head">
        <span className={`category-pill ${isService ? "service" : ""}`}>
          {isService ? "จ็อบเสริม" : isAddon ? "ท็อปปิ้ง / ของเพิ่ม" : "เมนูหลัก"}
        </span>
        <span className={`status ${menu.isAvailable ? "success" : "muted"}`}>{menu.isAvailable ? "พร้อมขาย" : "ปิดการขาย"}</span>
      </div>
      <h3>{menu.name}</h3>
      <p>{isService ? `จ็อบเสริม / บริการ · ไม่นับเป็น${unitLabel}` : isAddon ? `ท็อปปิ้ง / ของเพิ่ม · ไม่นับเป็น${unitLabel}` : `เมนูหลัก · นับเป็น${unitLabel}`}</p>
      <div className="menu-price">
        <div><span>{isService ? "ค่าบริการ" : "ราคาขาย"}</span><strong>{formatBaht(menu.price)}</strong></div>
        <div><span>ต้นทุน (ประมาณ)</span><strong>{formatBaht(total)}</strong></div>
      </div>
      {!isService && (
        <>
          <p className="cost-split">
            วัตถุดิบตามสูตร {formatBaht(fixedFood)} · บรรจุภัณฑ์ {formatBaht(menu.packagingCost)} · วัตถุดิบอื่น {formatPercentBps(pooledRate.bps)} = {formatBaht(pool)}
          </p>
          {breakdownRows.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
              {breakdownRows.map((b) => (
                <span
                  key={b.ingredientId}
                  style={{
                    fontSize: "0.75rem",
                    background: "var(--surface-subtle, rgba(0,0,0,0.04))",
                    padding: "2px 8px",
                    borderRadius: 999,
                    color: "var(--text-muted, #555)",
                  }}
                >
                  {b.name} {b.perServingQuantity.toLocaleString("th-TH", { maximumFractionDigits: 2 })} {b.baseUnit} ({formatBaht(b.perServingCost)} · ทุน {formatPercentBps(b.costShareBps)})
                </span>
              ))}
            </div>
          )}
        </>
      )}
      <div className={`menu-margin ${profit < 0 || marginBps < 2000 ? "warn" : ""}`}>
        {isService ? `กำไรขั้นต้น ${formatBaht(profit)}` : menu.cost === 0 ? "ยังไม่ได้ตั้งสูตร" : `กำไร ${formatBaht(profit)} · ${formatPercentBps(marginBps)}`}
      </div>
      {!isService ? (
        <RecipeEditor
          menu={menu}
          items={items}
          ingredients={ingredients}
          packaging={packaging}
          pooledBps={pooledRate.bps}
          unitLabel={unitLabel}
        />
      ) : (
        <p className="muted-note" style={{ margin: "12px 0 6px" }}>งานบริการ/จ็อบเสริม — ไม่มีสูตรวัตถุดิบอาหารและบรรจุภัณฑ์</p>
      )}
      <details className="menu-details">
        <summary>แก้ไขรายการ</summary>
        <ActionForm action={saveMenu} submitLabel="บันทึก" className="form-grid compact" resetOnSuccess={false}>
          <MenuFields menu={menu} unitLabel={unitLabel} />
        </ActionForm>
      </details>
      <div className="card-actions">
        <ActionButton action={setMenuAvailability} fields={{ id: menu.id, available: String(!menu.isAvailable) }} label={menu.isAvailable ? "ปิดการขาย" : "เปิดการขาย"} />
        <ActionButton action={deleteMenu} fields={{ id: menu.id }} label="ลบรายการ" confirmText={`ลบ “${menu.name}”?`} className="link-button danger" />
      </div>
    </article>;
  };

  return <>
    <PageTitle eyebrow="สินค้า" title="เมนูและสูตรต้นทุน" description={`ราคาขาย สูตรวัตถุดิบต่อ${unitLabel} (กรัม/มล./ชิ้น) และสัดส่วนต้นทุนกำไรอัตโนมัติ`} />
    <details className="panel form-panel" open={menus.length === 0}>
      <summary><ChefHat size={18} /> สร้างเมนู / ท็อปปิ้ง / จ็อบเสริมใหม่</summary>
      <ActionForm action={saveMenu} submitLabel="สร้างรายการ"><MenuFields unitLabel={unitLabel} /></ActionForm>
    </details>
    <p className="muted-note">
      ต้นทุนอาหาร = วัตถุดิบตามปริมาณในสูตร (กรัม/มล./ชิ้น) + บรรจุภัณฑ์ + วัตถุดิบอื่น {formatPercentBps(pooledRate.bps)} ของราคา ({pooledRate.source === "actual" ? "จากยอดซื้อจริง 30 วัน" : "ค่าเริ่มต้นในหน้าตั้งค่า"})
    </p>

    <h2 className="section-heading">เมนูหลัก</h2>
    <div className="section-grid">
      {dishes.map(card)}
      {!dishes.length && <div className="empty-state">ยังไม่มีเมนูหลัก — สร้างจากฟอร์มด้านบน</div>}
    </div>

    <h2 className="section-heading">ท็อปปิ้ง / ไส้เพิ่ม / ของเพิ่ม</h2>
    <div className="section-grid">
      {addons.map(card)}
      {!addons.length && <div className="empty-state">ยังไม่มีท็อปปิ้งหรือของเพิ่ม — สร้างเมนูแล้วเลือกประเภท “ท็อปปิ้ง / ไส้เพิ่ม / ของเพิ่ม”</div>}
    </div>

    <h2 className="section-heading">จ็อบเสริม / บริการ</h2>
    <p className="muted-note" style={{ marginTop: "-6px", marginBottom: "12px" }}>
      รายการบริการประจำ เช่น ค่าวิ่งส่งด่วน ค่ารับหิ้ว จะแสดงในหน้าเปิดบิลถาวรโดยไม่ต้องพิมพ์ซ้ำทุกรอบ และไม่นับเป็น{unitLabel}หลัก
    </p>
    <div className="section-grid">
      {services.map(card)}
      {!services.length && (
        <div className="empty-state">
          ยังไม่มีจ็อบเสริม — สร้างรายการใหม่แล้วเลือกประเภท “จ็อบเสริม / บริการ” เพื่อไว้กดเลือกในหน้าเปิดบิลได้ตลอด
        </div>
      )}
    </div>
  </>;
}
