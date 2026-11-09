"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Minus, Plus, X, ZoomIn } from "lucide-react";

export function ProfileAvatarCropper({
  imageSrc,
  onCrop,
  onCancel,
}: {
  imageSrc: string;
  onCrop: (croppedFile: File, dataUrl: string) => void;
  onCancel: () => void;
}) {
  const [imgElement, setImgElement] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, initialOffsetX: 0, initialOffsetY: 0 });

  const VIEW_SIZE = 280;
  const CROP_DIAMETER = 220;

  // Load image to get natural dimensions
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      setImgElement(img);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    };
    img.src = imageSrc;
  }, [imageSrc]);

  if (!imgElement) {
    return (
      <div className="crop-modal-scrim" onClick={onCancel}>
        <div className="crop-modal-card" onClick={(e) => e.stopPropagation()}>
          <div className="crop-loading">กำลังโหลดรูปภาพ…</div>
        </div>
      </div>
    );
  }

  const { naturalWidth, naturalHeight } = imgElement;
  const baseScale = Math.max(CROP_DIAMETER / naturalWidth, CROP_DIAMETER / naturalHeight);
  const currentScale = baseScale * zoom;

  // Drag handlers
  function handlePointerDown(e: React.PointerEvent) {
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      initialOffsetX: offset.x,
      initialOffsetY: offset.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!isDragging) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setOffset({
      x: dragStartRef.current.initialOffsetX + dx,
      y: dragStartRef.current.initialOffsetY + dy,
    });
  }

  function handlePointerUp(e: React.PointerEvent) {
    setIsDragging(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore if pointer capture already released
    }
  }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    const delta = -e.deltaY * 0.002;
    setZoom((prev) => Math.min(3, Math.max(1, prev + delta)));
  }

  // Crop execution
  async function handleApply() {
    if (!imgElement) return;

    const OUTPUT_SIZE = 256;
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // Fill white background for transparent images and transform identically to the viewport
    const ratio = OUTPUT_SIZE / CROP_DIAMETER;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    ctx.save();
    ctx.translate(OUTPUT_SIZE / 2 + offset.x * ratio, OUTPUT_SIZE / 2 + offset.y * ratio);
    ctx.scale(currentScale * ratio, currentScale * ratio);
    ctx.drawImage(imgElement, -naturalWidth / 2, -naturalHeight / 2, naturalWidth, naturalHeight);
    ctx.restore();

    let dataUrl = canvas.toDataURL("image/webp", 0.82);
    let mimeType = "image/webp";
    let ext = "webp";
    if (!dataUrl.startsWith("data:image/webp")) {
      dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      mimeType = "image/jpeg";
      ext = "jpg";
    }

    let blob: Blob | null = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), mimeType, 0.84);
    });

    if (!blob) {
      const base64Part = dataUrl.split(",")[1] ?? "";
      const binary = atob(base64Part);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes], { type: mimeType });
    }

    const fileName = `avatar_${Date.now()}.${ext}`;
    const croppedFile = new File([blob], fileName, { type: mimeType });
    onCrop(croppedFile, dataUrl);
  }

  return (
    <div className="crop-modal-scrim" onClick={onCancel} role="dialog" aria-modal="true">
      <div className="crop-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="crop-modal-header">
          <div>
            <h3>ครอบรูปโปรไฟล์</h3>
            <p>เลื่อนและซูมเพื่อจัดตำแหน่งในกรอบวงกลม</p>
          </div>
          <button type="button" className="crop-close-btn" onClick={onCancel} aria-label="ปิด">
            <X size={18} />
          </button>
        </div>

        {/* Crop Viewport with Circular Mask */}
        <div
          className="crop-viewport"
          style={{ width: `${VIEW_SIZE}px`, height: `${VIEW_SIZE}px` }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageSrc}
            alt="พรีวิวครอบรูป"
            className="crop-image"
            draggable={false}
            style={{
              transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${currentScale})`,
            }}
          />

          {/* Circular Cutout Mask */}
          <div
            className="crop-mask-circle"
            style={{ width: `${CROP_DIAMETER}px`, height: `${CROP_DIAMETER}px` }}
          />
        </div>

        {/* Zoom Slider */}
        <div className="crop-controls">
          <button
            type="button"
            className="crop-zoom-btn"
            onClick={() => setZoom((prev) => Math.max(1, prev - 0.2))}
            title="ซูมออก"
            aria-label="ซูมออก"
          >
            <Minus size={15} />
          </button>
          <div className="crop-slider-wrap">
            <ZoomIn size={14} className="crop-zoom-icon" />
            <input
              type="range"
              min="1"
              max="3"
              step="0.05"
              value={zoom}
              onChange={(e) => setZoom(parseFloat(e.target.value))}
              aria-label="ระดับการซูม"
            />
          </div>
          <button
            type="button"
            className="crop-zoom-btn"
            onClick={() => setZoom((prev) => Math.min(3, prev + 0.2))}
            title="ซูมเข้า"
            aria-label="ซูมเข้า"
          >
            <Plus size={15} />
          </button>
        </div>

        <small className="crop-hint">แตะลากบนรูปภาพเพื่อเลื่อนตำแหน่ง</small>

        {/* Actions */}
        <div className="crop-modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            ยกเลิก
          </button>
          <button type="button" className="primary-button crop-confirm-btn" onClick={handleApply}>
            <Check size={16} />
            <span>ใช้รูปนี้</span>
          </button>
        </div>
      </div>
    </div>
  );
}
