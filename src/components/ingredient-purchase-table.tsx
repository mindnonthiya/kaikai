"use client";

import { useEffect, useRef, useState } from "react";
import { StepperInput } from "@/components/stepper-input";
import { formatBaht, formatUnitCost, tryBahtToSatang } from "@/lib/money";

export type PerUnitPurchaseItem = {
  id: string;
  name: string;
  /** e.g. กก. */
  purchaseUnit: string;
  /** e.g. ชิ้น */
  baseUnit: string;
  unitsPerPurchaseUnit: number;
  /** Last price per purchase unit as a baht string ("" when never bought). */
  unitPrice: string;
};
export type PooledPurchaseItem = { id: string; name: string };

type State = { qty: Record<string, number>; unitPrice: Record<string, string>; amount: Record<string, string> };
const initial = (perUnit: PerUnitPurchaseItem[]): State => ({
  qty: {}, amount: {}, unitPrice: Object.fromEntries(perUnit.map((i) => [i.id, i.unitPrice])),
});

/**
 * One form for a shopping trip.
 * Per-piece items (chicken): amount in กก. × price per กก. → total. Fields qty_<id>, unit_price_<id>.
 * Pooled items (rice, herbs, sauce): total price only. Field amount_<id>.
 */
export function IngredientPurchaseTable({ perUnit, pooled }: { perUnit: PerUnitPurchaseItem[]; pooled: PooledPurchaseItem[] }) {
  const [state, setState] = useState(() => initial(perUnit));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const onReset = () => setState(initial(perUnit));
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [perUnit]);

  const set = <K extends keyof State>(key: K, id: string, value: State[K][string]) =>
    setState((current) => ({ ...current, [key]: { ...current[key], [id]: value } }));

  let total = 0, count = 0;
  for (const item of perUnit) {
    const qty = state.qty[item.id] ?? 0;
    const price = tryBahtToSatang(state.unitPrice[item.id] ?? "");
    if (qty > 0) { count += 1; total += Math.round(qty * (price ?? 0)); }
  }
  for (const item of pooled) {
    const amount = (state.amount[item.id] ?? "").trim() ? tryBahtToSatang(state.amount[item.id]) : null;
    if (amount) { count += 1; total += amount; }
  }

  return <div className="restock-table" ref={ref}>
    {perUnit.length > 0 && <p className="picker-subhead">นับต่อชิ้น — กรอกจำนวน{perUnit[0].purchaseUnit} × ราคาต่อ{perUnit[0].purchaseUnit}</p>}
    {perUnit.map((item) => {
      const qty = state.qty[item.id] ?? 0;
      const raw = state.unitPrice[item.id] ?? "";
      const price = tryBahtToSatang(raw);
      const line = qty > 0 && price ? Math.round(qty * price) : null;
      return <div key={item.id} className={`restock-row ${qty > 0 ? "is-active" : ""}`}>
        <div className="restock-name">
          <strong>{item.name}</strong>
          <small>{item.unitsPerPurchaseUnit.toLocaleString("th-TH")} {item.baseUnit}/{item.purchaseUnit}{price ? ` · ตก${item.baseUnit}ละ ${formatUnitCost(price / item.unitsPerPurchaseUnit)}` : ""}</small>
        </div>
        <label className="restock-packs">จำนวน ({item.purchaseUnit})
          <StepperInput name={`qty_${item.id}`} label={`จำนวน${item.purchaseUnit} ${item.name}`} onChange={(value) => set("qty", item.id, value)} />
        </label>
        <label>ราคาต่อ{item.purchaseUnit} (บาท)
          <input name={`unit_price_${item.id}`} inputMode="decimal" value={raw} required={qty > 0} placeholder="เช่น 125"
            onChange={(e) => set("unitPrice", item.id, e.target.value)} aria-invalid={raw.trim() !== "" && price === null} />
        </label>
        <p className="restock-line">{line !== null
          ? <>{qty.toLocaleString("th-TH")} {item.purchaseUnit} × {formatBaht(price!)} = <strong>{formatBaht(line)}</strong> · ≈ {Math.round(qty * item.unitsPerPurchaseUnit).toLocaleString("th-TH")} {item.baseUnit}</>
          : qty > 0 ? `กรอกราคาต่อ${item.purchaseUnit}` : "ไม่ได้ซื้อ"}</p>
      </div>;
    })}
    {pooled.length > 0 && <>
      <p className="picker-subhead">คิดเป็น % — กรอกแค่ราคารวมที่จ่าย</p>
      <div className="amount-grid">
        {pooled.map((item) => {
          const raw = state.amount[item.id] ?? "";
          const invalid = raw.trim() !== "" && tryBahtToSatang(raw) === null;
          return <label key={item.id} className={raw.trim() && !invalid ? "is-active" : ""}>{item.name} (บาท)
            <input name={`amount_${item.id}`} inputMode="decimal" value={raw} placeholder="0" aria-invalid={invalid}
              onChange={(e) => set("amount", item.id, e.target.value)} />
          </label>;
        })}
      </div>
    </>}
    <p className={`restock-total ${count ? "is-ready" : ""}`} aria-live="polite">
      {count ? <>ซื้อ {count} รายการ · รวม <strong>{formatBaht(total)}</strong></> : "กรอกเฉพาะรายการที่ซื้อมา ที่เหลือปล่อยว่าง"}
    </p>
  </div>;
}
