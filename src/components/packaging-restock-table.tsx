"use client";

import { useEffect, useRef, useState } from "react";
import { StepperInput } from "@/components/stepper-input";
import { formatBaht, formatUnitCost, tryBahtToSatang } from "@/lib/money";

export type RestockItem = {
  id: string;
  name: string;
  unit: string;
  perOrder: boolean;
  /** Price per pack from the last purchase, as a baht string ("" when never bought). */
  packPrice: string;
  /** Pieces per pack from the last purchase ("" when never bought). */
  perPack: string;
};

type RowState = { packs: number; price: string; perPack: string };
const initial = (items: RestockItem[]) => Object.fromEntries(items.map((i) => [i.id, { packs: 0, price: i.packPrice, perPack: i.perPack }])) as Record<string, RowState>;

/**
 * Restock several packaging items in one go: number of packs per item (stepper, starts at 0),
 * with price per pack and pieces per pack prefilled from the last purchase.
 * Field names: packs_<id>, price_<id>, qty_<id>.
 */
export function PackagingRestockTable({ items }: { items: RestockItem[] }) {
  const [rows, setRows] = useState(() => initial(items));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const onReset = () => setRows(initial(items));
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [items]);

  const update = (id: string, patch: Partial<RowState>) => setRows((current) => ({ ...current, [id]: { ...current[id], ...patch } }));

  let total = 0, chosen = 0;
  for (const item of items) {
    const row = rows[item.id];
    if (!row || row.packs <= 0) continue;
    chosen += 1;
    total += (tryBahtToSatang(row.price) ?? 0) * row.packs;
  }

  return <div className="restock-table" ref={ref}>
    {items.map((item) => {
      const row = rows[item.id] ?? { packs: 0, price: "", perPack: "" };
      const price = tryBahtToSatang(row.price);
      const perPack = Number(row.perPack.replace(/,/g, ""));
      const active = row.packs > 0;
      const valid = price !== null && Number.isFinite(perPack) && perPack > 0;
      return <div key={item.id} className={`restock-row ${active ? "is-active" : ""}`}>
        <div className="restock-name">
          <strong>{item.name}</strong>
          <small>{item.perOrder ? "ต่อออเดอร์" : "ลงค่าใช้จ่าย"}{valid ? ` · ตก${item.unit}ละ ${formatUnitCost(price! / perPack)}` : ""}</small>
        </div>
        <label className="restock-packs">จำนวนแพ็ก
          <StepperInput name={`packs_${item.id}`} label={`จำนวนแพ็ก ${item.name}`} decimals={false} onChange={(packs) => update(item.id, { packs })} />
        </label>
        <label>ราคา/แพ็ก (บาท)
          <input name={`price_${item.id}`} inputMode="decimal" value={row.price} required={active} placeholder="เช่น 65"
            onChange={(e) => update(item.id, { price: e.target.value })} aria-invalid={row.price.trim() !== "" && price === null} />
        </label>
        <label>{item.unit}/แพ็ก
          <input name={`qty_${item.id}`} inputMode="decimal" value={row.perPack} required={active} placeholder="เช่น 25"
            onChange={(e) => update(item.id, { perPack: e.target.value })} />
        </label>
        <p className="restock-line">{active && valid
          ? <>{row.packs.toLocaleString("th-TH")} แพ็ก = <strong>{formatBaht(price! * row.packs)}</strong> · {(perPack * row.packs).toLocaleString("th-TH")} {item.unit}</>
          : active ? "กรอกราคาและจำนวนต่อแพ็ก" : "ไม่ได้ซื้อ"}</p>
      </div>;
    })}
    <p className={`restock-total ${chosen ? "is-ready" : ""}`} aria-live="polite">
      {chosen ? <>ซื้อ {chosen} รายการ · รวม <strong>{formatBaht(total)}</strong></> : "กด + ที่รายการที่ซื้อมา"}
    </p>
  </div>;
}
