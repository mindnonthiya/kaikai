export type Satang = number & { readonly __brand: "Satang" };

const assertSafeInteger = (value: number, label: string) => {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} ต้องเป็นจำนวนเต็มที่ปลอดภัย`);
};

export function bahtToSatang(value: string | number): Satang {
  const normalized = String(value).trim().replace(/,/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) throw new Error("จำนวนเงินไม่ถูกต้อง");
  const [baht, fraction = ""] = normalized.split(".");
  const satang = Number(baht) * 100 + Number(fraction.padEnd(2, "0"));
  assertSafeInteger(satang, "จำนวนเงิน");
  return satang as Satang;
}

export function satang(value: number): Satang {
  assertSafeInteger(value, "จำนวนเงิน");
  return value as Satang;
}

export function formatBaht(value: number, showSymbol = true) {
  assertSafeInteger(value, "จำนวนเงิน");
  const abs = Math.abs(value);
  const formatted = new Intl.NumberFormat("th-TH", {
    minimumFractionDigits: abs % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(abs / 100);
  const sign = value < 0 ? "-" : "";
  return showSymbol ? `${sign}฿${formatted}` : `${sign}${formatted}`;
}

export function calculateLine(unitPrice: number, unitCost: number, quantity: number) {
  [unitPrice, unitCost, quantity].forEach((value) => assertSafeInteger(value, "ค่า"));
  if (unitPrice < 0 || unitCost < 0 || quantity <= 0) throw new Error("ราคา ต้นทุน และจำนวนต้องมากกว่าศูนย์");
  const revenue = unitPrice * quantity;
  const cost = unitCost * quantity;
  return { revenue: satang(revenue), cost: satang(cost), grossProfit: satang(revenue - cost) };
}

export function calculateSale(input: {
  items: Array<{ unitPrice: number; unitCost: number; quantity: number }>;
  discount?: number;
  deliveryCharged?: number;
  paymentFee?: number;
}) {
  if (!input.items.length) throw new Error("ต้องมีสินค้าอย่างน้อยหนึ่งรายการ");
  const lines = input.items.map((item) => calculateLine(item.unitPrice, item.unitCost, item.quantity));
  const discount = input.discount ?? 0;
  const deliveryCharged = input.deliveryCharged ?? 0;
  const paymentFee = input.paymentFee ?? 0;
  [discount, deliveryCharged, paymentFee].forEach((value) => {
    assertSafeInteger(value, "ส่วนปรับยอด");
    if (value < 0) throw new Error("ส่วนปรับยอดห้ามติดลบ");
  });
  const productRevenue = lines.reduce((sum, line) => sum + line.revenue, 0);
  const cogs = lines.reduce((sum, line) => sum + line.cost, 0);
  const netRevenue = productRevenue - discount + deliveryCharged - paymentFee;
  if (netRevenue < 0) throw new Error("รายได้สุทธิต้องไม่ติดลบ");
  const grossProfit = netRevenue - cogs;
  const boxes = input.items.reduce((sum, item) => sum + item.quantity, 0);
  return {
    productRevenue: satang(productRevenue),
    netRevenue: satang(netRevenue),
    cogs: satang(cogs),
    grossProfit: satang(grossProfit),
    boxes,
    averageProfitPerBox: satang(boxes ? Math.round(grossProfit / boxes) : 0),
    marginBasisPoints: netRevenue ? Math.round((grossProfit * 10_000) / netRevenue) : 0,
  };
}

export function weightedAverageCost(
  purchases: Array<{ totalCost: number; usableQuantity: number }>,
): number {
  if (!purchases.length) return 0;
  let totalCost = 0;
  let totalQuantity = 0;
  for (const purchase of purchases) {
    assertSafeInteger(purchase.totalCost, "ต้นทุน");
    if (purchase.totalCost < 0 || purchase.usableQuantity <= 0) throw new Error("ข้อมูลการซื้อไม่ถูกต้อง");
    totalCost += purchase.totalCost;
    totalQuantity += purchase.usableQuantity;
  }
  return Math.round(totalCost / totalQuantity);
}

export function calculateNetProfit(grossProfit: number, operatingExpenses: number): Satang {
  assertSafeInteger(grossProfit, "กำไรขั้นต้น");
  assertSafeInteger(operatingExpenses, "ค่าใช้จ่าย");
  if (operatingExpenses < 0) throw new Error("ค่าใช้จ่ายห้ามติดลบ");
  return satang(grossProfit - operatingExpenses);
}

/** Per-unit cost that may be a fraction of a satang, e.g. 9.4 satang/gram → "฿0.094". */
export function formatUnitCost(satangPerUnit: number) {
  if (!Number.isFinite(satangPerUnit)) return "—";
  return `฿${new Intl.NumberFormat("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(satangPerUnit / 100)}`;
}

/** Satang → plain baht string for form defaults and CSV, e.g. 6025 → "60.25". */
export function satangToBahtInput(value: number) {
  assertSafeInteger(value, "จำนวนเงิน");
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Like bahtToSatang but returns null instead of throwing (for live form previews). */
export function tryBahtToSatang(value: string): Satang | null {
  try { return bahtToSatang(value || "0"); } catch { return null; }
}
