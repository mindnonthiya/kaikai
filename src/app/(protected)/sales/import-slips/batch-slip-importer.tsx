"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import {
  AlertCircle,
  BookmarkPlus,
  Check,
  CheckCircle2,
  Eye,
  Loader2,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { saveAllPricePresets } from "@/app/actions/presets";
import type { Fulfillment, MenuRecord, PricePreset } from "@/lib/data/types";
import { compressSlipImage } from "@/lib/image-compression";
import { formatBaht, tryBahtToSatang } from "@/lib/money";
import { matchPresetStrictly } from "@/lib/preset-matcher";
import { checkIntraBatchDuplicate } from "@/lib/slip-duplicate";
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
  duplicateReason?: string;
  duplicateSaleNumber?: number;
  duplicateSoldAt?: string;

  selected: boolean;

  // Inline order item editor toggle
  isEditingItems?: boolean;
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

  const [currentPresets, setCurrentPresets] = useState<PricePreset[]>(presets);
  const [savingPresetForRowId, setSavingPresetForRowId] = useState<string | null>(null);

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
  const presetMap = new Map(currentPresets.map((p) => [p.id, p]));

  // Handle file selection (multiple) with Concurrency Queue (3 concurrent workers)
  async function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileList = Array.from(files);
    setTotalAnalyzing(fileList.length);
    setAnalyzingRemaining(fileList.length);
    setSaveResult(null);

    // Reset input so user can choose same files again if needed
    if (fileInputRef.current) fileInputRef.current.value = "";

    const newItems: Array<{ id: string; file: File }> = [];
    const initialRows: BatchSlipRow[] = [];

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
        amountSatang: 0,
        soldAt: new Date().toISOString(),
        matchedPresetId: null,
        fulfillment: "delivery",
        deliveryChargedSatang: defaultDeliveryFee,
        items: [],
        customerName: "",
        isDuplicate: false,
        selected: true,
        isEditingItems: false,
      });
    }

    setRows((prev) => [...initialRows, ...prev]);

    // Concurrency queue worker (Concurrency = 3)
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
    updateRow(rowId, {
      status: "processing",
      statusText: "กำลังลองอ่านใหม่…",
    });

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
      setRows((prev) =>
        prev.map((r) => {
          if (r.id !== rowId) return r;
          return {
            ...r,
            status: "error",
            statusText: "อ่านไม่สำเร็จ",
            selected: false,
          };
        })
      );
    }

    setAnalyzingRemaining((prev) => Math.max(0, prev - 1));
  }

  async function processSlipRow(rowId: string, file: File): Promise<boolean> {
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

      if (res.status === 429 || json.isRateLimit) {
        return false;
      }

      let amountSatang = 0;
      let soldAt = new Date().toISOString();
      let isDuplicate = false;
      let duplicateReason: string | undefined;
      let duplicateSaleNumber: number | undefined;
      let duplicateSoldAt: string | undefined;
      let bank: string | undefined;
      let ref: string | undefined;

      if (json.ok && json.result) {
        isDuplicate = Boolean(json.isDuplicate);
        duplicateReason = json.duplicateReason;
        duplicateSaleNumber = json.duplicateSaleNumber ?? undefined;
        duplicateSoldAt = json.duplicateSoldAt ?? undefined;

        amountSatang = json.result.amountSatang ?? 0;
        if (json.result.transferredAt) {
          soldAt = json.result.transferredAt;
        }
        bank = json.result.bank;
        ref = json.result.referenceNumber;
      } else if (json.isDuplicate) {
        isDuplicate = true;
        duplicateReason = json.duplicateReason;
        duplicateSaleNumber = json.duplicateSaleNumber ?? undefined;
        duplicateSoldAt = json.duplicateSoldAt ?? undefined;
      }

      // 3. Strict Match with Presets ONLY (Strict 1:1, no fuzzy substitutions)
      const matched = matchPresetStrictly(amountSatang, currentPresets);

      setRows((prev) =>
        prev.map((row) => {
          if (row.id !== rowId) return row;

          // Check intra-batch duplicate against other already-processed slips in this batch
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
            status: finalIsDuplicate ? "duplicate" : "ready",
            statusText: finalIsDuplicate
              ? finalDuplicateReason || `สลิปซ้ำ (เคยลงในบิล #${duplicateSaleNumber ?? "เดิม"})`
              : matched
              ? `ตรงสูตร: ${matched.name}`
              : amountSatang > 0
              ? `ไม่ตรงสูตรใด (฿${(amountSatang / 100).toFixed(0)})`
              : json.error || "ไม่พบยอดเงินในรูป",
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
            isDuplicate: finalIsDuplicate,
            duplicateReason: finalDuplicateReason,
            duplicateSaleNumber,
            duplicateSoldAt,
            selected: !finalIsDuplicate, // auto-uncheck suspected duplicates, merchant can check to confirm
            isEditingItems: !matched && amountSatang > 0 && !finalIsDuplicate,
          };
        })
      );
      return true;
    } catch (err: unknown) {
      console.error("Row processing error:", err);
      return false;
    }
  }

  // Handle direct amount edit (strict matching only, never substitute different numbers)
  function handleAmountChange(rowId: string, newBahtStr: string) {
    const parsedSatang = tryBahtToSatang(newBahtStr);
    const amountSatang = parsedSatang ?? 0;
    const matched = matchPresetStrictly(amountSatang, currentPresets);

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
        ? `ไม่ตรงสูตรใด (฿${(amountSatang / 100).toFixed(0)})`
        : "ยังไม่มียอดเงิน",
      isEditingItems: !matched && amountSatang > 0,
    });
  }

  // Update row helpers
  function updateRow(rowId: string, patch: Partial<BatchSlipRow>) {
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
  }

  function handlePresetChange(rowId: string, presetId: string) {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;

    if (!presetId) {
      updateRow(rowId, {
        matchedPresetId: null,
        items: [],
        statusText:
          row.amountSatang > 0
            ? `ไม่ตรงสูตรใด (฿${(row.amountSatang / 100).toFixed(0)})`
            : "ยังไม่มียอดเงิน",
        isEditingItems: true,
      });
      return;
    }

    const preset = presetMap.get(presetId);
    if (!preset) return;

    const newAmount = row.amountSatang > 0 ? row.amountSatang : preset.amountSatang;
    const isExact = preset.amountSatang === newAmount;

    updateRow(rowId, {
      amountSatang: newAmount,
      matchedPresetId: isExact ? preset.id : null,
      fulfillment: preset.fulfillment,
      deliveryChargedSatang: preset.deliveryChargedSatang,
      items: [...preset.items],
      status: "ready",
      statusText: isExact ? `ตรงสูตร: ${preset.name}` : `ใช้รายการจาก: ${preset.name}`,
      isEditingItems: false,
    });
  }

  function deleteRow(rowId: string) {
    setRows((prev) => prev.filter((r) => r.id !== rowId));
  }

  function toggleAll(checked: boolean) {
    setRows((prev) => prev.map((r) => ({ ...r, selected: checked })));
  }

  function toggleEditItems(rowId: string) {
    setRows((prev) =>
      prev.map((r) => (r.id === rowId ? { ...r, isEditingItems: !r.isEditingItems } : r))
    );
  }

  function handleAddItem(rowId: string, menuId: string) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== rowId) return r;
        const existing = r.items.find((it) => it.menuId === menuId);
        let updatedItems: Array<{ menuId: string; quantity: number }>;
        if (existing) {
          updatedItems = r.items.map((it) =>
            it.menuId === menuId ? { ...it, quantity: it.quantity + 1 } : it
          );
        } else {
          updatedItems = [...r.items, { menuId, quantity: 1 }];
        }
        return {
          ...r,
          items: updatedItems,
          matchedPresetId: null, // user customized items
        };
      })
    );
  }

  function handleUpdateItemQty(rowId: string, menuId: string, qty: number) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== rowId) return r;
        let updatedItems: Array<{ menuId: string; quantity: number }>;
        if (qty <= 0) {
          updatedItems = r.items.filter((it) => it.menuId !== menuId);
        } else {
          updatedItems = r.items.map((it) =>
            it.menuId === menuId ? { ...it, quantity: qty } : it
          );
        }
        return {
          ...r,
          items: updatedItems,
          matchedPresetId: null,
        };
      })
    );
  }

  function handleRemoveItem(rowId: string, menuId: string) {
    handleUpdateItemQty(rowId, menuId, 0);
  }

  function handleFulfillmentChange(rowId: string, fulfillment: Fulfillment) {
    updateRow(rowId, {
      fulfillment,
      deliveryChargedSatang: fulfillment === "delivery" ? defaultDeliveryFee : 0,
      matchedPresetId: null,
    });
  }

  async function handleQuickSaveAsPreset(row: BatchSlipRow) {
    if (row.items.length === 0) {
      alert("กรุณาเลือกรายการเมนูอย่างน้อย 1 รายการก่อนบันทึกเป็นสูตร");
      return;
    }
    if (row.amountSatang <= 0) {
      alert("กรุณาระบุยอดเงินของสูตร");
      return;
    }

    const itemsSummary = row.items
      .map((it) => {
        const m = menuMap.get(it.menuId);
        return m ? `${m.name}${it.quantity > 1 ? ` × ${it.quantity}` : ""}` : "";
      })
      .filter(Boolean)
      .join(" + ");
    const defaultName = `${itemsSummary} (${row.fulfillment === "delivery" ? "ส่ง" : "รับเอง"})`;

    const inputName = window.prompt("ตั้งชื่อสูตรเปิดบิลใหม่นี้:", defaultName);
    if (!inputName || !inputName.trim()) return;

    const newPreset: PricePreset = {
      id: crypto.randomUUID(),
      name: inputName.trim(),
      amountSatang: row.amountSatang,
      fulfillment: row.fulfillment,
      deliveryChargedSatang: row.fulfillment === "delivery" ? row.deliveryChargedSatang : 0,
      items: [...row.items],
    };

    const updatedPresets = [...currentPresets, newPreset];
    setSavingPresetForRowId(row.id);

    try {
      const res = await saveAllPricePresets(updatedPresets);
      if (!res.ok) {
        alert(res.message || "บันทึกสูตรไม่สำเร็จ");
        return;
      }
      setCurrentPresets(updatedPresets);

      // Auto-match all rows that have this exact amount
      setRows((prev) =>
        prev.map((r) => {
          if (r.amountSatang === newPreset.amountSatang) {
            return {
              ...r,
              matchedPresetId: newPreset.id,
              fulfillment: newPreset.fulfillment,
              deliveryChargedSatang: newPreset.deliveryChargedSatang,
              items: [...newPreset.items],
              statusText: `ตรงสูตร: ${newPreset.name}`,
              isEditingItems: false,
            };
          }
          return r;
        })
      );
    } catch (err) {
      console.error("Save preset error:", err);
      alert("เกิดข้อผิดพลาดในการบันทึกสูตร");
    } finally {
      setSavingPresetForRowId(null);
    }
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
              // If merchant confirmed to save a duplicate slip, append salt so DB unique constraint doesn't reject
              file_hash_sha256: row.isDuplicate ? `${row.hash}-ov-${crypto.randomUUID().slice(0, 8)}` : row.hash,
            }
          : undefined;

        // Calculate items food total + delivery and tip
        const itemsFoodTotalSatang = row.items.reduce((sum, it) => {
          const m = menuMap.get(it.menuId);
          return sum + (m ? m.price * it.quantity : 0);
        }, 0);
        const deliveryChargedSatang = row.fulfillment === "delivery" ? row.deliveryChargedSatang : 0;
        const expectedOrderTotalSatang = itemsFoodTotalSatang + deliveryChargedSatang;
        const rowTipSatang = Math.max(0, row.amountSatang - expectedOrderTotalSatang);

        // 2. Call create_sale RPC
        const { error: saleError } = await supabase.rpc("create_sale", {
          payload: {
            items: row.items.map((it) => ({
              menu_id: it.menuId,
              quantity: it.quantity,
            })),
            fulfillment: row.fulfillment,
            pooled_ingredient_bps: pooledBps,
            delivery_charged_satang: deliveryChargedSatang,
            discount_satang: 0,
            tip_satang: rowTipSatang,
            payment_fee_satang: 0,
            payment_amount_satang: row.amountSatang,
            payment_method: "transfer",
            payment_status: "paid",
            customer_name: row.customerName.trim() || null,
            sold_at: row.soldAt,
            notes: [
              row.referenceNumber ? `เลขอ้างอิง: ${row.referenceNumber}` : null,
              rowTipSatang > 0 ? `ทิป/โอนเกิน: ${formatBaht(rowTipSatang)}` : null,
            ].filter(Boolean).join(" · ") || null,
            reference_number: row.referenceNumber || null,
            ...(slipPayload ? { slip: slipPayload } : {}),
          },
        });

        if (saleError) {
          if (uploadedPath) await supabase.storage.from("sale-slips").remove([uploadedPath]);
          if (saleError.message.includes("slip_uploads_owner_id_file_hash_sha256_key")) {
            throw new Error("ไฟล์รูปสลิปนี้เคยบันทึกในระบบแล้ว");
          }
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
            กำลังอ่านข้อมูลสลิป (เสร็จแล้ว {totalAnalyzing - analyzingRemaining} จาก {totalAnalyzing} รูป)…
          </span>
        </div>
      )}

      {/* Save Result Toast */}
      {saveResult && (
        <div className={saveResult.ok ? "success-toast" : "error-toast"} style={{ marginBottom: "16px" }}>
          {saveResult.ok ? (
            <>
              บันทึกออเดอร์สำเร็จแล้ว <strong>{saveResult.savedCount} รายการ</strong> (ยอดรวม{" "}
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

              const itemsFoodTotalSatang = row.items.reduce((sum, it) => {
                const m = menuMap.get(it.menuId);
                return sum + (m ? m.price * it.quantity : 0);
              }, 0);
              const orderTotalSatang =
                itemsFoodTotalSatang + (row.fulfillment === "delivery" ? row.deliveryChargedSatang : 0);
              const isAmountMatchingFood = row.amountSatang > 0 && orderTotalSatang === row.amountSatang;
              const rowTipSatang = Math.max(0, row.amountSatang - orderTotalSatang);

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
                      disabled={row.status === "processing"}
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

                      {matchedPreset ? (
                        <span className="badge-preset-matched">
                          <Check size={12} /> ตรงสูตร: {matchedPreset.name}
                          {rowTipSatang > 0 ? ` (ทิป/โอนเกิน +${formatBaht(rowTipSatang)})` : ""}
                        </span>
                      ) : row.amountSatang > 0 ? (
                        <span className="badge-preset-unmatched">
                          <AlertCircle size={12} /> ไม่ตรงสูตรใด ({formatBaht(row.amountSatang)})
                          {hasItems && rowTipSatang > 0 ? ` (ทิป +${formatBaht(rowTipSatang)})` : ""}
                        </span>
                      ) : null}

                      {row.bank && <span className="slip-bank-badge">{row.bank}</span>}
                      {row.isDuplicate && (
                        <span className="badge-duplicate" title={row.duplicateReason}>
                          {row.duplicateReason || `สลิปซ้ำ (บิล #${row.duplicateSaleNumber ?? "เดิม"})`}
                        </span>
                      )}
                    </div>

                    <div className="slip-meta-line">
                      <span>
                        โอนเมื่อ:{" "}
                        {new Date(row.soldAt).toLocaleDateString("th-TH", {
                          day: "numeric",
                          month: "short",
                          year: "2-digit",
                        })}{" "}
                        {new Date(row.soldAt).toLocaleTimeString("th-TH", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}{" "}
                        น.
                      </span>
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
                        <option value="">
                          {matchedPreset
                            ? "— เลือกสูตรอื่น —"
                            : row.amountSatang > 0
                            ? "— ไม่ตรงสูตรใด (เลือกสูตรเปิดบิล) —"
                            : "— เลือกสูตรเปิดบิลด่วน —"}
                        </option>
                        {currentPresets.map((p) => (
                          <option key={p.id} value={p.id}>
                            {formatBaht(p.amountSatang)} · {p.name}
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        className="slip-edit-toggle-btn"
                        onClick={() => toggleEditItems(row.id)}
                      >
                        <Pencil size={12} /> {row.isEditingItems ? "ซ่อนเมนู" : hasItems ? "แก้ไขรายการ" : "เลือกเมนู"}
                      </button>
                    </div>

                    {/* Items summary when not editing */}
                    {!row.isEditingItems && hasItems && (
                      <div className="slip-items-summary">
                        <span>
                          {row.fulfillment === "delivery" ? "ส่ง" : "รับเอง"}
                          {row.fulfillment === "delivery" ? ` (${formatBaht(row.deliveryChargedSatang)})` : ""} ·{" "}
                          {row.items
                            .map((it) => {
                              const m = menuMap.get(it.menuId);
                              return m ? `${m.name} × ${it.quantity}` : null;
                            })
                            .filter(Boolean)
                            .join(", ")}
                          {rowTipSatang > 0 ? ` · ทิป/โอนเกิน +${formatBaht(rowTipSatang)}` : ""}
                        </span>
                      </div>
                    )}

                    {/* Inline Item & Order Editor */}
                    {row.isEditingItems && (
                      <div className="slip-item-editor">
                        {/* Quick add menu chips */}
                        <div className="slip-editor-menus">
                          <span className="slip-editor-subhead">แตะเพื่อเพิ่มเมนู:</span>
                          <div className="slip-menu-chips">
                            {menus.map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                className="slip-menu-chip-btn"
                                onClick={() => handleAddItem(row.id, m.id)}
                              >
                                <Plus size={12} /> {m.name} <span className="chip-price">฿{m.price / 100}</span>
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Selected Items List */}
                        {hasItems && (
                          <div className="slip-editor-items-table">
                            {row.items.map((it) => {
                              const m = menuMap.get(it.menuId);
                              if (!m) return null;
                              return (
                                <div key={it.menuId} className="slip-editor-item-row">
                                   <span className="slip-item-name">{m.name}</span>
                                  <span className="slip-item-unit-price">@{m.price / 100}฿</span>
                                  <div className="slip-item-qty-stepper">
                                    <button
                                      type="button"
                                      onClick={() => handleUpdateItemQty(row.id, it.menuId, it.quantity - 1)}
                                      className="stepper-btn"
                                      aria-label="ลดจำนวน"
                                    >
                                      -
                                    </button>
                                    <span className="stepper-val">{it.quantity}</span>
                                    <button
                                      type="button"
                                      onClick={() => handleUpdateItemQty(row.id, it.menuId, it.quantity + 1)}
                                      className="stepper-btn"
                                      aria-label="เพิ่มจำนวน"
                                    >
                                      +
                                    </button>
                                  </div>
                                  <span className="slip-item-total">฿{(m.price * it.quantity) / 100}</span>
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveItem(row.id, it.menuId)}
                                    className="slip-item-del-btn"
                                    title="ลบเมนูนี้"
                                  >
                                    <X size={14} />
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Delivery / Fulfillment Toggle */}
                        <div className="slip-editor-fulfillment">
                          <label className="picker-label">การจัดส่ง:</label>
                          <div className="fulfillment-segmented">
                            <button
                              type="button"
                              className={`seg-btn ${row.fulfillment === "pickup" ? "active" : ""}`}
                              onClick={() => handleFulfillmentChange(row.id, "pickup")}
                            >
                              รับเอง (0฿)
                            </button>
                            <button
                              type="button"
                              className={`seg-btn ${row.fulfillment === "delivery" ? "active" : ""}`}
                              onClick={() => handleFulfillmentChange(row.id, "delivery")}
                            >
                              ส่ง (+฿{defaultDeliveryFee / 100})
                            </button>
                          </div>
                        </div>

                        {/* Calculation Comparison Banner */}
                        {hasItems && (
                          <div className={`slip-calc-banner ${isAmountMatchingFood || rowTipSatang > 0 ? "match" : "diff"}`}>
                            {isAmountMatchingFood ? (
                              <>ยอดอาหารรวมค่าส่งตรงกับสลิปพอดี ({formatBaht(orderTotalSatang)})</>
                            ) : rowTipSatang > 0 ? (
                              <>
                                ยอดอาหารรวม {formatBaht(orderTotalSatang)} · ยอดสลิป {formatBaht(row.amountSatang)} (มีทิป/โอนเกิน +{formatBaht(rowTipSatang)})
                              </>
                            ) : (
                              <>
                                ยอดอาหารรวม {formatBaht(orderTotalSatang)} · ยอดสลิป {formatBaht(row.amountSatang)} (ยอดในสลิปน้อยกว่า {formatBaht(orderTotalSatang - row.amountSatang)})
                              </>
                            )}
                          </div>
                        )}

                        {/* Quick Save as Preset Button */}
                        {hasItems && row.amountSatang > 0 && !matchedPreset && (
                          <button
                            type="button"
                            className="slip-save-preset-btn"
                            disabled={savingPresetForRowId === row.id}
                            onClick={() => handleQuickSaveAsPreset(row)}
                          >
                            <BookmarkPlus size={13} />
                            {savingPresetForRowId === row.id
                              ? "กำลังบันทึกสูตร…"
                              : `บันทึกเป็นสูตรใหม่สำหรับยอด ${formatBaht(row.amountSatang)}`}
                          </button>
                        )}
                      </div>
                    )}

                    {/* Status Badge */}
                    <div className="slip-status-line">
                      {row.status === "processing" ? (
                        <span className="status-badge processing">
                          <Loader2 size={12} className="spin-icon" /> {row.statusText || "กำลังอ่าน…"}
                        </span>
                      ) : row.status === "error" ? (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                          <span className="status-badge warn">
                            <AlertCircle size={13} /> {row.statusText || "อ่านไม่สำเร็จ"}
                          </span>
                          <button
                            type="button"
                            className="slip-retry-btn"
                            onClick={() => handleRetryRow(row.id)}
                          >
                            <RotateCw size={11} /> กดอ่านใหม่
                          </button>
                        </div>
                      ) : row.isDuplicate ? (
                        row.selected ? (
                          <span className="status-badge ready">
                            <CheckCircle2 size={13} /> {isReady ? "พร้อมบันทึก (ยืนยันว่าไม่ซ้ำ)" : "เลือกบันทึกแล้ว (รอเลือกเมนู)"}
                          </span>
                        ) : (
                          <span className="status-badge duplicate">
                            <AlertCircle size={13} /> ไม่ได้เลือก (สงสัยว่าซ้ำ)
                          </span>
                        )
                      ) : isReady ? (
                        <span className="status-badge ready">
                          <CheckCircle2 size={13} /> พร้อมบันทึก
                        </span>
                      ) : (
                        <span className="status-badge warn">
                          <AlertCircle size={13} /> {row.amountSatang > 0 ? "รอระบุรายการอาหาร" : "ยังไม่มียอดเงิน"}
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
