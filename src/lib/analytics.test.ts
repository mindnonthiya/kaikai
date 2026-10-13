import { describe, expect, it } from "vitest";
import { dailySeries, expensesByCategory, menuCostWarnings, menuRanking, percentChange, recipeMaterialCost, summarize } from "./analytics";
import type { ExpenseRecord, MenuRecord, SaleRecord } from "./data/types";
import { bangkokDayKey, previousRange, resolveRange, startOfBangkokDay, startOfBangkokMonth } from "./time";

const sale = (over: Partial<SaleRecord> = {}): SaleRecord => ({
  id: "s", saleNumber: 1, soldAt: "2026-10-13T05:00:00.000Z", status: "confirmed", paymentStatus: "paid", customerName: null, notes: null,
  productRevenue: 12000, discount: 0, delivery: 0, fee: 0, netRevenue: 12000, cogs: 6550, grossProfit: 5450,
  items: [{ menuId: "m1", name: "ข้าวไก่", quantity: 2, revenue: 12000, cost: 6550 }],
  payments: [{ method: "transfer", amount: 12000 }],
  ...over,
});
const expense = (over: Partial<ExpenseRecord> = {}): ExpenseRecord => ({
  id: "e", spentAt: "2026-10-13T03:00:00.000Z", category: "ค่าแก๊ส", kind: "operating", amount: 2000, description: "แก๊ส", payee: null, paymentMethod: "cash", ...over,
});

describe("summarize", () => {
  it("adds up confirmed sales and subtracts only operating expenses", () => {
    const s = summarize([sale(), sale({ id: "s2", status: "cancelled" })], [expense(), expense({ id: "e2", kind: "direct", amount: 9999 })]);
    expect(s).toMatchObject({ saleCount: 1, revenue: 12000, cogs: 6550, grossProfit: 5450, operatingExpenses: 2000, directExpenses: 9999, netProfit: 3450, boxes: 2 });
    expect(s.payments.transfer).toBe(12000);
    expect(s.averageProfitPerBox).toBe(2725);
    expect(s.netMarginBps).toBe(2875);
  });
  it("reports outstanding money for unpaid sales", () => {
    expect(summarize([sale({ paymentStatus: "unpaid", payments: [] })], []).outstanding).toBe(12000);
  });
  it("handles an empty period without dividing by zero", () => {
    expect(summarize([], [])).toMatchObject({ revenue: 0, netProfit: 0, netMarginBps: 0, averageProfitPerBox: 0 });
  });
});

describe("rankings and breakdowns", () => {
  it("ranks menus by profit using sale snapshots", () => {
    const rows = menuRanking([sale(), sale({ id: "s2", items: [{ menuId: "m2", name: "พิเศษ", quantity: 1, revenue: 7500, cost: 4120 }] })]);
    expect(rows.map((r) => r.menuId)).toEqual(["m1", "m2"]);
    expect(rows[0]).toMatchObject({ quantity: 2, profit: 5450 });
  });
  it("groups expenses by category with shares", () => {
    const rows = expensesByCategory([expense({ amount: 3000 }), expense({ id: "e2", category: "ค่าไฟ", amount: 1000 })]);
    expect(rows[0]).toMatchObject({ category: "ค่าแก๊ส", amount: 3000, shareBps: 7500 });
  });
  it("buckets sales into Bangkok calendar days", () => {
    // 2026-10-12T18:00Z is 01:00 on 13 Oct in Bangkok.
    const start = startOfBangkokDay(new Date("2026-10-12T05:00:00Z"));
    const points = dailySeries([sale({ soldAt: "2026-10-12T18:00:00Z" })], [], start, 2);
    expect(points.map((p) => [p.key, p.revenue])).toEqual([["2026-10-12", 0], ["2026-10-13", 12000]]);
  });
  it("computes percent change and handles no baseline", () => {
    expect(percentChange(110, 100)).toBe(10);
    expect(percentChange(100, 0)).toBeNull();
  });
});

describe("menu costing", () => {
  it("keeps fractional per-gram costs until the final rounding", () => {
    const cost = recipeMaterialCost(
      [{ id: "1", menuId: "m", ingredientId: "chicken", packagingItemId: null, quantity: 120 }, { id: "2", menuId: "m", ingredientId: null, packagingItemId: "box", quantity: 1 }],
      new Map([["chicken", 9.4]]), new Map([["box", 450]]),
    );
    expect(cost).toBe(1578); // 120 × 9.4 = 1128 + 450
  });
  it("warns about missing cost and thin margins", () => {
    const base: MenuRecord = { id: "m", name: "A", category: "x", price: 6000, laborCost: 0, overheadCost: 0, cost: 3000, isAvailable: true, costCalculatedAt: null };
    const warnings = menuCostWarnings([base, { ...base, id: "b", cost: 0 }, { ...base, id: "c", cost: 5500 }]);
    expect(warnings.map((w) => w.menu.id)).toEqual(["b", "c"]);
  });
});

describe("Bangkok time ranges", () => {
  const now = new Date("2026-10-13T02:00:00Z"); // 09:00 Bangkok
  it("starts today at Bangkok midnight", () => {
    expect(resolveRange("today", now).start.toISOString()).toBe("2026-10-12T17:00:00.000Z");
  });
  it("starts the month on the 1st in Bangkok", () => {
    expect(startOfBangkokMonth(now).toISOString()).toBe("2026-09-30T17:00:00.000Z");
    expect(bangkokDayKey(startOfBangkokMonth(now))).toBe("2026-10-01");
  });
  it("compares month-to-date with the same days last month", () => {
    const prev = previousRange(resolveRange("month", now));
    expect(bangkokDayKey(prev.start)).toBe("2026-09-01");
    expect(bangkokDayKey(prev.end)).toBe("2026-09-14");
  });
});
