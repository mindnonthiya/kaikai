// Server-side data access. Reads through the signed-in user's session, so Row Level Security limits rows to that user.
// When Supabase is not configured every function returns empty data (there is no sample data).
import { hasSupabaseEnv } from "@/lib/env";
import { SCHEMA_OUTDATED_CODES, SCHEMA_OUTDATED_MESSAGE } from "@/lib/server-action";
import { createClient } from "@/lib/supabase/server";
import type {
  ExpenseKind, ExpenseRecord, Fulfillment, IngredientRecord, MenuRecord, PackagingPurchaseRecord, PackagingRecord, PaymentMethod, PaymentStatus,
  ProfileRecord, PurchaseRecord, RecipeItemRecord, SaleRecord, SaleSettings, SaleStatus,
} from "./types";

type Row = Record<string, unknown>;
const PAGE_SIZE = 1000; // matches the Data API max_rows default

/** Used until the owner sets their own delivery fee in Settings. */
export const DEFAULT_DELIVERY_FEE_SATANG = 1500;
const SALE_SETTINGS_KEY = "sales";

const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const str = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const strOrNull = (value: unknown) => (value === null || value === undefined || value === "" ? null : String(value));
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const one = (value: unknown) => (Array.isArray(value) ? value[0] : value) as Row | null | undefined;

function fail(what: string, error: { message: string; code?: string }): never {
  if (error.code && SCHEMA_OUTDATED_CODES.has(error.code)) throw new Error(`โหลด${what}ไม่สำเร็จ: ${SCHEMA_OUTDATED_MESSAGE}`);
  throw new Error(`โหลด${what}ไม่สำเร็จ: ${error.message}`);
}

/** Reads every page of a query (the Data API returns at most 1000 rows per request). */
async function fetchAll(what: string, build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>) {
  const all: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) fail(what, error);
    const page = rows(data);
    all.push(...page);
    if (page.length < PAGE_SIZE) return all;
  }
}

const SALE_COLUMNS = "id,sale_number,sold_at,status,payment_status,customer_name,notes,fulfillment,product_revenue_satang,discount_satang,delivery_charged_satang,payment_fee_satang,packaging_cost_satang,net_revenue_satang,cogs_satang,gross_profit_satang,sale_items(menu_id,menu_name_snapshot,menu_category_snapshot,quantity,line_revenue_satang,line_cost_satang),payments(method,amount_satang)";

function mapSale(row: Row): SaleRecord {
  return {
    id: str(row.id),
    saleNumber: num(row.sale_number),
    soldAt: str(row.sold_at),
    status: str(row.status) as SaleStatus,
    paymentStatus: str(row.payment_status) as PaymentStatus,
    customerName: strOrNull(row.customer_name),
    notes: strOrNull(row.notes),
    fulfillment: (str(row.fulfillment) || "pickup") as Fulfillment,
    productRevenue: num(row.product_revenue_satang),
    discount: num(row.discount_satang),
    delivery: num(row.delivery_charged_satang),
    fee: num(row.payment_fee_satang),
    packagingCost: num(row.packaging_cost_satang),
    netRevenue: num(row.net_revenue_satang),
    cogs: num(row.cogs_satang),
    grossProfit: num(row.gross_profit_satang),
    items: rows(row.sale_items).map((item) => ({
      menuId: str(item.menu_id),
      name: str(item.menu_name_snapshot),
      category: strOrNull(item.menu_category_snapshot),
      quantity: num(item.quantity),
      revenue: num(item.line_revenue_satang),
      cost: num(item.line_cost_satang),
    })),
    payments: rows(row.payments).map((payment) => ({ method: str(payment.method) as PaymentMethod, amount: num(payment.amount_satang) })),
  };
}

/** Sales with sold_at in [start, end), newest first. */
export async function fetchSales(start: Date, end: Date): Promise<SaleRecord[]> {
  if (!hasSupabaseEnv) return [];
  const supabase = await createClient();
  const data = await fetchAll("ข้อมูลการขาย", (from, to) =>
    supabase.from("sales").select(SALE_COLUMNS).gte("sold_at", start.toISOString()).lt("sold_at", end.toISOString())
      .order("sold_at", { ascending: false }).range(from, to));
  return data.map(mapSale);
}

function mapExpense(row: Row): ExpenseRecord {
  return {
    id: str(row.id),
    spentAt: str(row.spent_at),
    category: str(row.category),
    kind: str(row.kind) as ExpenseKind,
    amount: num(row.amount_satang),
    description: str(row.description),
    payee: strOrNull(row.payee),
    paymentMethod: strOrNull(row.payment_method) as PaymentMethod | null,
  };
}

/** Expenses with spent_at in [start, end), newest first. */
export async function fetchExpenses(start: Date, end: Date): Promise<ExpenseRecord[]> {
  if (!hasSupabaseEnv) return [];
  const supabase = await createClient();
  const data = await fetchAll("ค่าใช้จ่าย", (from, to) =>
    supabase.from("expenses").select("id,spent_at,category,kind,amount_satang,description,payee,payment_method")
      .gte("spent_at", start.toISOString()).lt("spent_at", end.toISOString()).order("spent_at", { ascending: false }).range(from, to));
  return data.map(mapExpense);
}

export function mapMenu(row: Row): MenuRecord {
  return {
    id: str(row.id),
    name: str(row.name),
    category: str(row.category),
    price: num(row.selling_price_satang),
    laborCost: num(row.labor_cost_satang),
    overheadCost: num(row.overhead_cost_satang),
    manualFoodCost: num(row.manual_food_cost_satang),
    packagingCost: num(row.packaging_cost_satang),
    cost: num(row.current_cost_satang),
    isAvailable: Boolean(row.is_available),
    costCalculatedAt: strOrNull(row.cost_calculated_at),
  };
}

export async function fetchMenus(): Promise<MenuRecord[]> {
  if (!hasSupabaseEnv) return [];
  const supabase = await createClient();
  const data = await fetchAll("เมนู", (from, to) =>
    supabase.from("menus").select("id,name,category,selling_price_satang,labor_cost_satang,overhead_cost_satang,manual_food_cost_satang,packaging_cost_satang,current_cost_satang,is_available,cost_calculated_at")
      .order("category").order("name").range(from, to));
  return data.map(mapMenu);
}

export async function fetchIngredients(): Promise<IngredientRecord[]> {
  if (!hasSupabaseEnv) return [];
  const supabase = await createClient();
  const data = await fetchAll("วัตถุดิบ", (from, to) =>
    supabase.from("ingredients").select("id,name,category,base_unit,weighted_unit_cost_satang,is_active").order("category").order("name").range(from, to));
  return data.map((row) => ({ id: str(row.id), name: str(row.name), category: str(row.category), baseUnit: str(row.base_unit), unitCost: num(row.weighted_unit_cost_satang), isActive: Boolean(row.is_active) }));
}

export async function fetchPackaging(): Promise<PackagingRecord[]> {
  if (!hasSupabaseEnv) return [];
  const supabase = await createClient();
  const data = await fetchAll("บรรจุภัณฑ์", (from, to) =>
    supabase.from("packaging_items").select("id,name,unit,unit_cost_satang,is_active,per_order").order("name").range(from, to));
  return data.map((row) => ({
    id: str(row.id), name: str(row.name), unit: str(row.unit), unitCost: num(row.unit_cost_satang),
    isActive: Boolean(row.is_active), perOrder: row.per_order !== false,
  }));
}

/** All packaging purchases, newest first. */
export async function fetchPackagingPurchases(): Promise<PackagingPurchaseRecord[]> {
  if (!hasSupabaseEnv) return [];
  const supabase = await createClient();
  const data = await fetchAll("ประวัติการซื้อบรรจุภัณฑ์", (from, to) =>
    supabase.from("packaging_purchases").select("id,packaging_item_id,purchased_at,price_satang,pack_quantity,vendor,expense_id,packaging_items(name,unit)")
      .order("purchased_at", { ascending: false }).order("created_at", { ascending: false }).range(from, to));
  return data.map((row) => {
    const item = one(row.packaging_items);
    return {
      id: str(row.id), packagingItemId: str(row.packaging_item_id), itemName: str(item?.name), unit: str(item?.unit),
      purchasedAt: str(row.purchased_at), price: num(row.price_satang), packQuantity: num(row.pack_quantity),
      vendor: strOrNull(row.vendor), expenseId: strOrNull(row.expense_id),
    };
  });
}

export async function fetchRecentPurchases(limit = 20): Promise<PurchaseRecord[]> {
  if (!hasSupabaseEnv) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.from("ingredient_purchases")
    .select("id,ingredient_id,purchased_at,price_satang,purchased_quantity,usable_quantity,purchase_unit,vendor,ingredients(name)")
    .order("purchased_at", { ascending: false }).limit(limit);
  if (error) fail("ประวัติการซื้อ", error);
  return rows(data).map((row) => {
    const ingredient = one(row.ingredients);
    return {
      id: str(row.id), ingredientId: str(row.ingredient_id), ingredientName: str(ingredient?.name), purchasedAt: str(row.purchased_at),
      price: num(row.price_satang), purchasedQuantity: num(row.purchased_quantity), usableQuantity: num(row.usable_quantity),
      unit: str(row.purchase_unit), vendor: strOrNull(row.vendor),
    };
  });
}

/** Latest purchase date per ingredient id. */
export async function fetchLastPurchaseDates(): Promise<Map<string, string>> {
  const latest = new Map<string, string>();
  if (!hasSupabaseEnv) return latest;
  const supabase = await createClient();
  const data = await fetchAll("ประวัติการซื้อ", (from, to) =>
    supabase.from("ingredient_purchases").select("ingredient_id,purchased_at").order("purchased_at", { ascending: false }).range(from, to));
  for (const row of data) if (!latest.has(str(row.ingredient_id))) latest.set(str(row.ingredient_id), str(row.purchased_at));
  return latest;
}

export async function fetchRecipeItems(): Promise<RecipeItemRecord[]> {
  if (!hasSupabaseEnv) return [];
  const supabase = await createClient();
  const data = await fetchAll("สูตรเมนู", (from, to) =>
    supabase.from("menu_recipe_items").select("id,menu_id,ingredient_id,packaging_item_id,quantity").range(from, to));
  return data.map((row) => ({ id: str(row.id), menuId: str(row.menu_id), ingredientId: strOrNull(row.ingredient_id), packagingItemId: strOrNull(row.packaging_item_id), quantity: num(row.quantity) }));
}

export async function fetchSaleSettings(): Promise<SaleSettings> {
  const fallback = { defaultDeliveryFee: DEFAULT_DELIVERY_FEE_SATANG };
  if (!hasSupabaseEnv) return fallback;
  const supabase = await createClient();
  const { data, error } = await supabase.from("settings").select("value").eq("key", SALE_SETTINGS_KEY).maybeSingle();
  if (error) fail("การตั้งค่า", error);
  const value = (data?.value ?? {}) as Row;
  const fee = Number(value.default_delivery_fee_satang);
  return { defaultDeliveryFee: Number.isSafeInteger(fee) && fee >= 0 ? fee : fallback.defaultDeliveryFee };
}

export async function fetchProfile(): Promise<ProfileRecord> {
  const fallback = { displayName: "เจ้าของร้าน", shopName: "kaikai", email: null };
  if (!hasSupabaseEnv) return fallback;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fallback;
  const { data } = await supabase.from("profiles").select("display_name,shop_name").eq("id", user.id).maybeSingle();
  const meta = (user.user_metadata ?? {}) as Row;
  return {
    displayName: str(data?.display_name) || str(meta.display_name) || fallback.displayName,
    shopName: str(data?.shop_name) || str(meta.shop_name) || fallback.shopName,
    email: user.email ?? null,
  };
}
