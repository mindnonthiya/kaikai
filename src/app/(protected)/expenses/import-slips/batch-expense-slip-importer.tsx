"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Eye,
  Loader2,
  Plus,
  ReceiptText,
  RotateCw,
  ShoppingBasket,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { revalidateExpensesAction } from "@/app/actions/expenses";
import { saveItemizedExpenseAction } from "@/app/actions/ingredients";
import { guessExpenseFromPayee } from "@/components/expense-form-with-slip";
import type { PerUnitPurchaseItem, PooledPurchaseItem } from "@/components/ingredient-purchase-table";
import type { RestockItem } from "@/components/packaging-restock-table";
import {
  SlipItemizedPicker,
  computeItemizedSummary,
  createInitialItemizedState,
  type ItemizedSelectionState,
} from "@/components/slip-itemized-picker";
import { EXPENSE_KIND_LABELS, FUEL_CATEGORY, type ExpenseKind } from "@/lib/data/types";
import { compressSlipImage } from "@/lib/image-compression";
import { formatBaht, tryBahtToSatang } from "@/lib/money";
import { checkIntraBatchDuplicate } from "@/lib/slip-duplicate";
import { createClient } from "@/lib/supabase/client";
import { bangkokDayKey, fromBangkokDateInput } from "@/lib/time";

const SLIP_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export type BatchExpenseSlipRow = {
  id: string;
  sourceFile: File;
  compressedFile?: File;
  previewUrl: string;
  hash: string;
  originalBytes: number;
  compressedBytes: number;

  status: "processing" | "ready" | "duplicate" | "error";
  statusText?: string;

  bank?: string;
  referenceNumber?: string;

  mode: "single" | "itemized";
  itemized: ItemizedSelectionState;

  amountSatang: number;
  spentAtDate: string; // YYYY-MM-DD
  category: string;
  description: string;
  payee: string;
  kind: ExpenseKind;

  isDuplicate: boolean;
  duplicateReason?: string;
  selected: boolean;
};

export function BatchExpenseSlipImporter({
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
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<BatchExpenseSlipRow[]>([]);
  const [analyzingRemaining, setAnalyzingRemaining] = useState(0);
  const [totalAnalyzing, setTotalAnalyzing] = useState(0);
  const [hasOcrProvider, setHasOcrProvider] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ current: number; total: number } | null>(null);
  const [saveResult, setSaveResult] = useState<{
    ok: boolean;
    savedCount: number;
    totalAmount: number;
    errorText?: string;
  } | null>(null);
  const [previewingImageUrl, setPreviewingImageUrl] = useState<string | null>(null);

  function updateRow(rowId: string, patch: Partial<BatchExpenseSlipRow>) {
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
  }

  function isRowReady(row: BatchExpenseSlipRow): boolean {
    if (row.status === "processing") return false;
    if (row.mode === "itemized") {
      const summary = computeItemizedSummary(row.itemized, perUnit, pooled, restockItems);
      return summary.itemCount > 0 && summary.totalSatang > 0;
    }
    return (
      row.amountSatang > 0 &&
      row.category.trim().length > 0 &&
      row.description.trim().length > 0
    );
  }

  function getRowEffectiveAmountSatang(row: BatchExpenseSlipRow): number {
    if (row.mode === "itemized") {
      const summary = computeItemizedSummary(row.itemized, perUnit, pooled, restockItems);
      return summary.totalSatang > 0 ? summary.totalSatang : row.amountSatang;
    }
    return row.amountSatang;
  }

  async function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileList = Array.from(files);
    setTotalAnalyzing(fileList.length);
    setAnalyzingRemaining(fileList.length);
    setSaveResult(null);

    if (fileInputRef.current) fileInputRef.current.value = "";

    const newItems: Array<{ id: string; file: File }> = [];
    const initialRows: BatchExpenseSlipRow[] = [];

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const rowId = crypto.randomUUID();
      const tempPreview = URL.createObjectURL(file);

      newItems.push({ id: rowId, file });
      initialRows.push({
        id: rowId,
        sourceFile: file,
        previewUrl: tempPreview,
        hash: "",
        originalBytes: file.size,
        compressedBytes: 0,
        status: "processing",
        statusText: i < 3 ? "กำลังวิเคราะห์…" : "รอคิววิเคราะห์…",
        mode: "single",
        itemized: createInitialItemizedState(perUnit, restockItems),
        amountSatang: 0,
        spentAtDate: today,
        category: FUEL_CATEGORY,
        description: FUEL_CATEGORY,
        payee: "",
        kind: "operating",
        isDuplicate: false,
        selected: true,
      });
    }

    setRows((prev) => [...initialRows, ...prev]);

    const CONCURRENCY = 3;
    let nextIndex = 0;

    async function queueWorker() {
      while (nextIndex < newItems.length) {
        const item = newItems[nextIndex++];
        if (!item) break;
        await processSlipRowWithRetry(item.id, item.file);
      }
    }

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, newItems.length) },
      () => queueWorker()
    );
    await Promise.all(workers);
  }

  async function handleRetryRow(rowId: string) {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;
    setTotalAnalyzing((prev) => prev + 1);
    setAnalyzingRemaining((prev) => prev + 1);
    updateRow(rowId, { status: "processing", statusText: "กำลังลองอ่านใหม่…" });
    await processSlipRowWithRetry(rowId, row.sourceFile);
  }

  async function processSlipRowWithRetry(rowId: string, file: File, maxRetries = 2) {
    let attempt = 0;
    let success = false;

    while (attempt <= maxRetries && !success) {
      if (attempt > 0) {
        updateRow(rowId, {
          status: "processing",
          statusText: `รอจังหวะส่งใหม่ (ครั้งที่ ${attempt})…`,
        });
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }

      updateRow(rowId, {
        status: "processing",
        statusText: "กำลังบีบอัดและอ่านข้อมูล…",
      });

      success = await processSlipRow(rowId, file);
      if (success) break;
      attempt++;
    }

    if (!success) {
      updateRow(rowId, {
        status: "error",
        statusText: "อ่านไม่สำเร็จ (กรอกตัวเลขเองได้)",
        selected: false,
      });
    }

    setAnalyzingRemaining((prev) => Math.max(0, prev - 1));
  }

  async function processSlipRow(rowId: string, file: File): Promise<boolean> {
    try {
      const compressed = await compressSlipImage(file, { maxWidth: 720, quality: 0.65 });

      const formData = new FormData();
      formData.append("file", compressed.file);
      formData.append("hash", compressed.hash);
      formData.append("context", "expense");

      const res = await fetch("/api/slip/analyze", {
        method: "POST",
        body: formData,
      });

      const json = await res.json();

      if (typeof json.hasProvider === "boolean") {
        setHasOcrProvider(json.hasProvider);
      }

      if (res.status === 429 || json.isRateLimit) {
        return false;
      }

      let amountSatang = 0;
      let spentAtDate = today;
      const isDuplicate = Boolean(json.isDuplicate);
      const duplicateReason: string | undefined = json.duplicateReason;
      let bank: string | undefined;
      let ref: string | undefined;
      let receiverName = "";

      if (json.ok && json.result) {
        amountSatang = json.result.amountSatang ?? 0;
        if (json.result.transferredAt) {
          const dKey = bangkokDayKey(json.result.transferredAt);
          if (dKey <= maxDate) spentAtDate = dKey;
        }
        bank = json.result.bank;
        ref = json.result.referenceNumber;
        receiverName = (json.result.receiverName || "").trim();
      }

      const guessed = guessExpenseFromPayee(receiverName);
      const category = guessed.category || FUEL_CATEGORY;
      const description =
        guessed.description ||
        (receiverName ? `${category} (${receiverName})` : category);
      const kind = guessed.kind || "operating";
      const mode = guessed.suggestItemized ? "itemized" : "single";

      setRows((prev) =>
        prev.map((row) => {
          if (row.id !== rowId) return row;

          let finalIsDuplicate = isDuplicate;
          let finalDuplicateReason = duplicateReason;
          if (!finalIsDuplicate) {
            const intraCheck = checkIntraBatchDuplicate(
              { id: rowId, hash: compressed.hash, referenceNumber: ref },
              prev.filter((r) => r.id !== rowId && r.status !== "processing")
            );
            if (intraCheck.isDuplicate) {
              finalIsDuplicate = true;
              finalDuplicateReason = intraCheck.reason;
            }
          }

          return {
            ...row,
            compressedFile: compressed.file,
            previewUrl: compressed.previewUrl,
            hash: compressed.hash,
            compressedBytes: compressed.compressedBytes,
            status: finalIsDuplicate ? "duplicate" : "ready",
            statusText: finalIsDuplicate
              ? finalDuplicateReason || "สลิปซ้ำ"
              : amountSatang > 0
              ? `อ่านยอด ${formatBaht(amountSatang)}`
              : "กรุณาระบุยอดเงิน",
            mode,
            amountSatang,
            spentAtDate,
            category,
            description,
            payee: receiverName,
            kind,
            bank,
            referenceNumber: ref,
            isDuplicate: finalIsDuplicate,
            duplicateReason: finalDuplicateReason,
            selected: !finalIsDuplicate && (amountSatang > 0 || mode === "itemized"),
          };
        })
      );

      return true;
    } catch (err) {
      console.error("Error processing expense slip row:", err);
      return false;
    }
  }

  function handleAmountChange(rowId: string, rawBaht: string) {
    const satang = tryBahtToSatang(rawBaht) ?? 0;
    setRows((prev) =>
      prev.map((r) =>
        r.id === rowId
          ? {
              ...r,
              amountSatang: satang,
              status: r.isDuplicate ? "duplicate" : "ready",
              selected: !r.isDuplicate && (satang > 0 || r.mode === "itemized"),
            }
          : r
      )
    );
  }

  function applyBulkCategory(cat: string) {
    setRows((prev) =>
      prev.map((r) => {
        if (!r.selected) return r;
        const nextDesc =
          !r.description.trim() || categories.includes(r.description.trim())
            ? r.payee
              ? `${cat} (${r.payee})`
              : cat
            : r.description;
        return { ...r, mode: "single", category: cat, description: nextDesc };
      })
    );
  }

  function removeRow(rowId: string) {
    setRows((prev) => prev.filter((r) => r.id !== rowId));
  }

  function toggleAll(checked: boolean) {
    setRows((prev) =>
      prev.map((r) => (r.status === "processing" ? r : { ...r, selected: checked }))
    );
  }

  const selectedRows = rows.filter((r) => r.selected);
  const readyRows = selectedRows.filter(isRowReady);
  const totalSelectedAmountSatang = readyRows.reduce(
    (sum, r) => sum + getRowEffectiveAmountSatang(r),
    0
  );

  async function handleSaveAll() {
    if (readyRows.length === 0 || saving) return;
    setSaving(true);
    setSaveResult(null);
    setSaveProgress({ current: 0, total: readyRows.length });

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setSaving(false);
      setSaveProgress(null);
      setSaveResult({
        ok: false,
        savedCount: 0,
        totalAmount: 0,
        errorText: "หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่",
      });
      return;
    }

    let successCount = 0;
    let totalSavedSatang = 0;
    const errors: string[] = [];

    for (let i = 0; i < readyRows.length; i++) {
      const row = readyRows[i];
      setSaveProgress({ current: i + 1, total: readyRows.length });

      let uploadedPath: string | null = null;
      try {
        const fileToUpload = row.compressedFile ?? row.sourceFile;
        const ext = SLIP_TYPES[fileToUpload.type] || "webp";
        const hashPart = row.hash ? row.hash.slice(0, 16) : Date.now().toString(36);
        uploadedPath = `${user.id}/expenses/${hashPart}_${crypto.randomUUID()}.${ext}`;

        const { error: uploadError } = await supabase.storage
          .from("sale-slips")
          .upload(uploadedPath, fileToUpload, {
            contentType: fileToUpload.type || "image/webp",
            upsert: false,
          });

        if (uploadError) {
          uploadedPath = null;
          throw new Error(`อัปโหลดรูปไม่สำเร็จ (${uploadError.message})`);
        }

        if (row.mode === "itemized") {
          const summary = computeItemizedSummary(row.itemized, perUnit, pooled, restockItems);
          const res = await saveItemizedExpenseAction({
            spentAt: row.spentAtDate || today,
            vendor: row.payee.trim() || null,
            paymentMethod: "transfer",
            receiptPath: uploadedPath,
            notes: row.referenceNumber ? `Ref: ${row.referenceNumber}` : null,
            perUnitItems: summary.perUnitItems,
            pooledItems: summary.pooledItems,
            packagingItems: summary.packagingItems,
            extraExpenses: summary.extraExpenses,
          });

          if (res.error) {
            if (uploadedPath) {
              await supabase.storage.from("sale-slips").remove([uploadedPath]).catch(() => undefined);
            }
            throw new Error(res.error);
          }

          successCount++;
          totalSavedSatang += summary.totalSatang;
          setRows((prev) => prev.filter((r) => r.id !== row.id));
          continue;
        }

        let spentAtIso: string;
        try {
          spentAtIso = fromBangkokDateInput(row.spentAtDate || today).toISOString();
        } catch {
          spentAtIso = fromBangkokDateInput(today).toISOString();
        }

        const { error: insertError } = await supabase.from("expenses").insert({
          owner_id: user.id,
          spent_at: spentAtIso,
          category: row.category.trim(),
          kind: row.kind,
          amount_satang: row.amountSatang,
          description: row.description.trim(),
          payee: row.payee.trim() || null,
          payment_method: "transfer",
          receipt_path: uploadedPath,
          notes: row.referenceNumber ? `Ref: ${row.referenceNumber}` : null,
        });

        if (insertError) {
          if (uploadedPath) {
            await supabase.storage.from("sale-slips").remove([uploadedPath]).catch(() => undefined);
          }
          throw new Error(insertError.message);
        }

        successCount++;
        totalSavedSatang += row.amountSatang;
        setRows((prev) => prev.filter((r) => r.id !== row.id));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "บันทึกไม่สำเร็จ";
        errors.push(`สลิปยอด ${formatBaht(getRowEffectiveAmountSatang(row))}: ${msg}`);
      }
    }

    await revalidateExpensesAction().catch(() => undefined);
    setSaving(false);
    setSaveProgress(null);
    setSaveResult({
      ok: errors.length === 0,
      savedCount: successCount,
      totalAmount: totalSavedSatang,
      errorText: errors.length > 0 ? errors.join(" · ") : undefined,
    });

    if (successCount > 0) {
      router.refresh();
    }
  }

  return (
    <div className="batch-slip-importer">
      <datalist id="batch-expense-categories">
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      {/* Mode Switcher */}
      <div className="sales-mode-bar">
        <div className="sales-mode-tabs">
          <Link href="/expenses" className="sales-mode-tab">
            รายการและบันทึกเดี่ยว
          </Link>
          <span className="sales-mode-tab active">
            นำเข้าสลิปค่าใช้จ่ายเป็นชุด
          </span>
        </div>
      </div>

      {/* Dropzone */}
      <div className="batch-dropzone-panel">
        <input
          id={fileInputId}
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="batch-file-input"
          onChange={handleFilesSelected}
        />
        <label htmlFor={fileInputId} className="batch-dropzone-label">
          <div className="batch-dropzone-icon">
            <UploadCloud size={36} />
          </div>
          <div className="batch-dropzone-text">
            <strong>แตะเลือกรูปสลิปค่าใช้จ่ายหลายๆ ใบพร้อมกัน</strong>
            <span>รองรับ JPG, PNG, WebP — อ่านยอดเงิน วันที่ และกดแยกพริก กระเทียม ไก่ หรือกล่องในสลิปได้เลย</span>
          </div>
          <div className="batch-dropzone-btn">
            <Plus size={16} /> เลือกรูปสลิปค่าใช้จ่าย
          </div>
        </label>
      </div>

      {hasOcrProvider === false && (
        <div className="batch-ocr-missing-notice" style={{ marginTop: "16px" }}>
          <div>
            <strong>ระบบยังไม่ได้เปิดใช้งานอ่านสลิปอัตโนมัติ (OCR_API_KEY)</strong>
            <span>สามารถกรอกยอดเงินและเลือกรายการในแต่ละสลิปแล้วกดบันทึกพร้อมกันได้ทันที</span>
          </div>
        </div>
      )}

      {analyzingRemaining > 0 && (
        <div className="batch-analyzing-banner">
          <Loader2 size={18} className="spin-icon" />
          <span>
            กำลังอ่านสลิปค่าใช้จ่าย (เสร็จแล้ว {totalAnalyzing - analyzingRemaining} จาก {totalAnalyzing} รูป)…
          </span>
        </div>
      )}

      {saveResult && (
        <div className={saveResult.ok ? "success-toast" : "error-toast"} style={{ marginBottom: "16px" }}>
          {saveResult.ok ? (
            <>
              บันทึกสลิปสำเร็จแล้ว <strong>{saveResult.savedCount} สลิป</strong> (รวม{" "}
              {formatBaht(saveResult.totalAmount)}) ·{" "}
              <Link href="/expenses" className="text-link" style={{ textDecoration: "underline" }}>
                ดูรายการค่าใช้จ่าย
              </Link>
            </>
          ) : (
            <>
              บันทึกสำเร็จ {saveResult.savedCount} สลิป — ติดปัญหาบางรายการ: {saveResult.errorText}
            </>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="batch-table-container">
          <div className="batch-table-header" style={{ flexWrap: "wrap", gap: "10px" }}>
            <div className="batch-select-all">
              <label className="checkbox-wrap">
                <input
                  type="checkbox"
                  checked={selectedRows.length === rows.length && rows.length > 0}
                  onChange={(e) => toggleAll(e.target.checked)}
                />
                <span>เลือกทั้งหมด ({rows.length} สลิป)</span>
              </label>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
              <small className="muted">ตั้งหมวดหมู่ให้ที่เลือก:</small>
              {[FUEL_CATEGORY, "ค่าแก๊ส", "ค่าไฟ", "ค่าน้ำ", "บรรจุภัณฑ์", "อุปกรณ์", "อื่น ๆ"].map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className="chip-btn"
                  onClick={() => applyBulkCategory(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
            <div className="batch-header-stats">
              พร้อมบันทึก: <strong>{readyRows.length}</strong> จาก {rows.length}
            </div>
          </div>

          <div className="batch-rows-list">
            {rows.map((row) => {
              const isReady = isRowReady(row);
              const itemizedSummary = computeItemizedSummary(
                row.itemized,
                perUnit,
                pooled,
                restockItems
              );

              return (
                <div
                  key={row.id}
                  className={`batch-slip-row ${row.isDuplicate ? "is-duplicate" : ""} ${
                    row.selected ? "is-selected" : ""
                  }`}
                >
                  <div className="col-select">
                    <input
                      type="checkbox"
                      checked={row.selected}
                      disabled={row.status === "processing"}
                      onChange={(e) => updateRow(row.id, { selected: e.target.checked })}
                    />
                  </div>

                  <div className="col-thumb" onClick={() => setPreviewingImageUrl(row.previewUrl)}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={row.previewUrl} alt="Slip" className="slip-thumb-img" />
                    <span className="thumb-zoom-icon">
                      <Eye size={12} />
                    </span>
                    {row.compressedBytes > 0 && (
                      <span className="thumb-size-badge">{(row.compressedBytes / 1024).toFixed(0)} KB</span>
                    )}
                  </div>

                  <div className="col-info">
                    <div className="slip-amount-row">
                      <div className="slip-amount-box">
                        <label>ยอดในสลิป:</label>
                        <div className="amount-input-badge">
                          <span>฿</span>
                          <input
                            type="number"
                            step="0.01"
                            placeholder="0.00"
                            value={row.amountSatang > 0 ? (row.amountSatang / 100).toString() : ""}
                            onChange={(e) => handleAmountChange(row.id, e.target.value)}
                            className="slip-amount-editable"
                            aria-label="ยอดเงินในสลิป"
                          />
                        </div>
                      </div>

                      {row.bank && <span className="slip-bank-badge">{row.bank}</span>}
                      {row.isDuplicate && (
                        <span className="badge-duplicate" title={row.duplicateReason}>
                          {row.duplicateReason || "สลิปซ้ำ"}
                        </span>
                      )}

                      {/* Toggle between Single Category and Itemized Ingredients/Packaging */}
                      <div className="slip-row-mode-pills">
                        <button
                          type="button"
                          className={`slip-row-mode-pill ${row.mode === "single" ? "active" : ""}`}
                          onClick={() => updateRow(row.id, { mode: "single" })}
                        >
                          <ReceiptText size={13} /> รายการเดี่ยว
                        </button>
                        <button
                          type="button"
                          className={`slip-row-mode-pill ${row.mode === "itemized" ? "active" : ""}`}
                          onClick={() => updateRow(row.id, { mode: "itemized", selected: true })}
                        >
                          <ShoppingBasket size={13} /> แยกวัตถุดิบ / บรรจุภัณฑ์
                          {itemizedSummary.itemCount > 0 && (
                            <span className="pill-count">{itemizedSummary.itemCount}</span>
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Common metadata row (Date & Payee/Vendor) */}
                    <div
                      className="form-grid compact"
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                        gap: "8px",
                        marginTop: "8px",
                      }}
                    >
                      {row.mode === "single" && (
                        <>
                          <label style={{ fontSize: "12px" }}>
                            หมวดหมู่
                            <input
                              list="batch-expense-categories"
                              value={row.category}
                              onChange={(e) => {
                                const nextCat = e.target.value;
                                const shouldSyncDesc =
                                  !row.description.trim() ||
                                  categories.includes(row.description.trim());
                                updateRow(row.id, {
                                  category: nextCat,
                                  ...(shouldSyncDesc ? { description: nextCat } : {}),
                                });
                              }}
                              placeholder="เช่น ค่าน้ำมัน"
                            />
                          </label>
                          <label style={{ fontSize: "12px" }}>
                            รายละเอียด
                            <input
                              value={row.description}
                              onChange={(e) => updateRow(row.id, { description: e.target.value })}
                              placeholder="เช่น เติมน้ำมัน"
                            />
                          </label>
                        </>
                      )}
                      <label style={{ fontSize: "12px" }}>
                        {row.mode === "itemized" ? "ร้านค้า / ผู้รับโอน" : "ผู้รับเงิน"}
                        <input
                          value={row.payee}
                          onChange={(e) => updateRow(row.id, { payee: e.target.value })}
                          placeholder={row.mode === "itemized" ? "เช่น ตลาดสด / แม็คโคร" : "เช่น ปั๊ม ปตท."}
                        />
                      </label>
                      <label style={{ fontSize: "12px" }}>
                        วันที่จ่าย (ตามสลิป)
                        <input
                          type="date"
                          value={row.spentAtDate}
                          max={maxDate}
                          onChange={(e) => updateRow(row.id, { spentAtDate: e.target.value })}
                        />
                      </label>
                      {row.mode === "single" && (
                        <label style={{ fontSize: "12px" }}>
                          ประเภท
                          <select
                            value={row.kind}
                            onChange={(e) =>
                              updateRow(row.id, { kind: e.target.value as ExpenseKind })
                            }
                          >
                            {(Object.keys(EXPENSE_KIND_LABELS) as ExpenseKind[]).map((k) => (
                              <option key={k} value={k}>
                                {EXPENSE_KIND_LABELS[k]}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>

                    {/* Itemized Picker when row is in itemized mode */}
                    {row.mode === "itemized" && (
                      <div style={{ marginTop: "10px" }}>
                        <SlipItemizedPicker
                          perUnit={perUnit}
                          pooled={pooled}
                          restockItems={restockItems}
                          categories={categories}
                          slipAmountSatang={row.amountSatang}
                          value={row.itemized}
                          onChange={(nextItemized) =>
                            updateRow(row.id, { itemized: nextItemized, selected: true })
                          }
                          compact
                        />
                      </div>
                    )}

                    <div className="slip-status-line" style={{ marginTop: "6px" }}>
                      {row.status === "processing" ? (
                        <span className="status-badge processing">
                          <Loader2 size={12} className="spin-icon" /> {row.statusText || "กำลังอ่าน…"}
                        </span>
                      ) : row.status === "error" && !isReady ? (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <span className="status-badge warn">
                            <AlertCircle size={13} /> {row.statusText}
                          </span>
                          <button
                            type="button"
                            className="slip-retry-btn"
                            onClick={() => handleRetryRow(row.id)}
                          >
                            <RotateCw size={11} /> กดอ่านใหม่
                          </button>
                        </div>
                      ) : isReady ? (
                        <span className="status-badge ready">
                          <CheckCircle2 size={13} />{" "}
                          {row.mode === "itemized"
                            ? `พร้อมบันทึก (${itemizedSummary.itemCount} รายการ · รวม ${formatBaht(
                                itemizedSummary.totalSatang
                              )})`
                            : `พร้อมบันทึก (${row.category} · ${formatBaht(row.amountSatang)})`}
                        </span>
                      ) : (
                        <span className="status-badge warn">
                          <AlertCircle size={13} />{" "}
                          {row.mode === "itemized"
                            ? "กรุณากรอกจำนวนเงินของวัตถุดิบหรือบรรจุภัณฑ์อย่างน้อย 1 รายการ"
                            : "กรุณาระบุยอดเงินและรายละเอียดให้ครบ"}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="col-actions">
                    <button
                      type="button"
                      className="icon-button danger"
                      onClick={() => removeRow(row.id)}
                      aria-label="ลบสลิปนี้"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="batch-bottom-bar">
            <div className="bar-summary">
              <span>เลือกพร้อมบันทึก {readyRows.length} สลิป</span>
              <strong>ยอดรวม {formatBaht(totalSelectedAmountSatang)}</strong>
            </div>
            <div className="bar-buttons">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setRows([])}
                disabled={saving || rows.length === 0}
              >
                ล้างทั้งหมด
              </button>
              <button
                type="button"
                className="primary-button batch-save-btn"
                disabled={readyRows.length === 0 || saving}
                onClick={handleSaveAll}
              >
                {saving ? (
                  <>
                    <Loader2 size={16} className="spin-icon" /> กำลังบันทึก ({saveProgress?.current ?? 0}/
                    {saveProgress?.total ?? readyRows.length})…
                  </>
                ) : (
                  <>
                    <Check size={16} /> ยืนยันบันทึก ({readyRows.length} สลิป)
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {previewingImageUrl && (
        <div className="image-preview-modal-backdrop" onClick={() => setPreviewingImageUrl(null)}>
          <div className="image-preview-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>ดูรูปสลิปต้นฉบับ</strong>
              <button
                type="button"
                className="icon-button"
                onClick={() => setPreviewingImageUrl(null)}
                aria-label="ปิด"
              >
                <X size={18} />
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewingImageUrl} alt="Full Slip" className="full-slip-preview" />
          </div>
        </div>
      )}
    </div>
  );
}
