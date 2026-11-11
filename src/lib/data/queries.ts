// Server-side data access. Reads through the signed-in user's session, so Row Level Security limits rows to that user.
// When Supabase is not configured every function returns empty data (there is no sample data).
import { cache } from "react";
import { cookies } from "next/headers";
import {
  COSTING_WINDOW_DAYS,
  type Summary,
  filterExpenses,
  filterSales,
  pooledFoodRevenue,
  pooledIngredientBps,
  summarize,
} from "@/lib/analytics";
import { hasSupabaseEnv } from "@/lib/env";
import { SCHEMA_OUTDATED_CODES, SCHEMA_OUTDATED_MESSAGE } from "@/lib/server-action";
import {
  ACTIVE_SHOP_COOKIE,
  DEFAULT_SHOP_ID,
  SHOPS_REGISTRY_SETTINGS_KEY,
  matchesPurchaseShop,
  matchesSaleShop,
  matchesShopText,
  normalizeShopId,
  resolveInventoryShopId,
  scopedSettingsKey,
  stripShopPrefix,
  type ShopSummary,
} from "@/lib/shop-scope";
import { createClient } from "@/lib/supabase/server";
import { DAY_MS, DEFAULT_DAY_START_HOUR, normalizeDayStartHour, resolveRange } from "@/lib/time";
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

const DERIVED_WINDOW_CACHE_PREFIXES = [
  "sales_win",
  "sales_superset",
  "expenses_win",
  "expenses_superset",
  "ing_purchases_win",
  "recent_purchases",
  "latest_purchases",
  "pack_purchases",
  "all_time",
  "pooled_rate",
];

export function invalidateQueryCache(prefix?: string) {
  if (!prefix) {
    memoryCache.clear();
    return;
  }
  for (const key of memoryCache.keys()) {
    if (
      key.includes(prefix) ||
      DERIVED_WINDOW_CACHE_PREFIXES.some((derived) => key.includes(derived))
    ) {
      memoryCache.delete(key);
    }
  }
}

/** Deduplicates `supabase.auth.getUser()` within a single server request. */
export const getSessionUser = cache(async () => {
  if (!hasSupabaseEnv) return null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user ?? null;
  } catch {
    return null;
  }
});

/** Reads the active shop ID and its resolved ingredient/packaging catalog shop ID from the request cookie. */
export const getActiveShopState = cache(async (): Promise<{ shopId: string; inventoryShopId: string }> => {
  let rawCookieShop = DEFAULT_SHOP_ID;
  try {
    const cookieStore = await cookies();
    rawCookieShop = normalizeShopId(cookieStore.get(ACTIVE_SHOP_COOKIE)?.value);
  } catch {
    return { shopId: DEFAULT_SHOP_ID, inventoryShopId: DEFAULT_SHOP_ID };
  }
  if (!hasSupabaseEnv) {
    return { shopId: DEFAULT_SHOP_ID, inventoryShopId: DEFAULT_SHOP_ID };
  }
  try {
    const user = await getSessionUser();
    const registryCacheKey = user ? `${user.id}:shops_registry_raw` : "";
    let list: Row[] | undefined = registryCacheKey ? getCached<Row[]>(registryCacheKey) : undefined;

    if (!list) {
      const supabase = await createClient();
      const { data } = await supabase
        .from("settings")
        .select("value")
        .eq("key", SHOPS_REGISTRY_SETTINGS_KEY)
        .maybeSingle();
      const rawVal = (data?.value ?? {}) as Row;
      list = Array.isArray(rawVal.shops) ? (rawVal.shops as Row[]) : [];
      if (registryCacheKey) {
        setCached(registryCacheKey, list, 60_000);
      }
    }

    const exists =
      rawCookieShop === DEFAULT_SHOP_ID ||
      list.some((s) => normalizeShopId(str(s.id)) === rawCookieShop);
    const effectiveShopId = exists ? rawCookieShop : DEFAULT_SHOP_ID;
    const inventoryShopId = resolveInventoryShopId(
      effectiveShopId,
      list as Array<{ id?: string | null; sharedIngredientsFromShopId?: string | null; shared_ingredients_from_shop_id?: string | null }>,
    );
    return { shopId: effectiveShopId, inventoryShopId };
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
    const [user, shopId] = await Promise.all([getSessionUser(), getActiveShopId()]);
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
let cachedHasScopeColumns: boolean | null = null;

function isMissingScopeColumnError(err: unknown): boolean {
  const msg =
    err instanceof QueryError
      ? `${err.originalMessage ?? ""} ${err.message}`
      : err instanceof Error
      ? err.message
      : String(err ?? "");
  const code = err instanceof QueryError ? err.code : undefined;
  return (
    (code === "42703" || code === "PGRST204" || msg.includes("does not exist")) &&
    (msg.includes("shop_scope_id") ||
      msg.includes("catalog_scope_id") ||
      msg.includes("purchase_shop_scope_id"))
  );
}

async function withScopeFallback<T>(
  scopedFn: () => Promise<T>,
  legacyFn: () => Promise<T>,
): Promise<T> {
  if (cachedHasScopeColumns === false) {
    return legacyFn();
  }
  try {
    const res = await scopedFn();
    cachedHasScopeColumns = true;
    return res;
  } catch (err) {
    if (isMissingScopeColumnError(err)) {
      cachedHasScopeColumns = false;
      return legacyFn();
    }
    throw err;
  }
}

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
    soldAt: str(row.soldAt ?? row.sold_at),
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

interface SupersetWindowCache<T> {
  startMs: number;
  endMs: number;
  records: T[];
}

/** Sales with sold_at in [start, end), newest first, scoped to the active shop. */
export async function fetchSales(start: Date, end: Date): Promise<SaleRecord[]> {
  if (!hasSupabaseEnv) return [];
  const [supabase, shopId, userId] = await Promise.all([
    createClient(),
    getActiveShopId(),
    getRequestUserId(),
  ]);

  const startMs = start.getTime();
  const endMs = end.getTime();
  const exactKey = `${userId}:sales_win:${shopId}:${startMs}:${endMs}`;
  const exactCached = getCached<SaleRecord[]>(exactKey);
  if (exactCached) return exactCached;

  const supersetKey = `${userId}:sales_superset:${shopId}`;
  const superset = getCached<SupersetWindowCache<SaleRecord>>(supersetKey);
  if (superset && superset.startMs <= startMs && superset.endMs >= endMs) {
    const sliced = filterSales(superset.records, start, end);
    return setCached(exactKey, sliced, 60_000);
  }

  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const querySales = (cols: string) =>
    withScopeFallback(
      () =>
        fetchAll("ข้อมูลการขาย", (from, to) =>
          supabase.from("sales").select(cols).gte("sold_at", startIso).lt("sold_at", endIso)
            .eq("shop_scope_id", shopId)
            .order("sold_at", { ascending: false }).range(from, to)),
      () =>
        fetchAll("ข้อมูลการขาย", (from, to) =>
          supabase.from("sales").select(cols).gte("sold_at", startIso).lt("sold_at", endIso)
            .order("sold_at", { ascending: false }).range(from, to)),
    );

  let mapped: SaleRecord[];
  if (cachedHasTipColumn === false) {
    const data = await querySales(SALE_COLUMNS_LEGACY);
    mapped = data.filter((r) => matchesSaleShop(r, shopId)).map(mapSale);
  } else {
    try {
      const data = await querySales(SALE_COLUMNS_WITH_TIP);
      cachedHasTipColumn = true;
      mapped = data.filter((r) => matchesSaleShop(r, shopId)).map(mapSale);
    } catch (err: unknown) {
      const isMissingColumn =
        (err instanceof QueryError && (err.code === "42703" || err.originalMessage?.includes("tip_satang"))) ||
        (err instanceof Error && err.message.includes("tip_satang"));
      if (isMissingColumn) {
        cachedHasTipColumn = false;
        const data = await querySales(SALE_COLUMNS_LEGACY);
        mapped = data.filter((r) => matchesSaleShop(r, shopId)).map(mapSale);
      } else {
        throw err;
      }
    }
  }

  setCached(exactKey, mapped, 60_000);
  const currentSpan = endMs - startMs;
  const prevSpan = superset ? superset.endMs - superset.startMs : 0;
  if (!superset || currentSpan >= prevSpan) {
    setCached(supersetKey, { startMs, endMs, records: mapped }, 60_000);
  }
  return mapped;
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
  const [supabase, shopId, userId] = await Promise.all([
    createClient(),
    getActiveShopId(),
    getRequestUserId(),
  ]);

  const startMs = start.getTime();
  const endMs = end.getTime();
  const exactKey = `${userId}:expenses_win:${shopId}:${startMs}:${endMs}`;
  const exactCached = getCached<ExpenseRecord[]>(exactKey);
  if (exactCached) return exactCached;

  const supersetKey = `${userId}:expenses_superset:${shopId}`;
  const superset = getCached<SupersetWindowCache<ExpenseRecord>>(supersetKey);
  if (superset && superset.startMs <= startMs && superset.endMs >= endMs) {
    const sliced = filterExpenses(superset.records, start, end);
    return setCached(exactKey, sliced, 60_000);
  }

  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const data = await withScopeFallback(
    () =>
      fetchAll("ค่าใช้จ่าย", (from, to) =>
        supabase.from("expenses").select("id,spent_at,category,kind,amount_satang,description,payee,payment_method,receipt_path,notes")
          .eq("shop_scope_id", shopId)
          .gte("spent_at", startIso).lt("spent_at", endIso).order("spent_at", { ascending: false }).range(from, to)),
    () =>
      fetchAll("ค่าใช้จ่าย", (from, to) =>
        supabase.from("expenses").select("id,spent_at,category,kind,amount_satang,description,payee,payment_method,receipt_path,notes")
          .gte("spent_at", startIso).lt("spent_at", endIso).order("spent_at", { ascending: false }).range(from, to)),
  );
  const mapped = data.filter((row) => matchesShopText(str(row.description), shopId)).map(mapExpense);

  setCached(exactKey, mapped, 60_000);
  const currentSpan = endMs - startMs;
  const prevSpan = superset ? superset.endMs - superset.startMs : 0;
  if (!superset || currentSpan >= prevSpan) {
    setCached(supersetKey, { startMs, endMs, records: mapped }, 60_000);
  }
  return mapped;
}

/**
 * Cached all-time summary for the active shop so `/dashboard` does not need to re-download
 * all historical sales & expenses on every single visit when viewing Today / 7d / Month.
 */
export async function fetchAllTimeSummary(end: Date, dayStartHour = DEFAULT_DAY_START_HOUR): Promise<Summary> {
  if (!hasSupabaseEnv) return summarize([], []);
  const [userId, shopId] = await Promise.all([getRequestUserId(), getActiveShopId()]);
  const cacheKey = `${userId}:all_time_summary:${shopId}`;
  const cached = getCached<Summary>(cacheKey);
  if (cached) return cached;

  const allRange = resolveRange("all", end, dayStartHour);
  const [allSales, allExpenses] = await Promise.all([
    fetchSales(allRange.start, end),
    fetchExpenses(allRange.start, end),
  ]);
  const summary = summarize(allSales, allExpenses);
  return setCached(cacheKey, summary, 60_000);
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
  const cacheKey = `${userId}:menus:${shopId}`;
  const cached = getCached<MenuRecord[]>(cacheKey);
  if (cached) return cached;

  const supabase = await createClient();
  const [data, menuYields] = await Promise.all([
    withScopeFallback(
      () =>
        fetchAll("เมนู", (from, to) =>
          supabase.from("menus").select("id,name,category,image_path,selling_price_satang,packaging_cost_satang,current_cost_satang,is_available,cost_calculated_at")
            .eq("shop_scope_id", shopId)
            .order("category", { ascending: false }).order("selling_price_satang").order("name").range(from, to)),
      () =>
        fetchAll("เมนู", (from, to) =>
          supabase.from("menus").select("id,name,category,image_path,selling_price_satang,packaging_cost_satang,current_cost_satang,is_available,cost_calculated_at")
            .order("category", { ascending: false }).order("selling_price_satang").order("name").range(from, to)),
    ),
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
  const data = await withScopeFallback(
    () =>
      fetchAll("วัตถุดิบ", (from, to) =>
        supabase.from("ingredients")
          .select("id,name,category,costing,base_unit,purchase_unit,units_per_purchase_unit,yield_auto,yield_updated_at,price_per_purchase_unit_satang,weighted_unit_cost_satang,is_active")
          .eq("catalog_scope_id", inventoryShopId)
          .order("costing", { ascending: false }).order("name").range(from, to)),
    () =>
      fetchAll("วัตถุดิบ", (from, to) =>
        supabase.from("ingredients")
          .select("id,name,category,costing,base_unit,purchase_unit,units_per_purchase_unit,yield_auto,yield_updated_at,price_per_purchase_unit_satang,weighted_unit_cost_satang,is_active")
          .order("costing", { ascending: false }).order("name").range(from, to)),
  );
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
  const data = await withScopeFallback(
    () =>
      fetchAll("บรรจุภัณฑ์", (from, to) =>
        supabase.from("packaging_items").select("id,name,unit,unit_cost_satang,is_active,per_order")
          .eq("catalog_scope_id", inventoryShopId).order("name").range(from, to)),
    () =>
      fetchAll("บรรจุภัณฑ์", (from, to) =>
        supabase.from("packaging_items").select("id,name,unit,unit_cost_satang,is_active,per_order")
          .order("name").range(from, to)),
  );
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
  const [supabase, shopId, inventoryShopId, userId] = await Promise.all([
    createClient(),
    getActiveShopId(),
    getActiveInventoryShopId(),
    getRequestUserId(),
  ]);
  const cacheKey = `${userId}:packaging_purchases:${shopId}:${inventoryShopId}`;
  const cached = getCached<PackagingPurchaseRecord[]>(cacheKey);
  if (cached) return cached;

  const data = await withScopeFallback(
    () =>
      fetchAll("ประวัติการซื้อบรรจุภัณฑ์", (from, to) =>
        supabase.from("packaging_purchases").select("id,packaging_item_id,purchased_at,price_satang,pack_quantity,pack_count,vendor,expense_id,packaging_items!inner(name,unit,catalog_scope_id)")
          .eq("purchase_shop_scope_id", shopId)
          .eq("packaging_items.catalog_scope_id", inventoryShopId)
          .order("purchased_at", { ascending: false }).order("created_at", { ascending: false }).range(from, to)),
    () =>
      fetchAll("ประวัติการซื้อบรรจุภัณฑ์", (from, to) =>
        supabase.from("packaging_purchases").select("id,packaging_item_id,purchased_at,price_satang,pack_quantity,pack_count,vendor,expense_id,packaging_items(name,unit)")
          .order("purchased_at", { ascending: false }).order("created_at", { ascending: false }).range(from, to)),
  );
  const res = data
    .filter((row) => {
      const itemName = str(one(row.packaging_items)?.name);
      return (
        matchesShopText(itemName, inventoryShopId) &&
        matchesPurchaseShop({ vendor: row.vendor, ingredientName: itemName }, shopId)
      );
    })
    .map((row) => {
      const item = one(row.packaging_items);
      const cleanVendor = stripShopPrefix(strOrNull(row.vendor)).trim();
      return {
        id: str(row.id), packagingItemId: str(row.packaging_item_id), itemName: stripShopPrefix(str(item?.name)), unit: str(item?.unit),
        purchasedAt: str(row.purchased_at), price: num(row.price_satang), packQuantity: num(row.pack_quantity), packCount: num(row.pack_count) || 1,
        vendor: cleanVendor || null, expenseId: strOrNull(row.expense_id),
      };
    });
  return setCached(cacheKey, res, 60_000);
}

const PURCHASE_COLUMNS = "id,ingredient_id,purchased_at,price_satang,purchased_quantity,purchase_unit,vendor,ingredients!inner(name,costing,catalog_scope_id)";
const PURCHASE_COLUMNS_LEGACY = "id,ingredient_id,purchased_at,price_satang,purchased_quantity,purchase_unit,vendor,ingredients(name,costing)";

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
  const [supabase, shopId, inventoryShopId, userId] = await Promise.all([
    createClient(),
    getActiveShopId(),
    getActiveInventoryShopId(),
    getRequestUserId(),
  ]);
  const cacheKey = `${userId}:recent_purchases:${shopId}:${inventoryShopId}:${limit}`;
  const cached = getCached<PurchaseRecord[]>(cacheKey);
  if (cached) return cached;

  const rawRows = await withScopeFallback(
    async () => {
      const { data, error } = await supabase.from("ingredient_purchases").select(PURCHASE_COLUMNS)
        .eq("purchase_shop_scope_id", shopId)
        .eq("ingredients.catalog_scope_id", inventoryShopId)
        .order("purchased_at", { ascending: false }).order("created_at", { ascending: false }).limit(limit);
      if (error) fail("ประวัติการซื้อ", error);
      return rows(data);
    },
    () =>
      fetchAll("ประวัติการซื้อ", (from, to) =>
        supabase.from("ingredient_purchases").select(PURCHASE_COLUMNS_LEGACY)
          .order("purchased_at", { ascending: false }).order("created_at", { ascending: false }).range(from, to)),
  );
  const res = rawRows
    .filter((row) => {
      const ingredientName = str(one(row.ingredients)?.name);
      return (
        matchesShopText(ingredientName, inventoryShopId) &&
        matchesPurchaseShop({ vendor: row.vendor, ingredientName }, shopId)
      );
    })
    .slice(0, limit)
    .map(mapPurchase);
  return setCached(cacheKey, res, 60_000);
}

/** Ingredient purchases with purchased_at in [start, end), newest first, scoped to the active shop. */
export async function fetchIngredientPurchases(start: Date, end: Date): Promise<PurchaseRecord[]> {
  if (!hasSupabaseEnv) return [];
  const [supabase, shopId, userId] = await Promise.all([
    createClient(),
    getActiveShopId(),
    getRequestUserId(),
  ]);
  const startMs = start.getTime();
  const endMs = end.getTime();
  const cacheKey = `${userId}:ing_purchases_win:${shopId}:${startMs}:${endMs}`;
  const cached = getCached<PurchaseRecord[]>(cacheKey);
  if (cached) return cached;

  const data = await withScopeFallback(
    () =>
      fetchAll("การซื้อวัตถุดิบ", (from, to) =>
        supabase.from("ingredient_purchases").select(PURCHASE_COLUMNS)
          .eq("purchase_shop_scope_id", shopId)
          .gte("purchased_at", start.toISOString()).lt("purchased_at", end.toISOString()).order("purchased_at", { ascending: false }).range(from, to)),
    () =>
      fetchAll("การซื้อวัตถุดิบ", (from, to) =>
        supabase.from("ingredient_purchases").select(PURCHASE_COLUMNS_LEGACY)
          .gte("purchased_at", start.toISOString()).lt("purchased_at", end.toISOString()).order("purchased_at", { ascending: false }).range(from, to)),
  );
  const res = data
    .filter((row) => matchesPurchaseShop({ vendor: row.vendor, ingredientName: one(row.ingredients)?.name }, shopId))
    .map(mapPurchase);
  return setCached(cacheKey, res, 60_000);
}

export type LatestPurchase = { purchasedAt: string; price: number; quantity: number | null };

/** Latest purchase per ingredient id (date, total price, quantity in the purchase unit). */
export async function fetchLatestPurchases(): Promise<Map<string, LatestPurchase>> {
  const latest = new Map<string, LatestPurchase>();
  if (!hasSupabaseEnv) return latest;
  const [supabase, shopId, inventoryShopId, userId] = await Promise.all([
    createClient(),
    getActiveShopId(),
    getActiveInventoryShopId(),
    getRequestUserId(),
  ]);
  const cacheKey = `${userId}:latest_purchases:${shopId}:${inventoryShopId}`;
  const cached = getCached<Map<string, LatestPurchase>>(cacheKey);
  if (cached) return cached;

  const data = await withScopeFallback(
    () =>
      fetchAll("ประวัติการซื้อ", (from, to) =>
        supabase.from("ingredient_purchases")
          .select("ingredient_id,purchased_at,price_satang,purchased_quantity,ingredients!inner(catalog_scope_id)")
          .eq("purchase_shop_scope_id", shopId)
          .eq("ingredients.catalog_scope_id", inventoryShopId)
          .order("purchased_at", { ascending: false }).order("created_at", { ascending: false }).range(from, to)),
    () =>
      fetchAll("ประวัติการซื้อ", (from, to) =>
        supabase.from("ingredient_purchases")
          .select("ingredient_id,purchased_at,price_satang,purchased_quantity")
          .order("purchased_at", { ascending: false }).order("created_at", { ascending: false }).range(from, to)),
  );
  for (const row of data) {
    if (latest.has(str(row.ingredient_id))) continue;
    latest.set(str(row.ingredient_id), {
      purchasedAt: str(row.purchased_at), price: num(row.price_satang),
      quantity: row.purchased_quantity === null || row.purchased_quantity === undefined ? null : num(row.purchased_quantity),
    });
  }
  return setCached(cacheKey, latest, 60_000);
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
  const cacheKey = `${userId}:settings:sales:${shopId}`;
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
  const cacheKey = `${userId}:settings:presets:${shopId}`;
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
  let initialBps = (settings ?? (await fetchSaleSettings())).initialPooledBps;
  let empty = { pooledPurchases: 0, foodRevenue: 0, historyDays: 0, initialBps };
  if (!hasSupabaseEnv) return { ...pooledIngredientBps(empty), ...empty };

  const [userId, inventoryShopId, shopsData] = await Promise.all([
    getRequestUserId(),
    getActiveInventoryShopId(),
    fetchShops(),
  ]);
  const supabase = await createClient();
  if (shopsData.activeShopId !== inventoryShopId) {
    const { data: catalogSetting, error: catalogSettingError } = await supabase
      .from("settings")
      .select("value")
      .eq("key", scopedSettingsKey(SALE_SETTINGS_KEY, inventoryShopId))
      .maybeSingle();
    if (catalogSettingError) fail("การตั้งค่าต้นทุนคลังร่วม", catalogSettingError);
    const catalogInitialBps = Number((catalogSetting?.value as Row | null)?.initial_pooled_bps);
    if (Number.isSafeInteger(catalogInitialBps) && catalogInitialBps >= 0 && catalogInitialBps <= 10_000) {
      initialBps = catalogInitialBps;
      empty = { ...empty, initialBps };
    }
  }
  const cacheKey = `${userId}:pooled_rate:${inventoryShopId}:${initialBps}`;
  const cached = getCached<PooledRate>(cacheKey);
  if (cached) return cached;

  const catalogShopIds = Array.from(
    new Set([
      inventoryShopId,
      ...shopsData.shops
        .filter((s) => resolveInventoryShopId(s.id, shopsData.shops) === inventoryShopId)
        .map((s) => s.id),
    ]),
  );

  const now = Date.now();
  const allPooledPurchases = await withScopeFallback(
    () =>
      fetchAll("การซื้อวัตถุดิบ", (from, to) =>
        supabase.from("ingredient_purchases")
          .select("purchased_at,price_satang,vendor,ingredients!inner(name,costing,catalog_scope_id)")
          .eq("ingredients.costing", "pooled")
          .eq("ingredients.catalog_scope_id", inventoryShopId)
          .lte("purchased_at", new Date(now).toISOString())
          .order("purchased_at", { ascending: true })
          .range(from, to),
      ),
    () =>
      fetchAll("การซื้อวัตถุดิบ", (from, to) =>
        supabase.from("ingredient_purchases")
          .select("purchased_at,price_satang,vendor,ingredients!inner(name,costing)")
          .eq("ingredients.costing", "pooled")
          .lte("purchased_at", new Date(now).toISOString())
          .order("purchased_at", { ascending: true })
          .range(from, to),
      ),
  );
  const shopPurchases = allPooledPurchases.filter((r) =>
    matchesShopText(str(one(r.ingredients)?.name), inventoryShopId),
  );
  const firstAt = shopPurchases[0]?.purchased_at;
  if (!firstAt) return setCached(cacheKey, { ...pooledIngredientBps(empty), ...empty }, 60_000);

  const start = new Date(Math.max(now - COSTING_WINDOW_DAYS * DAY_MS, Date.parse(str(firstAt))));
  const startIso = start.toISOString();
  const windowPurchases = shopPurchases.filter((r) => str(r.purchased_at) >= startIso);

  const rawSales = await withScopeFallback(
    () =>
      fetchAll("ข้อมูลการขาย", (from, to) =>
        supabase.from("sale_items")
          .select("id,menu_id,menu_name_snapshot,menu_category_snapshot,line_revenue_satang,sales!inner(status,sold_at,notes,shop_scope_id)")
          .eq("sales.status", "confirmed")
          .in("sales.shop_scope_id", catalogShopIds)
          .gte("sales.sold_at", startIso)
          .lte("sales.sold_at", new Date(now).toISOString())
          .order("id")
          .range(from, to),
      ),
    () =>
      fetchAll("ข้อมูลการขาย", (from, to) =>
        supabase.from("sale_items")
          .select("id,menu_id,menu_name_snapshot,menu_category_snapshot,line_revenue_satang,sales!inner(status,sold_at,notes)")
          .eq("sales.status", "confirmed")
          .gte("sales.sold_at", startIso)
          .lte("sales.sold_at", new Date(now).toISOString())
          .order("id")
          .range(from, to),
      ),
  );
  const shopSales = rawSales.filter((r) =>
    catalogShopIds.some((sid) => matchesSaleShop({ notes: one(r.sales)?.notes, sale_items: [r] }, sid)),
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
    const [user, activeShopId] = await Promise.all([getSessionUser(), getActiveShopId()]);
    if (!user) return { activeShopId: DEFAULT_SHOP_ID, shops: [defaultFallback], email: null };

    const shopsCacheKey = `${user.id}:shops_list_cached`;
    const cachedShopsData = getCached<{ shops: ShopSummary[]; email: string | null }>(shopsCacheKey);
    if (cachedShopsData) {
      const validIds = new Set(cachedShopsData.shops.map((s) => s.id));
      return {
        activeShopId: validIds.has(activeShopId) ? activeShopId : DEFAULT_SHOP_ID,
        shops: cachedShopsData.shops,
        email: cachedShopsData.email,
      };
    }

    const supabase = await createClient();
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
    setCached(`${user.id}:shops_registry_raw`, rawList, 60_000);

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

    setCached(
      shopsCacheKey,
      {
        shops: allShops,
        email: user.email ?? null,
      },
      60_000,
    );

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
