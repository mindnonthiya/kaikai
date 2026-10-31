"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ImagePlus, Loader2, ReceiptText, ShoppingBasket, X } from "lucide-react";
import { saveExpense } from "@/app/actions/expenses";
import { saveItemizedExpenseAction } from "@/app/actions/ingredients";
import type { PerUnitPurchaseItem, PooledPurchaseItem } from "@/components/ingredient-purchase-table";
import type { RestockItem } from "@/components/packaging-restock-table";
import {
  SlipItemizedPicker,
  computeItemizedSummary,
  createInitialItemizedState,
  type ItemizedSelectionState,
} from "@/components/slip-itemized-picker";
import { FUEL_CATEGORY, type ExpenseKind, type PaymentMethod } from "@/lib/data/types";
import { hasSupabaseEnv } from "@/lib/env";
import { compressSlipImage } from "@/lib/image-compression";
import { formatBaht, satangToBahtInput, tryBahtToSatang } from "@/lib/money";
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
  suggestItemized?: boolean;
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
  if (/แม็คโคร|makro|cp axtra|ซีพี แอ็กซ์ตร้า|โลตัส|lotus|บิ๊กซี|big c|ตลาด|ของสด|ผัก|ไก่/i.test(text)) {
    return {
      category: "บรรจุภัณฑ์",
      description: `ซื้อของ (${text})`,
      kind: "operating",
      suggestItemized: true,
    };
  }
  return {};
}

export function ExpenseFormWithSlip({
  today,
  maxDate,
  categories,
  perUnit = [],
  pooled = [],
  restockItems = [],
}: {
  today: string;
  maxDate: string;
  categories: string[];
  perUnit?: PerUnitPurchaseItem[];
  pooled?: PooledPurchaseItem[];
  restockItems?: RestockItem[];
}) {
  const router = useRouter();
  const [entryMode, setEntryMode] = useState<"single" | "itemized">("single");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [kind, setKind] = useState<ExpenseKind>("operating");
  const [spentAt, setSpentAt] = useState(today);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("transfer");
  const [payee, setPayee] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");

  const [itemizedState, setItemizedState] = useState<ItemizedSelectionState>(() =>
    createInitialItemizedState(perUnit, restockItems)
  );

  const [slip, setSlip] = useState<File | null>(null);
  const [slipPreviewUrl, setSlipPreviewUrl] = useState<string | null>(null);
  const [slipHash, setSlipHash] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const slipAmountSatang = tryBahtToSatang(amount) ?? 0;
  const itemizedSummary = computeItemizedSummary(itemizedState, perUnit, pooled, restockItems);

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
      setSlipPreviewUrl(compressed.previewUrl);
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
          if (guessed.suggestItemized) {
            setEntryMode("itemized");
          }
        }

        if (!json.isDuplicate) {
          setStatus({
            ok: true,
            text: ocr.amountSatang
              ? `อ่านสลิปสำเร็จ: ยอด ${formatBaht(ocr.amountSatang)}${detectedPayee ? ` · ผู้รับ "${detectedPayee}"` : ""} — เลือกบันทึกเป็นรายการเดี่ยว หรือกด "แยกซื้อวัตถุดิบ/บรรจุภัณฑ์" เพื่อแยกพริก กระเทียม ไก่ ในสลิปนี้ได้เลย`
              : `แนบสลิปเรียบร้อย (${(compressed.compressedBytes / 1024).toFixed(0)} KB)`,
          });
        }
      } else if (!json.isDuplicate) {
        setStatus({
          ok: true,
          text: `แนบสลิปเรียบร้อย (${(compressed.compressedBytes / 1024).toFixed(0)} KB) — กรอกยอดเงินและเลือกรายการด้านล่าง`,
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
    if (entryMode === "itemized" && itemizedSummary.itemCount === 0) {
      setStatus({ ok: false, text: "กรุณากรอกรายการวัตถุดิบ บรรจุภัณฑ์ หรือค่าใช้จ่ายอย่างน้อย 1 รายการ" });
      return;
    }

    setSaving(true);
    setStatus(null);
    let uploadedPath: string | null = null;

    try {
      const supabase = createClient();
      if (slip && hasSupabaseEnv) {
        const {
          data: { user },
        } = await supabase.auth.getUser();
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

      if (entryMode === "itemized") {
        const res = await saveItemizedExpenseAction({
          spentAt,
          vendor: payee.trim() || null,
          paymentMethod,
          receiptPath: uploadedPath,
          notes: referenceNumber ? `Ref: ${referenceNumber}` : null,
          perUnitItems: itemizedSummary.perUnitItems,
          pooledItems: itemizedSummary.pooledItems,
          packagingItems: itemizedSummary.packagingItems,
          extraExpenses: itemizedSummary.extraExpenses,
        });

        if (res.error) {
          if (uploadedPath) {
            await supabase.storage.from("sale-slips").remove([uploadedPath]).catch(() => undefined);
          }
          setStatus({ ok: false, text: res.error });
          return;
        }

        setItemizedState(createInitialItemizedState(perUnit, restockItems));
        setAmount("");
        setSpentAt(today);
        setPaymentMethod("transfer");
        setPayee("");
        setReferenceNumber("");
        setSlip(null);
        setSlipPreviewUrl(null);
        setSlipHash("");
        setStatus({ ok: true, text: res.message ?? "บันทึกรายการซื้อและค่าใช้จ่ายเรียบร้อยแล้ว" });
        router.refresh();
        return;
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
        if (uploadedPath) {
          await supabase.storage.from("sale-slips").remove([uploadedPath]).catch(() => undefined);
        }
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
      setSlipPreviewUrl(null);
      setSlipHash("");
      setStatus({ ok: true, text: res.message ?? "บันทึกค่าใช้จ่ายแล้ว" });
      router.refresh();
    } catch (err: unknown) {
      setStatus({
        ok: false,
        text: err instanceof Error ? err.message : "บันทึกค่าใช้จ่ายไม่สำเร็จ",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={handleSubmit}>
      {/* SLIP UPLOAD ZONE */}
      <div className="wide" style={{ gridColumn: "1 / -1", marginBottom: "2px" }}>
        {slip ? (
          <div className="slip-chosen">
            {slipPreviewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={slipPreviewUrl}
                alt="ตัวอย่างสลิป"
                style={{
                  width: "48px",
                  height: "62px",
                  objectFit: "cover",
                  borderRadius: "8px",
                  border: "1px solid rgba(0,0,0,0.1)",
                  flexShrink: 0,
                }}
              />
            ) : (
              <ImagePlus size={18} />
            )}
            <span>
              <strong>{slip.name}</strong>
              <small>
                {(slip.size / 1024).toFixed(0)} KB ·{" "}
                {analyzing
                  ? "กำลังอ่านยอดจากสลิป…"
                  : slipAmountSatang > 0
                  ? `ยอดสลิป ${formatBaht(slipAmountSatang)} · พร้อมแนบเมื่อกดบันทึก`
                  : "พร้อมแนบเมื่อกดบันทึก"}
              </small>
            </span>
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                setSlip(null);
                setSlipPreviewUrl(null);
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
            <span>
              รองรับ JPG, PNG หรือ WebP — แนบสลิปใบเดียวแล้วเลือกแยกพริก กระเทียม ไก่ กล่อง หรือค่าใช้จ่ายทั่วไปได้ทันที
            </span>
          </label>
        )}
      </div>

      {/* MODE SWITCHER: SINGLE EXPENSE VS ITEMIZED INGREDIENTS/PACKAGING */}
      <div className="wide" style={{ gridColumn: "1 / -1" }}>
        <div className="expense-entry-mode-switch" role="tablist" aria-label="เลือกรูปแบบการบันทึกค่าใช้จ่าย">
          <button
            type="button"
            role="tab"
            aria-selected={entryMode === "single"}
            className={`expense-mode-btn ${entryMode === "single" ? "active" : ""}`}
            onClick={() => setEntryMode("single")}
          >
            <ReceiptText size={16} />
            <div>
              <strong>ค่าใช้จ่ายทั่วไป (บิลเดี่ยว)</strong>
              <small>เช่น ค่าน้ำมัน, ค่าแก๊ส, ค่าไฟ, ค่าน้ำ, ค่าเช่า</small>
            </div>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={entryMode === "itemized"}
            className={`expense-mode-btn ${entryMode === "itemized" ? "active" : ""}`}
            onClick={() => setEntryMode("itemized")}
          >
            <ShoppingBasket size={16} />
            <div>
              <strong>แยกซื้อวัตถุดิบ / บรรจุภัณฑ์ในสลิปนี้</strong>
              <small>เลือกแยก พริกกี่บาท กระเทียมกี่บาท ไก่กี่กิโล กล่องกี่แพ็ก</small>
            </div>
            {itemizedSummary.itemCount > 0 && (
              <span className="mode-count-pill">{itemizedSummary.itemCount} รายการ</span>
            )}
          </button>
        </div>
      </div>

      {/* COMMON FIELDS FOR BOTH MODES: DATE, PAYMENT METHOD, PAYEE/VENDOR */}
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
        {entryMode === "itemized" ? "ร้านค้า / ผู้รับโอน (ไม่บังคับ)" : "ผู้รับเงิน (ไม่บังคับ)"}
        <input
          name="payee"
          maxLength={120}
          value={payee}
          onChange={(e) => setPayee(e.target.value)}
          placeholder={entryMode === "itemized" ? "เช่น ตลาดสด / แม็คโคร" : "เช่น ปั๊ม ปตท."}
        />
      </label>

      <label>
        {entryMode === "itemized" ? "ยอดรวมตามสลิป (บาท · ใช้เทียบยอด)" : "จำนวนเงิน (บาท)"}
        <input
          name="amount"
          inputMode="decimal"
          required={entryMode === "single"}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={entryMode === "itemized" ? "อ่านจากสลิปอัตโนมัติ หรือเว้นว่างได้" : "เช่น 100"}
        />
      </label>

      {/* MODE 1: SINGLE EXPENSE FIELDS */}
      {entryMode === "single" ? (
        <>
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
                    if (!description.trim() || categories.includes(description.trim())) {
                      setDescription(cat);
                    }
                  }}
                >
                  {cat}
                </button>
              ))}
            </div>
          </label>
          <label className="wide" style={{ gridColumn: "1 / -1" }}>
            ประเภทการคิดกำไร
            <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as ExpenseKind)}>
              <option value="operating">ดำเนินงาน เช่น ค่าน้ำมัน แก๊ส (หักจากกำไร)</option>
              <option value="recurring">ประจำ เช่น ค่าเช่า (หักจากกำไร)</option>
              <option value="one_time">ครั้งเดียว เช่น ซื้ออุปกรณ์ (หักจากกำไร)</option>
              <option value="direct">ต้นทุนโดยตรง (อยู่ในต้นทุนเมนูแล้ว ไม่หักซ้ำ)</option>
            </select>
          </label>
        </>
      ) : (
        /* MODE 2: ITEMIZED INGREDIENTS + PACKAGING + EXTRA EXPENSES */
        <div className="wide" style={{ gridColumn: "1 / -1" }}>
          <SlipItemizedPicker
            perUnit={perUnit}
            pooled={pooled}
            restockItems={restockItems}
            categories={categories}
            slipAmountSatang={slipAmountSatang}
            value={itemizedState}
            onChange={setItemizedState}
          />
        </div>
      )}

      <p className="field-hint wide">
        {entryMode === "itemized"
          ? "ทุกรายการที่กรอกจะถูกบันทึกตามวันที่จ่ายด้านบน · อัปเดตต้นทุนไก่/บรรจุภัณฑ์และ % วัตถุดิบรวมให้อัตโนมัติ พร้อมผูกสลิปใบเดียวกันในหน้าค่าใช้จ่ายและหน้าเทียบยอดธนาคาร"
          : "หากเป็นสลิปซื้อของสด (ไก่ พริก กระเทียม ข้าว) หรือบรรจุภัณฑ์ (กล่อง ช้อน ถุง) กดสลับไปที่ปุ่ม “แยกซื้อวัตถุดิบ / บรรจุภัณฑ์ในสลิปนี้” ด้านบนเพื่อแจกแจงรายตัวได้เลย"}
      </p>

      <div className="form-footer">
        {status && (
          <p className={status.ok ? "form-success" : "form-error"} role="status">
            {status.text}
          </p>
        )}
        <button type="submit" className="primary-button" disabled={saving || analyzing}>
          {saving
            ? "กำลังบันทึก…"
            : entryMode === "itemized"
            ? itemizedSummary.itemCount > 0
              ? `บันทึก ${itemizedSummary.itemCount} รายการ (${formatBaht(itemizedSummary.totalSatang)})`
              : "บันทึกรายการที่เลือก"
            : "บันทึกค่าใช้จ่าย"}
        </button>
      </div>
    </form>
  );
}
