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
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import type { Fulfillment, MenuRecord, PricePreset } from "@/lib/data/types";
import { compressSlipImage } from "@/lib/image-compression";
import { formatBaht, tryBahtToSatang } from "@/lib/money";
import { createClient } from "@/lib/supabase/client";

export type BatchSlipRow = {
  id: string;
  sourceFile: File;
  compressedFile?: File;
  previewUrl: string;
  hash: string;
  originalBytes: number;
  compressedBytes: number;

  // Processing state
  status: "processing" | "ready" | "duplicate" | "error";
  statusText?: string;

  // OCR details
  extractedAmountSatang?: number;
  extractedTransferredAt?: string;
  bank?: string;
  referenceNumber?: string;

  // Form values for the order
  amountSatang: number;
  soldAt: string; // ISO or YYYY-MM-DDTHH:mm
  matchedPresetId: string | null;
  fulfillment: Fulfillment;
  deliveryChargedSatang: number;
  items: Array<{ menuId: string; quantity: number }>;
  customerName: string;

  // Duplicate detection
  isDuplicate: boolean;
  duplicateSaleNumber?: number;

  selected: boolean;
};

type Props = {
  menus: MenuRecord[];
  presets: PricePreset[];
  defaultDeliveryFee: number;
  pooledBps: number;
};

export function BatchSlipImporter({ menus, presets, defaultDeliveryFee, pooledBps }: Props) {
  const router = useRouter();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<BatchSlipRow[]>([]);
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

  // Modal for previewing a slip
  const [previewingImageUrl, setPreviewingImageUrl] = useState<string | null>(null);

  const menuMap = new Map(menus.map((m) => [m.id, m]));
  const presetMap = new Map(presets.map((p) => [p.id, p]));

  // Find matching preset by amount
  function matchPresetByAmount(amountSatang: number): PricePreset | null {
    if (!amountSatang) return null;
    return presets.find((p) => p.amountSatang === amountSatang) ?? null;
  }

  // Handle file selection (multiple)
  async function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileList = Array.from(files);
    setTotalAnalyzing(fileList.length);
    setAnalyzingRemaining(fileList.length);
    setSaveResult(null);

    // Reset input so user can choose same files again if needed
    if (fileInputRef.current) fileInputRef.current.value = "";

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];

      const rowId = crypto.randomUUID();
      const tempPreview = URL.createObjectURL(file);

      // Create placeholder row immediately
      const initialRow: BatchSlipRow = {
        id: rowId,
        sourceFile: file,
        previewUrl: tempPreview,
        hash: "",
        originalBytes: file.size,
        compressedBytes: 0,
        status: "processing",
        statusText: "กำลังบีบอัดและวิเคราะห์…",
        amountSatang: 0,
        soldAt: new Date().toISOString(),
        matchedPresetId: null,
        fulfillment: "delivery",
        deliveryChargedSatang: defaultDeliveryFee,
        items: [],
        customerName: "",
        isDuplicate: false,
        selected: true,
      };

      setRows((prev) => [initialRow, ...prev]);

      // Process in background
      processSlipRow(rowId, file);
    }
  }

  async function processSlipRow(rowId: string, file: File) {
    try {
      // 1. Client-side compression to WebP (~30 KB)
      const compressed = await compressSlipImage(file, { maxWidth: 720, quality: 0.65 });

      // 2. Send compressed file to /api/slip/analyze
      const formData = new FormData();
      formData.append("file", compressed.file);
      formData.append("hash", compressed.hash);

      const res = await fetch("/api/slip/analyze", {
        method: "POST",
        body: formData,
      });

      const json = await res.json();

      if (typeof json.hasProvider === "boolean") {
        setHasOcrProvider(json.hasProvider);
      }

      let amountSatang = 0;
      let soldAt = new Date().toISOString();
      let isDuplicate = false;
      let duplicateSaleNumber: number | undefined;
      let bank: string | undefined;
      let ref: string | undefined;

      if (json.ok) {
        isDuplicate = Boolean(json.isDuplicate);
        duplicateSaleNumber = json.duplicateSaleNumber ?? undefined;

        if (json.result) {
          amountSatang = json.result.amountSatang ?? 0;
          if (json.result.transferredAt) {
            soldAt = json.result.transferredAt;
          }
          bank = json.result.bank;
          ref = json.result.referenceNumber;
        }
      }

      // 3. Match with Presets
      const matched = matchPresetByAmount(amountSatang);

      setRows((prev) =>
        prev.map((row) => {
          if (row.id !== rowId) return row;

          const fulfillment = matched ? matched.fulfillment : "delivery";
          const deliveryFee = matched ? matched.deliveryChargedSatang : defaultDeliveryFee;
          const items = matched ? [...matched.items] : [];

          return {
            ...row,
            compressedFile: compressed.file,
            compressedBlob: compressed.blob,
            previewUrl: compressed.previewUrl,
            hash: compressed.hash,
            compressedBytes: compressed.compressedBytes,
            status: isDuplicate ? "duplicate" : "ready",
            statusText: isDuplicate
              ? `สลิปซ้ำ (เคยลงในบิล #${duplicateSaleNumber ?? "เดิม"})`
              : matched
              ? `ตรงสูตร: ${matched.name}`
              : amountSatang > 0
              ? "อ่านยอดเงินสำเร็จ (กรุณาเลือกเมนู)"
              : "กรุณาระบุยอดเงินและเมนู",
            extractedAmountSatang: amountSatang > 0 ? amountSatang : undefined,
            extractedTransferredAt: soldAt,
            bank,
            referenceNumber: ref,
            amountSatang,
            soldAt,
            matchedPresetId: matched?.id ?? null,
            fulfillment,
            deliveryChargedSatang: deliveryFee,
            items,
            isDuplicate,
            selected: !isDuplicate, // auto-uncheck duplicate slips
          };
        })
      );
    } catch (err: unknown) {
      console.error("Row processing error:", err);
      const msg = err instanceof Error ? err.message : "เกิดข้อผิดพลาดในการอ่านรูป";
      setRows((prev) =>
        prev.map((row) => {
          if (row.id !== rowId) return row;
          return {
            ...row,
            status: "error",
            statusText: msg,
            selected: false,
          };
        })
      );
    } finally {
      setAnalyzingRemaining((prev) => Math.max(0, prev - 1));
    }
  }

  // Handle direct amount edit (e.g. typing 84 auto-matches the preset)
  function handleAmountChange(rowId: string, newBahtStr: string) {
    const parsedSatang = tryBahtToSatang(newBahtStr);
    const amountSatang = parsedSatang ?? 0;
    const matched = matchPresetByAmount(amountSatang);

    updateRow(rowId, {
      amountSatang,
      matchedPresetId: matched?.id ?? null,
      fulfillment: matched ? matched.fulfillment : "delivery",
      deliveryChargedSatang: matched ? matched.deliveryChargedSatang : defaultDeliveryFee,
      items: matched ? [...matched.items] : [],
      status: "ready",
      statusText: matched
        ? `ตรงสูตร: ${matched.name}`
        : amountSatang > 0
        ? "กรุณาเลือกสูตรเมนู"
        : "ยังไม่มียอดเงิน",
    });
  }

  // Update row helpers
  function updateRow(rowId: string, patch: Partial<BatchSlipRow>) {
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
  }

  function handlePresetChange(rowId: string, presetId: string) {
    const preset = presetMap.get(presetId);
    if (!preset) {
      updateRow(rowId, { matchedPresetId: null });
      return;
    }

    updateRow(rowId, {
      matchedPresetId: preset.id,
      amountSatang: preset.amountSatang,
      fulfillment: preset.fulfillment,
      deliveryChargedSatang: preset.deliveryChargedSatang,
      items: [...preset.items],
      status: "ready",
      statusText: `ตรงสูตร: ${preset.name}`,
    });
  }

  function deleteRow(rowId: string) {
    setRows((prev) => prev.filter((r) => r.id !== rowId));
  }

  function toggleAll(checked: boolean) {
    setRows((prev) => prev.map((r) => (r.isDuplicate ? r : { ...r, selected: checked })));
  }

  // Calculated totals
  const selectedRows = rows.filter((r) => r.selected && r.status !== "processing");
  const totalAmountSelectedSatang = selectedRows.reduce((sum, r) => sum + (r.amountSatang || 0), 0);
  const readyToSaveCount = selectedRows.filter((r) => r.amountSatang > 0 && r.items.length > 0).length;

  // Batch Save to Supabase
  async function handleBatchSave() {
    if (readyToSaveCount === 0) return;
    setSaving(true);
    setSaveResult(null);
    setSaveProgress({ current: 0, total: readyToSaveCount });

    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      alert("กรุณาเข้าสู่ระบบใหม่");
      setSaving(false);
      return;
    }

    let successCount = 0;
    let totalSavedSatang = 0;
    const errors: string[] = [];

    const toProcess = selectedRows.filter((r) => r.amountSatang > 0 && r.items.length > 0);

    for (let i = 0; i < toProcess.length; i++) {
      const row = toProcess[i];
      setSaveProgress({ current: i + 1, total: toProcess.length });

      let uploadedPath: string | null = null;
      try {
        // 1. Upload compressed WebP slip (~30 KB)
        if (row.compressedFile) {
          uploadedPath = `${user.id}/${crypto.randomUUID()}.webp`;
          const { error: uploadError } = await supabase.storage
            .from("sale-slips")
            .upload(uploadedPath, row.compressedFile, {
              contentType: "image/webp",
              upsert: false,
            });

          if (uploadError) {
            uploadedPath = null;
            throw new Error(`อัปโหลดรูปไม่สำเร็จ: ${uploadError.message}`);
          }
        }

        const slipPayload = uploadedPath
          ? {
              storage_path: uploadedPath,
              mime_type: "image/webp",
              size_bytes: row.compressedBytes || row.sourceFile.size,
              file_hash_sha256: row.hash,
            }
          : undefined;

        // 2. Call create_sale RPC
        const { error: saleError } = await supabase.rpc("create_sale", {
          payload: {
            items: row.items.map((it) => ({
              menu_id: it.menuId,
              quantity: it.quantity,
            })),
            fulfillment: row.fulfillment,
            pooled_ingredient_bps: pooledBps,
            delivery_charged_satang: row.fulfillment === "delivery" ? row.deliveryChargedSatang : 0,
            discount_satang: 0,
            tip_satang: 0,
            payment_fee_satang: 0,
            payment_amount_satang: row.amountSatang,
            payment_method: "transfer",
            payment_status: "paid",
            customer_name: row.customerName.trim() || null,
            sold_at: row.soldAt,
            notes: row.referenceNumber ? `เลขอ้างอิง: ${row.referenceNumber}` : null,
            ...(slipPayload ? { slip: slipPayload } : {}),
          },
        });

        if (saleError) {
          if (uploadedPath) await supabase.storage.from("sale-slips").remove([uploadedPath]);
          throw new Error(saleError.message);
        }

        successCount++;
        totalSavedSatang += row.amountSatang;

        // Remove row from list on success
        setRows((prev) => prev.filter((r) => r.id !== row.id));
      } catch (err: unknown) {
        console.error(`Failed to save slip row ${row.id}:`, err);
        const msg = err instanceof Error ? err.message : "บันทึกไม่สำเร็จ";
        errors.push(`สลิปยอด ${formatBaht(row.amountSatang)}: ${msg}`);
      }
    }

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
      {/* Sub navigation between single and batch mode */}
      <div className="sales-mode-tabs">
        <Link href="/sales/new" className="sales-mode-tab">
          เปิดบิลเดี่ยว
        </Link>
        <Link href="/sales/import-slips" className="sales-mode-tab active">
          นำเข้าสลิปเป็นชุด
        </Link>
      </div>

      {/* Hero Dropzone */}
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
            <strong>แตะเลือกรูปสลิปหลายๆ รูปพร้อมกัน</strong>
            <span>รองรับ JPG, PNG, WebP — ระบบบีบอัดรูปจิ๋ว ~30 KB และอ่านยอดเงินออโต้</span>
          </div>
          <div className="batch-dropzone-btn">
            <Plus size={16} /> เลือกรูปสลิป
          </div>
        </label>
      </div>

      {/* Missing OCR API Key Warning Banner */}
      {hasOcrProvider === false && (
        <div className="batch-ocr-missing-notice" style={{ marginTop: "16px" }}>
          <div>
            <strong>ระบบยังไม่ได้เปิดใช้งานอ่านสลิปอัตโนมัติ (OCR_API_KEY)</strong>
            <span>
              ยังไม่ได้ระบุ <code>OCR_API_KEY</code> ในไฟล์ <code>.env.local</code> (ใช้ Gemini API ฟรี) ระบบจึงยังไม่สามารถอ่านยอดเงินจากรูปได้อัตโนมัติ — สามารถพิมพ์ยอดเงิน เช่น 84 ที่ช่องสลิปเพื่อจับคู่สูตรได้ทันที หรือใส่ API Key ใน <code>.env.local</code> เพื่อให้อ่านอัตโนมัติ 100%
            </span>
          </div>
        </div>
      )}

      {/* Progress banner when analyzing */}
      {analyzingRemaining > 0 && (
        <div className="batch-analyzing-banner">
          <Loader2 size={18} className="spin-icon" />
          <span>
            กำลังบีบอัดและอ่านข้อมูลสลิป (เหลือ {analyzingRemaining} จาก {totalAnalyzing} รูป)…
          </span>
        </div>
      )}

      {/* Save Result Toast */}
      {saveResult && (
        <div className={saveResult.ok ? "success-toast" : "error-toast"} style={{ marginBottom: "16px" }}>
          {saveResult.ok ? (
            <>
              🎉 บันทึกออเดอร์สำเร็จแล้ว <strong>{saveResult.savedCount} รายการ</strong> (ยอดรวม{" "}
              {formatBaht(saveResult.totalAmount)}) ·{" "}
              <Link href="/sales" className="text-link" style={{ textDecoration: "underline" }}>
                ดูประวัติการขาย
              </Link>
            </>
          ) : (
            <>
              บันทึกสำเร็จ {saveResult.savedCount} รายการ — ติดปัญหาบางรายการ: {saveResult.errorText}
            </>
          )}
        </div>
      )}

      {/* Batch Table Container */}
      {rows.length > 0 && (
        <div className="batch-table-container">
          <div className="batch-table-header">
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
            <div className="batch-header-stats">
              พร้อมบันทึก: <strong>{readyToSaveCount}</strong> จาก {rows.length}
            </div>
          </div>

          <div className="batch-rows-list">
            {rows.map((row) => {
              const matchedPreset = row.matchedPresetId ? presetMap.get(row.matchedPresetId) : null;
              const hasItems = row.items.length > 0;
              const isReady = row.status === "ready" && row.amountSatang > 0 && hasItems;

              return (
                <div
                  key={row.id}
                  className={`batch-slip-row ${row.isDuplicate ? "is-duplicate" : ""} ${
                    row.selected ? "is-selected" : ""
                  }`}
                >
                  {/* Select Checkbox */}
                  <div className="col-select">
                    <input
                      type="checkbox"
                      checked={row.selected}
                      disabled={row.isDuplicate || row.status === "processing"}
                      onChange={(e) => updateRow(row.id, { selected: e.target.checked })}
                    />
                  </div>

                  {/* Thumbnail */}
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

                  {/* Info & Extracted Details */}
                  <div className="col-info">
                    <div className="slip-amount-row">
                      <div className="slip-amount-box">
                        <label>ยอดเงิน:</label>
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

                      {matchedPreset && (
                        <span className="badge-preset-matched">
                          <Check size={12} /> ตรงสูตร: {matchedPreset.name}
                        </span>
                      )}

                      {row.bank && <span className="slip-bank-badge">{row.bank}</span>}
                      {row.isDuplicate && (
                        <span className="badge-duplicate">
                          สลิปซ้ำ (บิล #{row.duplicateSaleNumber ?? "เดิม"})
                        </span>
                      )}
                    </div>

                    <div className="slip-meta-line">
                      <span>เวลาโอน: {new Date(row.soldAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })} น.</span>
                      {row.referenceNumber && <span> · Ref: {row.referenceNumber}</span>}
                    </div>

                    {/* Preset Picker Dropdown */}
                    <div className="slip-preset-picker">
                      <label className="picker-label">สูตรเปิดบิล:</label>
                      <select
                        value={row.matchedPresetId ?? ""}
                        onChange={(e) => handlePresetChange(row.id, e.target.value)}
                        className={`preset-select ${matchedPreset ? "has-preset" : "no-preset"}`}
                      >
                        <option value="">— เลือกสูตรเปิดบิลด่วน —</option>
                        {presets.map((p) => (
                          <option key={p.id} value={p.id}>
                            {formatBaht(p.amountSatang)} · {p.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Items display */}
                    {hasItems && (
                      <div className="slip-items-summary">
                        <span>
                          {row.fulfillment === "delivery" ? "🛵 ส่ง" : "🏪 รับเอง"}
                          {row.fulfillment === "delivery" ? ` (${formatBaht(row.deliveryChargedSatang)})` : ""} ·{" "}
                          {row.items
                            .map((it) => {
                              const m = menuMap.get(it.menuId);
                              return m ? `${m.name} × ${it.quantity}` : null;
                            })
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      </div>
                    )}

                    {/* Status Badge */}
                    <div className="slip-status-line">
                      {row.status === "processing" ? (
                        <span className="status-badge processing">
                          <Loader2 size={12} className="spin-icon" /> กำลังอ่าน…
                        </span>
                      ) : isReady ? (
                        <span className="status-badge ready">
                          <CheckCircle2 size={13} /> พร้อมบันทึก
                        </span>
                      ) : row.isDuplicate ? (
                        <span className="status-badge duplicate">
                          <AlertCircle size={13} /> ข้ามรายการนี้ (ซ้ำ)
                        </span>
                      ) : (
                        <span className="status-badge warn">
                          <AlertCircle size={13} /> รอเลือกสูตรเมนู
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Remove Button */}
                  <div className="col-action">
                    <button
                      type="button"
                      className="icon-button danger"
                      onClick={() => deleteRow(row.id)}
                      aria-label="ลบรายการนี้"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Sticky Bottom Actions Bar */}
          <div className="batch-bottom-bar">
            <div className="bar-summary">
              <span>เลือก {selectedRows.length} รายการ</span>
              <strong>ยอดรวม {formatBaht(totalAmountSelectedSatang)}</strong>
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
                disabled={saving || readyToSaveCount === 0}
                onClick={handleBatchSave}
              >
                {saving ? (
                  <>
                    <Loader2 size={18} className="spin-icon" />
                    กำลังบันทึก ({saveProgress?.current}/{saveProgress?.total})…
                  </>
                ) : (
                  <>
                    <Check size={18} /> ยืนยันและบันทึกออเดอร์ ({readyToSaveCount} รายการ)
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Slip Image Full View Modal */}
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
