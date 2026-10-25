// Builds the list used to tick off a day's records against the bank app statement.
import { countsAsRevenue } from "@/lib/analytics";
import type { ExpenseRecord, SaleRecord } from "@/lib/data/types";

export type BankLine = {
  id: string;
  direction: "in" | "out";
  /** ISO time. Expenses only have a date, so `hasTime` is false for them. */
  at: string;
  hasTime: boolean;
  label: string;
  detail: string;
  amount: number;
  source: "sale" | "expense";
  sourceId: string;
};

export type OutstandingSale = { id: string; saleNumber: number; customerName: string | null; soldAt: string; amount: number };

export type BankCheck = {
  incoming: BankLine[];
  outgoing: BankLine[];
  totalIn: number;
  totalOut: number;
  net: number;
  /** Confirmed sales that are not fully paid yet — counted in sales but no money has arrived. */
  outstanding: OutstandingSale[];
  /** Records marked as cash/other — they never reach the bank, a common reason the totals differ. */
  notViaBank: BankLine[];
};

export function buildBankCheck(sales: SaleRecord[], expenses: ExpenseRecord[]): BankCheck {
  const incoming: BankLine[] = [];
  const notViaBank: BankLine[] = [];
  const outstanding: OutstandingSale[] = [];

  for (const sale of sales.filter(countsAsRevenue)) {
    const label = `#${sale.saleNumber} · ${sale.customerName ?? "ลูกค้าทั่วไป"}`;
    const detail = sale.items.map((i) => `${i.name} ×${i.quantity}`).join(" · ");
    let transfer = 0, other = 0, paid = 0;
    for (const p of sale.payments) {
      paid += p.amount;
      if (p.method === "transfer") transfer += p.amount;
      else other += p.amount;
    }
    if (transfer > 0) incoming.push({ id: `s:${sale.id}`, direction: "in", at: sale.soldAt, hasTime: true, label, detail, amount: transfer, source: "sale", sourceId: sale.id });
    if (other > 0) notViaBank.push({ id: `s:${sale.id}:other`, direction: "in", at: sale.soldAt, hasTime: true, label, detail: "บันทึกเป็นเงินสด/อื่น ๆ", amount: other, source: "sale", sourceId: sale.id });
    const due = sale.netRevenue - paid;
    if (due > 0) outstanding.push({ id: sale.id, saleNumber: sale.saleNumber, customerName: sale.customerName, soldAt: sale.soldAt, amount: due });
  }

  const outgoing: BankLine[] = [];
  for (const e of expenses) {
    const line: BankLine = {
      id: `e:${e.id}`, direction: "out", at: e.spentAt, hasTime: false,
      label: e.description, detail: [e.category, e.payee].filter(Boolean).join(" · "), amount: e.amount, source: "expense", sourceId: e.id,
    };
    // Expenses without a method come from purchase records and were paid by transfer.
    if ((e.paymentMethod ?? "transfer") === "transfer") outgoing.push(line);
    else notViaBank.push({ ...line, detail: `บันทึกเป็น${e.paymentMethod === "cash" ? "เงินสด" : "อื่น ๆ"} · ${line.detail}` });
  }

  incoming.sort((a, b) => a.at.localeCompare(b.at));
  outgoing.sort((a, b) => a.at.localeCompare(b.at) || a.label.localeCompare(b.label, "th"));
  const totalIn = incoming.reduce((s, l) => s + l.amount, 0);
  const totalOut = outgoing.reduce((s, l) => s + l.amount, 0);
  return { incoming, outgoing, totalIn, totalOut, net: totalIn - totalOut, outstanding, notViaBank };
}

/**
 * Lines whose amount alone, or two together, equal `difference` (satang).
 * Helps spot "the ฿700 that doesn't match" in one glance.
 */
export function linesMatchingDifference(difference: number, lines: { id: string; amount: number }[], maxPairs = 5): string[][] {
  const target = Math.abs(difference);
  if (!target) return [];
  const result: string[][] = lines.filter((l) => l.amount === target).map((l) => [l.id]);
  let pairs = 0;
  for (let i = 0; i < lines.length && pairs < maxPairs; i++) {
    for (let j = i + 1; j < lines.length && pairs < maxPairs; j++) {
      if (lines[i].amount + lines[j].amount === target) { result.push([lines[i].id, lines[j].id]); pairs++; }
    }
  }
  return result;
}
