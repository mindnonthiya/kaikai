import { describe, expect, it } from "vitest";
import { dailySeries, menuFoodCost, menuRanking, packagingLinesCost, pooledFoodRevenue, recipeCostParts, summarize } from "./analytics";
import { allocateSatang, calculateSale, roundedMaterialCost } from "./money";
import { buildBankCheck } from "./bank-check";
import type { SaleRecord } from "./data/types";

const order = (over: Partial<SaleRecord> = {}): SaleRecord => ({
  id: "s", saleNumber: 1, soldAt: "2026-11-01T05:00:00Z", status: "confirmed", paymentStatus: "paid", customerName: null, notes: null,
  fulfillment: "delivery", productRevenue: 33700, discount: 500, delivery: 1500, tip: 200, fee: 100,
  netRevenue: 34800, cogs: 15074, grossProfit: 19726, packagingCost: 1410,
  items: [
    { menuId: "m1", name: "ข้าวไก่69", category: "เมนูหลัก", quantity: 2, revenue: 13800, cost: 8666, packagingCost: 470 },
    { menuId: "m2", name: "ข้าวไก่89", category: "เมนูหลัก", quantity: 1, revenue: 8900, cost: 5583, packagingCost: 470 },
    { menuId: "addon", name: "ข้าวเพิ่ม", category: "เพิ่มเติม", quantity: 1, revenue: 1000, cost: 985, packagingCost: 160 },
    { menuId: "service", name: "รับหิ้ว", category: "บริการ", quantity: 1, revenue: 10000, cost: 0, packagingCost: 0 },
  ], payments: [{ method: "transfer", amount: 34900 }], ...over,
});

describe("end-to-end accounting identities", () => {
  it("matches the SQL mixed-order fixture to the satang", () => {
    const totals = calculateSale({ items: [
      { unitPrice: 6900, unitCost: 3863, quantity: 2 },
      { unitPrice: 8900, unitCost: 5113, quantity: 1 },
      { unitPrice: 1000, unitCost: 825, quantity: 1 },
      { unitPrice: 10000, unitCost: 0, quantity: 1 },
    ], discount: 500, deliveryCharged: 1500, tip: 200, paymentFee: 100, packagingCost: 1410 });
    expect(totals).toMatchObject({ productRevenue: 33700, netRevenue: 34800, cogs: 15074, grossProfit: 19726 });
    const summary = summarize([order()], [{ id: "e", spentAt: order().soldAt, category: "ค่าไฟ", kind: "operating", amount: 1500, description: "ค่าไฟ", payee: null, paymentMethod: "transfer" },
      { id: "direct", spentAt: order().soldAt, category: "วัตถุดิบ", kind: "direct", amount: 9000, description: "ซื้อไก่", payee: null, paymentMethod: "transfer" }]);
    expect(summary).toMatchObject({ revenue: 34800, cogs: 15074, grossProfit: 19726, netProfit: 18226, boxes: 3, addons: 1, outstanding: 0, averageProfitPerOrder: 19726, averageCostPerOrder: 15074 });
  });
  it("reconciles menu, day and overall totals including all order adjustments", () => {
    const sales = [order(), order({ id: "cancel", status: "cancelled" })];
    const menuRows = menuRanking(sales);
    const summary = summarize(sales, []);
    expect(menuRows.reduce((n, m) => n + m.revenue, 0)).toBe(summary.revenue);
    expect(menuRows.reduce((n, m) => n + m.cost, 0)).toBe(summary.cogs);
    expect(menuRows.reduce((n, m) => n + m.profit, 0)).toBe(summary.grossProfit);
    expect(menuRows.find(m => m.isAdjustment)).toMatchObject({ revenue: 1600, cost: 0, profit: 1600 });
    const day = dailySeries(sales, [], new Date("2026-10-31T17:00:00Z"), 1)[0];
    expect(day).toMatchObject({ revenue: 34800, grossProfit: 19726, netProfit: 19726 });
  });
  it("does not net one customer's excess payment against another unpaid bill", () => {
    const sales = [order({ payments: [{ method: "transfer", amount: 35000 }] }), order({ id: "unpaid", paymentStatus: "unpaid", payments: [] })];
    expect(summarize(sales, []).outstanding).toBe(34900);
    expect(buildBankCheck(sales, []).outstanding).toMatchObject([{ id: "unpaid", amount: 34900 }]);
  });
  it("keeps service-only and tip-only orders out of food box counts", () => {
    const service = order({ items: [order().items[3]], productRevenue: 10000, discount: 0, delivery: 0, tip: 0, fee: 0, netRevenue: 10000, cogs: 0, packagingCost: 0, grossProfit: 10000 });
    expect(summarize([service], []).boxes).toBe(0);
    const tipOnly = order({ items: [], productRevenue: 0, discount: 0, delivery: 0, tip: 100, fee: 0, netRevenue: 100, cogs: 0, packagingCost: 0, grossProfit: 100 });
    expect(menuRanking([tipOnly])).toMatchObject([{ revenue: 100, cost: 0, profit: 100, isAdjustment: true }]);
  });
  it("keeps distinct custom names separate in menu reporting", () => {
    const custom = order({ items: [
      { menuId: "", name: "งาน A", category: "พิเศษ", quantity: 1, revenue: 1000, cost: 100 },
      { menuId: "", name: "งาน B", category: "พิเศษ", quantity: 1, revenue: 2000, cost: 200 },
    ], productRevenue: 3000, netRevenue: 3000, cogs: 300, discount: 0, tip: 0, delivery: 0, fee: 0, packagingCost: 0 });
    expect(menuRanking([custom]).map(m => m.name).sort()).toEqual(["งาน A", "งาน B"]);
    expect(summarize([custom], []).boxes).toBe(0);
  });
  it("applies pooled food percentage to food only and retains explicit service costs", () => {
    expect(pooledFoodRevenue(order().items.map(i => ({ ...i })))).toBe(23700);
    expect(menuFoodCost({ name: "รับหิ้ว", category: "บริการ", price: 10000, cost: 1000, packagingCost: 0 }, 1250)).toBe(1000);
    expect(menuFoodCost({ name: "ข้าวไก่", category: "เมนูหลัก", price: 6900, cost: 3470, packagingCost: 470 }, 1250)).toBe(3863);
  });
  it("rejects discounts that exceed product value even if delivery masks the excess", () => {
    expect(() => calculateSale({ items: [{ unitPrice: 100, unitCost: 50, quantity: 1 }], discount: 101, deliveryCharged: 1000 })).toThrow();
  });
});

describe("whole-satang precision", () => {
  it("keeps every satang when allocating unequal or equal shares", () => {
    expect(allocateSatang(1, [1, 1, 1])).toEqual([1, 0, 0]);
    for (let total = 0; total < 1000; total++) {
      expect(allocateSatang(total, [6900, 8900, 1000]).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
  it("rounds decimal unit prices like PostgreSQL numeric, per packaging line", () => {
    expect(packagingLinesCost([{ unitCost: 10.075, quantity: 100 }])).toBe(1008);
    expect(roundedMaterialCost([{ unitCost: 0.25, quantity: 1 }, { unitCost: 0.25, quantity: 1 }])).toBe(1);
    expect(recipeCostParts([{ id: "r", menuId: "m", ingredientId: "i", packagingItemId: null, quantity: 100 }], new Map([["i", 10.075]]), new Map())).toEqual({ ingredients: 1008, packaging: 0 });
  });
});
