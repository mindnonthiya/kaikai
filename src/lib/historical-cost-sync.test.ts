import { describe, expect, it, vi } from "vitest";
import { syncHistoricalCosts } from "./historical-cost-sync";

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
});
