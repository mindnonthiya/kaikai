import { describe, expect, it } from "vitest";
import { buildBankCheck, linesMatchingDifference } from "./bank-check";
import type { ExpenseRecord, SaleRecord } from "./data/types";

const sale = (over: Partial<SaleRecord> = {}): SaleRecord => ({
  id: "s", saleNumber: 1, soldAt: "2026-10-13T05:00:00.000Z", status: "confirmed", paymentStatus: "paid", customerName: null, notes: null,
  productRevenue: 12000, discount: 0, delivery: 0, fee: 0, netRevenue: 12000, cogs: 6550, grossProfit: 5450, fulfillment: "pickup", packagingCost: 0,
  items: [{ menuId: "m1", name: "ข้าวไก่", category: "ข้าวกล่อง", quantity: 2, revenue: 12000, cost: 6550 }],
  payments: [{ method: "transfer", amount: 12000 }],
  ...over,
});
const expense = (over: Partial<ExpenseRecord> = {}): ExpenseRecord => ({
  id: "e", spentAt: "2026-10-13T03:00:00.000Z", category: "ค่าแก๊ส", kind: "operating", amount: 2000, description: "แก๊ส", payee: null, paymentMethod: "transfer", ...over,
});

describe("buildBankCheck", () => {
  it("lists transfers in and out and skips cancelled sales", () => {
    const check = buildBankCheck(
      [sale(), sale({ id: "s2", saleNumber: 2, soldAt: "2026-10-13T04:00:00.000Z", netRevenue: 7000, payments: [{ method: "transfer", amount: 7000 }] }), sale({ id: "s3", status: "cancelled" })],
      [expense(), expense({ id: "e2", amount: 500, paymentMethod: null })],
    );
    expect(check.incoming.map((l) => l.id)).toEqual(["s:s2", "s:s"]);
    expect(check.outgoing.map((l) => l.id).sort()).toEqual(["e:e", "e:e2"]);
    expect(check).toMatchObject({ totalIn: 19000, totalOut: 2500, net: 16500 });
    expect(check.notViaBank).toEqual([]);
  });

  it("separates cash records and unpaid amounts", () => {
    const check = buildBankCheck(
      [
        sale({ payments: [{ method: "transfer", amount: 8000 }, { method: "cash", amount: 4000 }] }),
        sale({ id: "s2", saleNumber: 2, paymentStatus: "unpaid", payments: [] }),
      ],
      [expense({ paymentMethod: "cash" })],
    );
    expect(check.totalIn).toBe(8000);
    expect(check.totalOut).toBe(0);
    expect(check.notViaBank.map((l) => [l.id, l.amount])).toEqual([["s:s:other", 4000], ["e:e", 2000]]);
    expect(check.outstanding).toEqual([expect.objectContaining({ id: "s2", amount: 12000 })]);
  });
});

describe("linesMatchingDifference", () => {
  const lines = [{ id: "a", amount: 70000 }, { id: "b", amount: 30000 }, { id: "c", amount: 40000 }, { id: "d", amount: 12000 }];
  it("finds single records and pairs equal to the gap", () => {
    expect(linesMatchingDifference(-70000, lines)).toEqual([["a"], ["b", "c"]]);
  });
  it("returns nothing when there is no gap or no match", () => {
    expect(linesMatchingDifference(0, lines)).toEqual([]);
    expect(linesMatchingDifference(5, lines)).toEqual([]);
  });
});
