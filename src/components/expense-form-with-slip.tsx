"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { saveExpense } from "@/app/actions/expenses";
import { FUEL_CATEGORY, type ExpenseKind, type PaymentMethod } from "@/lib/data/types";
import { hasSupabaseEnv } from "@/lib/env";
import { compressSlipImage } from "@/lib/image-compression";
import { formatBaht, satangToBahtInput } from "@/lib/money";
import { createClient } from "@/lib/supabase/client";
import { bangkokDayKey } from "@/lib/time";

const SLIP_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const MAX_SLIP_BYTES = 10 * 1024 * 1024;

export function guessExpenseFromPayee(payee: string): {
  category?: string;
  description?: string;
  kind?: ExpenseKind;
} {
  const text = payee.trim();
  if (!text) return {};
  if (/ปตท|ptt|บางจาก|bangchak|เชลล์|shell|คาลเท็กซ์|caltex|พีที|ptg|เอสโซ่|esso|ปั๊ม|น้ำมัน/i.test(text)) {
    return { category: FUEL_CATEGORY, description: "เติมน้ำมัน", kind: "operating" };
  }
  if (/แก๊ส|ก๊าซ|gas|สยามแก๊ส|เวิลด์แก๊ส/i.test(text)) {
    return { category: "ค่าแก๊ส", description: "ค่าแก๊ส", kind: "operating" };
  }
  if (/การไฟฟ้า|pea|mea|ไฟฟ้า/i.test(text)) {
    return { category: "ค่าไฟ", description: "ค่าไฟ", kind: "operating" };
  }
  if (/การประปา|mwa|pwa|ประปา/i.test(text)) {
    return { category: "ค่าน้ำ", description: "ค่าน้ำ", kind: "operating" };
  }
  if (/แม็คโคร|makro|cp axtra|ซีพี แอ็กซ์ตร้า|โลตัส|lotus|บิ๊กซี|big c/i.test(text)) {
    return { category: "บรรจุภัณฑ์", description: `ซื้อของ (${text})`, kind: "operating" };
  }
  return {};
}

export function ExpenseFormWithSlip({
  today,
  maxDate,
  categories,
}: {
  today: string;
  maxDate: string;
  categories: string[];
}) {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [kind, setKind] = useState<ExpenseKind>("operating");
  const [spentAt, setSpentAt] = useState(today);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("transfer");
  const [payee, setPayee] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");

  const [slip, setSlip] = useState<File | null>(null);
  const [slipHash, setSlipHash] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  async function handleChooseSlip(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;
    if (!SLIP_TYPES[file.type]) {
      setStatus({ ok: false, text: "รองรับเฉพาะไฟล์ JPG, PNG หรือ WebP" });
      return;
    }
    if (file.size > MAX_SLIP_BYTES) {
      setStatus({ ok: false, text: "ไฟล์สลิปต้องไม่เกิน 10 MB" });
      return;
    }

    setAnalyzing(true);
    setStatus({ ok: true, text: "กำลังบีบอัดรูปและอ่านข้อมูลสลิป…" });
    try {
      const compressed = await compressSlipImage(file, { maxWidth: 720, quality: 0.65 });
      setSlip(compressed.file);
      setSlipHash(compressed.hash);
      setPaymentMethod("transfer");

      const formData = new FormData();
      formData.append("file", compressed.file);
      formData.append("hash", compressed.hash);
      formData.append("context", "expense");

      const res = await fetch("/api/slip/analyze", { method: "POST", body: formData });
      const json = await res.json();

      if (json.isDuplicate) {
        setStatus({
          ok: false,
          text: json.duplicateReason || "สลิปค่าใช้จ่ายนี้เคยบันทึกไปแล้ว — กรุณาตรวจสอบว่าไม่ได้ลงซ้ำ",
        });
      }

      if (json.ok && json.result) {
        const ocr = json.result;
        if (ocr.amountSatang && ocr.amountSatang > 0) {
          setAmount(satangToBahtInput(ocr.amountSatang));
        }
        if (ocr.transferredAt) {
          const dKey = bangkokDayKey(ocr.transferredAt);
          if (dKey <= maxDate) setSpentAt(dKey);
        }
        if (ocr.referenceNumber) {
          setReferenceNumber(ocr.referenceNumber);
        }
        const detectedPayee = (ocr.receiverName || "").trim();
        if (detectedPayee) {
          setPayee((prev) => prev || detectedPayee);
          const guessed = guessExpenseFromPayee(detectedPayee);
          if (guessed.category) setCategory((prev) => prev || guessed.category!);
          if (guessed.description) setDescription((prev) => prev || guessed.description!);
          if (guessed.kind) setKind(guessed.kind);
        }

        if (!json.isDuplicate) {
          setStatus({
            ok: true,
            text: ocr.amountSatang
              ? `อ่านสลิปสำเร็จ: ยอด ${formatBaht(ocr.amountSatang)}${detectedPayee ? ` · ผู้รับ "${detectedPayee}"` : ""} (บีบอัดเหลือ ${(compressed.compressedBytes / 1024).toFixed(0)} KB)`
              : `แนบสลิปเรียบร้อย (${(compressed.compressedBytes / 1024).toFixed(0)} KB)`,
          });
        }
      } else if (!json.isDuplicate) {
        setStatus({
          ok: true,
          text: `แนบสลิปเรียบร้อย (${(compressed.compressedBytes / 1024).toFixed(0)} KB) — กรอกยอดเงินและรายละเอียดด้านล่าง`,
        });
      }
    } catch (err: unknown) {
      console.error("Expense slip analysis error:", err);
      setSlip(file);
      setStatus({ ok: true, text: "แนบสลิปแล้ว — กรุณากรอกรายละเอียดค่าใช้จ่าย" });
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setStatus(null);
    let uploadedPath: string | null = null;

    try {
      const supabase = createClient();
      if (slip && hasSupabaseEnv) {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่");
        const ext = SLIP_TYPES[slip.type] || "webp";
        const hashPart = slipHash ? slipHash.slice(0, 16) : Date.now().toString(36);
        uploadedPath = `${user.id}/expenses/${hashPart}_${crypto.randomUUID()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from("sale-slips")
          .upload(uploadedPath, slip, { contentType: slip.type, upsert: false });
        if (uploadError) {
          uploadedPath = null;
          throw new Error(`อัปโหลดสลิปไม่สำเร็จ: ${uploadError.message}`);
        }
      }

      const formData = new FormData();
      formData.set("description", description);
      formData.set("amount", amount);
      formData.set("category", category);
      formData.set("kind", kind);
      formData.set("spent_at", spentAt);
      formData.set("payment_method", paymentMethod);
      formData.set("payee", payee);
      if (uploadedPath) formData.set("receipt_path", uploadedPath);
      if (referenceNumber) formData.set("notes", `Ref: ${referenceNumber}`);

      const res = await saveExpense(formData);
      if (res.error) {
        if (uploadedPath) await supabase.storage.from("sale-slips").remove([uploadedPath]).catch(() => undefined);
        setStatus({ ok: false, text: res.error });
        return;
      }

      setDescription("");
      setAmount("");
      setCategory("");
      setKind("operating");
      setSpentAt(today);
      setPaymentMethod("transfer");
      setPayee("");
      setReferenceNumber("");
      setSlip(null);
      setSlipHash("");
      setStatus({ ok: true, text: res.message ?? "บันทึกค่าใช้จ่ายแล้ว" });
      router.refresh();
    } catch (err: unknown) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : "บันทึกค่าใช้จ่ายไม่สำเร็จ" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="action-form" onSubmit={handleSubmit}>
      <div className="wide" style={{ gridColumn: "1 / -1", marginBottom: "4px" }}>
        {slip ? (
          <div className="slip-chosen">
            <ImagePlus size={18} />
            <span>
              <strong>{slip.name}</strong>
              <small>
                {(slip.size / 1024).toFixed(0)} KB · {analyzing ? "กำลังอ่านยอดจากสลิป…" : "อ่านข้อมูลและพร้อมแนบเมื่อกดบันทึก"}
              </small>
            </span>
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                setSlip(null);
                setSlipHash("");
                setReferenceNumber("");
              }}
              aria-label="เอาสลิปออก"
            >
              <X size={18} />
            </button>
          </div>
        ) : (
          <label className="slip-drop" style={{ marginTop: 0 }}>
            <input
              id="expense-slip"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleChooseSlip}
            />
            {analyzing ? <Loader2 className="spin-icon" /> : <ImagePlus />}
            <strong>แนบสลิปค่าใช้จ่ายเพื่อดึงยอดเงินและวันที่อัตโนมัติ (ไม่บังคับ)</strong>
            <span>รองรับ JPG, PNG หรือ WebP — ระบบบีบอัดรูปจิ๋วและอ่านยอดเงิน/ผู้รับให้ทันที</span>
          </label>
        )}
      </div>

      <label>
        รายละเอียด
        <input
          name="description"
          maxLength={200}
          required
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="เช่น เติมน้ำมันมอเตอร์ไซค์"
        />
      </label>
      <label>
        จำนวนเงิน (บาท)
        <input
          name="amount"
          inputMode="decimal"
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="เช่น 100"
        />
      </label>
      <label>
        หมวดหมู่
        <input
          name="category"
          list="expense-categories"
          maxLength={60}
          required
          value={category}
          onChange={(e) => {
            const nextCat = e.target.value;
            setCategory(nextCat);
            if (!description.trim() && categories.includes(nextCat)) {
              setDescription(nextCat);
            }
          }}
          placeholder={`เช่น ${FUEL_CATEGORY}`}
        />
        <div className="tip-chips" style={{ marginTop: "6px" }}>
          {[FUEL_CATEGORY, "ค่าแก๊ส", "ค่าไฟ", "ค่าน้ำ", "บรรจุภัณฑ์"].map((cat) => (
            <button
              key={cat}
              type="button"
              className={`chip-btn ${category === cat ? "round-up" : ""}`}
              onClick={() => {
                setCategory(cat);
                if (!description.trim()) setDescription(cat);
              }}
            >
              {cat}
            </button>
          ))}
        </div>
      </label>
      <label>
        ประเภท
        <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as ExpenseKind)}>
          <option value="operating">ดำเนินงาน เช่น ค่าน้ำมัน แก๊ส (หักจากกำไร)</option>
          <option value="recurring">ประจำ เช่น ค่าเช่า (หักจากกำไร)</option>
          <option value="one_time">ครั้งเดียว เช่น ซื้ออุปกรณ์ (หักจากกำไร)</option>
          <option value="direct">ต้นทุนโดยตรง (อยู่ในต้นทุนเมนูแล้ว ไม่หักซ้ำ)</option>
        </select>
      </label>
      <label>
        วันที่จ่าย
        <input
          type="date"
          name="spent_at"
          value={spentAt}
          max={maxDate}
          onChange={(e) => setSpentAt(e.target.value)}
        />
      </label>
      <label>
        วิธีชำระ
        <select
          name="payment_method"
          value={paymentMethod}
          onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
        >
          <option value="transfer">เงินโอน</option>
          <option value="cash">เงินสด</option>
          <option value="other">อื่น ๆ</option>
        </select>
      </label>
      <label>
        ผู้รับเงิน (ไม่บังคับ)
        <input
          name="payee"
          maxLength={120}
          value={payee}
          onChange={(e) => setPayee(e.target.value)}
          placeholder="เช่น ปั๊ม ปตท."
        />
      </label>
      <p className="field-hint wide">
        ค่าไฟ / ค่าแก๊ส ลงที่นี่ตอนบิลมา (หมวด “ค่าไฟ” “ค่าแก๊ส”) · ซื้อไก่ ข้าว ผัก เครื่องปรุง กล่อง ช้อน ถุง ให้บันทึกที่หน้า{" "}
        <Link href="/ingredients" className="text-link">
          วัตถุดิบและบรรจุภัณฑ์
        </Link>{" "}
        แทน ระบบคิดต้นทุนหรือลงค่าใช้จ่ายให้เอง ไม่ต้องลงซ้ำ
      </p>
      <div className="form-Status">
        <button type="submit" className="primary-button" disabled={saving || analyzing}>
          {saving ? "กำลังบันทึก…" : "บันทึกค่าใช้จ่าย"}
        </button>
        {status && (
          <span className={status.ok ? "form-ok" : "form-error"} role="status">
            {status.text}
          </span>
        )}
      </div>
    </form>
  );
}
