"use client";

import { useState } from "react";
import { Eye, Loader2, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export function ExpenseReceiptButton({
  receiptPath,
  receiptPaths,
  label = "ดูสลิป",
  modalTitle = "ดูรูปสลิป",
}: {
  receiptPath?: string | null;
  receiptPaths?: string[];
  label?: string;
  modalTitle?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const allPaths = Array.from(
    new Set(
      [
        ...(receiptPaths ?? []),
        ...(receiptPath ? [receiptPath] : []),
      ].filter((p): p is string => Boolean(p && p.trim()))
    )
  );

  if (allPaths.length === 0) return null;

  async function handleOpen() {
    if (previewUrls.length > 0) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const signedResults = await Promise.all(
        allPaths.map(async (path) => {
          const { data, error: signError } = await supabase.storage
            .from("sale-slips")
            .createSignedUrl(path, 300);
          if (signError || !data?.signedUrl) {
            throw new Error(signError?.message ?? "ไม่สามารถเปิดรูปสลิปได้");
          }
          return data.signedUrl;
        })
      );
      setPreviewUrls(signedResults);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "เปิดรูปสลิปไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  const displayLabel = allPaths.length > 1 ? `${label} (${allPaths.length} ใบ)` : label;

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
        <span>{displayLabel}</span>
      </button>
      {error && <small className="form-error" style={{ display: "block", fontSize: 11 }}>{error}</small>}

      {previewUrls.length > 0 && (
        <div className="image-preview-modal-backdrop" onClick={() => setPreviewUrls([])}>
          <div className="image-preview-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>
                {modalTitle}
                {previewUrls.length > 1 ? ` (รวม ${previewUrls.length} สลิป)` : ""}
              </strong>
              <button
                type="button"
                className="icon-button"
                onClick={() => setPreviewUrls([])}
                aria-label="ปิดหน้าต่างดูสลิป"
              >
                <X size={18} />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, maxHeight: "78vh", overflowY: "auto" }}>
              {previewUrls.map((url, idx) => (
                <div key={url} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {previewUrls.length > 1 && (
                    <span className="pill" style={{ alignSelf: "flex-start", fontSize: 12, fontWeight: 700 }}>
                      สลิปใบที่ {idx + 1} / {previewUrls.length}
                    </span>
                  )}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={`สลิปใบที่ ${idx + 1}`} className="full-slip-preview" />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
