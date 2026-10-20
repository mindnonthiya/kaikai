// Server-side data access. Reads through the signed-in user's session, so Row Level Security limits rows to that user.
// When Supabase is not configured every function returns empty data (there is no sample data).
import { cache } from "react";
import { COSTING_WINDOW_DAYS, pooledIngredientBps } from "@/lib/analytics";
import { hasSupabaseEnv } from "@/lib/env";
import { SCHEMA_OUTDATED_CODES, SCHEMA_OUTDATED_MESSAGE } from "@/lib/server-action";
import { createClient } from "@/lib/supabase/server";
import { DAY_MS } from "@/lib/time";
import type {
  ExpenseKind, ExpenseRecord, Fulfillment, IngredientCosting, IngredientRecord, MenuRecord, PackagingPurchaseRecord, PackagingRecord, PaymentMethod, PaymentStatus,
  PricePreset, ProfileRecord, PurchaseRecord, RecipeItemRecord, SaleRecord, SaleSettings, SaleStatus,
} from "./types";

type Row = Record<string, unknown>;
const PAGE_SIZE = 1000; // matches the Data API max_rows default

/** Used until the owner sets their own delivery fee in Settings. */
export const DEFAULT_DELIVERY_FEE_SATANG = 1500;
/** Starting guess for other ingredients (rice, herbs, sauce) = 10% of food sales, until there is real data. */
export const DEFAULT_INITIAL_POOLED_BPS = 1000;
export const SALE_SETTINGS_KEY = "sales";
export const PRICE_PRESETS_SETTINGS_KEY = "price_presets";

// User-scoped in-memory cache to eliminate redundant Supabase roundtrips in serverless
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const memoryCache = new Map<string, CacheEntry<unknown>>();

export function getCached<T>(key: string): T | undefined {
  const entry = memoryCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

export function setCached<T>(key: string, data: T, ttlMs = 60_000): T {
  memoryCache.set(key, { data, expiresAt: Date.now() + ttlMs });
  return data;
}

export function invalidateQueryCache(prefix?: string) {
  if (!prefix) {
    memoryCache.clear();
    return;
  }
  for (const key of memoryCache.keys()) {
    if (key.includes(prefix)) {
      memoryCache.delete(key);
    }
  }
}

/** Cache the user ID for the lifetime of a single request to avoid duplicate auth roundtrips */
export const getRequestUserId = cache(async (): Promise<string> => {
  if (!hasSupabaseEnv) return "anon";
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    return user?.id ?? "anon";
  } catch {
    return "anon";
  }
});

const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const str = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const strOrNull = (value: unknown) => (value === null || value === undefined || value === "" ? null : String(value));
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const one = (value: unknown) => (Array.isArray(value) ? value[0] : value) as Row | null | undefined;

export class QueryError extends Error {
  code?: string;
  originalMessage?: string;
  constructor(message: string, code?: string, originalMessage?: string) {
    super(message);
    this.name = "QueryError";
    this.code = code;
    this.originalMessage = originalMessage;
  }
}

function fail(what: string, error: { message: string; code?: string }): never {
  const outMsg = error.code && SCHEMA_OUTDATED_CODES.has(error.code)
    ? `โหลด${what}ไม่สำเร็จ: ${SCHEMA_OUTDATED_MESSAGE}`
    : `โหลด${what}ไม่สำเร็จ: ${error.message}`;
  throw new QueryError(outMsg, error.code, error.message);
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

const SALE_COLUMNS_WITH_TIP = "id,sale_number,sold_at,status,payment_status,customer_name,notes,fulfillment,product_revenue_satang,discount_satang,delivery_charged_satang,tip_satang,payment_fee_satang,packaging_cost_satang,net_revenue_satang,cogs_satang,gross_profit_satang,sale_items(menu_id,menu_name_snapshot,menu_category_snapshot,quantity,line_revenue_satang,line_cost_satang),payments(method,amount_satang)";
const SALE_COLUMNS_LEGACY = "id,sale_number,sold_at,status,payment_status,customer_name,notes,fulfillment,product_revenue_satang,discount_satang,delivery_charged_satang,payment_fee_satang,packaging_cost_satang,net_revenue_satang,cogs_satang,gross_profit_satang,sale_items(menu_id,menu_name_snapshot,menu_category_snapshot,quantity,line_revenue_satang,line_cost_satang),payments(method,amount_satang)";

let cachedHasTipColumn: boolean | null = null;

function mapSale(row: Row): SaleRecord {
  const productRev = num(row.product_revenue_satang);
  const discount = num(row.discount_satang);
  const delivery = num(row.delivery_charged_satang);
  const fee = num(row.payment_fee_satang);
  const netRevenue = num(row.net_revenue_satang);

  // If tip_satang exists in the database row, use it.
  // In unmigrated databases, infer tip from netRevenue if net exceeds expected product revenue:
  const computedTip = Math.max(0, netRevenue - (productRev - discount + delivery - fee));
  const tip = row.tip_satang !== undefined && row.tip_satang !== null ? num(row.tip_satang) : computedTip;

  return {
    id: str(row.id),
    saleNumber: num(row.sale_number),
    soldAt: str(row.sold_at),
    status: str(row.status) as SaleStatus,
    paymentStatus: str(row.payment_status) as PaymentStatus,
    customerName: strOrNull(row.customer_name),
    notes: strOrNull(row.notes),
    fulfillment: (str(row.fulfillment) || "pickup") as Fulfillment,
    productRevenue: productRev,
    discount,
    delivery,
    tip,
    fee,
    packagingCost: num(row.packaging_cost_satang),
    netRevenue,
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

  const querySales = (cols: string) =>
    fetchAll("ข้อมูลการขาย", (from, to) =>
      supabase.from("sales").select(cols).gte("sold_at", start.toISOString()).lt("sold_at", end.toISOString())
        .order("sold_at", { ascending: false }).range(from, to));

  if (cachedHasTipColumn === false) {
    const data = await querySales(SALE_COLUMNS_LEGACY);
    return data.map(mapSale);
  }

  try {
    const data = await querySales(SALE_COLUMNS_WITH_TIP);
    cachedHasTipColumn = true;
    return data.map(mapSale);
  } catch (err: unknown) {
    const isMissingColumn =
      (err instanceof QueryError && (err.code === "42703" || err.originalMessage?.includes("tip_satang"))) ||
      (err instanceof Error && err.message.includes("tip_satang"));
    if (isMissingColumn) {
      cachedHasTipColumn = false;
      const data = await querySales(SALE_COLUMNS_LEGACY);
      return data.map(mapSale);
    }
    throw err;
  }
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
    imagePath: strOrNull(row.image_path),
    price: num(row.selling_price_satang),
    packagingCost: num(row.packaging_cost_satang),
    cost: num(row.current_cost_satang),
    isAvailable: Boolean(row.is_available),
    costCalculatedAt: strOrNull(row.cost_calculated_at),
  };
}

export const fetchMenus = cache(async (): Promise<MenuRecord[]> => {
  if (!hasSupabaseEnv) return [];
  const userId = await getRequestUserId();
  const cacheKey = `${userId}:menus`;
  const cached = getCached<MenuRecord[]>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const data = await fetchAll("เมนู", (from, to) =>
    supabase.from("menus").select("id,name,category,image_path,selling_price_satang,packaging_cost_satang,current_cost_satang,is_available,cost_calculated_at")
      .order("category", { ascending: false }).order("selling_price_satang").order("name").range(from, to));
  const res = data.map(mapMenu);
  return setCached(cacheKey, res, 60_000);
});

export const fetchIngredients = cache(async (): Promise<IngredientRecord[]> => {
  if (!hasSupabaseEnv) return [];
  const userId = await getRequestUserId();
  const cacheKey = `${userId}:ingredients`;
  const cached = getCached<IngredientRecord[]>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const data = await fetchAll("วัตถุดิบ", (from, to) =>
    supabase.from("ingredients")
      .select("id,name,category,costing,base_unit,purchase_unit,units_per_purchase_unit,yield_auto,yield_updated_at,price_per_purchase_unit_satang,weighted_unit_cost_satang,is_active")
      .order("costing", { ascending: false }).order("name").range(from, to));
  const res = data.map((row) => ({
    id: str(row.id), name: str(row.name), category: str(row.category), costing: (str(row.costing) || "per_unit") as IngredientCosting,
    baseUnit: str(row.base_unit), purchaseUnit: str(row.purchase_unit) || str(row.base_unit), unitsPerPurchaseUnit: num(row.units_per_purchase_unit) || 1,
    yieldAuto: Boolean(row.yield_auto), yieldUpdatedAt: strOrNull(row.yield_updated_at),
    pricePerPurchaseUnit: num(row.price_per_purchase_unit_satang), unitCost: num(row.weighted_unit_cost_satang), isActive: Boolean(row.is_active),
  }));
  return setCached(cacheKey, res, 60_000);
});

export const fetchPackaging = cache(async (): Promise<PackagingRecord[]> => {
  if (!hasSupabaseEnv) return [];
  const userId = await getRequestUserId();
  const cacheKey = `${userId}:packaging`;
  const cached = getCached<PackagingRecord[]>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const data = await fetchAll("บรรจุภัณฑ์", (from, to) =>
    supabase.from("packaging_items").select("id,name,unit,unit_cost_satang,is_active,per_order").order("name").range(from, to));
  const res = data.map((row) => ({
    id: str(row.id), name: str(row.name), unit: str(row.unit), unitCost: num(row.unit_cost_satang),
    isActive: Boolean(row.is_active), perOrder: row.per_order !== false,
  }));
  return setCached(cacheKey, res, 60_000);
});

/** All packaging purchases, newest first. */
export async function fetchPackagingPurchases(): Promise<PackagingPurchaseRecord[]> {
  if (!hasSupabaseEnv) return [];
  const supabase = await createClient();
  const data = await fetchAll("ประวัติการซื้อบรรจุภัณฑ์", (from, to) =>
    supabase.from("packaging_purchases").select("id,packaging_item_id,purchased_at,price_satang,pack_quantity,pack_count,vendor,expense_id,packaging_items(name,unit)")
      .order("purchased_at", { ascending: false }).order("created_at", { ascending: false }).range(from, to));
  return data.map((row) => {
    const item = one(row.packaging_items);
    return {
      id: str(row.id), packagingItemId: str(row.packaging_item_id), itemName: str(item?.name), unit: str(item?.unit),
      purchasedAt: str(row.purchased_at), price: num(row.price_satang), packQuantity: num(row.pack_quantity), packCount: num(row.pack_count) || 1,
      vendor: strOrNull(row.vendor), expenseId: strOrNull(row.expense_id),
    };
  });
}

const PURCHASE_COLUMNS = "id,ingredient_id,purchased_at,price_satang,purchased_quantity,purchase_unit,vendor,ingredients(name,costing)";

function mapPurchase(row: Row): PurchaseRecord {
  const ingredient = one(row.ingredients);
  return {
    id: str(row.id), ingredientId: str(row.ingredient_id), ingredientName: str(ingredient?.name),
    costing: (str(ingredient?.costing) || "per_unit") as IngredientCosting, purchasedAt: str(row.purchased_at), price: num(row.price_satang),
    purchasedQuantity: row.purchased_quantity === null || row.purchased_quantity === undefined ? null : num(row.purchased_quantity),
    unit: strOrNull(row.purchase_unit), vendor: strOrNull(row.vendor),
  };
}

export async function fetchRecentPurchases(limit = 20): Promise<PurchaseRecord[]> {
  if (!hasSupabaseEnv) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.from("ingredient_purchases").select(PURCHASE_COLUMNS)
    .order("purchased_at", { ascending: false }).order("created_at", { ascending: false }).limit(limit);
  if (error) fail("ประวัติการซื้อ", error);
  return rows(data).map(mapPurchase);
}

/** Ingredient purchases with purchased_at in [start, end), newest first. */
export async function fetchIngredientPurchases(start: Date, end: Date): Promise<PurchaseRecord[]> {
  if (!hasSupabaseEnv) return [];
  const supabase = await createClient();
  const data = await fetchAll("การซื้อวัตถุดิบ", (from, to) =>
    supabase.from("ingredient_purchases").select(PURCHASE_COLUMNS)
      .gte("purchased_at", start.toISOString()).lt("purchased_at", end.toISOString()).order("purchased_at", { ascending: false }).range(from, to));
  return data.map(mapPurchase);
}

export type LatestPurchase = { purchasedAt: string; price: number; quantity: number | null };

/** Latest purchase per ingredient id (date, total price, quantity in the purchase unit). */
export async function fetchLatestPurchases(): Promise<Map<string, LatestPurchase>> {
  const latest = new Map<string, LatestPurchase>();
  if (!hasSupabaseEnv) return latest;
  const supabase = await createClient();
  const data = await fetchAll("ประวัติการซื้อ", (from, to) =>
    supabase.from("ingredient_purchases").select("ingredient_id,purchased_at,price_satang,purchased_quantity")
      .order("purchased_at", { ascending: false }).order("created_at", { ascending: false }).range(from, to));
  for (const row of data) {
    if (latest.has(str(row.ingredient_id))) continue;
    latest.set(str(row.ingredient_id), {
      purchasedAt: str(row.purchased_at), price: num(row.price_satang),
      quantity: row.purchased_quantity === null || row.purchased_quantity === undefined ? null : num(row.purchased_quantity),
    });
  }
  return latest;
}

export const fetchRecipeItems = cache(async (): Promise<RecipeItemRecord[]> => {
  if (!hasSupabaseEnv) return [];
  const userId = await getRequestUserId();
  const cacheKey = `${userId}:recipes`;
  const cached = getCached<RecipeItemRecord[]>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const data = await fetchAll("สูตรเมนู", (from, to) =>
    supabase.from("menu_recipe_items").select("id,menu_id,ingredient_id,packaging_item_id,quantity").range(from, to));
  const res = data.map((row) => ({ id: str(row.id), menuId: str(row.menu_id), ingredientId: strOrNull(row.ingredient_id), packagingItemId: strOrNull(row.packaging_item_id), quantity: num(row.quantity) }));
  return setCached(cacheKey, res, 60_000);
});

export const fetchSaleSettings = cache(async (): Promise<SaleSettings> => {
  const fallback = { defaultDeliveryFee: DEFAULT_DELIVERY_FEE_SATANG, initialPooledBps: DEFAULT_INITIAL_POOLED_BPS, showMenuImages: true };
  if (!hasSupabaseEnv) return fallback;
  const userId = await getRequestUserId();
  const cacheKey = `${userId}:settings:sales`;
  const cached = getCached<SaleSettings>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const { data, error } = await supabase.from("settings").select("value").eq("key", SALE_SETTINGS_KEY).maybeSingle();
  if (error) fail("การตั้งค่า", error);
  const value = (data?.value ?? {}) as Row;
  const fee = Number(value.default_delivery_fee_satang);
  const bps = Number(value.initial_pooled_bps);
  const showMenuImages = value.show_menu_images !== undefined ? Boolean(value.show_menu_images) : true;
  const res = {
    defaultDeliveryFee: Number.isSafeInteger(fee) && fee >= 0 ? fee : fallback.defaultDeliveryFee,
    initialPooledBps: Number.isSafeInteger(bps) && bps >= 0 && bps <= 10_000 ? bps : fallback.initialPooledBps,
    showMenuImages,
  };
  return setCached(cacheKey, res, 60_000);
});

export const fetchPricePresets = cache(async (): Promise<PricePreset[]> => {
  if (!hasSupabaseEnv) return [];
  const userId = await getRequestUserId();
  const cacheKey = `${userId}:settings:presets`;
  const cached = getCached<PricePreset[]>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const { data, error } = await supabase.from("settings").select("value").eq("key", PRICE_PRESETS_SETTINGS_KEY).maybeSingle();
  if (error) fail("สูตรเปิดบิลด่วน", error);
  const value = data?.value;
  if (!value) return setCached(cacheKey, [], 60_000);
  const list = Array.isArray(value)
    ? value
    : Array.isArray((value as Record<string, unknown>).presets)
    ? ((value as Record<string, unknown>).presets as unknown[])
    : [];
  const res = list.map((item: unknown) => {
    const p = (item ?? {}) as Record<string, unknown>;
    const rawItems = Array.isArray(p.items) ? (p.items as Record<string, unknown>[]) : [];
    return {
      id: str(p.id) || crypto.randomUUID(),
      name: str(p.name),
      amountSatang: num(p.amountSatang ?? p.amount_satang),
      fulfillment: (p.fulfillment === "delivery" ? "delivery" : "pickup") as Fulfillment,
      deliveryChargedSatang: num(p.deliveryChargedSatang ?? p.delivery_charged_satang),
      items: rawItems.map((it) => ({
        menuId: str(it.menuId ?? it.menu_id),
        quantity: num(it.quantity) || 1,
      })),
      notes: strOrNull(p.notes) ?? undefined,
    };
  });
  return setCached(cacheKey, res, 60_000);
});

export type PooledRate = ReturnType<typeof pooledIngredientBps> & { pooledPurchases: number; foodRevenue: number; historyDays: number; initialBps: number };

/**
 * Other-ingredient rate for new orders: purchases of pooled ingredients ÷ food sales,
 * over the last 30 days (or since the first pooled purchase, if more recent).
 */
export const fetchPooledRate = cache(async (settings?: SaleSettings): Promise<PooledRate> => {
  const initialBps = (settings ?? (await fetchSaleSettings())).initialPooledBps;
  const empty = { pooledPurchases: 0, foodRevenue: 0, historyDays: 0, initialBps };
  if (!hasSupabaseEnv) return { ...pooledIngredientBps(empty), ...empty };

  const userId = await getRequestUserId();
  const cacheKey = `${userId}:pooled_rate`;
  const cached = getCached<PooledRate>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const now = Date.now();
  const first = await supabase.from("ingredient_purchases").select("purchased_at,ingredients!inner(costing)")
    .eq("ingredients.costing", "pooled").order("purchased_at").limit(1);
  if (first.error) fail("การซื้อวัตถุดิบ", first.error);
  const firstAt = rows(first.data)[0]?.purchased_at;
  if (!firstAt) return setCached(cacheKey, { ...pooledIngredientBps(empty), ...empty }, 60_000);
  const start = new Date(Math.max(now - COSTING_WINDOW_DAYS * DAY_MS, Date.parse(str(firstAt))));
  const [purchases, sales] = await Promise.all([
    fetchAll("การซื้อวัตถุดิบ", (from, to) => supabase.from("ingredient_purchases").select("price_satang,ingredients!inner(costing)")
      .eq("ingredients.costing", "pooled").gte("purchased_at", start.toISOString()).range(from, to)),
    fetchAll("ข้อมูลการขาย", (from, to) => supabase.from("sales").select("product_revenue_satang")
      .eq("status", "confirmed").gte("sold_at", start.toISOString()).range(from, to)),
  ]);
  const input = {
    pooledPurchases: purchases.reduce((sum, r) => sum + num(r.price_satang), 0),
    foodRevenue: sales.reduce((sum, r) => sum + num(r.product_revenue_satang), 0),
    historyDays: Math.floor((now - start.getTime()) / DAY_MS),
    initialBps,
  };
  const res = { ...pooledIngredientBps(input), ...input };
  return setCached(cacheKey, res, 60_000);
});

export const fetchProfile = cache(async (): Promise<ProfileRecord> => {
  const fallback = { displayName: "เจ้าของร้าน", shopName: "kaikai", email: null };
  if (!hasSupabaseEnv) return fallback;
  const userId = await getRequestUserId();
  if (userId === "anon") return fallback;
  const cacheKey = `${userId}:profile`;
  const cached = getCached<ProfileRecord>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fallback;
  const { data } = await supabase.from("profiles").select("display_name,shop_name").eq("id", user.id).maybeSingle();
  const meta = (user.user_metadata ?? {}) as Row;
  const res = {
    displayName: str(data?.display_name) || str(meta.display_name) || fallback.displayName,
    shopName: str(data?.shop_name) || str(meta.shop_name) || fallback.shopName,
    email: user.email ?? null,
  };
  return setCached(cacheKey, res, 60_000);
});
