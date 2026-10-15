"use client";

import { useRef, useState } from "react";
import { Image as ImageIcon, Trash2, Upload } from "lucide-react";

export function MenuImageField({ currentImage }: { currentImage?: string | null }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(currentImage ?? null);
  const [removeImage, setRemoveImage] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      alert("รูปภาพต้องมีขนาดไม่เกิน 5 MB");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    setFileName(file.name);
    setRemoveImage(false);
  }

  function handleRemove() {
    setPreviewUrl(null);
    setFileName(null);
    setRemoveImage(true);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleTriggerClick() {
    fileInputRef.current?.click();
  }

  return (
    <div className="menu-image-field">
      <span className="field-label-text">
        รูปภาพอาหาร <small className="muted-hint">(ไม่บังคับ — อัปโหลดรูปภาพอาหารจริง)</small>
      </span>

      <input
        ref={fileInputRef}
        type="file"
        name="image"
        accept="image/jpeg,image/png,image/webp,image/gif"
        onChange={handleFileChange}
        style={{ display: "none" }}
        tabIndex={-1}
      />
      <input type="hidden" name="remove_image" value={removeImage ? "true" : "false"} />

      {previewUrl && !removeImage ? (
        <div className="menu-image-preview-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt="ตัวอย่างรูปเมนู" className="menu-image-preview-thumb" />
          <div className="menu-image-content">
            <strong className="menu-image-filename" title={fileName ?? "รูปภาพเมนู"}>
              {fileName ? fileName : "มีรูปภาพเมนูนี้แล้ว"}
            </strong>
            <div className="menu-image-actions">
              <button type="button" className="btn-subtle" onClick={handleTriggerClick} title="เปลี่ยนรูปภาพ">
                <Upload size={13} /> เปลี่ยนรูป
              </button>
              <button type="button" className="btn-subtle danger" onClick={handleRemove} title="ลบรูปภาพ">
                <Trash2 size={13} /> ลบรูป
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="menu-image-upload-drop"
          onClick={handleTriggerClick}
        >
          <div className="upload-drop-icon">
            <ImageIcon size={20} />
          </div>
          <div className="upload-drop-text">
            <strong>กดเพื่อเลือกรูปภาพอาหาร</strong>
            <small className="muted-hint">รองรับไฟล์ JPG, PNG, WebP (ไม่เกิน 5 MB)</small>
          </div>
        </button>
      )}
    </div>
  );
}
