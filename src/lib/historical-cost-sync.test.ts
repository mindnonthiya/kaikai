import { describe, expect, it, vi } from "vitest";
import { recalculatedItemCost, saleCostTotals, syncHistoricalCosts } from "./historical-cost-sync";

vi.mock("@/lib/menu-cost", () => ({
  recalculateMenuCosts: vi.fn().mockResolvedValue(undefined),
}));

describe("syncHistoricalCosts", () => {
  it("recalculates line costs and parent sale totals correctly", async () => {
    const saleItems = [
      {
        id: "item1",
        sale_id: "sale1",
        menu_id: "menu1",
        menu_name_snapshot: "ข้าวไก่ต้มน้ำปลา",
        quantity: 2,
        unit_price_satang: 6900,
        line_cost_satang: 0,
        unit_cost_satang: 0,
        packaging_cost_satang: 0,
      },
    ];

    const sales = [
      {
        id: "sale1",
        net_revenue_satang: 13800,
        cogs_satang: 0,
        packaging_cost_satang: 0,
        gross_profit_satang: 13800,
      },
    ];

    const menus = [
      {
        id: "menu1",
        name: "ข้าวไก่ต้มน้ำปลา",
        current_cost_satang: 3950,
        packaging_cost_satang: 500,
        selling_price_satang: 6900,
      },
    ];

    const updatedSaleItems: Record<string, unknown>[] = [];
    const updatedSales: Record<string, unknown>[] = [];

    interface MockBuilder {
      select: ReturnType<typeof vi.fn>;
      eq: ReturnType<typeof vi.fn>;
      in: ReturnType<typeof vi.fn>;
      or: ReturnType<typeof vi.fn>;
      single: ReturnType<typeof vi.fn>;
      maybeSingle: ReturnType<typeof vi.fn>;
      update?: ReturnType<typeof vi.fn>;
      then: (
        resolve: (val: { data: unknown; error: null }) => unknown,
        reject?: (reason: unknown) => unknown
      ) => Promise<unknown>;
    }

    function createBuilder(data: unknown): MockBuilder {
      const b: MockBuilder = {
        select: vi.fn().mockImplementation(() => b),
        eq: vi.fn().mockImplementation(() => b),
        in: vi.fn().mockImplementation(() => b),
        or: vi.fn().mockImplementation(() => b),
        single: vi.fn().mockImplementation(() => Promise.resolve({ data, error: null })),
        maybeSingle: vi.fn().mockImplementation(() => Promise.resolve({ data, error: null })),
        then: (resolve, reject) => Promise.resolve({ data, error: null }).then(resolve, reject),
      };
      return b;
    }

    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === "menus") {
          return createBuilder(menus);
        }
        if (table === "sale_items") {
          const b = createBuilder(saleItems);
          b.eq = vi.fn().mockImplementation((col: string) => {
            if (col === "sale_id") {
              return createBuilder([
                {
                  line_cost_satang: 7900,
                  packaging_cost_satang: 500,
                  quantity: 2,
                },
              ]);
            }
            return b;
          });
          b.update = vi.fn((payload: Record<string, unknown>) => ({
            eq: vi.fn((col: string, idVal: string) => {
              void col;
              updatedSaleItems.push({ id: idVal, ...payload });
              return Promise.resolve({ error: null });
            }),
          }));
          return b;
        }
        if (table === "sales") {
          const b = createBuilder(sales[0]);
          b.update = vi.fn((payload: Record<string, unknown>) => ({
            eq: vi.fn((col: string, idVal: string) => {
              void col;
              updatedSales.push({ id: idVal, ...payload });
              return Promise.resolve({ error: null });
            }),
          }));
          return b;
        }
        return createBuilder([]);
      }),
    };

    const result = await syncHistoricalCosts(mockSupabase as never, {
      ownerId: "owner1",
      menuId: "menu1",
      forceAll: true,
    });

    expect(result.affectedSalesCount).toBe(1);
    expect(result.updatedItemsCount).toBe(1);

    // Verify item update
    expect(updatedSaleItems[0]).toMatchObject({
      id: "item1",
      unit_cost_satang: 3950,
      line_cost_satang: 7900,
      packaging_cost_satang: 500,
      ingredient_cost_satang: 3450,
    });

    // Verify parent sale update
    expect(updatedSales[0]).toMatchObject({
      id: "sale1",
      cogs_satang: 7900,
      packaging_cost_satang: 1000,
      gross_profit_satang: 13800 - 7900,
    });
  });

  it("keeps the pooled-ingredient cost stored on the item and the packaging actually used", async () => {
    const updatedSaleItems: Record<string, unknown>[] = [];
    const updatedSales: Record<string, unknown>[] = [];

    const builder = (data: unknown) => {
      const b: Record<string, unknown> = {};
      for (const fn of ["select", "eq", "in", "or"]) b[fn] = vi.fn(() => b);
      b.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
      b.then = (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
        Promise.resolve({ data, error: null }).then(resolve, reject);
      return b;
    };
    const recordUpdates = (target: Record<string, unknown>[]) =>
      vi.fn((payload: Record<string, unknown>) => ({
        eq: vi.fn((col: string, id: string) => {
          void col;
          target.push({ id, ...payload });
          return Promise.resolve({ error: null });
        }),
      }));

    const mockSupabase = {
      rpc: vi.fn(() => Promise.resolve({ data: null, error: { message: "missing function" } })),
      from: vi.fn((table: string) => {
        if (table === "menus") {
          return builder([{ id: "menu1", name: "ข้าวไก่ต้มน้ำปลา", current_cost_satang: 3147, packaging_cost_satang: 597, selling_price_satang: 6900 }]);
        }
        if (table === "sale_items") {
          const b = builder([
            // Previously stripped by the old sync: cost = menu cost only, pooled 15.6% of 69 ฿ = 10.76 ฿ stored separately.
            { id: "item1", sale_id: "sale1", menu_id: "menu1", menu_name_snapshot: "ข้าวไก่ต้มน้ำปลา", quantity: 1, unit_price_satang: 6900, line_cost_satang: 3147, unit_cost_satang: 3147, packaging_cost_satang: 597, pooled_cost_satang: 1076 },
          ]);
          b.update = recordUpdates(updatedSaleItems);
          return b;
        }
        if (table === "sale_packaging") return builder([{ line_cost_satang: 260 }, { line_cost_satang: 160 }]);
        if (table === "sales") {
          const b = builder({ net_revenue_satang: 8400 });
          b.update = recordUpdates(updatedSales);
          return b;
        }
        return builder([]);
      }),
    };

    await syncHistoricalCosts(mockSupabase as never, { ownerId: "owner1", forceAll: true });

    expect(updatedSaleItems[0]).toMatchObject({
      id: "item1",
      unit_cost_satang: 3147 + 1076,
      ingredient_cost_satang: 3147 - 597 + 1076,
      packaging_cost_satang: 597,
      line_cost_satang: 4223,
      unit_profit_satang: 6900 - 4223,
    });
    // food (4223 − 597) + packaging actually handed out (260 + 160)
    expect(updatedSales[0]).toMatchObject({
      id: "sale1",
      cogs_satang: 3626 + 420,
      packaging_cost_satang: 420,
      gross_profit_satang: 8400 - 4046,
    });
  });
});

describe("recalculatedItemCost", () => {
  it("adds the pooled cost on top of the current menu cost", () => {
    expect(recalculatedItemCost({ menuCost: 3147, menuPackagingCost: 597, pooledCost: 1076, unitPrice: 6900, quantity: 2 })).toEqual({
      unitCost: 4223,
      ingredientCost: 3626,
      packagingCost: 597,
      unitProfit: 2677,
      lineCost: 8446,
    });
  });

  it("matches the menu cost when no pooled cost was recorded", () => {
    expect(recalculatedItemCost({ menuCost: 3950, menuPackagingCost: 500, pooledCost: 0, unitPrice: 6900, quantity: 1 }).unitCost).toBe(3950);
  });
});

describe("saleCostTotals", () => {
  const items = [
    { lineCost: 8446, packCost: 597, quantity: 2 },
    { lineCost: 1000, packCost: 0, quantity: 1 },
  ];

  it("uses the menus' default packaging when none was recorded", () => {
    expect(saleCostTotals(items, null)).toEqual({ cogs: 9446, packaging: 1194 });
  });

  it("uses the packaging actually handed out when recorded", () => {
    expect(saleCostTotals(items, 500)).toEqual({ cogs: 8446 - 1194 + 1000 + 500, packaging: 500 });
  });
});
