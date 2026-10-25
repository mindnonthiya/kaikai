"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, Search } from "lucide-react";
import { linesMatchingDifference, type BankLine } from "@/lib/bank-check";
import { formatBaht } from "@/lib/money";
import { formatTime } from "@/lib/time";

type Props = { dateKey: string; incoming: BankLine[]; outgoing: BankLine[]; totalIn: number; totalOut: number };

const toSatang = (value: string) => {
  const n = Number(value.replace(/,/g, ""));
  return value.trim() && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

export function BankCheckList({ dateKey, incoming, outgoing, totalIn, totalOut }: Props) {
  const storageKey = `kaikai:bank-check:${dateKey}`;
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [bankIn, setBankIn] = useState("");
  const [bankOut, setBankOut] = useState("");
  const [loaded, setLoaded] = useState(false);

  // Ticks are a personal checklist, so they live in this browser only.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as { ticked?: string[]; bankIn?: string; bankOut?: string };
      setTicked(new Set(saved.ticked ?? []));
      setBankIn(saved.bankIn ?? "");
      setBankOut(saved.bankOut ?? "");
    } catch {
      setTicked(new Set());
    }
    setLoaded(true);
  }, [storageKey]);

  useEffect(() => {
    // Saving before the first load would wipe the stored checklist.
    if (!loaded) return;
    localStorage.setItem(storageKey, JSON.stringify({ ticked: [...ticked], bankIn, bankOut }));
  }, [loaded, storageKey, ticked, bankIn, bankOut]);

  function toggle(id: string) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const bankInSatang = toSatang(bankIn);
  const bankOutSatang = toSatang(bankOut);
  const diffIn = bankInSatang === null ? null : bankInSatang - totalIn;
  const diffOut = bankOutSatang === null ? null : bankOutSatang - totalOut;

  const highlight = useMemo(() => {
    const ids = new Set<string>();
    const candidates: { side: "in" | "out"; groups: string[][] }[] = [];
    // The system shows more than the bank → one of our records is the likely culprit.
    if (diffIn !== null && diffIn < 0) candidates.push({ side: "in", groups: linesMatchingDifference(diffIn, incoming.filter((l) => !ticked.has(l.id))) });
    if (diffOut !== null && diffOut < 0) candidates.push({ side: "out", groups: linesMatchingDifference(diffOut, outgoing.filter((l) => !ticked.has(l.id))) });
    for (const c of candidates) for (const g of c.groups) for (const id of g) ids.add(id);
    return ids;
  }, [diffIn, diffOut, incoming, outgoing, ticked]);

  const allLines = [...incoming, ...outgoing];
  const doneCount = allLines.filter((l) => ticked.has(l.id)).length;

  return (
    <>
      <section className="panel bank-compare" aria-labelledby="bank-compare-title">
        <div className="panel-head">
          <div>
            <h2 id="bank-compare-title">กรอกยอดจากแอปธนาคาร</h2>
            <p>เปิด statement ของวันนี้ในแอป แล้วกรอกยอดรวมเงินเข้าและเงินออก</p>
          </div>
        </div>
        <div className="bank-compare-grid">
          <CompareBox
            id="bank-in" label="เงินเข้าในแอป (บาท)" value={bankIn} onChange={setBankIn}
            system={totalIn} diff={diffIn}
            moreInBank="เงินเข้าในแอปมากกว่าระบบ — อาจมีบิลขายที่ยังไม่ได้บันทึก หรือบันทึกเป็นเงินสด/ยังไม่ชำระ ทั้งที่ลูกค้าโอนแล้ว"
            moreInSystem="ระบบมีเงินเข้ามากกว่าแอป — อาจบันทึกบิลซ้ำ หรือกด “ชำระแล้ว” ทั้งที่ลูกค้ายังไม่โอน"
          />
          <CompareBox
            id="bank-out" label="เงินออกในแอป (บาท)" value={bankOut} onChange={setBankOut}
            system={totalOut} diff={diffOut}
            moreInBank="เงินออกในแอปมากกว่าระบบ — มีค่าใช้จ่ายที่จ่ายไปแล้วแต่ยังไม่ได้บันทึก"
            moreInSystem="ระบบมีเงินออกมากกว่าแอป — อาจจ่ายบางรายการด้วยเงินส่วนตัว/บัญชีอื่น หรือบันทึกค่าใช้จ่ายซ้ำ"
          />
        </div>
        {highlight.size > 0 && (
          <p className="bank-hint" role="status"><Search size={16} aria-hidden /> รายการที่ไฮไลต์สีเหลืองด้านล่างมียอดเท่ากับส่วนต่างพอดี ลองเช็กรายการนั้นก่อน</p>
        )}
      </section>

      <p className="bank-progress" aria-live="polite">ติ๊กแล้ว {doneCount} / {allLines.length} รายการ{doneCount > 0 && <button type="button" className="link-button small" onClick={() => setTicked(new Set())}>ล้างเครื่องหมาย</button>}</p>

      <div className="dashboard-grid bank-lists">
        <LineList title="เงินโอนเข้า (บิลขาย)" total={totalIn} lines={incoming} ticked={ticked} highlight={highlight} onToggle={toggle} empty="ไม่มีบิลที่รับเงินโอนในวันนี้" />
        <LineList title="เงินโอนออก (ค่าใช้จ่าย)" total={totalOut} lines={outgoing} ticked={ticked} highlight={highlight} onToggle={toggle} empty="ไม่มีค่าใช้จ่ายที่จ่ายด้วยเงินโอนในวันนี้" />
      </div>
    </>
  );
}

function CompareBox({ id, label, value, onChange, system, diff, moreInBank, moreInSystem }: {
  id: string; label: string; value: string; onChange: (v: string) => void; system: number; diff: number | null; moreInBank: string; moreInSystem: string;
}) {
  return (
    <div className="bank-compare-box">
      <label htmlFor={id}>{label}</label>
      <input id={id} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder="เช่น 6495" />
      <div className="bank-compare-row"><span>ในระบบ</span><strong>{formatBaht(system)}</strong></div>
      {diff !== null && (
        <div className={`bank-diff ${diff === 0 ? "match" : "mismatch"}`} role="status">
          {diff === 0
            ? <><CheckCircle2 size={16} aria-hidden /> ตรงกันพอดี</>
            : <><CircleAlert size={16} aria-hidden /> <span><b>ต่างกัน {formatBaht(Math.abs(diff))}</b> · {diff > 0 ? moreInBank : moreInSystem}</span></>}
        </div>
      )}
    </div>
  );
}

function LineList({ title, total, lines, ticked, highlight, onToggle, empty }: {
  title: string; total: number; lines: BankLine[]; ticked: Set<string>; highlight: Set<string>; onToggle: (id: string) => void; empty: string;
}) {
  return (
    <section className="panel bank-list">
      <div className="panel-head">
        <div><h2>{title}</h2><p>{lines.length} รายการ · รวม {formatBaht(total)}</p></div>
      </div>
      <ul>
        {lines.map((line) => {
          const done = ticked.has(line.id);
          return (
            <li key={line.id} className={`${done ? "done" : ""} ${highlight.has(line.id) ? "suspect" : ""}`}>
              <label>
                <input type="checkbox" checked={done} onChange={() => onToggle(line.id)} aria-label={`ตรงกับแอปแล้ว: ${line.label} ${formatBaht(line.amount)}`} />
                <span className="bank-line-time">{line.hasTime ? formatTime(line.at) : "—"}</span>
                <span className="bank-line-text"><strong>{line.label}</strong>{line.detail && <small>{line.detail}</small>}</span>
                <strong className={`bank-line-amount ${line.direction}`}>{line.direction === "in" ? "+" : "−"}{formatBaht(line.amount)}</strong>
              </label>
            </li>
          );
        })}
        {!lines.length && <li className="empty-state">{empty}</li>}
      </ul>
    </section>
  );
}
