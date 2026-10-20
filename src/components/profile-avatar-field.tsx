"use client";

import { useRef, useState } from "react";
import { Camera, Check, Pencil, Trash2 } from "lucide-react";
import { ProfileAvatarCropper } from "./profile-avatar-cropper";

export function ProfileAvatarField({
  currentAvatar,
  initialShopName,
  initialDisplayName,
}: {
  currentAvatar?: string | null;
  initialShopName: string;
  initialDisplayName?: string;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(currentAvatar ?? null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [rawCropSrc, setRawCropSrc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [shopName, setShopName] = useState(initialShopName || "kaikai");
  const [displayName, setDisplayName] = useState(initialDisplayName || "");
  const [editingShop, setEditingShop] = useState(false);
  const [editingDisplay, setEditingDisplay] = useState(false);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 15 * 1024 * 1024) {
      alert("รูปภาพต้องมีขนาดไม่เกิน 15 MB");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setRawCropSrc(objectUrl);
  }

  function handleCropComplete(croppedFile: File, croppedPreviewUrl: string) {
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(croppedFile);
      if (fileInputRef.current) {
        fileInputRef.current.files = dataTransfer.files;
      }
    } catch {
      // Fallback if DataTransfer is restricted
    }

    setPreviewUrl(croppedPreviewUrl);
    setRemoveAvatar(false);
    setRawCropSrc(null);
  }

  function handleCropCancel() {
    setRawCropSrc(null);
    if (!previewUrl && fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleRemove(e: React.MouseEvent) {
    e.stopPropagation();
    setPreviewUrl(null);
    setRemoveAvatar(true);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleTriggerClick() {
    fileInputRef.current?.click();
  }

  const hasImage = Boolean(previewUrl && !removeAvatar);
  const initialLetter = Array.from((displayName || shopName || "ก").trim())[0] ?? "ก";

  return (
    <div className="profile-card-unified">
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

      {/* Left: Circular Avatar (click circle to pick photo) */}
      <div className="profile-avatar-col">
        <div
          className="profile-avatar-preview"
          onClick={handleTriggerClick}
          title="กดตรงรูปโปรไฟล์เพื่อเลือกรูปภาพ"
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
          <div className="profile-avatar-badge" aria-hidden="true" title="เลือกรูปภาพ">
            <Camera size={13} />
          </div>
        </div>

        {hasImage && (
          <button
            type="button"
            className="profile-avatar-remove-link"
            onClick={handleRemove}
            title="ลบรูปโปรไฟล์"
          >
            <Trash2 size={11} />
            <span>ลบรูป</span>
          </button>
        )}
      </div>

      {/* Right: Shop Name & Owner Name with Pencil Edit */}
      <div className="profile-details-col">
        {/* Row 1: Shop Name */}
        <div className="profile-item-row">
          <span className="profile-item-label">ชื่อร้าน (ชื่อบัญชีร้าน)</span>
          {editingShop ? (
            <div className="profile-item-edit-wrap">
              <input
                id="settings-shop"
                name="shop_name"
                value={shopName}
                onChange={(e) => setShopName(e.target.value)}
                onBlur={() => setEditingShop(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    setEditingShop(false);
                  }
                }}
                autoFocus
                maxLength={80}
                required
                placeholder="ชื่อร้าน"
                className="profile-item-input"
              />
              <button
                type="button"
                className="profile-item-done-btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setEditingShop(false)}
                title="เสร็จสิ้น"
                aria-label="เสร็จสิ้น"
              >
                <Check size={14} />
              </button>
            </div>
          ) : (
            <div
              className="profile-item-val-wrap"
              onClick={() => setEditingShop(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setEditingShop(true);
                }
              }}
              title="กดเพื่อแก้ไขชื่อร้าน"
            >
              <strong className="profile-item-value">{shopName || "kaikai"}</strong>
              <button
                type="button"
                className="profile-pencil-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingShop(true);
                }}
                title="แก้ไขชื่อร้าน"
                aria-label="แก้ไขชื่อร้าน"
              >
                <Pencil size={13} />
              </button>
              <input type="hidden" name="shop_name" value={shopName} />
            </div>
          )}
        </div>

        {/* Row 2: Owner / Contact Name */}
        <div className="profile-item-row">
          <span className="profile-item-label">
            ชื่อเจ้าของร้าน / ผู้ติดต่อ <small className="muted-hint">(ไม่บังคับ)</small>
          </span>
          {editingDisplay ? (
            <div className="profile-item-edit-wrap">
              <input
                id="settings-name"
                name="display_name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onBlur={() => setEditingDisplay(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    setEditingDisplay(false);
                  }
                }}
                autoFocus
                maxLength={80}
                placeholder={shopName || "หากเว้นว่างจะใช้ชื่อร้าน"}
                className="profile-item-input"
              />
              <button
                type="button"
                className="profile-item-done-btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setEditingDisplay(false)}
                title="เสร็จสิ้น"
                aria-label="เสร็จสิ้น"
              >
                <Check size={14} />
              </button>
            </div>
          ) : (
            <div
              className="profile-item-val-wrap"
              onClick={() => setEditingDisplay(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setEditingDisplay(true);
                }
              }}
              title="กดเพื่อแก้ไขชื่อผู้ติดต่อ"
            >
              <span className={`profile-item-value ${displayName ? "" : "is-fallback"}`}>
                {displayName ? displayName : `ใช้ชื่อร้าน (${shopName || "kaikai"})`}
              </span>
              <button
                type="button"
                className="profile-pencil-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingDisplay(true);
                }}
                title="แก้ไขชื่อผู้ติดต่อ"
                aria-label="แก้ไขชื่อผู้ติดต่อ"
              >
                <Pencil size={13} />
              </button>
              <input type="hidden" name="display_name" value={displayName} />
            </div>
          )}
        </div>
      </div>

      {rawCropSrc && (
        <ProfileAvatarCropper
          imageSrc={rawCropSrc}
          onCrop={handleCropComplete}
          onCancel={handleCropCancel}
        />
      )}
    </div>
  );
}
