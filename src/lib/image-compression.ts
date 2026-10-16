/**
 * Client-side slip image compression & SHA-256 hashing.
 * Compresses raw high-res receipts/slips (~1-3MB) to compact WebP (~25-35KB),
 * keeping all text, numbers, and QR codes crisp while minimizing Supabase Storage usage.
 */

export type CompressedSlip = {
  file: File;
  blob: Blob;
  hash: string;
  originalBytes: number;
  compressedBytes: number;
  width: number;
  height: number;
  previewUrl: string;
};

export async function computeSha256Hex(blob: Blob): Promise<string> {
  const buffer = typeof blob.arrayBuffer === "function"
    ? await blob.arrayBuffer()
    : await new Response(blob).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function compressSlipImage(
  source: File,
  options: {
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;
  } = {}
): Promise<CompressedSlip> {
  const maxWidth = options.maxWidth ?? 720;
  const maxHeight = options.maxHeight ?? 1440;
  const quality = options.quality ?? 0.65;

  // Load into HTMLImageElement
  const objectUrl = URL.createObjectURL(source);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("ไม่สามารถเปิดไฟล์รูปภาพได้"));
    el.src = objectUrl;
  });

  // Calculate target dimensions
  let { naturalWidth: width, naturalHeight: height } = img;
  if (width > maxWidth) {
    height = Math.round((height * maxWidth) / width);
    width = maxWidth;
  }
  if (height > maxHeight) {
    width = Math.round((width * maxHeight) / height);
    height = maxHeight;
  }

  // Draw to Canvas
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    URL.revokeObjectURL(objectUrl);
    throw new Error("Canvas context is unavailable");
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);

  // Convert to WebP blob (fallback to JPEG if webp fails)
  let blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/webp", quality);
  });

  let mimeType = "image/webp";
  let extension = "webp";

  if (!blob || blob.type !== "image/webp") {
    blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.7);
    });
    mimeType = "image/jpeg";
    extension = "jpg";
  }

  URL.revokeObjectURL(objectUrl);

  if (!blob) throw new Error("การบีบอัดภาพไม่สำเร็จ");

  const hash = await computeSha256Hex(blob);
  const baseName = source.name.replace(/\.[^/.]+$/, "");
  const compressedFile = new File([blob], `${baseName}.${extension}`, { type: mimeType });
  const previewUrl = URL.createObjectURL(blob);

  return {
    file: compressedFile,
    blob,
    hash,
    originalBytes: source.size,
    compressedBytes: blob.size,
    width,
    height,
    previewUrl,
  };
}
