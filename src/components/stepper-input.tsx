"use client";

import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";

const toNumber = (value: string) => {
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const tidy = (n: number) => String(Math.round(n * 10_000) / 10_000);

/**
 * Number input with − / + buttons. The value can also be typed (e.g. 0.5).
 * Restores `defaultValue` when the surrounding form is reset.
 */
export function StepperInput({ name, defaultValue = 0, step = 1, min = 0, label, onChange, id, decimals = true }: {
  name: string;
  defaultValue?: number;
  step?: number;
  min?: number;
  /** Accessible label, e.g. "จำนวนแพ็ก กล่อง + ฝา". */
  label: string;
  onChange?: (value: number) => void;
  id?: string;
  /** false = whole numbers only. */
  decimals?: boolean;
}) {
  const [value, setValue] = useState(tidy(defaultValue));
  const ref = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const onReset = () => { setValue(tidy(defaultValue)); onChangeRef.current?.(defaultValue); };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [defaultValue]);

  function set(next: string) {
    setValue(next);
    onChangeRef.current?.(toNumber(next));
  }

  const current = toNumber(value);
  return <div className={`stepper ${current > 0 ? "has-value" : ""}`} ref={ref}>
    <button type="button" aria-label={`ลด ${label}`} disabled={current <= min} onClick={() => set(tidy(Math.max(min, current - step)))}><Minus size={14} /></button>
    <input
      id={id} name={name} value={value} aria-label={label} inputMode={decimals ? "decimal" : "numeric"}
      onChange={(e) => set(e.target.value.replace(decimals ? /[^\d.]/g : /\D/g, ""))}
      onFocus={(e) => e.target.select()}
    />
    <button type="button" aria-label={`เพิ่ม ${label}`} onClick={() => set(tidy(current + step))}><Plus size={14} /></button>
  </div>;
}
