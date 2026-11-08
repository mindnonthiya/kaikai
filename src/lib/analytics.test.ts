import { describe, expect, it } from "vitest";
import {
  dailySeries, defaultOrderPackaging, expensesByCategory, ingredientUsageBreakdown, learnedYield, menuCostWarnings, menuRanking, monthlySeries, packagingLinesCost, percentChange,
  pooledCost, pooledIngredientBps, recipeCostParts, recipeIngredientBreakdown, recipeMaterialCost, summarize, weightedPricePerUnit, yieldWindow,
} from "./analytics";
import type { ExpenseRecord, IngredientRecord, MenuRecord, PurchaseRecord, RecipeItemRecord, SaleRecord } from "./data/types";
import {
  bangkokDayKey,
  fromBangkokDateTimeInput,
  previousRange,
  resolveRange,
  startOfBangkokDay,
  startOfBangkokMonth,
  toBangkokDateTimeInput,
} from "./time";

const sale = (over: Partial<SaleRecord> = {}): SaleRecord => ({
  id: "s", saleNumber: 1, soldAt: "2026-10-13T05:00:00.000Z", status: "confirmed", paymentStatus: "paid", customerName: null, notes: null,
  productRevenue: 12000, discount: 0, delivery: 0, fee: 0, netRevenue: 12000, cogs: 6550, grossProfit: 5450, fulfillment: "pickup", packagingCost: 0,
  items: [{ menuId: "m1", name: "ข้าวไก่", category: "ข้าวกล่อง", quantity: 2, revenue: 12000, cost: 6550 }],
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
  it("counts add-ons separately from boxes", () => {
    const s = summarize([sale({ items: [
      { menuId: "m1", name: "ข้าวไก่", category: "ข้าวกล่อง", quantity: 2, revenue: 13800, cost: 6000 },
      { menuId: "a1", name: "ไก่เพิ่ม", category: "เพิ่มเติม", quantity: 3, revenue: 2400, cost: 900 },
    ] })], []);
    expect(s).toMatchObject({ boxes: 2, addons: 3 });
  });
  it("totals delivery income, fuel and packaging", () => {
    const s = summarize(
      [sale({ fulfillment: "delivery", delivery: 1500, packagingCost: 470 }), sale({ id: "s2", packagingCost: 470 })],
      [expense({ category: "ค่าน้ำมัน", amount: 4000 }), expense({ id: "e2" })],
    );
    expect(s).toMatchObject({ deliveryIncome: 1500, deliveryCount: 1, fuelExpenses: 4000, packagingCost: 940, operatingExpenses: 6000 });
  });
  it("totals tips and overtransferred amounts", () => {
    const s = summarize([sale({ tip: 1000 }), sale({ id: "s2", tip: 2500 })], []);
    expect(s.tipIncome).toBe(3500);
  });
  it("tracks net bank transfers and treats unspecified expense methods as transfer", () => {
    const s = summarize(
      [
        sale({ payments: [{ method: "cash", amount: 5000 }] }),
        sale({ id: "s2", payments: [{ method: "transfer", amount: 7000 }] }),
      ],
      [
        expense({ amount: 1500, paymentMethod: "cash" }),
        expense({ id: "e2", amount: 2000, paymentMethod: "transfer" }),
        expense({ id: "e3", amount: 500, paymentMethod: null }),
      ],
    );
    expect(s.payments.transfer).toBe(7000);
    expect(s.expensePayments.cash).toBe(1500);
    expect(s.expensePayments.transfer).toBe(2500);
    expect(s.netTransfer).toBe(4500);
  });
});


describe("rankings and breakdowns", () => {
  it("ranks menus by profit using sale snapshots", () => {
    const rows = menuRanking([sale(), sale({ id: "s2", productRevenue: 7500, netRevenue: 7500, cogs: 4120, grossProfit: 3380, items: [{ menuId: "m2", name: "พิเศษ", category: "ข้าวกล่อง", quantity: 1, revenue: 7500, cost: 4120 }] })]);
    expect(rows.map((r) => r.menuId)).toEqual(["m1", "m2"]);
    expect(rows[0]).toMatchObject({ quantity: 2, profit: 5450 });
  });
  it("lists add-ons after dishes even when they earn more", () => {
    const rows = menuRanking([sale({ productRevenue: 46900, netRevenue: 46900, cogs: 13000, grossProfit: 33900, items: [
      { menuId: "a1", name: "ไก่เพิ่ม", category: "เพิ่มเติม", quantity: 50, revenue: 40000, cost: 10000 },
      { menuId: "m1", name: "ข้าวไก่", category: "ข้าวกล่อง", quantity: 1, revenue: 6900, cost: 3000 },
    ] })]);
    expect(rows.map((r) => [r.menuId, r.isAddon])).toEqual([["m1", false], ["a1", true]]);
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
  it("splits recipe cost into food and packaging, skipping packaging not counted per order", () => {
    const parts = recipeCostParts(
      [
        { id: "1", menuId: "m", ingredientId: "chicken", packagingItemId: null, quantity: 100 },
        { id: "2", menuId: "m", ingredientId: null, packagingItemId: "box", quantity: 1 },
        { id: "3", menuId: "m", ingredientId: null, packagingItemId: "bag", quantity: 1 },
      ],
      new Map([["chicken", 10]]), new Map([["box", 260]]),
    );
    expect(parts).toEqual({ ingredients: 1000, packaging: 260 });
  });
  it("divides batch ingredient cost by recipeYield while keeping packaging per sold unit (e.g. crepe batter for 30 sheets)", () => {
    const batterRecipe: RecipeItemRecord[] = [
      { id: "1", menuId: "crepe", ingredientId: "flour", packagingItemId: null, quantity: 1000 }, // 1000g × 4.5 satang = 4500
      { id: "2", menuId: "crepe", ingredientId: "sugar", packagingItemId: null, quantity: 200 },  // 200g × 3.0 satang = 600
      { id: "3", menuId: "crepe", ingredientId: "egg", packagingItemId: null, quantity: 4 },      // 4 eggs × 400 satang = 1600
      { id: "4", menuId: "crepe", ingredientId: "milk", packagingItemId: null, quantity: 1200 },  // 1200ml × 5.0 satang = 6000
      { id: "5", menuId: "crepe", ingredientId: "butter", packagingItemId: null, quantity: 180 }, // 180g × 25.0 satang = 4500
      { id: "6", menuId: "crepe", ingredientId: null, packagingItemId: "sleeve", quantity: 1 },   // 1 sleeve = 100 satang per crepe
    ];
    const ingCosts = new Map([
      ["flour", 4.5],
      ["sugar", 3.0],
      ["egg", 400],
      ["milk", 5.0],
      ["butter", 25.0],
    ]);
    const packCosts = new Map([["sleeve", 100]]);
    // Batch ingredients = 4500 + 600 + 1600 + 6000 + 4500 = 17200 satang (172.00 ฿)
    // Divided by 30 sheets = 573.33 -> 573 satang (5.73 ฿) per sheet
    const parts = recipeCostParts(batterRecipe, ingCosts, packCosts, 30);
    expect(parts).toEqual({ ingredients: 573, packaging: 100 });
    expect(recipeMaterialCost(batterRecipe, ingCosts, packCosts, 30)).toBe(673);
  });
  it("computes per-ingredient cost and % share (quantity and cost) via recipeIngredientBreakdown", () => {
    const ingredients: IngredientRecord[] = [
      { id: "flour", name: "แป้งเครป", category: "c", costing: "per_unit", baseUnit: "กรัม", purchaseUnit: "กก.", unitsPerPurchaseUnit: 1000, yieldAuto: false, yieldUpdatedAt: null, pricePerPurchaseUnit: 4500, unitCost: 4.5, isActive: true },
      { id: "nutella", name: "นูเทลล่า", category: "c", costing: "per_unit", baseUnit: "กรัม", purchaseUnit: "กระปุก", unitsPerPurchaseUnit: 900, yieldAuto: false, yieldUpdatedAt: null, pricePerPurchaseUnit: 27000, unitCost: 30, isActive: true },
    ];
    const items: RecipeItemRecord[] = [
      { id: "1", menuId: "m", ingredientId: "flour", packagingItemId: null, quantity: 80 },   // 80g × 4.5 = 360 satang (3.60 ฿)
      { id: "2", menuId: "m", ingredientId: "nutella", packagingItemId: null, quantity: 20 }, // 20g × 30 = 600 satang (6.00 ฿)
    ];
    const result = recipeIngredientBreakdown(items, ingredients, 1);
    expect(result).toEqual({
      recipeYield: 1,
      totalRecipeQuantity: 100,
      batchIngredientCost: 960,
      perServingIngredientCost: 960,
      rows: [
        {
          ingredientId: "nutella",
          name: "นูเทลล่า",
          baseUnit: "กรัม",
          quantity: 20,
          perServingQuantity: 20,
          batchCost: 600,
          perServingCost: 600,
          quantityShareBps: 2000, // 20% of total 100g
          costShareBps: 6250,     // 600 / 960 = 62.5% of total ingredient cost
        },
        {
          ingredientId: "flour",
          name: "แป้งเครป",
          baseUnit: "กรัม",
          quantity: 80,
          perServingQuantity: 80,
          batchCost: 360,
          perServingCost: 360,
          quantityShareBps: 8000, // 80% of total 100g
          costShareBps: 3750,     // 360 / 960 = 37.5% of total ingredient cost
        },
      ],
    });
  });
  it("computes theoretical ingredient usage and cost share across sales via ingredientUsageBreakdown", () => {
    const ingredients: IngredientRecord[] = [
      { id: "flour", name: "แป้งเครป", category: "c", costing: "per_unit", baseUnit: "กรัม", purchaseUnit: "กก.", unitsPerPurchaseUnit: 1000, yieldAuto: false, yieldUpdatedAt: null, pricePerPurchaseUnit: 4500, unitCost: 4.5, isActive: true },
      { id: "nutella", name: "นูเทลล่า", category: "c", costing: "per_unit", baseUnit: "กรัม", purchaseUnit: "กระปุก", unitsPerPurchaseUnit: 900, yieldAuto: false, yieldUpdatedAt: null, pricePerPurchaseUnit: 27000, unitCost: 30, isActive: true },
    ];
    const recipeItems: RecipeItemRecord[] = [
      // Menu m1 is a batch recipe yielding 10 sheets using 1000g flour (so 100g per sheet)
      { id: "1", menuId: "m1", ingredientId: "flour", packagingItemId: null, quantity: 1000 },
      // Addon a1 uses 30g nutella per serving
      { id: "2", menuId: "a1", ingredientId: "nutella", packagingItemId: null, quantity: 30 },
    ];
    const sales = [
      sale({
        items: [
          { menuId: "m1", name: "แป้งเครป", category: "อาหารจานหลัก", quantity: 5, revenue: 15000, cost: 2250 },
          { menuId: "a1", name: "เพิ่มนูเทลล่า", category: "เพิ่มเติม", quantity: 2, revenue: 4000, cost: 1800 },
        ],
      }),
    ];
    const purchases: PurchaseRecord[] = [
      { id: "p1", ingredientId: "flour", ingredientName: "แป้งเครป", costing: "per_unit", purchasedAt: "2026-10-13T01:00:00Z", price: 4500, purchasedQuantity: 1, unit: "กก.", vendor: null },
    ];
    const usage = ingredientUsageBreakdown({
      sales,
      recipeItems,
      ingredients,
      purchases,
      menuYields: new Map([["m1", 10]]),
    });
    expect(usage).toEqual([
      {
        ingredientId: "flour",
        name: "แป้งเครป",
        baseUnit: "กรัม",
        purchaseUnit: "กก.",
        unitsPerPurchaseUnit: 1000,
        unitCost: 4.5,
        usedBaseQuantity: 500, // 5 sold × (1000g / 10) = 500g
        usedPurchaseQuantity: 0.5, // 500g / 1000g = 0.5 กก.
        estimatedCost: 2250, // 500 × 4.5 = 2250 satang
        costShareBps: 5556, // 2250 / (2250 + 1800) = 55.56%
        purchasedQuantity: 1,
        purchasedAmount: 4500,
        menusCount: 1,
      },
      {
        ingredientId: "nutella",
        name: "นูเทลล่า",
        baseUnit: "กรัม",
        purchaseUnit: "กระปุก",
        unitsPerPurchaseUnit: 900,
        unitCost: 30,
        usedBaseQuantity: 60, // 2 sold × 30g = 60g
        usedPurchaseQuantity: 0.07, // rounded to 2 decimal places: 60 / 900 = 0.0666... -> 0.07
        estimatedCost: 1800, // 60 × 30 = 1800 satang
        costShareBps: 4444, // 1800 / 4050 = 44.44%
        purchasedQuantity: 0,
        purchasedAmount: 0,
        menusCount: 1,
      },
    ]);
  });
  it("warns about missing cost and thin margins", () => {
    const base: MenuRecord = { id: "m", name: "A", category: "x", price: 6000, packagingCost: 0, cost: 3000, isAvailable: true, costCalculatedAt: null };
    const warnings = menuCostWarnings([base, { ...base, id: "b", cost: 0 }, { ...base, id: "c", cost: 5500 }]);
    expect(warnings.map((w) => w.menu.id)).toEqual(["b", "c"]);
  });
  it("adds the pooled-ingredient % before judging the margin", () => {
    const menu: MenuRecord = { id: "m", name: "A", category: "x", price: 6900, packagingCost: 470, cost: 4000, isAvailable: true, costCalculatedAt: null };
    expect(menuCostWarnings([menu], 2000, 0)).toHaveLength(0); // 42% margin
    expect(menuCostWarnings([menu], 2000, 2500)).toHaveLength(1); // 4000 + 1725 → 17.0%
  });
  it("costs chicken per piece: 69 = 5 pieces, 89 = 7 pieces", () => {
    const perPiece = 12500 / 27; // 125 ฿/กก., 27 pieces per กก.
    const chicken = new Map([["chicken", perPiece]]);
    const recipe = (pieces: number) => [{ id: "1", menuId: "m", ingredientId: "chicken", packagingItemId: null, quantity: pieces }];
    expect(recipeCostParts(recipe(5), chicken, new Map()).ingredients).toBe(2315); // 23.15 ฿
    expect(recipeCostParts(recipe(7), chicken, new Map()).ingredients).toBe(3241); // 32.41 ฿
  });
});

describe("pooled ingredients", () => {
  it("uses the starting % until there are 7 days of data", () => {
    expect(pooledIngredientBps({ pooledPurchases: 50000, foodRevenue: 200000, historyDays: 6, initialBps: 1000 })).toEqual({ bps: 1000, source: "initial" });
    expect(pooledIngredientBps({ pooledPurchases: 0, foodRevenue: 200000, historyDays: 30, initialBps: 1000 })).toEqual({ bps: 1000, source: "initial" });
  });
  it("divides purchases by food sales once there is enough data", () => {
    expect(pooledIngredientBps({ pooledPurchases: 50000, foodRevenue: 400000, historyDays: 7, initialBps: 1000 })).toEqual({ bps: 1250, source: "actual" });
    expect(pooledIngredientBps({ pooledPurchases: 900000, foodRevenue: 100000, historyDays: 10, initialBps: 1000 }).bps).toBe(10000);
  });
  it("rounds the pooled cost per item like create_sale", () => {
    expect(pooledCost(6900, 1250)).toBe(863); // 8.625 ฿ → 8.63
    expect(pooledCost(8900, 0)).toBe(0);
  });
});

describe("chicken price and pieces per กก.", () => {
  const day = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString();
  it("weights the price per กก. by quantity over 30 days", () => {
    const price = weightedPricePerUnit([
      { purchasedAt: day(1), price: 19000, quantity: 2 },
      { purchasedAt: day(5), price: 47500, quantity: 5 },
      { purchasedAt: day(9), price: 50000, quantity: 5 },
      { purchasedAt: day(9), price: 3000, quantity: null },
    ]);
    expect(price).toBeCloseTo(116500 / 12, 6); // ≈ 97.08 ฿/กก.
  });
  it("ignores purchases older than 30 days before the latest one", () => {
    const price = weightedPricePerUnit([
      { purchasedAt: new Date(Date.UTC(2026, 7, 1)).toISOString(), price: 10000, quantity: 1 },
      { purchasedAt: day(10), price: 25000, quantity: 2 },
    ]);
    expect(price).toBe(12500);
  });
  it("learns from purchases before the latest one, spanning 7+ days", () => {
    const window = yieldWindow([
      { purchasedAt: day(1), quantity: 5 },
      { purchasedAt: day(4), quantity: 5 },
      { purchasedAt: day(8), quantity: 6 },
    ]);
    expect(window).toEqual({ start: new Date(day(1)), end: new Date(day(8)), quantity: 10 });
    expect(yieldWindow([{ purchasedAt: day(1), quantity: 5 }, { purchasedAt: day(3), quantity: 5 }, { purchasedAt: day(5), quantity: 5 }])).toBeNull();
    expect(yieldWindow([{ purchasedAt: day(1), quantity: 5 }, { purchasedAt: day(9), quantity: 5 }])).toBeNull();
  });
  it("rounds learned pieces per กก. and rejects outliers", () => {
    expect(learnedYield(268, 10, 27)).toBe(26.8);
    expect(learnedYield(100, 10, 27)).toBeNull(); // 10 per กก. — probably a missed purchase entry
    expect(learnedYield(0, 10, 27)).toBeNull();
  });
});

describe("order packaging", () => {
  // Shop example: box+lid 65฿/25 = 2.60, spoon 40฿/25 = 1.60, sauce cup 25฿/50 = 0.50.
  const perDish = [{ packagingId: "box", quantity: 1 }, { packagingId: "spoon", quantity: 1 }, { packagingId: "cup", quantity: 1 }];
  it("multiplies recipe packaging by dishes and ignores add-ons without packaging", () => {
    const totals = defaultOrderPackaging([{ quantity: 2, packaging: perDish }, { quantity: 1, packaging: perDish }, { quantity: 3, packaging: [] }]);
    expect(Object.fromEntries(totals)).toEqual({ box: 3, spoon: 3, cup: 3 });
  });
  it("rounds fractional pieces up and skips empty lines", () => {
    const totals = defaultOrderPackaging([{ quantity: 3, packaging: [{ packagingId: "bag", quantity: 0.5 }] }, { quantity: 0, packaging: perDish }]);
    expect(Object.fromEntries(totals)).toEqual({ bag: 2 });
  });
  it("costs packaging per line in whole satang", () => {
    expect(packagingLinesCost([{ unitCost: 260, quantity: 1 }, { unitCost: 160, quantity: 2 }, { unitCost: 50, quantity: 1 }, { unitCost: 999, quantity: 0 }])).toBe(630);
    expect(packagingLinesCost([{ unitCost: 40 / 3, quantity: 1 }])).toBe(13);
  });
  it("gives spoons = the larger of dishes and plain rice, not the sum", () => {
    const rice = { isAddon: true, packaging: [{ packagingId: "spoon", quantity: 1 }] };
    const spoons = (dishes: number, rices: number) => defaultOrderPackaging([{ quantity: dishes, packaging: perDish }, { quantity: rices, ...rice }]).get("spoon");
    expect(spoons(1, 2)).toBe(2); // 89 + rice ×2 → 2 spoons
    expect(spoons(1, 1)).toBe(1); // 89 + rice ×1 → 1 spoon
    expect(spoons(3, 1)).toBe(3);
    expect(spoons(0, 2)).toBe(2); // rice only
    const box = defaultOrderPackaging([{ quantity: 1, packaging: perDish }, { quantity: 2, ...rice }]).get("box");
    expect(box).toBe(1); // add-ons do not add boxes
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
  it("formats Bangkok datetime-local string correctly", () => {
    expect(toBangkokDateTimeInput(now)).toBe("2026-10-13T09:00");
  });
  it("parses Bangkok datetime-local input back into UTC ISO string", () => {
    const iso = fromBangkokDateTimeInput("2026-10-13T09:00");
    expect(iso).toBe("2026-10-13T02:00:00.000Z");
  });
  it("shifts day and month boundaries when a custom dayStartHour (e.g. 06:00) is configured", () => {
    const todayRange = resolveRange("today", now, 6);
    expect(todayRange.start.toISOString()).toBe("2026-10-12T23:00:00.000Z");
    expect(todayRange.end.toISOString()).toBe("2026-10-13T23:00:00.000Z");

    const earlyMorning = new Date("2026-10-12T19:30:00.000Z"); // 02:30 Bangkok on 13 Oct
    expect(bangkokDayKey(earlyMorning, 6)).toBe("2026-10-12");
    expect(bangkokDayKey(earlyMorning, 0)).toBe("2026-10-13");
    expect(resolveRange("today", earlyMorning, 6).start.toISOString()).toBe("2026-10-11T23:00:00.000Z");

    const start = startOfBangkokDay(new Date("2026-10-12T05:00:00Z"), 6);
    const points = dailySeries(
      [
        sale({ id: "late-night", soldAt: "2026-10-12T19:00:00.000Z", netRevenue: 5000 }),
        sale({ id: "after-6am", soldAt: "2026-10-12T23:00:00.000Z", netRevenue: 8000 }),
      ],
      [],
      start,
      2,
      undefined,
      6,
    );
    expect(points.map((p) => [p.key, p.revenue])).toEqual([["2026-10-12", 5000], ["2026-10-13", 8000]]);
    const all = resolveRange("all", now);
    expect(all.label).toBe("ทั้งหมด");
    const prev = previousRange(all);
    expect(prev.start.getTime()).toBe(prev.end.getTime());
    const months = monthlySeries(
      [
        sale({ id: "oct", soldAt: "2026-10-15T05:00:00.000Z", netRevenue: 10000, cogs: 4000 }),
        sale({ id: "nov", soldAt: "2026-11-01T05:00:00.000Z", netRevenue: 5000, cogs: 2000 }),
      ],
      [],
    );
    expect(months.map((m) => [m.key, m.revenue, m.grossProfit])).toEqual([
      ["2026-11", 5000, 3000],
      ["2026-10", 10000, 6000],
    ]);
  });
});
