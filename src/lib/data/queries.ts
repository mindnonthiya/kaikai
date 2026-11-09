// Server-side data access. Reads through the signed-in user's session, so Row Level Security limits rows to that user.
// When Supabase is not configured every function returns empty data (there is no sample data).
import { cache } from "react";
import { cookies } from "next/headers";
import { COSTING_WINDOW_DAYS, pooledFoodRevenue, pooledIngredientBps } from "@/lib/analytics";
import { hasSupabaseEnv } from "@/lib/env";
import { SCHEMA_OUTDATED_CODES, SCHEMA_OUTDATED_MESSAGE } from "@/lib/server-action";
import {
  ACTIVE_SHOP_COOKIE,
  DEFAULT_SHOP_ID,
  SHOPS_REGISTRY_SETTINGS_KEY,
  decodeShopText,
  matchesSaleShop,
  matchesShopText,
  normalizeShopId,
  resolveInventoryShopId,
  scopedSettingsKey,
  stripShopPrefix,
  type ShopSummary,
} from "@/lib/shop-scope";
import { createClient } from "@/lib/supabase/server";
import { DAY_MS, DEFAULT_DAY_START_HOUR, normalizeDayStartHour } from "@/lib/time";
import {
  DEFAULT_UNIT_LABEL,
  type ExpenseKind, type ExpenseRecord, type Fulfillment, type IngredientCosting, type IngredientRecord, type MenuRecord,
  type PackagingPurchaseRecord, type PackagingRecord, type PaymentMethod, type PaymentStatus,
  type PricePreset, type ProfileRecord, type PurchaseRecord, type RecipeItemRecord, type SaleRecord, type SaleSettings, type SaleStatus,
} from "./types";

type Row = Record<string, unknown>;
const PAGE_SIZE = 1000; // matches the Data API max_rows default

/** Used until the owner sets their own delivery fee in Settings. */
export const DEFAULT_DELIVERY_FEE_SATANG = 1500;
export const DEFAULT_DELIVERY_FEE_OPTIONS_SATANG = [1500, 2000];
/** Starting guess for other ingredients (rice, herbs, sauce) = 10% of food sales, until there is real data. */
export const DEFAULT_INITIAL_POOLED_BPS = 1000;
export const SALE_SETTINGS_KEY = "sales";
export const PRICE_PRESETS_SETTINGS_KEY = "price_presets";
export const MENU_YIELDS_SETTINGS_KEY = "menu_yields";
export const PACKAGING_DEFAULTS_SETTINGS_KEY = "packaging_defaults";

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

/** Reads the active shop ID and its resolved ingredient/packaging catalog shop ID from the request cookie. */
export const getActiveShopState = cache(async (): Promise<{ shopId: string; inventoryShopId: string }> => {
  let rawCookieShop = DEFAULT_SHOP_ID;
  try {
    const cookieStore = await cookies();
    rawCookieShop = normalizeShopId(cookieStore.get(ACTIVE_SHOP_COOKIE)?.value);
  } catch {
    return { shopId: DEFAULT_SHOP_ID, inventoryShopId: DEFAULT_SHOP_ID };
  }
  if (rawCookieShop === DEFAULT_SHOP_ID || !hasSupabaseEnv) {
    return { shopId: DEFAULT_SHOP_ID, inventoryShopId: DEFAULT_SHOP_ID };
  }
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("settings")
      .select("value")
      .eq("key", SHOPS_REGISTRY_SETTINGS_KEY)
      .maybeSingle();
    const rawVal = (data?.value ?? {}) as Row;
    const list = Array.isArray(rawVal.shops) ? (rawVal.shops as Row[]) : [];
    const exists = list.some((s) => normalizeShopId(str(s.id)) === rawCookieShop);
    if (!exists) {
      return { shopId: DEFAULT_SHOP_ID, inventoryShopId: DEFAULT_SHOP_ID };
    }
    const inventoryShopId = resolveInventoryShopId(
      rawCookieShop,
      list as Array<{ id?: string | null; sharedIngredientsFromShopId?: string | null; shared_ingredients_from_shop_id?: string | null }>,
    );
    return { shopId: rawCookieShop, inventoryShopId };
  } catch {
    return { shopId: DEFAULT_SHOP_ID, inventoryShopId: DEFAULT_SHOP_ID };
  }
});

/** Reads the active shop ID from the request cookie (verified against the signed-in user's shop registry). */
export const getActiveShopId = cache(async (): Promise<string> => (await getActiveShopState()).shopId);

/** Reads the shop ID whose ingredients & packaging catalog the active shop uses. */
export const getActiveInventoryShopId = cache(async (): Promise<string> => (await getActiveShopState()).inventoryShopId);

/** Cache the user ID + active shop ID for the lifetime of a single request to isolate caches per shop */
export const getRequestUserId = cache(async (): Promise<string> => {
  if (!hasSupabaseEnv) return "anon";
  try {
    const [supabase, shopId] = await Promise.all([createClient(), getActiveShopId()]);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return "anon";
    return `${user.id}:${shopId}`;
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

const SALE_COLUMNS_WITH_TIP = "id,sale_number,sold_at,status,payment_status,customer_name,notes,fulfillment,product_revenue_satang,discount_satang,delivery_charged_satang,tip_satang,payment_fee_satang,packaging_cost_satang,net_revenue_satang,cogs_satang,gross_profit_satang,sale_items(menu_id,menu_name_snapshot,menu_category_snapshot,quantity,line_revenue_satang,line_cost_satang,packaging_cost_satang),payments(method,amount_satang),slip_uploads(storage_path)";
const SALE_COLUMNS_LEGACY = "id,sale_number,sold_at,status,payment_status,customer_name,notes,fulfillment,product_revenue_satang,discount_satang,delivery_charged_satang,payment_fee_satang,packaging_cost_satang,net_revenue_satang,cogs_satang,gross_profit_satang,sale_items(menu_id,menu_name_snapshot,menu_category_snapshot,quantity,line_revenue_satang,line_cost_satang,packaging_cost_satang),payments(method,amount_satang),slip_uploads(storage_path)";

let cachedHasTipColumn: boolean | null = null;

function mapSale(row: Row): SaleRecord {
  const productRev = num(row.product_revenue_satang);
  const discount = num(row.discount_satang);
  const delivery = num(row.delivery_charged_satang);
  const fee = num(row.payment_fee_satang);
  const netRevenue = num(row.net_revenue_satang);

  const computedTip = Math.max(0, netRevenue - (productRev - discount + delivery - fee));
  const tip = row.tip_satang !== undefined && row.tip_satang !== null ? num(row.tip_satang) : computedTip;
  const cleanNotes = stripShopPrefix(strOrNull(row.notes)).trim();

  return {
    id: str(row.id),
    saleNumber: num(row.sale_number),
    soldAt: str(row.sold_at),
    status: str(row.status) as SaleStatus,
    paymentStatus: str(row.payment_status) as PaymentStatus,
    customerName: strOrNull(row.customer_name),
    notes: cleanNotes || null,
    fulfillment: (str(row.fulfillment) || "pickup") as Fulfillment,
    productRevenue: productRev,
    discount,
    delivery,
    tip,
    fee,
    packagingCost: num(row.packaging_cost_satang),
    netRevenue,
    cogs: num(row.cogs_satang),
    grossProfit: netRevenue - num(row.cogs_satang),
    slipPath: strOrNull(one(row.slip_uploads)?.storage_path),
    slipPaths: rows(row.slip_uploads).map((s) => str(s.storage_path)).filter(Boolean),
    items: rows(row.sale_items).map((item) => ({
      menuId: str(item.menu_id),
      name: stripShopPrefix(str(item.menu_name_snapshot)),
      category: strOrNull(item.menu_category_snapshot),
      quantity: num(item.quantity),
      revenue: num(item.line_revenue_satang),
      cost: num(item.line_cost_satang),
      packagingCost: num(item.packaging_cost_satang),
    })),
    payments: rows(row.payments).map((payment) => ({ method: str(payment.method) as PaymentMethod, amount: num(payment.amount_satang) })),
  };
}

/** Sales with sold_at in [start, end), newest first, scoped to the active shop. */
export async function fetchSales(start: Date, end: Date): Promise<SaleRecord[]> {
  if (!hasSupabaseEnv) return [];
  const [supabase, shopId] = await Promise.all([createClient(), getActiveShopId()]);

  const querySales = (cols: string) =>
    fetchAll("ข้อมูลการขาย", (from, to) =>
      supabase.from("sales").select(cols).gte("sold_at", start.toISOString()).lt("sold_at", end.toISOString())
        .order("sold_at", { ascending: false }).range(from, to));

  if (cachedHasTipColumn === false) {
    const data = await querySales(SALE_COLUMNS_LEGACY);
    return data.filter((r) => matchesSaleShop(r, shopId)).map(mapSale);
  }

  try {
    const data = await querySales(SALE_COLUMNS_WITH_TIP);
    cachedHasTipColumn = true;
    return data.filter((r) => matchesSaleShop(r, shopId)).map(mapSale);
  } catch (err: unknown) {
    const isMissingColumn =
      (err instanceof QueryError && (err.code === "42703" || err.originalMessage?.includes("tip_satang"))) ||
      (err instanceof Error && err.message.includes("tip_satang"));
    if (isMissingColumn) {
      cachedHasTipColumn = false;
      const data = await querySales(SALE_COLUMNS_LEGACY);
      return data.filter((r) => matchesSaleShop(r, shopId)).map(mapSale);
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
    description: stripShopPrefix(str(row.description)),
    payee: strOrNull(row.payee),
    paymentMethod: strOrNull(row.payment_method) as PaymentMethod | null,
    receiptPath: strOrNull(row.receipt_path),
    notes: strOrNull(row.notes),
  };
}

/** Expenses with spent_at in [start, end), newest first, scoped to the active shop. */
export async function fetchExpenses(start: Date, end: Date): Promise<ExpenseRecord[]> {
  if (!hasSupabaseEnv) return [];
  const [supabase, shopId] = await Promise.all([createClient(), getActiveShopId()]);
  const data = await fetchAll("ค่าใช้จ่าย", (from, to) =>
    supabase.from("expenses").select("id,spent_at,category,kind,amount_satang,description,payee,payment_method,receipt_path,notes")
      .gte("spent_at", start.toISOString()).lt("spent_at", end.toISOString()).order("spent_at", { ascending: false }).range(from, to));
  return data.filter((row) => matchesShopText(str(row.description), shopId)).map(mapExpense);
}

/** Batch yield divisor per menu ID (e.g. 1 batch = 30 crepes -> yield 30). */
export const fetchMenuYields = cache(async (): Promise<Map<string, number>> => {
  const yields = new Map<string, number>();
  if (!hasSupabaseEnv) return yields;
  const userId = await getRequestUserId();
  const cacheKey = `${userId}:settings:menu_yields`;
  const cached = getCached<Map<string, number>>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const { data } = await supabase.from("settings").select("value").eq("key", MENU_YIELDS_SETTINGS_KEY).maybeSingle();
  const raw = (data?.value ?? {}) as Record<string, unknown>;
  for (const [menuId, val] of Object.entries(raw)) {
    const n = Number(val);
    if (Number.isFinite(n) && n > 0) {
      yields.set(menuId, n);
    }
  }
  return setCached(cacheKey, yields, 60_000);
});

export type PackagingDefaultConfig = { packPriceSatang: number; packQuantity: number };

/** Configured default pack price and quantity per packaging item ID (when no purchase record exists yet). */
export const fetchPackagingDefaults = cache(async (): Promise<Map<string, PackagingDefaultConfig>> => {
  const defaults = new Map<string, PackagingDefaultConfig>();
  if (!hasSupabaseEnv) return defaults;
  const userId = await getRequestUserId();
  const cacheKey = `${userId}:settings:packaging_defaults`;
  const cached = getCached<Map<string, PackagingDefaultConfig>>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const { data } = await supabase.from("settings").select("value").eq("key", PACKAGING_DEFAULTS_SETTINGS_KEY).maybeSingle();
  const raw = (data?.value ?? {}) as Record<string, unknown>;
  for (const [packId, val] of Object.entries(raw)) {
    const entry = (val ?? {}) as Record<string, unknown>;
    const packPriceSatang = Number(entry.packPriceSatang ?? entry.pack_price_satang);
    const packQuantity = Number(entry.packQuantity ?? entry.pack_quantity);
    if (Number.isFinite(packPriceSatang) && packPriceSatang > 0 && Number.isFinite(packQuantity) && packQuantity > 0) {
      defaults.set(packId, { packPriceSatang, packQuantity });
    }
  }
  return setCached(cacheKey, defaults, 60_000);
});

export function mapMenu(row: Row, yieldOverride?: number): MenuRecord {
  const rawYield = yieldOverride ?? num(row.recipe_yield);
  return {
    id: str(row.id),
    name: stripShopPrefix(str(row.name)),
    category: str(row.category),
    imagePath: strOrNull(row.image_path),
    price: num(row.selling_price_satang),
    packagingCost: num(row.packaging_cost_satang),
    cost: num(row.current_cost_satang),
    recipeYield: Number.isFinite(rawYield) && rawYield > 0 ? rawYield : 1,
    isAvailable: Boolean(row.is_available),
    costCalculatedAt: strOrNull(row.cost_calculated_at),
  };
}

export const fetchMenus = cache(async (): Promise<MenuRecord[]> => {
  if (!hasSupabaseEnv) return [];
  const [userId, shopId] = await Promise.all([getRequestUserId(), getActiveShopId()]);
  const cacheKey = `${userId}:menus`;
  const cached = getCached<MenuRecord[]>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const [data, menuYields] = await Promise.all([
    fetchAll("เมนู", (from, to) =>
      supabase.from("menus").select("id,name,category,image_path,selling_price_satang,packaging_cost_satang,current_cost_satang,is_available,cost_calculated_at")
        .order("category", { ascending: false }).order("selling_price_satang").order("name").range(from, to)),
    fetchMenuYields(),
  ]);
  const res = data
    .filter((row) => matchesShopText(str(row.name), shopId))
    .map((row) => mapMenu(row, menuYields.get(str(row.id))));
  return setCached(cacheKey, res, 60_000);
});

export const fetchIngredients = cache(async (): Promise<IngredientRecord[]> => {
  if (!hasSupabaseEnv) return [];
  const [userId, inventoryShopId] = await Promise.all([getRequestUserId(), getActiveInventoryShopId()]);
  const cacheKey = `${userId}:ingredients:${inventoryShopId}`;
  const cached = getCached<IngredientRecord[]>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const data = await fetchAll("วัตถุดิบ", (from, to) =>
    supabase.from("ingredients")
      .select("id,name,category,costing,base_unit,purchase_unit,units_per_purchase_unit,yield_auto,yield_updated_at,price_per_purchase_unit_satang,weighted_unit_cost_satang,is_active")
      .order("costing", { ascending: false }).order("name").range(from, to));
  const res = data
    .filter((row) => matchesShopText(str(row.name), inventoryShopId))
    .map((row) => ({
      id: str(row.id), name: stripShopPrefix(str(row.name)), category: str(row.category), costing: (str(row.costing) || "per_unit") as IngredientCosting,
      baseUnit: str(row.base_unit), purchaseUnit: str(row.purchase_unit) || str(row.base_unit), unitsPerPurchaseUnit: num(row.units_per_purchase_unit) || 1,
      yieldAuto: Boolean(row.yield_auto), yieldUpdatedAt: strOrNull(row.yield_updated_at),
      pricePerPurchaseUnit: num(row.price_per_purchase_unit_satang), unitCost: num(row.weighted_unit_cost_satang), isActive: Boolean(row.is_active),
    }));
  return setCached(cacheKey, res, 60_000);
});

export const fetchPackaging = cache(async (): Promise<PackagingRecord[]> => {
  if (!hasSupabaseEnv) return [];
  const [userId, inventoryShopId] = await Promise.all([getRequestUserId(), getActiveInventoryShopId()]);
  const cacheKey = `${userId}:packaging:${inventoryShopId}`;
  const cached = getCached<PackagingRecord[]>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const data = await fetchAll("บรรจุภัณฑ์", (from, to) =>
    supabase.from("packaging_items").select("id,name,unit,unit_cost_satang,is_active,per_order").order("name").range(from, to));
  const res = data
    .filter((row) => matchesShopText(str(row.name), inventoryShopId))
    .map((row) => ({
      id: str(row.id), name: stripShopPrefix(str(row.name)), unit: str(row.unit), unitCost: num(row.unit_cost_satang),
      isActive: Boolean(row.is_active), perOrder: row.per_order !== false,
    }));
  return setCached(cacheKey, res, 60_000);
});

/** All packaging purchases for the active shop's catalog, newest first. */
export async function fetchPackagingPurchases(): Promise<PackagingPurchaseRecord[]> {
  if (!hasSupabaseEnv) return [];
  const [supabase, inventoryShopId] = await Promise.all([createClient(), getActiveInventoryShopId()]);
  const data = await fetchAll("ประวัติการซื้อบรรจุภัณฑ์", (from, to) =>
    supabase.from("packaging_purchases").select("id,packaging_item_id,purchased_at,price_satang,pack_quantity,pack_count,vendor,expense_id,packaging_items(name,unit)")
      .order("purchased_at", { ascending: false }).order("created_at", { ascending: false }).range(from, to));
  return data
    .filter((row) => matchesShopText(str(one(row.packaging_items)?.name), inventoryShopId))
    .map((row) => {
      const item = one(row.packaging_items);
      return {
        id: str(row.id), packagingItemId: str(row.packaging_item_id), itemName: stripShopPrefix(str(item?.name)), unit: str(item?.unit),
        purchasedAt: str(row.purchased_at), price: num(row.price_satang), packQuantity: num(row.pack_quantity), packCount: num(row.pack_count) || 1,
        vendor: strOrNull(row.vendor), expenseId: strOrNull(row.expense_id),
      };
    });
}

const PURCHASE_COLUMNS = "id,ingredient_id,purchased_at,price_satang,purchased_quantity,purchase_unit,vendor,ingredients(name,costing)";

function mapPurchase(row: Row): PurchaseRecord {
  const ingredient = one(row.ingredients);
  const cleanVendor = stripShopPrefix(strOrNull(row.vendor)).trim();
  return {
    id: str(row.id), ingredientId: str(row.ingredient_id), ingredientName: stripShopPrefix(str(ingredient?.name)),
    costing: (str(ingredient?.costing) || "per_unit") as IngredientCosting, purchasedAt: str(row.purchased_at), price: num(row.price_satang),
    purchasedQuantity: row.purchased_quantity === null || row.purchased_quantity === undefined ? null : num(row.purchased_quantity),
    unit: strOrNull(row.purchase_unit), vendor: cleanVendor || null,
  };
}

export async function fetchRecentPurchases(limit = 20): Promise<PurchaseRecord[]> {
  if (!hasSupabaseEnv) return [];
  const [supabase, inventoryShopId] = await Promise.all([createClient(), getActiveInventoryShopId()]);
  const { data, error } = await supabase.from("ingredient_purchases").select(PURCHASE_COLUMNS)
    .order("purchased_at", { ascending: false }).order("created_at", { ascending: false }).limit(Math.max(limit * 4, 100));
  if (error) fail("ประวัติการซื้อ", error);
  return rows(data)
    .filter((row) => matchesShopText(str(one(row.ingredients)?.name), inventoryShopId))
    .slice(0, limit)
    .map(mapPurchase);
}

/** Ingredient purchases with purchased_at in [start, end), newest first, scoped to the active shop's catalog. */
export async function fetchIngredientPurchases(start: Date, end: Date): Promise<PurchaseRecord[]> {
  if (!hasSupabaseEnv) return [];
  const [supabase, inventoryShopId] = await Promise.all([createClient(), getActiveInventoryShopId()]);
  const data = await fetchAll("การซื้อวัตถุดิบ", (from, to) =>
    supabase.from("ingredient_purchases").select(PURCHASE_COLUMNS)
      .gte("purchased_at", start.toISOString()).lt("purchased_at", end.toISOString()).order("purchased_at", { ascending: false }).range(from, to));
  return data
    .filter((row) => matchesShopText(str(one(row.ingredients)?.name), inventoryShopId))
    .map(mapPurchase);
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
  const fallback: SaleSettings = {
    defaultDeliveryFee: DEFAULT_DELIVERY_FEE_SATANG,
    deliveryFeeOptions: DEFAULT_DELIVERY_FEE_OPTIONS_SATANG,
    initialPooledBps: DEFAULT_INITIAL_POOLED_BPS,
    showMenuImages: true,
    dayStartHour: DEFAULT_DAY_START_HOUR,
    unitLabel: DEFAULT_UNIT_LABEL,
  };
  if (!hasSupabaseEnv) return fallback;
  const [userId, shopId] = await Promise.all([getRequestUserId(), getActiveShopId()]);
  const cacheKey = `${userId}:settings:sales`;
  const cached = getCached<SaleSettings>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const key = scopedSettingsKey(SALE_SETTINGS_KEY, shopId);
  const { data, error } = await supabase.from("settings").select("value").eq("key", key).maybeSingle();
  if (error) fail("การตั้งค่า", error);
  const value = (data?.value ?? {}) as Row;
  const fee = Number(value.default_delivery_fee_satang);
  const bps = Number(value.initial_pooled_bps);
  const showMenuImages = value.show_menu_images !== undefined ? Boolean(value.show_menu_images) : true;
  const dayStartHour = normalizeDayStartHour(value.day_start_hour);
  const unitLabel = str(value.unit_label).trim() || DEFAULT_UNIT_LABEL;
  const resolvedDefaultFee = Number.isSafeInteger(fee) && fee >= 0 ? fee : fallback.defaultDeliveryFee;
  const rawFeeOptions = Array.isArray(value.delivery_fee_options_satang)
    ? value.delivery_fee_options_satang.map(Number).filter((n) => Number.isSafeInteger(n) && n >= 0)
    : [];
  const baseOptions = rawFeeOptions.length > 0 ? rawFeeOptions : DEFAULT_DELIVERY_FEE_OPTIONS_SATANG;
  const deliveryFeeOptions = Array.from(new Set([resolvedDefaultFee, ...baseOptions])).sort((a, b) => a - b);
  const res: SaleSettings = {
    defaultDeliveryFee: resolvedDefaultFee,
    deliveryFeeOptions,
    initialPooledBps: Number.isSafeInteger(bps) && bps >= 0 && bps <= 10_000 ? bps : fallback.initialPooledBps,
    showMenuImages,
    dayStartHour,
    unitLabel,
  };
  return setCached(cacheKey, res, 60_000);
});

export const fetchPricePresets = cache(async (): Promise<PricePreset[]> => {
  if (!hasSupabaseEnv) return [];
  const [userId, shopId] = await Promise.all([getRequestUserId(), getActiveShopId()]);
  const cacheKey = `${userId}:settings:presets`;
  const cached = getCached<PricePreset[]>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const key = scopedSettingsKey(PRICE_PRESETS_SETTINGS_KEY, shopId);
  const { data, error } = await supabase.from("settings").select("value").eq("key", key).maybeSingle();
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
 * over the last 30 days (or since the first pooled purchase of the active shop, if more recent).
 */
export const fetchPooledRate = cache(async (settings?: SaleSettings): Promise<PooledRate> => {
  const initialBps = (settings ?? (await fetchSaleSettings())).initialPooledBps;
  const empty = { pooledPurchases: 0, foodRevenue: 0, historyDays: 0, initialBps };
  if (!hasSupabaseEnv) return { ...pooledIngredientBps(empty), ...empty };

  const [userId, shopId] = await Promise.all([getRequestUserId(), getActiveShopId()]);
  const cacheKey = `${userId}:pooled_rate`;
  const cached = getCached<PooledRate>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const now = Date.now();
  const allPooledPurchases = await fetchAll("การซื้อวัตถุดิบ", (from, to) =>
    supabase.from("ingredient_purchases")
      .select("purchased_at,price_satang,vendor,ingredients!inner(name,costing)")
      .eq("ingredients.costing", "pooled")
      .lte("purchased_at", new Date(now).toISOString())
      .order("purchased_at", { ascending: true })
      .range(from, to),
  );
  const shopPurchases = allPooledPurchases.filter((r) => {
    const rawVendor = str(r.vendor);
    if (rawVendor.startsWith("[s:")) {
      return decodeShopText(rawVendor).shopId === shopId;
    }
    return matchesShopText(str(one(r.ingredients)?.name), shopId);
  });
  const firstAt = shopPurchases[0]?.purchased_at;
  if (!firstAt) return setCached(cacheKey, { ...pooledIngredientBps(empty), ...empty }, 60_000);

  const start = new Date(Math.max(now - COSTING_WINDOW_DAYS * DAY_MS, Date.parse(str(firstAt))));
  const startIso = start.toISOString();
  const windowPurchases = shopPurchases.filter((r) => str(r.purchased_at) >= startIso);

  const rawSales = await fetchAll("ข้อมูลการขาย", (from, to) =>
    supabase.from("sale_items")
      .select("id,menu_id,menu_name_snapshot,menu_category_snapshot,line_revenue_satang,sales!inner(status,sold_at,notes)")
      .eq("sales.status", "confirmed")
      .gte("sales.sold_at", startIso)
      .lte("sales.sold_at", new Date(now).toISOString())
      .order("id")
      .range(from, to),
  );
  const shopSales = rawSales.filter((r) =>
    matchesSaleShop({ notes: one(r.sales)?.notes, sale_items: [r] }, shopId),
  );

  const input = {
    pooledPurchases: windowPurchases.reduce((sum, r) => sum + num(r.price_satang), 0),
    foodRevenue: pooledFoodRevenue(
      shopSales.map((r) => ({
        menuId: strOrNull(r.menu_id),
        category: strOrNull(r.menu_category_snapshot),
        name: stripShopPrefix(str(r.menu_name_snapshot)),
        revenue: num(r.line_revenue_satang),
      })),
    ),
    historyDays: Math.floor((now - start.getTime()) / DAY_MS),
    initialBps,
  };
  const res = { ...pooledIngredientBps(input), ...input };
  return setCached(cacheKey, res, 60_000);
});

/** Fetches all shops registered under the current user's email account, plus the activeShopId. */
export const fetchShops = cache(async (): Promise<{ activeShopId: string; shops: ShopSummary[]; email: string | null }> => {
  const defaultFallback: ShopSummary = {
    id: DEFAULT_SHOP_ID,
    shopName: "kaikai",
    displayName: "เจ้าของร้าน",
    avatarUrl: null,
    unitLabel: DEFAULT_UNIT_LABEL,
    createdAt: new Date(0).toISOString(),
  };
  if (!hasSupabaseEnv) {
    return { activeShopId: DEFAULT_SHOP_ID, shops: [defaultFallback], email: null };
  }
  try {
    const [supabase, activeShopId] = await Promise.all([createClient(), getActiveShopId()]);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { activeShopId: DEFAULT_SHOP_ID, shops: [defaultFallback], email: null };

    const meta = (user.user_metadata ?? {}) as Row;
    let defaultAvatar: string | null = str(meta.avatar_url) || str(meta.picture) || null;
    let defaultDisplay = str(meta.display_name);
    let defaultShopName = str(meta.shop_name);

    const [profileRes, settingsRes] = await Promise.all([
      supabase.from("profiles").select("display_name,shop_name,avatar_url").eq("id", user.id).maybeSingle(),
      supabase.from("settings").select("key,value").eq("owner_id", user.id),
    ]);

    if (!profileRes.error && profileRes.data) {
      if (str(profileRes.data.avatar_url)) defaultAvatar = str(profileRes.data.avatar_url);
      if (str(profileRes.data.display_name)) defaultDisplay = str(profileRes.data.display_name);
      if (str(profileRes.data.shop_name)) defaultShopName = str(profileRes.data.shop_name);
    } else if (profileRes.error) {
      const { data: dataFallback } = await supabase.from("profiles").select("display_name,shop_name").eq("id", user.id).maybeSingle();
      if (dataFallback) {
        if (str(dataFallback.display_name)) defaultDisplay = str(dataFallback.display_name);
        if (str(dataFallback.shop_name)) defaultShopName = str(dataFallback.shop_name);
      }
    }

    const settingsMap = new Map<string, Row>();
    for (const sRow of rows(settingsRes.data)) {
      const k = str(sRow.key);
      if (k && sRow.value && typeof sRow.value === "object") {
        settingsMap.set(k, sRow.value as Row);
      }
    }

    const primaryProfileSetting = settingsMap.get("profile");
    if (primaryProfileSetting) {
      if (str(primaryProfileSetting.shop_name)) defaultShopName = str(primaryProfileSetting.shop_name);
      if (str(primaryProfileSetting.display_name)) defaultDisplay = str(primaryProfileSetting.display_name);
      if ("avatar_url" in primaryProfileSetting) {
        defaultAvatar = primaryProfileSetting.avatar_url === null ? null : str(primaryProfileSetting.avatar_url) || defaultAvatar;
      }
    }
    const primarySaleSetting = settingsMap.get(SALE_SETTINGS_KEY);
    const defaultUnitLabel = str(primarySaleSetting?.unit_label).trim() || DEFAULT_UNIT_LABEL;

    const primaryShop: ShopSummary = {
      id: DEFAULT_SHOP_ID,
      shopName: defaultShopName || "kaikai",
      displayName: defaultDisplay || defaultShopName || "เจ้าของร้าน",
      avatarUrl: defaultAvatar || null,
      unitLabel: defaultUnitLabel,
      createdAt: user.created_at ?? new Date(0).toISOString(),
    };

    const registryRow = settingsMap.get(SHOPS_REGISTRY_SETTINGS_KEY);
    const rawList = Array.isArray(registryRow?.shops) ? (registryRow!.shops as Row[]) : [];
    const extraShops: ShopSummary[] = [];
    const seenIds = new Set<string>([DEFAULT_SHOP_ID]);

    for (const item of rawList) {
      const id = normalizeShopId(str(item.id));
      if (id === DEFAULT_SHOP_ID || seenIds.has(id)) continue;
      seenIds.add(id);

      const profKey = scopedSettingsKey("profile", id);
      const saleKey = scopedSettingsKey(SALE_SETTINGS_KEY, id);
      const prof = settingsMap.get(profKey);
      const sale = settingsMap.get(saleKey);

      const sName = str(prof?.shop_name) || str(item.shopName ?? item.shop_name) || "ร้านสาขา";
      const dName = str(prof?.display_name) || str(item.displayName ?? item.display_name) || sName;
      let av: string | null = strOrNull(item.avatarUrl ?? item.avatar_url);
      if (prof && "avatar_url" in prof) {
        av = prof.avatar_url === null ? null : str(prof.avatar_url) || av;
      }
      const uLabel = str(sale?.unit_label).trim() || str(item.unitLabel ?? item.unit_label).trim() || DEFAULT_UNIT_LABEL;
      const rawShared = strOrNull(item.sharedIngredientsFromShopId ?? item.shared_ingredients_from_shop_id);

      extraShops.push({
        id,
        shopName: sName,
        displayName: dName,
        avatarUrl: av,
        unitLabel: uLabel,
        createdAt: str(item.createdAt ?? item.created_at) || new Date().toISOString(),
        sharedIngredientsFromShopId: rawShared,
      });
    }

    const allShops = [primaryShop, ...extraShops];
    for (const s of allShops) {
      if (s.id === DEFAULT_SHOP_ID) {
        s.sharedIngredientsFromShopId = null;
        continue;
      }
      const resolvedInvId = resolveInventoryShopId(s.id, allShops);
      s.sharedIngredientsFromShopId = resolvedInvId !== s.id ? resolvedInvId : null;
    }
    const resolvedActiveId = seenIds.has(activeShopId) ? activeShopId : DEFAULT_SHOP_ID;

    return {
      activeShopId: resolvedActiveId,
      shops: allShops,
      email: user.email ?? null,
    };
  } catch (err) {
    console.error("fetchShops failed gracefully:", err);
    return { activeShopId: DEFAULT_SHOP_ID, shops: [defaultFallback], email: null };
  }
});

export const fetchProfile = cache(async (): Promise<ProfileRecord> => {
  const fallback = { displayName: "เจ้าของร้าน", shopName: "kaikai", email: null, avatarUrl: null };
  if (!hasSupabaseEnv) return fallback;
  try {
    const { activeShopId, shops, email } = await fetchShops();
    const current = shops.find((s) => s.id === activeShopId) ?? shops[0] ?? fallback;
    return {
      displayName: current.displayName || fallback.displayName,
      shopName: current.shopName || fallback.shopName,
      email,
      avatarUrl: current.avatarUrl ?? null,
    };
  } catch (err) {
    console.error("fetchProfile failed gracefully:", err);
    return fallback;
  }
});
