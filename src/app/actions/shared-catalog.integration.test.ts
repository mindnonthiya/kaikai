import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_SHOP_COOKIE,
  DEFAULT_SHOP_ID,
  SHOPS_REGISTRY_SETTINGS_KEY,
  encodeShopText,
} from "@/lib/shop-scope";

type Row = Record<string, unknown>;

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

let activeShopCookieValue = DEFAULT_SHOP_ID;
let idCounter = 100;

function nextUuid() {
  idCounter += 1;
  return `00000000-0000-0000-0000-${String(idCounter).padStart(12, "0")}`;
}

class InMemorySupabase {
  tables: Record<string, Row[]> = {
    settings: [],
    profiles: [{ id: TEST_USER_ID, store_name: "สาขาหลัก" }],
    ingredients: [],
    ingredient_purchases: [],
    packaging_items: [],
    packaging_purchases: [],
    menus: [],
    menu_recipe_items: [],
    expenses: [],
    sales: [],
    sale_items: [],
    sale_packaging: [],
  };

  failOn: ((table: string, op: string, payload?: unknown) => { code?: string; message: string } | null) | null = null;

  auth = {
    getUser: async () => ({
      data: { user: { id: TEST_USER_ID, email: "owner@example.com" } },
      error: null,
    }),
  };

  storage = {
    from: () => ({
      remove: async () => ({ data: [], error: null }),
    }),
  };

  from(table: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const db = this;
    if (!db.tables[table]) db.tables[table] = [];

    type FilterFn = (row: Row) => boolean;
    const filters: FilterFn[] = [];
    let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payloadData: unknown = null;
    let upsertConflict = "";
    let headCountOnly = false;
    let orderCol: string | null = null;
    let orderAsc = true;
    let rangeBounds: [number, number] | null = null;
    let limitCount: number | null = null;

    const applyFilters = (rows: Row[]) => rows.filter((r) => filters.every((fn) => fn(r)));

    const execute = async (): Promise<{ data: unknown; error: { code?: string; message: string } | null; count?: number }> => {
      if (db.failOn) {
        const simulatedErr = db.failOn(table, op, payloadData);
        if (simulatedErr) {
          return { data: null, error: simulatedErr };
        }
      }

      const tableRows = db.tables[table];

      if (op === "insert") {
        const items = Array.isArray(payloadData) ? payloadData : [payloadData];
        const inserted: Row[] = [];
        for (const raw of items) {
          const item = { ...(raw as Row) };
          if (!item.id) item.id = nextUuid();
          if (!item.created_at) item.created_at = new Date().toISOString();
          tableRows.push(item);
          inserted.push({ ...item });
        }
        return { data: inserted, error: null };
      }

      if (op === "upsert") {
        const items = Array.isArray(payloadData) ? payloadData : [payloadData];
        const conflictCols = upsertConflict
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        const upserted: Row[] = [];
        for (const raw of items) {
          const item = { ...(raw as Row) };
          const existingIdx =
            conflictCols.length > 0
              ? tableRows.findIndex((r) => conflictCols.every((col) => r[col] === item[col]))
              : -1;
          if (existingIdx >= 0) {
            tableRows[existingIdx] = { ...tableRows[existingIdx], ...item };
            upserted.push({ ...tableRows[existingIdx] });
          } else {
            if (!item.id) item.id = nextUuid();
            tableRows.push(item);
            upserted.push({ ...item });
          }
        }
        return { data: upserted, error: null };
      }

      if (op === "update") {
        const matched = applyFilters(tableRows);
        const updated: Row[] = [];
        for (const row of matched) {
          Object.assign(row, payloadData as Row);
          updated.push({ ...row });
        }
        return { data: updated, error: null };
      }

      if (op === "delete") {
        const matched = new Set(applyFilters(tableRows));
        const deleted: Row[] = [];
        db.tables[table] = tableRows.filter((r) => {
          if (matched.has(r)) {
            deleted.push({ ...r });
            return false;
          }
          return true;
        });
        return { data: deleted, error: null };
      }

      // select
      let matched = applyFilters(tableRows).map((r) => ({ ...r }));
      if (headCountOnly) {
        return { data: null, error: null, count: matched.length };
      }
      if (orderCol) {
        const col = orderCol;
        const dir = orderAsc ? 1 : -1;
        matched.sort((a, b) => {
          const va = String(a[col] ?? "");
          const vb = String(b[col] ?? "");
          return va.localeCompare(vb) * dir;
        });
      }
      if (rangeBounds) {
        matched = matched.slice(rangeBounds[0], rangeBounds[1] + 1);
      }
      if (limitCount !== null) {
        matched = matched.slice(0, limitCount);
      }
      return { data: matched, error: null };
    };

    const builder = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (op === "select") {
          headCountOnly = Boolean(opts?.head);
        }
        return builder;
      },
      insert(values: unknown) {
        op = "insert";
        payloadData = values;
        return builder;
      },
      update(values: unknown) {
        op = "update";
        payloadData = values;
        return builder;
      },
      upsert(values: unknown, opts?: { onConflict?: string }) {
        op = "upsert";
        payloadData = values;
        upsertConflict = opts?.onConflict ?? "";
        return builder;
      },
      delete() {
        op = "delete";
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return builder;
      },
      neq(col: string, val: unknown) {
        filters.push((r) => r[col] !== val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        filters.push((r) => set.has(r[col]));
        return builder;
      },
      is(col: string, val: unknown) {
        filters.push((r) => (r[col] ?? null) === val);
        return builder;
      },
      like(col: string, pattern: string) {
        const regex = new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$");
        filters.push((r) => typeof r[col] === "string" && regex.test(String(r[col])));
        return builder;
      },
      ilike(col: string, pattern: string) {
        const regex = new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
        filters.push((r) => typeof r[col] === "string" && regex.test(String(r[col])));
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderCol = col;
        orderAsc = opts?.ascending !== false;
        return builder;
      },
      range(from: number, to: number) {
        rangeBounds = [from, to];
        return builder;
      },
      limit(n: number) {
        limitCount = n;
        return builder;
      },
      async single() {
        const res = await execute();
        if (res.error) return res;
        const arr = (res.data as Row[]) ?? [];
        if (arr.length === 0) {
          return { data: null, error: { code: "PGRST116", message: "Row not found" } };
        }
        return { data: arr[0], error: null };
      },
      async maybeSingle() {
        const res = await execute();
        if (res.error) return res;
        const arr = (res.data as Row[]) ?? [];
        return { data: arr[0] ?? null, error: null };
      },
      then<TResult1 = unknown, TResult2 = never>(
        onfulfilled?: ((value: { data: unknown; error: { code?: string; message: string } | null; count?: number }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return execute().then(onfulfilled, onrejected);
      },
    };

    return builder;
  }
}

let mockDb: InMemorySupabase;

vi.mock("@/lib/env", () => ({
  hasSupabaseEnv: true,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === ACTIVE_SHOP_COOKIE ? { value: activeShopCookieValue } : undefined),
    set: (name: string, value: string) => {
      if (name === ACTIVE_SHOP_COOKIE) activeShopCookieValue = value;
    },
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => mockDb,
}));

import { deleteExpensesBulkAction, updateExpenseAction } from "./expenses";
import { saveItemizedExpenseAction } from "./ingredients";
import { saveMenuRecipe } from "./menus";
import { cancelSale } from "./sales";
import { deleteShopAction, updateShopIngredientSharingAction } from "./settings";

describe("shared ingredient & packaging catalog integration", () => {
  beforeEach(() => {
    idCounter = 100;
    activeShopCookieValue = DEFAULT_SHOP_ID;
    mockDb = new InMemorySupabase();
  });

  it("handles full lifecycle: share -> multi-branch purchase -> unlink -> relink -> delete shop with accurate costs", async () => {
    const ingAId = "00000000-0000-0000-0000-000000000010";
    const packAId = "00000000-0000-0000-0000-000000000020";
    const menuAId = "00000000-0000-0000-0000-000000000030";
    const menuBId = "00000000-0000-0000-0000-000000000031";

    // Setup Shop A (default) and Shop B (shop-b sharing from default)
    mockDb.tables.settings.push({
      id: nextUuid(),
      owner_id: TEST_USER_ID,
      key: SHOPS_REGISTRY_SETTINGS_KEY,
      value: {
        shops: [
          {
            id: "shop-b",
            name: "สาขา 2",
            createdAt: "2026-11-01T00:00:00.000Z",
            sharedIngredientsFromShopId: DEFAULT_SHOP_ID,
          },
        ],
      },
    });

    mockDb.tables.ingredients.push({
      id: ingAId,
      owner_id: TEST_USER_ID,
      name: "ไก่สด",
      costing: "per_unit",
      base_unit: "ชิ้น",
      purchase_unit: "กก.",
      units_per_purchase_unit: 10,
      price_per_purchase_unit_satang: 0,
      weighted_unit_cost_satang: 0,
      yield_auto: false,
      is_active: true,
    });

    mockDb.tables.packaging_items.push({
      id: packAId,
      owner_id: TEST_USER_ID,
      name: "กล่อง",
      unit: "ใบ",
      per_order: true,
      unit_cost_satang: 0,
      is_active: true,
    });

    mockDb.tables.menus.push(
      {
        id: menuAId,
        owner_id: TEST_USER_ID,
        name: "ข้าวมันไก่ A",
        category: "เมนูหลัก",
        selling_price_satang: 5000,
        current_cost_satang: 0,
        is_available: true,
      },
      {
        id: menuBId,
        owner_id: TEST_USER_ID,
        name: encodeShopText("ข้าวมันไก่ B", "shop-b"),
        category: "เมนูหลัก",
        selling_price_satang: 5000,
        current_cost_satang: 0,
        is_available: true,
      },
    );

    // Both Menu A and Menu B use 2 ชิ้น ไก่สด + 1 ใบ กล่อง
    mockDb.tables.menu_recipe_items.push(
      { id: nextUuid(), owner_id: TEST_USER_ID, menu_id: menuAId, ingredient_id: ingAId, packaging_item_id: null, quantity: 2 },
      { id: nextUuid(), owner_id: TEST_USER_ID, menu_id: menuAId, ingredient_id: null, packaging_item_id: packAId, quantity: 1 },
      { id: nextUuid(), owner_id: TEST_USER_ID, menu_id: menuBId, ingredient_id: ingAId, packaging_item_id: null, quantity: 2 },
      { id: nextUuid(), owner_id: TEST_USER_ID, menu_id: menuBId, ingredient_id: null, packaging_item_id: packAId, quantity: 1 },
    );

    // 1. Shop A buys 1 กก. ไก่สด @ 100฿ (10,000 satang) and 1 แพ็ก (100 ใบ) กล่อง @ 100฿ (10,000 satang)
    activeShopCookieValue = DEFAULT_SHOP_ID;
    const resPurchaseA = await saveItemizedExpenseAction({
      spentAt: "2026-11-10",
      vendor: "ตลาดสด",
      perUnitItems: [{ ingredientId: ingAId, quantity: 1, unitPriceSatang: 10000 }],
      packagingItems: [{ packagingId: packAId, packs: 1, packPriceSatang: 10000, perPackQuantity: 100 }],
    });
    expect(resPurchaseA.ok).toBe(true);

    // 2. Shop B buys 1 กก. ไก่สด @ 200฿ (20,000 satang) and 1 แพ็ก (100 ใบ) กล่อง @ 300฿ (30,000 satang)
    activeShopCookieValue = "shop-b";
    const resPurchaseB = await saveItemizedExpenseAction({
      spentAt: "2026-11-10",
      vendor: "ตลาดสาขา 2",
      perUnitItems: [{ ingredientId: ingAId, quantity: 1, unitPriceSatang: 20000 }],
      packagingItems: [{ packagingId: packAId, packs: 1, packPriceSatang: 30000, perPackQuantity: 100 }],
    });
    expect(resPurchaseB.ok).toBe(true);

    // Shared catalog average cost:
    // ไก่สด: (10,000 + 20,000) / 2 = 15,000 per กก. -> 1,500 satang per ชิ้น
    // กล่อง: (10,000 + 30,000) / 200 = 200 satang per ใบ
    // Menu cost = 2 * 1,500 + 1 * 200 = 3,200 satang
    const sharedIng = mockDb.tables.ingredients.find((i) => i.id === ingAId)!;
    const sharedPack = mockDb.tables.packaging_items.find((p) => p.id === packAId)!;
    expect(sharedIng.weighted_unit_cost_satang).toBe(1500);
    expect(sharedPack.unit_cost_satang).toBe(200);
    expect(mockDb.tables.menus.find((m) => m.id === menuAId)!.current_cost_satang).toBe(3200);
    expect(mockDb.tables.menus.find((m) => m.id === menuBId)!.current_cost_satang).toBe(3200);

    // 3. Unlink Shop B (isolated catalog)
    const unlinkForm = new FormData();
    unlinkForm.set("shop_id", "shop-b");
    unlinkForm.set("shared_from_shop_id", "isolated");
    const unlinkRes = await updateShopIngredientSharingAction(unlinkForm);
    expect(unlinkRes.ok).toBe(true);

    const shopBIng = mockDb.tables.ingredients.find((i) => i.name === "[s:shop-b]ไก่สด");
    const shopBPack = mockDb.tables.packaging_items.find((p) => p.name === "[s:shop-b]กล่อง");
    expect(shopBIng).toBeDefined();
    expect(shopBPack).toBeDefined();

    // Shop A catalog now only has Shop A's purchases (ไก่สด = 1,000/ชิ้น, กล่อง = 100/ใบ, Menu A = 2,100)
    expect(mockDb.tables.ingredients.find((i) => i.id === ingAId)!.weighted_unit_cost_satang).toBe(1000);
    expect(mockDb.tables.packaging_items.find((p) => p.id === packAId)!.unit_cost_satang).toBe(100);
    expect(mockDb.tables.menus.find((m) => m.id === menuAId)!.current_cost_satang).toBe(2100);

    // Shop B catalog now only has Shop B's purchases (ไก่สด = 2,000/ชิ้น, กล่อง = 300/ใบ, Menu B = 4,300)
    expect(shopBIng!.weighted_unit_cost_satang).toBe(2000);
    expect(shopBPack!.unit_cost_satang).toBe(300);
    expect(mockDb.tables.menus.find((m) => m.id === menuBId)!.current_cost_satang).toBe(4300);

    // 4. Relink Shop B back to Shop A (default)
    const relinkForm = new FormData();
    relinkForm.set("shop_id", "shop-b");
    relinkForm.set("shared_from_shop_id", DEFAULT_SHOP_ID);
    const relinkRes = await updateShopIngredientSharingAction(relinkForm);
    expect(relinkRes.ok).toBe(true);

    // Duplicate Shop B catalog items were merged into Shop A's catalog
    expect(mockDb.tables.ingredients.find((i) => i.name === "[s:shop-b]ไก่สด")).toBeUndefined();
    expect(mockDb.tables.packaging_items.find((p) => p.name === "[s:shop-b]กล่อง")).toBeUndefined();
    expect(mockDb.tables.ingredients.find((i) => i.id === ingAId)!.weighted_unit_cost_satang).toBe(1500);
    expect(mockDb.tables.packaging_items.find((p) => p.id === packAId)!.unit_cost_satang).toBe(200);
    expect(mockDb.tables.menus.find((m) => m.id === menuAId)!.current_cost_satang).toBe(3200);
    expect(mockDb.tables.menus.find((m) => m.id === menuBId)!.current_cost_satang).toBe(3200);

    // 5. Delete Shop B while sharing Shop A's catalog
    const delForm = new FormData();
    delForm.set("shop_id", "shop-b");
    const delRes = await deleteShopAction(delForm);
    expect(delRes.ok).toBe(true);

    // Shop B's purchases must be removed from Shop A's shared catalog!
    expect(mockDb.tables.ingredient_purchases).toHaveLength(1);
    expect(mockDb.tables.packaging_purchases).toHaveLength(1);

    // Shop A's unit costs and Menu A cost must be recalculated without Shop B's deleted purchases
    expect(mockDb.tables.ingredients.find((i) => i.id === ingAId)!.weighted_unit_cost_satang).toBe(1000);
    expect(mockDb.tables.packaging_items.find((p) => p.id === packAId)!.unit_cost_satang).toBe(100);
    expect(mockDb.tables.menus.find((m) => m.id === menuAId)!.current_cost_satang).toBe(2100);
  });

  it("isolates same-day, same-price, no-slip expenses between branches on edit and delete (including legacy fallback)", async () => {
    const eggId = "00000000-0000-0000-0000-000000000050";

    mockDb.tables.settings.push({
      id: nextUuid(),
      owner_id: TEST_USER_ID,
      key: SHOPS_REGISTRY_SETTINGS_KEY,
      value: {
        shops: [
          {
            id: "shop-b",
            name: "สาขา 2",
            createdAt: "2026-11-01T00:00:00.000Z",
            sharedIngredientsFromShopId: DEFAULT_SHOP_ID,
          },
        ],
      },
    });

    mockDb.tables.ingredients.push({
      id: eggId,
      owner_id: TEST_USER_ID,
      name: "ไข่ไก่",
      costing: "per_unit",
      base_unit: "ฟอง",
      purchase_unit: "แผง",
      units_per_purchase_unit: 30,
      price_per_purchase_unit_satang: 0,
      weighted_unit_cost_satang: 0,
      yield_auto: false,
      is_active: true,
    });

    // Both Shop A and Shop B buy 1 แผง ไข่ไก่ at 120฿ on the same day with no slip and no vendor
    activeShopCookieValue = DEFAULT_SHOP_ID;
    await saveItemizedExpenseAction({
      spentAt: "2026-11-10",
      perUnitItems: [{ ingredientId: eggId, quantity: 1, unitPriceSatang: 12000 }],
    });

    activeShopCookieValue = "shop-b";
    await saveItemizedExpenseAction({
      spentAt: "2026-11-10",
      perUnitItems: [{ ingredientId: eggId, quantity: 1, unitPriceSatang: 12000 }],
    });

    expect(mockDb.tables.expenses).toHaveLength(2);
    expect(mockDb.tables.ingredient_purchases).toHaveLength(2);

    const expA = mockDb.tables.expenses.find((e) => e.description === "ซื้อไข่ไก่ 1 แผง")!;
    const expB = mockDb.tables.expenses.find((e) => e.description === "[s:shop-b]ซื้อไข่ไก่ 1 แผง")!;
    const purA = mockDb.tables.ingredient_purchases.find((p) => p.expense_id === expA.id)!;
    const purB = mockDb.tables.ingredient_purchases.find((p) => p.expense_id === expB.id)!;
    expect(purA).toBeDefined();
    expect(purB).toBeDefined();

    // Even if expense_id were null (legacy row before migration), editing Shop B's expense must ONLY touch Shop B's purchase
    purA.expense_id = null;
    purB.expense_id = null;

    const editRes = await updateExpenseAction({
      id: String(expB.id),
      spentAt: "2026-11-10",
      description: "ซื้อไข่ไก่ 1 แผง",
      category: "วัตถุดิบ",
      kind: "direct",
      amountSatang: 18000,
      paymentMethod: "transfer",
    });
    expect(editRes.ok).toBe(true);

    // Shop A's purchase stays 12,000; Shop B's purchase becomes 18,000
    expect(mockDb.tables.ingredient_purchases.find((p) => p.id === purA.id)!.price_satang).toBe(12000);
    expect(mockDb.tables.ingredient_purchases.find((p) => p.id === purB.id)!.price_satang).toBe(18000);

    // Reset both to 12,000 with expense_id = null and delete Shop B's expense -> must ONLY delete Shop B's purchase
    purB.price_satang = 12000;
    expB.amount_satang = 12000;

    const delRes = await deleteExpensesBulkAction([String(expB.id)]);
    expect(delRes.ok).toBe(true);
    expect(mockDb.tables.ingredient_purchases).toHaveLength(1);
    expect(mockDb.tables.ingredient_purchases[0].id).toBe(purA.id);
  });

  it("rolls back all changes and preserves shops_registry if an error occurs mid-relink", async () => {
    const ingAId = "00000000-0000-0000-0000-000000000060";
    const ingBId = "00000000-0000-0000-0000-000000000061";
    const purBId = "00000000-0000-0000-0000-000000000062";

    mockDb.tables.settings.push({
      id: nextUuid(),
      owner_id: TEST_USER_ID,
      key: SHOPS_REGISTRY_SETTINGS_KEY,
      value: {
        shops: [
          {
            id: "shop-b",
            name: "สาขา 2",
            createdAt: "2026-11-01T00:00:00.000Z",
            sharedIngredientsFromShopId: null,
          },
        ],
      },
    });

    mockDb.tables.ingredients.push(
      {
        id: ingAId,
        owner_id: TEST_USER_ID,
        name: "หมูสับ",
        costing: "per_unit",
        base_unit: "กรัม",
        purchase_unit: "กก.",
        units_per_purchase_unit: 1000,
        price_per_purchase_unit_satang: 15000,
        weighted_unit_cost_satang: 15,
        is_active: true,
      },
      {
        id: ingBId,
        owner_id: TEST_USER_ID,
        name: "[s:shop-b]หมูสับ",
        costing: "per_unit",
        base_unit: "กรัม",
        purchase_unit: "กก.",
        units_per_purchase_unit: 1000,
        price_per_purchase_unit_satang: 16000,
        weighted_unit_cost_satang: 16,
        is_active: true,
      },
    );

    mockDb.tables.ingredient_purchases.push({
      id: purBId,
      owner_id: TEST_USER_ID,
      ingredient_id: ingBId,
      purchased_at: "2026-11-10T00:00:00.000Z",
      price_satang: 16000,
      purchased_quantity: 1,
      vendor: "[s:shop-b]ตลาด",
    });

    // Inject failure when deleting the duplicate ingredient after purchases were already moved
    mockDb.failOn = (table, op) => {
      if (table === "ingredients" && op === "delete") {
        return { code: "23503", message: "Simulated FK failure on ingredients delete" };
      }
      return null;
    };

    const relinkErrForm = new FormData();
    relinkErrForm.set("shop_id", "shop-b");
    relinkErrForm.set("shared_from_shop_id", DEFAULT_SHOP_ID);
    const res = await updateShopIngredientSharingAction(relinkErrForm);
    expect(res.error).toBeDefined();

    // Verify rollback restored purchase's ingredient_id to ingBId and kept shops_registry unchanged
    expect(mockDb.tables.ingredient_purchases.find((p) => p.id === purBId)!.ingredient_id).toBe(ingBId);
    const reg = mockDb.tables.settings.find((s) => s.key === SHOPS_REGISTRY_SETTINGS_KEY)!.value as {
      shops: Array<{ id: string; sharedIngredientsFromShopId: string | null }>;
    };
    expect(reg.shops[0].sharedIngredientsFromShopId).toBeNull();
  });

  it("rejects cross-catalog ingredient, packaging, and menu IDs on server actions", async () => {
    const ingDefaultId = "00000000-0000-0000-0000-000000000070";
    const menuDefaultId = "00000000-0000-0000-0000-000000000071";
    const menuShopCId = "00000000-0000-0000-0000-000000000072";

    mockDb.tables.settings.push({
      id: nextUuid(),
      owner_id: TEST_USER_ID,
      key: SHOPS_REGISTRY_SETTINGS_KEY,
      value: {
        shops: [
          {
            id: "shop-c",
            name: "สาขา 3 (แยกคลัง)",
            createdAt: "2026-11-01T00:00:00.000Z",
            sharedIngredientsFromShopId: null,
          },
        ],
      },
    });

    mockDb.tables.ingredients.push({
      id: ingDefaultId,
      owner_id: TEST_USER_ID,
      name: "กุ้งสด",
      costing: "per_unit",
      base_unit: "ตัว",
      purchase_unit: "กก.",
      units_per_purchase_unit: 30,
      price_per_purchase_unit_satang: 20000,
      weighted_unit_cost_satang: 667,
      is_active: true,
    });

    mockDb.tables.menus.push(
      {
        id: menuDefaultId,
        owner_id: TEST_USER_ID,
        name: "กะเพรากุ้ง",
        category: "เมนูหลัก",
        selling_price_satang: 6000,
        current_cost_satang: 0,
        is_available: true,
      },
      {
        id: menuShopCId,
        owner_id: TEST_USER_ID,
        name: "[s:shop-c]กะเพรากุ้ง C",
        category: "เมนูหลัก",
        selling_price_satang: 6000,
        current_cost_satang: 0,
        is_available: true,
      },
    );

    // Switch active shop to isolated shop-c
    activeShopCookieValue = "shop-c";

    // 1. Trying to record purchase for default's ingredient while in isolated shop-c must fail
    const purchaseRes = await saveItemizedExpenseAction({
      spentAt: "2026-11-10",
      perUnitItems: [{ ingredientId: ingDefaultId, quantity: 1, unitPriceSatang: 20000 }],
    });
    expect(purchaseRes.error).toContain("ไม่ได้อยู่ในคลังของร้านปัจจุบัน");
    expect(mockDb.tables.ingredient_purchases).toHaveLength(0);

    // 2. Trying to attach default's ingredient to shop-c's menu recipe must fail
    const recipeForm1 = new FormData();
    recipeForm1.set("menu_id", menuShopCId);
    recipeForm1.set(`ing_${ingDefaultId}`, "5");
    const recipeRes1 = await saveMenuRecipe(recipeForm1);
    expect(recipeRes1.error).toContain("ไม่ได้อยู่ในคลังของร้านปัจจุบัน");
    expect(mockDb.tables.menu_recipe_items).toHaveLength(0);

    // 3. Trying to edit default's menu recipe while active shop is shop-c must fail
    const recipeForm2 = new FormData();
    recipeForm2.set("menu_id", menuDefaultId);
    const recipeRes2 = await saveMenuRecipe(recipeForm2);
    expect(recipeRes2.error).toContain("ไม่พบเมนูในร้านปัจจุบัน");
  });

  it("rejects same-name catalog merges when costing units are incompatible", async () => {
    const defaultIngredientId = "00000000-0000-0000-0000-000000000080";
    const branchIngredientId = "00000000-0000-0000-0000-000000000081";
    mockDb.tables.settings.push({
      id: nextUuid(),
      owner_id: TEST_USER_ID,
      key: SHOPS_REGISTRY_SETTINGS_KEY,
      value: { shops: [{ id: "shop-b", shopName: "สาขา B", sharedIngredientsFromShopId: null }] },
    });
    mockDb.tables.ingredients.push(
      {
        id: defaultIngredientId,
        owner_id: TEST_USER_ID,
        name: "นมสด",
        costing: "per_unit",
        base_unit: "มล.",
        purchase_unit: "ขวด",
        units_per_purchase_unit: 1000,
        price_per_purchase_unit_satang: 5000,
        weighted_unit_cost_satang: 5,
        is_active: true,
      },
      {
        id: branchIngredientId,
        owner_id: TEST_USER_ID,
        name: "[s:shop-b]นมสด",
        costing: "per_unit",
        base_unit: "กล่อง",
        purchase_unit: "ลัง",
        units_per_purchase_unit: 12,
        price_per_purchase_unit_satang: 60000,
        weighted_unit_cost_satang: 5000,
        is_active: true,
      },
    );

    activeShopCookieValue = "shop-b";
    const form = new FormData();
    form.set("shop_id", "shop-b");
    form.set("shared_from_shop_id", DEFAULT_SHOP_ID);
    const result = await updateShopIngredientSharingAction(form);
    expect(result.error).toContain("ชื่อซ้ำกัน");
    expect(mockDb.tables.ingredients).toHaveLength(2);
    const registry = mockDb.tables.settings.find((row) => row.key === SHOPS_REGISTRY_SETTINGS_KEY)!.value as {
      shops: Array<{ sharedIngredientsFromShopId: string | null }>;
    };
    expect(registry.shops[0].sharedIngredientsFromShopId).toBeNull();
  });

  it("resets the old catalog cost when the leaving branch was its only purchaser", async () => {
    const ingredientId = "00000000-0000-0000-0000-000000000082";
    mockDb.tables.settings.push({
      id: nextUuid(),
      owner_id: TEST_USER_ID,
      key: SHOPS_REGISTRY_SETTINGS_KEY,
      value: { shops: [{ id: "shop-b", shopName: "สาขา B", sharedIngredientsFromShopId: DEFAULT_SHOP_ID }] },
    });
    mockDb.tables.ingredients.push({
      id: ingredientId,
      owner_id: TEST_USER_ID,
      name: "แป้ง",
      costing: "per_unit",
      base_unit: "กรัม",
      purchase_unit: "กก.",
      units_per_purchase_unit: 1000,
      price_per_purchase_unit_satang: 10000,
      weighted_unit_cost_satang: 10,
      is_active: true,
    });
    mockDb.tables.ingredient_purchases.push({
      id: nextUuid(),
      owner_id: TEST_USER_ID,
      ingredient_id: ingredientId,
      purchased_at: "2026-11-10T00:00:00.000Z",
      price_satang: 10000,
      purchased_quantity: 1,
      vendor: "[s:shop-b]ตลาด",
    });

    activeShopCookieValue = "shop-b";
    const form = new FormData();
    form.set("shop_id", "shop-b");
    form.set("shared_from_shop_id", "isolated");
    const result = await updateShopIngredientSharingAction(form);
    expect(result.ok).toBe(true);
    expect(mockDb.tables.ingredients.find((row) => row.id === ingredientId)!.weighted_unit_cost_satang).toBe(0);
    expect(mockDb.tables.ingredients.find((row) => row.name === "[s:shop-b]แป้ง")!.weighted_unit_cost_satang).toBe(10);
  });

  it("moves branch sale_packaging when switching from shared catalog X to Y", async () => {
    const packAId = "00000000-0000-0000-0000-000000000083";
    const packCId = "00000000-0000-0000-0000-000000000084";
    const menuBId = "00000000-0000-0000-0000-000000000085";
    const saleBId = "00000000-0000-0000-0000-000000000086";
    mockDb.tables.settings.push({
      id: nextUuid(),
      owner_id: TEST_USER_ID,
      key: SHOPS_REGISTRY_SETTINGS_KEY,
      value: {
        shops: [
          { id: "shop-b", shopName: "สาขา B", sharedIngredientsFromShopId: DEFAULT_SHOP_ID },
          { id: "shop-c", shopName: "สาขา C", sharedIngredientsFromShopId: null },
        ],
      },
    });
    mockDb.tables.packaging_items.push(
      { id: packAId, owner_id: TEST_USER_ID, name: "กล่อง", unit: "ใบ", per_order: true, unit_cost_satang: 100, is_active: true },
      { id: packCId, owner_id: TEST_USER_ID, name: "[s:shop-c]กล่อง", unit: "ใบ", per_order: true, unit_cost_satang: 120, is_active: true },
    );
    mockDb.tables.menus.push({
      id: menuBId,
      owner_id: TEST_USER_ID,
      name: "[s:shop-b]เมนู B",
      category: "เมนูหลัก",
      selling_price_satang: 5000,
      current_cost_satang: 100,
      is_available: true,
    });
    mockDb.tables.menu_recipe_items.push({
      id: nextUuid(), owner_id: TEST_USER_ID, menu_id: menuBId, ingredient_id: null, packaging_item_id: packAId, quantity: 1,
    });
    mockDb.tables.sales.push({ id: saleBId, owner_id: TEST_USER_ID, notes: "[s:shop-b]", status: "confirmed" });
    mockDb.tables.sale_packaging.push({
      id: nextUuid(), owner_id: TEST_USER_ID, sale_id: saleBId, packaging_item_id: packAId, quantity: 1,
    });

    activeShopCookieValue = "shop-b";
    const form = new FormData();
    form.set("shop_id", "shop-b");
    form.set("shared_from_shop_id", "shop-c");
    const result = await updateShopIngredientSharingAction(form);
    expect(result.ok).toBe(true);
    expect(mockDb.tables.sale_packaging[0].packaging_item_id).toBe(packCId);
    expect(mockDb.tables.menu_recipe_items[0].packaging_item_id).toBe(packCId);
  });

  it("rejects expense and sale mutations from another active shop", async () => {
    const expenseBId = "00000000-0000-0000-0000-000000000087";
    const saleBId = "00000000-0000-0000-0000-000000000088";
    mockDb.tables.settings.push({
      id: nextUuid(),
      owner_id: TEST_USER_ID,
      key: SHOPS_REGISTRY_SETTINGS_KEY,
      value: { shops: [{ id: "shop-b", shopName: "สาขา B", sharedIngredientsFromShopId: DEFAULT_SHOP_ID }] },
    });
    mockDb.tables.expenses.push({
      id: expenseBId,
      owner_id: TEST_USER_ID,
      description: "[s:shop-b]ค่าขนส่ง",
      category: "ขนส่ง",
      spent_at: "2026-11-10T00:00:00.000Z",
      amount_satang: 1000,
    });
    mockDb.tables.sales.push({
      id: saleBId,
      owner_id: TEST_USER_ID,
      notes: "[s:shop-b]",
      status: "confirmed",
      cancelled_at: null,
    });

    activeShopCookieValue = DEFAULT_SHOP_ID;
    const expenseResult = await deleteExpensesBulkAction([expenseBId]);
    expect(expenseResult.error).toContain("ร้านปัจจุบัน");
    expect(mockDb.tables.expenses).toHaveLength(1);

    const saleForm = new FormData();
    saleForm.set("id", saleBId);
    const saleResult = await cancelSale(saleForm);
    expect(saleResult.error).toContain("ร้านปัจจุบัน");
    expect(mockDb.tables.sales[0].status).toBe("confirmed");
  });

  it("falls back cleanly when PostgREST schema cache returns PGRST202 for shop registry and delete RPCs", async () => {
    mockDb.tables.settings.push({
      id: nextUuid(),
      owner_id: TEST_USER_ID,
      key: SHOPS_REGISTRY_SETTINGS_KEY,
      value: { shops: [{ id: "shop-b", shopName: "สาขา B", sharedIngredientsFromShopId: DEFAULT_SHOP_ID }] },
    });

    (mockDb as unknown as { rpc: () => Promise<unknown> }).rpc = async () => ({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function in the schema cache",
      },
    });

    const unlinkForm = new FormData();
    unlinkForm.set("shop_id", "shop-b");
    unlinkForm.set("shared_from_shop_id", "isolated");
    const unlinkRes = await updateShopIngredientSharingAction(unlinkForm);
    expect(unlinkRes.ok).toBe(true);

    const delForm = new FormData();
    delForm.set("shop_id", "shop-b");
    const delRes = await deleteShopAction(delForm);
    expect(delRes.ok).toBe(true);
  });
});
