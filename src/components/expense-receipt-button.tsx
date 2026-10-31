"use client";

import { useState } from "react";
import { Eye, Loader2, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export function ExpenseReceiptButton({
  receiptPath,
  label = "ดูสลิป",
  modalTitle = "ดูรูปสลิป",
}: {
  receiptPath: string;
  label?: string;
  modalTitle?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleOpen() {
    if (previewUrl) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data, error: signError } = await supabase.storage
        .from("sale-slips")
        .createSignedUrl(receiptPath, 300);
      if (signError || !data?.signedUrl) {
        throw new Error(signError?.message ?? "ไม่สามารถเปิดรูปสลิปได้");
      }
      setPreviewUrl(data.signedUrl);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "เปิดรูปสลิปไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="link-button"
        style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px" }}
        onClick={handleOpen}
        disabled={loading}
      >
        {loading ? <Loader2 size={13} className="spin-icon" /> : <Eye size={13} />}
        <span>{label}</span>
      </button>
      {error && <small className="form-error" style={{ display: "block", fontSize: 11 }}>{error}</small>}

      {previewUrl && (
        <div className="image-preview-modal-backdrop" onClick={() => setPreviewUrl(null)}>
          <div className="image-preview-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>{modalTitle}</strong>
              <button
                type="button"
                className="icon-button"
                onClick={() => setPreviewUrl(null)}
                aria-label="ปิดหน้าต่างดูสลิป"
              >
                <X size={18} />
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="สลิปค่าใช้จ่าย" className="full-slip-preview" />
          </div>
        </div>
      )}
    </>
  );
}
