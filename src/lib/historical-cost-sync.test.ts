import { describe, expect, it, vi } from "vitest";
import { recalculatedItemCost, saleCostTotals, syncHistoricalCosts } from "./historical-cost-sync";

vi.mock("@/lib/menu-cost", () => ({
  recalculateMenuCosts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server-action", () => ({ dbError: (error: { message: string }) => { throw new Error(error.message); } }));

describe("atomic historical cost recalculation", () => {
  it("uses the transactional database calculation for all historical bills", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { affected_sales_count: 1005, updated_items_count: 2006 }, error: null });
    const result = await syncHistoricalCosts({ rpc } as never, { ownerId: "owner", menuId: "m", forceAll: true });
    expect(rpc).toHaveBeenCalledWith("recalculate_order_costs", { p_menu_id: "m", p_force_all: true });
    expect(result).toEqual({ affectedSalesCount: 1005, updatedItemsCount: 2006 });
  });
  it("does not silently fall back to partial writes when the database fails", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "migration missing" } });
    await expect(syncHistoricalCosts({ rpc } as never, { ownerId: "owner", forceAll: true })).rejects.toThrow("migration missing");
    expect(rpc).toHaveBeenCalledTimes(1);
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
