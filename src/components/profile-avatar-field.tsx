"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, Check, Pencil, Trash2 } from "lucide-react";
import { saveProfile } from "@/app/actions/settings";
import { DEFAULT_SHOP_ID, getClientActiveShopId } from "@/lib/shop-scope";
import { ProfileAvatarCropper } from "./profile-avatar-cropper";

export const AVATAR_STORAGE_KEY = "kaikai_profile_avatar";
export const AVATAR_REMOVED_KEY = "kaikai_profile_avatar_removed";
export const AVATAR_UPDATED_EVENT = "kaikai:avatar-updated";

export function getAvatarStorageKey(shopId?: string): string {
  const id = shopId || getClientActiveShopId();
  return id === DEFAULT_SHOP_ID ? AVATAR_STORAGE_KEY : `${AVATAR_STORAGE_KEY}:${id}`;
}

export function getAvatarRemovedKey(shopId?: string): string {
  const id = shopId || getClientActiveShopId();
  return id === DEFAULT_SHOP_ID ? AVATAR_REMOVED_KEY : `${AVATAR_REMOVED_KEY}:${id}`;
}

export function notifyAvatarUpdated(avatarUrl: string | null, shopId?: string) {
  if (typeof window === "undefined") return;
  try {
    const storageKey = getAvatarStorageKey(shopId);
    const removedKey = getAvatarRemovedKey(shopId);
    if (avatarUrl) {
      window.localStorage.setItem(storageKey, avatarUrl);
      window.localStorage.removeItem(removedKey);
    } else {
      window.localStorage.removeItem(storageKey);
      window.localStorage.setItem(removedKey, "true");
    }
    window.dispatchEvent(new CustomEvent(AVATAR_UPDATED_EVENT, { detail: { avatarUrl, shopId } }));
  } catch {
    // Ignore storage quota or private mode errors
  }
}

export function ProfileAvatarField({
  shopId = DEFAULT_SHOP_ID,
  currentAvatar,
  initialShopName,
  initialDisplayName,
}: {
  shopId?: string;
  currentAvatar?: string | null;
  initialShopName: string;
  initialDisplayName?: string;
}) {
  const router = useRouter();
  const [previewUrl, setPreviewUrl] = useState<string | null>(currentAvatar ?? null);
  const [avatarDataUrl, setAvatarDataUrl] = useState<string>(
    currentAvatar && currentAvatar.startsWith("data:image/") ? currentAvatar : "",
  );
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [rawCropSrc, setRawCropSrc] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ type: "saving" | "saved" | "error"; text: string } | null>(null);
  const [, startSaveTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [shopName, setShopName] = useState(initialShopName || "kaikai");
  const [displayName, setDisplayName] = useState(initialDisplayName || "");
  const [editingShop, setEditingShop] = useState(false);
  const [editingDisplay, setEditingDisplay] = useState(false);

  // Sync shopName and displayName when switching shops
  useEffect(() => {
    setShopName(initialShopName || "kaikai");
    setDisplayName(initialDisplayName || "");
    setEditingShop(false);
    setEditingDisplay(false);
    setSaveStatus(null);
  }, [shopId, initialShopName, initialDisplayName]);

  // Sync with server-provided currentAvatar or shop-scoped localStorage fallback
  useEffect(() => {
    setImgFailed(false);
    const storageKey = getAvatarStorageKey(shopId);
    const removedKey = getAvatarRemovedKey(shopId);
    if (currentAvatar) {
      setPreviewUrl(currentAvatar);
      if (currentAvatar.startsWith("data:image/")) {
        setAvatarDataUrl(currentAvatar);
      }
      setRemoveAvatar(false);
      try {
        window.localStorage.setItem(storageKey, currentAvatar);
        window.localStorage.removeItem(removedKey);
      } catch {
        // Ignore
      }
    } else {
      try {
        const wasRemoved = window.localStorage.getItem(removedKey) === "true";
        const cached = window.localStorage.getItem(storageKey);
        if (!wasRemoved && cached) {
          setPreviewUrl(cached);
          if (cached.startsWith("data:image/")) {
            setAvatarDataUrl(cached);
          }
        } else {
          setPreviewUrl(null);
          setAvatarDataUrl("");
        }
      } catch {
        setPreviewUrl(null);
        setAvatarDataUrl("");
      }
    }
  }, [currentAvatar, shopId]);

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

  function handleCropComplete(croppedFile: File, croppedDataUrl: string) {
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(croppedFile);
      if (fileInputRef.current) {
        fileInputRef.current.files = dataTransfer.files;
      }
    } catch {
      // Fallback via hidden avatar_data_url input
    }

    setImgFailed(false);
    setPreviewUrl(croppedDataUrl);
    setAvatarDataUrl(croppedDataUrl);
    setRemoveAvatar(false);
    setRawCropSrc(null);
    notifyAvatarUpdated(croppedDataUrl, shopId);

    // Auto-save immediately so the avatar sticks right after clicking "ใช้รูปนี้"
    setSaveStatus({ type: "saving", text: "กำลังบันทึกรูป…" });
    startSaveTransition(async () => {
      const fd = new FormData();
      fd.set("shop_name", (shopName || "kaikai").trim() || "kaikai");
      fd.set("display_name", displayName.trim());
      fd.set("remove_avatar", "false");
      fd.set("avatar_data_url", croppedDataUrl);
      fd.set("avatar", croppedFile);
      const res = await saveProfile(fd);
      if (res.ok) {
        setSaveStatus({ type: "saved", text: "บันทึกรูปแล้ว ✓" });
        if (fileInputRef.current) fileInputRef.current.value = "";
        router.refresh();
      } else {
        setSaveStatus({ type: "error", text: res.error ?? "บันทึกรูปไม่สำเร็จ" });
      }
    });
  }

  function handleCropCancel() {
    setRawCropSrc(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleRemove(e: React.MouseEvent) {
    e.stopPropagation();
    setPreviewUrl(null);
    setAvatarDataUrl("");
    setRemoveAvatar(true);
    setImgFailed(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    notifyAvatarUpdated(null, shopId);

    setSaveStatus({ type: "saving", text: "กำลังลบรูป…" });
    startSaveTransition(async () => {
      const fd = new FormData();
      fd.set("shop_name", (shopName || "kaikai").trim() || "kaikai");
      fd.set("display_name", displayName.trim());
      fd.set("remove_avatar", "true");
      fd.set("avatar_data_url", "");
      const res = await saveProfile(fd);
      if (res.ok) {
        setSaveStatus({ type: "saved", text: "ลบรูปโปรไฟล์แล้ว" });
        router.refresh();
      } else {
        setSaveStatus({ type: "error", text: res.error ?? "ลบรูปไม่สำเร็จ" });
      }
    });
  }

  function handleTriggerClick() {
    fileInputRef.current?.click();
  }

  const hasImage = Boolean(previewUrl && !removeAvatar && !imgFailed);
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
      <input type="hidden" name="avatar_data_url" value={removeAvatar ? "" : avatarDataUrl} />

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
            <img
              src={previewUrl!}
              alt="รูปโปรไฟล์"
              className="profile-avatar-img"
              onError={() => setImgFailed(true)}
            />
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

        {saveStatus && (
          <span className={`profile-avatar-status ${saveStatus.type}`} role="status">
            {saveStatus.text}
          </span>
        )}
      </div>

      {/* Right: Shop Name & Owner Name with Pencil Edit */}
      <div className="profile-details-col">
        {/* Row 1: Shop Name */}
        <div className="profile-item-row">
          <span className="profile-item-label">ชื่อร้าน (ร้านที่กำลังเปิดอยู่)</span>
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
