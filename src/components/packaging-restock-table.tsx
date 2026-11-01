"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil, RotateCcw } from "lucide-react";
import { StepperInput } from "@/components/stepper-input";
import { formatBaht, formatUnitCost, tryBahtToSatang } from "@/lib/money";

export type RestockItem = {
  id: string;
  name: string;
  unit: string;
  perOrder: boolean;
  /** Price per pack from the last purchase or item default, as a baht string ("" when never bought). */
  packPrice: string;
  /** Pieces per pack from the last purchase or item default ("" when never bought). */
  perPack: string;
};

type RowState = { packs: number; price: string; perPack: string };
const initial = (items: RestockItem[]) =>
  Object.fromEntries(
    items.map((i) => [i.id, { packs: 0, price: i.packPrice, perPack: i.perPack }])
  ) as Record<string, RowState>;

/**
 * Restock several packaging items in one go: number of packs per item (stepper, starts at 0),
 * with price per pack and pieces per pack locked to the configured default unless the user clicks to edit.
 * Field names: packs_<id>, price_<id>, qty_<id>.
 */
export function PackagingRestockTable({ items }: { items: RestockItem[] }) {
  const [rows, setRows] = useState(() => initial(items));
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const onReset = () => {
      setRows(initial(items));
      setEditingIds(new Set());
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [items]);

  const update = (id: string, patch: Partial<RowState>) =>
    setRows((current) => ({ ...current, [id]: { ...current[id], ...patch } }));

  const toggleEdit = (id: string) =>
    setEditingIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  let total = 0,
    chosen = 0;
  for (const item of items) {
    const row = rows[item.id];
    if (!row || row.packs <= 0) continue;
    chosen += 1;
    total += (tryBahtToSatang(row.price || item.packPrice) ?? 0) * row.packs;
  }

  return (
    <div className="restock-table" ref={ref}>
      {items.map((item) => {
        const rawRow = rows[item.id];
        const effectivePrice =
          rawRow && rawRow.price.trim() !== "" ? rawRow.price : item.packPrice;
        const effectivePerPack =
          rawRow && rawRow.perPack.trim() !== "" ? rawRow.perPack : item.perPack;
        const row = {
          packs: rawRow?.packs ?? 0,
          price: effectivePrice,
          perPack: effectivePerPack,
        };
        const price = tryBahtToSatang(row.price);
        const perPack = Number(row.perPack.replace(/,/g, ""));
        const active = row.packs > 0;
        const valid = price !== null && Number.isFinite(perPack) && perPack > 0;
        const hasDefaults = Boolean(
          item.packPrice.trim() !== "" && item.perPack.trim() !== ""
        );
        const isEditing = !hasDefaults || Number(item.perPack) <= 1 || editingIds.has(item.id);
        const isModified =
          hasDefaults &&
          (row.price !== item.packPrice || row.perPack !== item.perPack);

        return (
          <div key={item.id} className={`restock-row ${active ? "is-active" : ""}`}>
            <div className="restock-name">
              <strong>{item.name}</strong>
              <small>
                {item.perOrder ? "ต่อออเดอร์" : "ลงค่าใช้จ่าย"}
                {valid ? ` · ตก${item.unit}ละ ${formatUnitCost(price! / perPack)}` : ""}
              </small>
            </div>
            <div className="restock-inputs">
              <label className="restock-packs">
                จำนวนแพ็ก
                <StepperInput
                  name={`packs_${item.id}`}
                  label={`จำนวนแพ็ก ${item.name}`}
                  decimals={false}
                  onChange={(packs) => update(item.id, { packs })}
                />
              </label>
              {!isEditing ? (
                <div
                  style={{
                    gridColumn: "span 2",
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                    padding: "8px 12px",
                    borderRadius: "10px",
                    background: "rgba(255, 250, 243, 0.85)",
                    border: "1px dashed var(--line, #eadfce)",
                  }}
                >
                  <input type="hidden" name={`price_${item.id}`} value={row.price} />
                  <input type="hidden" name={`qty_${item.id}`} value={row.perPack} />
                  <span style={{ fontSize: "13px" }}>
                    ค่าที่ตั้งไว้:{" "}
                    <strong>
                      แพ็กละ {price ? formatBaht(price) : `฿${row.price}`}
                    </strong>{" "}
                    · ได้ <strong>{row.perPack}</strong> {item.unit}/แพ็ก
                  </span>
                  <button
                    type="button"
                    className="chip"
                    style={{ fontSize: "12px", padding: "3px 10px" }}
                    onClick={() => toggleEdit(item.id)}
                  >
                    <Pencil size={12} style={{ marginRight: 4 }} />
                    เปลี่ยนราคา/จำนวน (ซื้อคนละร้าน)
                  </button>
                </div>
              ) : (
                <>
                  <label>
                    ราคา/แพ็ก (บาท)
                    <input
                      name={`price_${item.id}`}
                      inputMode="decimal"
                      value={row.price}
                      required={active}
                      placeholder="เช่น 65"
                      onChange={(e) => update(item.id, { price: e.target.value })}
                      aria-invalid={row.price.trim() !== "" && price === null}
                    />
                  </label>
                  <label>
                    <span
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "6px",
                      }}
                    >
                      <span>{item.unit}/แพ็ก</span>
                      {hasDefaults && (
                        <button
                          type="button"
                          className="link-button"
                          style={{ fontSize: "11px" }}
                          onClick={() => {
                            update(item.id, {
                              price: item.packPrice,
                              perPack: item.perPack,
                            });
                            toggleEdit(item.id);
                          }}
                        >
                          <RotateCcw size={11} />{" "}
                          {isModified
                            ? `คืนค่าเดิม (฿${item.packPrice}/${item.perPack})`
                            : "ล็อกค่าที่ตั้งไว้"}
                        </button>
                      )}
                    </span>
                    <input
                      name={`qty_${item.id}`}
                      inputMode="decimal"
                      value={row.perPack}
                      required={active}
                      placeholder="เช่น 25"
                      onChange={(e) => update(item.id, { perPack: e.target.value })}
                    />
                  </label>
                </>
              )}
            </div>
            <p className="restock-line">
              {active && valid ? (
                <>
                  {row.packs.toLocaleString("th-TH")} แพ็ก ={" "}
                  <strong>{formatBaht(price! * row.packs)}</strong> ·{" "}
                  {(perPack * row.packs).toLocaleString("th-TH")} {item.unit}
                </>
              ) : active ? (
                "กรอกราคาและจำนวนต่อแพ็ก"
              ) : (
                "กด + เลือกจำนวนแพ็กที่ซื้อ"
              )}
            </p>
          </div>
        );
      })}
      <p className={`restock-total ${chosen ? "is-ready" : ""}`} aria-live="polite">
        {chosen ? (
          <>
            ซื้อ {chosen} รายการ · รวม <strong>{formatBaht(total)}</strong>
          </>
        ) : (
          "กด + ที่รายการที่ซื้อมา"
        )}
      </p>
    </div>
  );
}
