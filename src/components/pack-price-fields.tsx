"use client";

import { useEffect, useRef, useState } from "react";
import { formatUnitCost, tryBahtToSatang } from "@/lib/money";

/**
 * "Pack price" + "pieces per pack" inputs with a live "costs ฿X per piece" preview.
 * Input names: pack_price, pack_quantity (read by the packaging server actions).
 */
export function PackPriceFields({ unit, required = true, unitInputName }: {
  /** Fixed unit label, e.g. "ชิ้น". */
  unit?: string;
  required?: boolean;
  /** Name of a sibling input whose value is the unit (used in the "new item" form). */
  unitInputName?: string;
}) {
  const [price, setPrice] = useState("");
  const [count, setCount] = useState("");
  const [typedUnit, setTypedUnit] = useState(unit ?? "ชิ้น");
  const ref = useRef<HTMLDivElement>(null);

  // Follow the unit input and clear the preview when the form is reset after saving.
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const source = unitInputName ? (form.elements.namedItem(unitInputName) as HTMLInputElement | HTMLSelectElement | null) : null;
    const readUnit = () => source instanceof HTMLSelectElement ? source.selectedOptions[0]?.dataset.unit : source?.value.trim();
    const syncUnit = () => setTypedUnit(readUnit() || unit || "ชิ้น");
    const onReset = () => { setPrice(""); setCount(""); setTimeout(syncUnit, 0); };
    syncUnit();
    source?.addEventListener("input", syncUnit);
    source?.addEventListener("change", syncUnit);
    form.addEventListener("reset", onReset);
    return () => {
      source?.removeEventListener("input", syncUnit);
      source?.removeEventListener("change", syncUnit);
      form.removeEventListener("reset", onReset);
    };
  }, [unit, unitInputName]);

  const priceSatang = price.trim() ? tryBahtToSatang(price) : null;
  const pieces = Number(count.replace(/,/g, ""));
  const valid = priceSatang !== null && Number.isFinite(pieces) && pieces > 0;
  const label = unit ?? typedUnit;

  return <div className="pack-price" ref={ref}>
    <label>ราคาที่ซื้อทั้งแพ็ก (บาท)
      <input name="pack_price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required={required} placeholder="เช่น 65" aria-invalid={price.trim() !== "" && priceSatang === null} />
    </label>
    <label>ได้กี่{label}ในแพ็ก
      <input name="pack_quantity" inputMode="decimal" value={count} onChange={(e) => setCount(e.target.value)} required={required} placeholder="เช่น 25" />
    </label>
    <p className={`pack-preview ${valid ? "is-ready" : ""}`} aria-live="polite">
      {valid ? <>ตก{label}ละ <strong>{formatUnitCost(priceSatang! / pieces)}</strong></> : `กรอกราคาและจำนวน ระบบจะหารให้ว่าตก${label}ละเท่าไร`}
    </p>
  </div>;
}
