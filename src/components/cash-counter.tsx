"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { formatBaht } from "@/lib/money";

interface CashCounterProps {
  expectedCashSatang: number;
  initialActualSatang?: number | null;
  shiftId?: string;
}

const DENOMINATIONS = [
  { key: "1000", label: "ธนบัตร 1,000", value: 1000, type: "bill" },
  { key: "500", label: "ธนบัตร 500", value: 500, type: "bill" },
  { key: "100", label: "ธนบัตร 100", value: 100, type: "bill" },
  { key: "50", label: "ธนบัตร 50", value: 50, type: "bill" },
  { key: "20", label: "ธนบัตร 20", value: 20, type: "bill" },
  { key: "10", label: "เหรียญ 10", value: 10, type: "coin" },
  { key: "5", label: "เหรียญ 5", value: 5, type: "coin" },
  { key: "2", label: "เหรียญ 2", value: 2, type: "coin" },
  { key: "1", label: "เหรียญ 1", value: 1, type: "coin" },
] as const;

export function CashCounter({
  expectedCashSatang,
  initialActualSatang,
  shiftId,
}: CashCounterProps) {
  const [mode, setMode] = useState<"breakdown" | "direct">("breakdown");
  const [directBaht, setDirectBaht] = useState<string>(
    initialActualSatang ? (initialActualSatang / 100).toString() : ""
  );
  const [counts, setCounts] = useState<Record<string, number>>({
    "1000": 0,
    "500": 0,
    "100": 0,
    "50": 0,
    "20": 0,
    "10": 0,
    "5": 0,
    "2": 0,
    "1": 0,
  });

  const breakdownTotalBaht = DENOMINATIONS.reduce(
    (sum, d) => sum + (counts[d.key] || 0) * d.value,
    0
  );
  const breakdownTotalSatang = breakdownTotalBaht * 100;

  const actualSatang =
    mode === "breakdown"
      ? breakdownTotalSatang
      : Math.round((parseFloat(directBaht) || 0) * 100);

  const diffSatang = actualSatang - expectedCashSatang;

  function updateCount(key: string, delta: number) {
    setCounts((prev) => {
      const current = prev[key] || 0;
      const next = Math.max(0, current + delta);
      return { ...prev, [key]: next };
    });
  }

  function setCountValue(key: string, value: string) {
    const parsed = parseInt(value, 10);
    setCounts((prev) => ({
      ...prev,
      [key]: isNaN(parsed) || parsed < 0 ? 0 : parsed,
    }));
  }

  return (
    <div className="cash-counter-widget">
      {shiftId && <input type="hidden" name="id" value={shiftId} />}
      <input type="hidden" name="use_breakdown" value={mode === "breakdown" ? "true" : "false"} />
      <input type="hidden" name="actual_cash" value={(actualSatang / 100).toFixed(2)} />

      {/* Hidden inputs for breakdown form submission */}
      {DENOMINATIONS.map((d) => (
        <input
          key={d.key}
          type="hidden"
          name={`count_${d.key}`}
          value={counts[d.key] || 0}
        />
      ))}

      {/* Mode toggle */}
      <div className="cash-counter-tabs">
        <button
          type="button"
          className={`cash-tab-btn ${mode === "breakdown" ? "active" : ""}`}
          onClick={() => setMode("breakdown")}
        >
          นับตามธนบัตร / เหรียญ
        </button>
        <button
          type="button"
          className={`cash-tab-btn ${mode === "direct" ? "active" : ""}`}
          onClick={() => setMode("direct")}
        >
          กรอกยอดเงินรวมเอง
        </button>
      </div>

      {mode === "direct" ? (
        <div className="direct-cash-input-wrap">
          <label>
            <span>ยอดเงินสดที่นับได้จริง (บาท)</span>
            <input
              type="number"
              step="any"
              min="0"
              placeholder="เช่น 5795"
              value={directBaht}
              onChange={(e) => setDirectBaht(e.target.value)}
              className="direct-cash-input"
              autoFocus
            />
          </label>
        </div>
      ) : (
        <div className="denominations-container">
          <div className="denominations-head">
            <span>นับจำนวนใบและเหรียญ</span>
            <button
              type="button"
              className="link-button small"
              onClick={() =>
                setCounts({
                  "1000": 0,
                  "500": 0,
                  "100": 0,
                  "50": 0,
                  "20": 0,
                  "10": 0,
                  "5": 0,
                  "2": 0,
                  "1": 0,
                })
              }
            >
              ล้างค่า (เริ่มใหม่)
            </button>
          </div>

          <div className="denominations-grid">
            {DENOMINATIONS.map((d) => {
              const count = counts[d.key] || 0;
              const subtotal = count * d.value;
              return (
                <div key={d.key} className={`denom-row ${d.type} ${count > 0 ? "has-value" : ""}`}>
                  <div className="denom-label">
                    <strong>{d.label}</strong>
                    <span className="denom-subtotal">{formatBaht(subtotal * 100)}</span>
                  </div>
                  <div className="denom-stepper">
                    <button
                      type="button"
                      className="stepper-btn minus"
                      onClick={() => updateCount(d.key, -1)}
                      disabled={count <= 0}
                      aria-label={`ลด ${d.label}`}
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min="0"
                      value={count === 0 ? "" : count}
                      placeholder="0"
                      onChange={(e) => setCountValue(d.key, e.target.value)}
                      className="stepper-input"
                    />
                    <button
                      type="button"
                      className="stepper-btn plus"
                      onClick={() => updateCount(d.key, 1)}
                      aria-label={`เพิ่ม ${d.label}`}
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Realtime Reconciliation Difference Card */}
      <div className="reconciliation-summary-box">
        <div className="summary-col">
          <span className="summary-col-label">เงินสดที่ควรมีในเก๊ะ</span>
          <strong className="summary-col-val expected">{formatBaht(expectedCashSatang)}</strong>
        </div>
        <div className="summary-col-separator">−</div>
        <div className="summary-col">
          <span className="summary-col-label">เงินสดที่นับได้จริง</span>
          <strong className="summary-col-val actual">{formatBaht(actualSatang)}</strong>
        </div>
        <div className="summary-col-separator">=</div>
        <div className={`summary-col diff ${diffSatang === 0 ? "match" : diffSatang < 0 ? "shortage" : "surplus"}`}>
          <span className="summary-col-label">ผลต่าง (ขาด / เกิน)</span>
          <strong className="summary-col-val">
            {diffSatang === 0 ? (
              "พอดีเป๊ะ (฿0)"
            ) : diffSatang < 0 ? (
              `ขาด ${formatBaht(Math.abs(diffSatang))}`
            ) : (
              `เกิน +${formatBaht(diffSatang)}`
            )}
          </strong>
        </div>
      </div>

      {/* Difference feedback message */}
      {diffSatang === 0 && actualSatang > 0 && (
        <div className="reconciliation-alert success">
          <CheckCircle2 size={18} />
          <div>
            <strong>ยอดเงินสดตรงเป๊ะ ครบถ้วน!</strong>
            <p>เงินสดในลิ้นชักตรงกับบันทึกยอดขายและค่าใช้จ่ายของวันนี้</p>
          </div>
        </div>
      )}

      {diffSatang < 0 && (
        <div className="reconciliation-alert warning">
          <AlertCircle size={18} />
          <div>
            <strong>เงินสดขาดไป {formatBaht(Math.abs(diffSatang))}</strong>
            <p>
              สาเหตุที่พบบ่อย: มีรายการซื้อของสด/วัตถุดิบ หรือค่าใช้จ่ายเงินสดที่ยังไม่ได้บันทึก,
              ทอนเงินเกินให้ลูกค้า, หรือหยิบเงินสดไปใช้ส่วนตัว
            </p>
          </div>
        </div>
      )}

      {diffSatang > 0 && (
        <div className="reconciliation-alert info">
          <AlertCircle size={18} />
          <div>
            <strong>เงินสดเกินมา {formatBaht(diffSatang)}</strong>
            <p>
              อาจเกิดจาก: ได้รับทิปเงินสด, มีออเดอร์ขายเงินสดที่ลืมกดบันทึกในระบบ,
              หรือเงินทอนเริ่มต้นมีมากกว่าที่บันทึกไว้
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
