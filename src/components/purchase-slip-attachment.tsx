"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { hasSupabaseEnv } from "@/lib/env";
import { compressSlipImage } from "@/lib/image-compression";
import { formatBaht } from "@/lib/money";
import { createClient } from "@/lib/supabase/client";
import { bangkokDayKey } from "@/lib/time";

const SLIP_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const MAX_SLIP_BYTES = 10 * 1024 * 1024;

export function PurchaseSlipAttachment({
  maxDate,
  dayStartHour = 0,
}: {
  maxDate: string;
  dayStartHour?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [receiptPath, setReceiptPath] = useState("");
  const [referenceNotes, setReferenceNotes] = useState("");
  const [fileName, setFileName] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const form = wrapRef.current?.closest("form");
    if (!form) return;
    const onReset = () => {
      setReceiptPath("");
      setReferenceNotes("");
      setFileName("");
      setPreviewUrl(null);
      setStatusText(null);
      setIsError(false);
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, []);

  async function removeUploadedFromStorage(pathToRemove: string) {
    if (!pathToRemove || !hasSupabaseEnv) return;
    try {
      const supabase = createClient();
      await supabase.storage.from("sale-slips").remove([pathToRemove]);
    } catch {
      // Ignore storage cleanup errors
    }
  }

  async function handleRemoveSlip() {
    const oldPath = receiptPath;
    setReceiptPath("");
    setReferenceNotes("");
    setFileName("");
    setPreviewUrl(null);
    setStatusText(null);
    setIsError(false);
    if (oldPath) {
      await removeUploadedFromStorage(oldPath);
    }
  }

  async function handleChooseFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;

    if (!SLIP_TYPES[file.type]) {
      setIsError(true);
      setStatusText("รองรับเฉพาะไฟล์ JPG, PNG หรือ WebP");
      return;
    }
    if (file.size > MAX_SLIP_BYTES) {
      setIsError(true);
      setStatusText("ไฟล์สลิปต้องไม่เกิน 10 MB");
      return;
    }

    if (receiptPath) {
      await removeUploadedFromStorage(receiptPath);
      setReceiptPath("");
    }

    setBusy(true);
    setIsError(false);
    setStatusText("กำลังบีบอัดรูปและอ่านข้อมูลสลิป…");

    try {
      const compressed = await compressSlipImage(file, { maxWidth: 720, quality: 0.65 });
      setFileName(compressed.file.name);
      setPreviewUrl(compressed.previewUrl);

      if (hasSupabaseEnv) {
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          const ext = SLIP_TYPES[compressed.file.type] || "webp";
          const hashPart = compressed.hash ? compressed.hash.slice(0, 16) : Date.now().toString(36);
          const path = `${user.id}/expenses/${hashPart}_${crypto.randomUUID()}.${ext}`;
          const { error: uploadError } = await supabase.storage
            .from("sale-slips")
            .upload(path, compressed.file, { contentType: compressed.file.type, upsert: false });
          if (!uploadError) {
            setReceiptPath(path);
          }
        }
      }

      const formData = new FormData();
      formData.append("file", compressed.file);
      formData.append("hash", compressed.hash);
      formData.append("context", "expense");

      const res = await fetch("/api/slip/analyze", { method: "POST", body: formData });
      const json = await res.json();

      if (json.isDuplicate) {
        setIsError(true);
        setStatusText(
          json.duplicateReason || "สลิปค่าใช้จ่ายนี้เคยบันทึกไปแล้ว — กรุณาตรวจสอบว่าไม่ได้ลงซ้ำ"
        );
      }

      const form = wrapRef.current?.closest("form");
      if (json.ok && json.result) {
        const ocr = json.result;
        if (ocr.transferredAt && form) {
          const dKey = bangkokDayKey(ocr.transferredAt, dayStartHour);
          if (dKey <= maxDate) {
            const dateInput = form.querySelector<HTMLInputElement>('input[name="purchased_at"]');
            if (dateInput) dateInput.value = dKey;
          }
        }
        const detectedVendor = (ocr.receiverName || "").trim();
        if (detectedVendor && form) {
          const vendorInput = form.querySelector<HTMLInputElement>('input[name="vendor"]');
          if (vendorInput && !vendorInput.value.trim()) {
            vendorInput.value = detectedVendor;
          }
        }
        if (ocr.referenceNumber) {
          setReferenceNotes(`Ref: ${ocr.referenceNumber}`);
        }
        if (!json.isDuplicate) {
          setStatusText(
            ocr.amountSatang
              ? `อ่านสลิปสำเร็จ: ยอดในสลิป ${formatBaht(ocr.amountSatang)}${
                  detectedVendor ? ` · ร้าน/ผู้รับ "${detectedVendor}"` : ""
                }`
              : "แนบสลิปเรียบร้อยแล้ว"
          );
        }
      } else if (!json.isDuplicate) {
        setStatusText("แนบสลิปเรียบร้อยแล้ว");
      }
    } catch {
      setStatusText("แนบสลิปแล้ว");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={wrapRef} className="wide" style={{ gridColumn: "1 / -1" }}>
      <input type="hidden" name="receipt_path" value={receiptPath} />
      <input type="hidden" name="notes" value={referenceNotes} />
      {fileName ? (
        <div className="slip-chosen" style={{ marginTop: 0 }}>
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt="ตัวอย่างสลิป"
              style={{
                width: "42px",
                height: "54px",
                objectFit: "cover",
                borderRadius: "7px",
                border: "1px solid rgba(0,0,0,0.1)",
                flexShrink: 0,
              }}
            />
          ) : (
            <ImagePlus size={18} />
          )}
          <span>
            <strong>{fileName}</strong>
            <small className={isError ? "form-error" : ""}>
              {statusText ?? "พร้อมแนบสลิปนี้กับรายการซื้อ"}
            </small>
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={handleRemoveSlip}
            aria-label="เอาสลิปออก"
          >
            <X size={18} />
          </button>
        </div>
      ) : (
        <label className="slip-drop compact-slip-drop" style={{ marginTop: 0 }}>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleChooseFile}
          />
          {busy ? <Loader2 className="spin-icon" size={18} /> : <ImagePlus size={18} />}
          <strong>แนบสลิปโอนเงินของรอบที่ซื้อนี้ (ไม่บังคับ)</strong>
          <span>ระบบดึงวันที่และชื่อร้านให้อัตโนมัติ และผูกสลิปเข้ากับทุกรายการที่กรอกด้านล่าง</span>
        </label>
      )}
    </div>
  );
}
