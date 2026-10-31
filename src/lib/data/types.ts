// Shapes the pages work with. Supabase rows are mapped into these in ./queries.ts.

export type PaymentMethod = "cash" | "transfer" | "other";
export type PaymentStatus = "unpaid" | "partial" | "paid" | "refunded";
export type SaleStatus = "draft" | "confirmed" | "cancelled" | "refunded";
export type ExpenseKind = "direct" | "operating" | "one_time" | "recurring";
export type Fulfillment = "pickup" | "delivery";

/** Menus in this category are add-ons (extra chicken, plain rice): listed separately when selling, not counted as boxes. */
export const ADDON_CATEGORY = "เพิ่มเติม";
/** Category used for normal dishes (chicken rice boxes). */
export const DISH_CATEGORY = "เมนูหลัก";
/** Category used for courier/delivery gigs and side services (e.g. mj ส่งด่วน, ค่าหิ้ว): permanent preset options, not food boxes. */
export const SERVICE_CATEGORY = "บริการ";

export const isAddonCategory = (category: string | null | undefined) => (category ?? "").trim() === ADDON_CATEGORY;
export const isServiceCategory = (category: string | null | undefined, name?: string) => {
  const cat = (category ?? "").trim();
  if (cat === SERVICE_CATEGORY || cat === "บริการ / จ็อบเสริม" || cat === "จ็อบเสริม") return true;
  if (name && /ส่งด่วน|รับหิ้ว|ค่าส่ง|ไรเดอร์|จ็อบเสริม/.test(name) && !/ข้าว|ไก่/.test(name)) return true;
  return false;
};
export const isDishCategory = (category: string | null | undefined, name?: string) => {
  return (category ?? "").trim() !== "พิเศษ" && !isAddonCategory(category) && !isServiceCategory(category, name);
};
/** Expense category used to compare delivery income with fuel. */
export const FUEL_CATEGORY = "ค่าน้ำมัน";
/** Bills that arrive later (electric stove, gas) — the reports remind the owner when a month has none. */
export const UTILITY_CATEGORIES = ["ค่าไฟ", "ค่าแก๊ส"];

/**
 * per_unit: counted in recipes per piece (chicken: bought by กก., 1 กก. ≈ 27 pieces).
 * pooled:   other ingredients (rice, herbs, sauce) — purchases ÷ food sales = % added to every order.
 */
export type IngredientCosting = "per_unit" | "pooled";
export const INGREDIENT_COSTING_LABELS: Record<IngredientCosting, string> = { per_unit: "นับต่อชิ้น", pooled: "คิดเป็น %" };

export type SaleItemRecord = { menuId: string; name: string; category: string | null; quantity: number; revenue: number; cost: number; packagingCost?: number };
export type PaymentRecord = { method: PaymentMethod; amount: number };

export type SaleRecord = {
  id: string;
  saleNumber: number;
  soldAt: string;
  status: SaleStatus;
  paymentStatus: PaymentStatus;
  customerName: string | null;
  notes: string | null;
  fulfillment: Fulfillment;
  productRevenue: number;
  discount: number;
  delivery: number;
  tip?: number;
  fee: number;
  /** Packaging actually handed out with this order (part of cogs). */
  packagingCost: number;
  netRevenue: number;
  cogs: number;
  grossProfit: number;
  slipPath?: string | null;
  items: SaleItemRecord[];
  payments: PaymentRecord[];
};

export type ExpenseRecord = {
  id: string;
  spentAt: string;
  category: string;
  kind: ExpenseKind;
  amount: number;
  description: string;
  payee: string | null;
  paymentMethod: PaymentMethod | null;
  receiptPath?: string | null;
  notes?: string | null;
};

export type MenuRecord = {
  id: string;
  name: string;
  category: string;
  imagePath?: string | null;
  price: number;
  /** Default packaging cost per dish from the recipe (included in `cost`). */
  packagingCost: number;
  /** Cost per dish = per-piece ingredients (chicken) + packaging. Pooled ingredients are added at sale time as a %. */
  cost: number;
  isAvailable: boolean;
  costCalculatedAt: string | null;
};

export type IngredientRecord = {
  id: string;
  name: string;
  category: string;
  costing: IngredientCosting;
  /** Unit used in recipes, e.g. ชิ้น. */
  baseUnit: string;
  /** Unit the owner buys in, e.g. กก. */
  purchaseUnit: string;
  /** Recipe units per purchase unit, e.g. 27 pieces per กก. */
  unitsPerPurchaseUnit: number;
  /** true = unitsPerPurchaseUnit is learned from sales between purchases. */
  yieldAuto: boolean;
  yieldUpdatedAt: string | null;
  /** Satang per purchase unit (weighted, last 30 days); may be fractional. */
  pricePerPurchaseUnit: number;
  /** Satang per recipe unit; may be fractional (e.g. 4.5 ฿ per piece = 450). */
  unitCost: number;
  isActive: boolean;
};

export type PackagingRecord = {
  id: string;
  name: string;
  unit: string;
  /** Satang per piece (weighted average of purchases); may be fractional. */
  unitCost: number;
  isActive: boolean;
  /** true = cost counted in each order; false = booked as an expense when bought. */
  perOrder: boolean;
};

export type PackagingPurchaseRecord = {
  id: string;
  packagingItemId: string;
  itemName: string;
  unit: string;
  purchasedAt: string;
  /** Total price of the purchase. */
  price: number;
  /** Total pieces bought (all packs). */
  packQuantity: number;
  /** Number of packs bought. */
  packCount: number;
  vendor: string | null;
  /** Set when the purchase was also recorded as an expense. */
  expenseId: string | null;
};

export type SaleSettings = {
  defaultDeliveryFee: number;
  /** Quick-pick delivery fee options in satang (e.g. [1500, 2000] = 15฿, 20฿). */
  deliveryFeeOptions?: number[];
  /** Pooled-ingredient rate (basis points of food sales) used until there is enough real data. */
  initialPooledBps: number;
  /** Whether to display food images across the system (default true). When false, displays compact text-only layout. */
  showMenuImages?: boolean;
  /** Hour of day (0-12, Bangkok time) when a new business day starts. Default 0 (00:00 midnight). */
  dayStartHour?: number;
};

export type PricePresetItem = {
  menuId: string;
  quantity: number;
};

export type PricePreset = {
  id: string;
  name: string;
  amountSatang: number;
  fulfillment: Fulfillment;
  deliveryChargedSatang: number;
  items: PricePresetItem[];
  notes?: string;
};


export type PurchaseRecord = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  costing: IngredientCosting;
  purchasedAt: string;
  price: number;
  /** In the purchase unit (e.g. กก.); null for pooled items recorded by amount only. */
  purchasedQuantity: number | null;
  unit: string | null;
  vendor: string | null;
};

export type RecipeItemRecord = {
  id: string;
  menuId: string;
  ingredientId: string | null;
  packagingItemId: string | null;
  quantity: number;
};

export type ProfileRecord = { displayName: string; shopName: string; email: string | null; avatarUrl?: string | null };

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = { cash: "เงินสด", transfer: "เงินโอน", other: "อื่น ๆ" };
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = { paid: "ชำระแล้ว", partial: "ชำระบางส่วน", unpaid: "ค้างชำระ", refunded: "คืนเงินแล้ว" };
export const EXPENSE_KIND_LABELS: Record<ExpenseKind, string> = { direct: "ต้นทุนโดยตรง", operating: "ดำเนินงาน", one_time: "ครั้งเดียว", recurring: "ประจำ" };
export const FULFILLMENT_LABELS: Record<Fulfillment, string> = { pickup: "รับเอง", delivery: "ส่ง" };
