"use client";

import { useRef, useState } from "react";
import { Camera, Trash2, Upload } from "lucide-react";

export function ProfileAvatarField({
  currentAvatar,
  initialLetter,
}: {
  currentAvatar?: string | null;
  initialLetter: string;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(currentAvatar ?? null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
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
    setRemoveAvatar(false);
  }

  function handleRemove() {
    setPreviewUrl(null);
    setFileName(null);
    setRemoveAvatar(true);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleTriggerClick() {
    fileInputRef.current?.click();
  }

  const hasImage = Boolean(previewUrl && !removeAvatar);

  return (
    <div className="profile-avatar-field">
      <span className="field-label-text">
        รูปโปรไฟล์ร้านค้า <small className="muted-hint">(โลโก้ร้านหรือรูปภาพโปรไฟล์)</small>
      </span>

      <input
        ref={fileInputRef}
        type="file"
        name="avatar"
        accept="image/jpeg,image/png,image/webp,image/gif"
        onChange={handleFileChange}
        style={{ display: "none" }}
        tabIndex={-1}
      />
      <input type="hidden" name="remove_avatar" value={removeAvatar ? "true" : "false"} />

      <div className="profile-avatar-row">
        <div
          className="profile-avatar-preview"
          onClick={handleTriggerClick}
          title="กดเพื่อเปลี่ยนรูปโปรไฟล์"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleTriggerClick();
            }
          }}
        >
          {hasImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl!} alt="รูปโปรไฟล์" className="profile-avatar-img" />
          ) : (
            <span className="profile-avatar-placeholder">{initialLetter}</span>
          )}
          <div className="profile-avatar-badge" aria-hidden="true">
            <Camera size={14} />
          </div>
        </div>

        <div className="profile-avatar-info">
          <div className="profile-avatar-actions">
            <button
              type="button"
              className="btn-subtle"
              onClick={handleTriggerClick}
            >
              {hasImage ? <Upload size={14} /> : <Camera size={14} />}
              <span>{hasImage ? "เปลี่ยนรูปภาพ" : "เลือกรูปภาพ"}</span>
            </button>

            {hasImage && (
              <button
                type="button"
                className="btn-subtle danger"
                onClick={handleRemove}
              >
                <Trash2 size={14} />
                <span>ลบรูป</span>
              </button>
            )}
          </div>
          <small className="muted-hint">
            {fileName ? fileName : "รองรับ JPG, PNG, WebP ขนาดไม่เกิน 5 MB"}
          </small>
        </div>
      </div>
    </div>
  );
}
