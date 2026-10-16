import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { GeminiOcrProvider } from "@/lib/ocr/gemini";
import { createClient } from "@/lib/supabase/server";

function getActiveOcrProvider() {
  let provider = (process.env.OCR_PROVIDER ?? "").toLowerCase().trim();
  let apiKey = (process.env.OCR_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim();

  // If empty in process.env, read directly from .env.local / .env.cloud on disk
  if (!apiKey) {
    try {
      const cwd = process.cwd();
      const envFiles = [".env.local", ".env.cloud", ".env"];
      for (const f of envFiles) {
        const fullPath = path.join(cwd, f);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, "utf-8");
          const mKey = content.match(/OCR_API_KEY\s*=\s*([^\r\n]+)/);
          const mProv = content.match(/OCR_PROVIDER\s*=\s*([^\r\n]+)/);
          if (mKey && mKey[1]?.trim()) {
            apiKey = mKey[1].trim().replace(/^["']|["']$/g, "");
            if (mProv && mProv[1]?.trim()) {
              provider = mProv[1].trim().replace(/^["']|["']$/g, "").toLowerCase();
            }
            if (apiKey) break;
          }
        }
      }
    } catch (err) {
      console.error("[analyze/route] Error reading env file:", err);
    }
  }

  if (!apiKey) return null;
  return new GeminiOcrProvider(apiKey);
}

export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const clientHash = formData.get("hash") as string | null;

    if (!file) {
      return NextResponse.json({ ok: false, error: "กรุณาแนบไฟล์รูปสลิป" }, { status: 400 });
    }

    const buffer = await file.arrayBuffer();

    // Compute or verify SHA-256
    let hash = clientHash;
    if (!hash) {
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      hash = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
    }

    // Check duplicate slip in database
    let isDuplicate = false;
    let duplicateSaleNumber: number | null = null;
    let duplicateSoldAt: string | null = null;

    const { data: existingSlip } = await supabase
      .from("slip_uploads")
      .select("id, sale_id, created_at, sales(sale_number, sold_at)")
      .eq("file_hash_sha256", hash)
      .maybeSingle();

    if (existingSlip) {
      isDuplicate = true;
      const sale = (existingSlip as unknown as { sales?: { sale_number: number; sold_at: string } | null })?.sales;
      if (sale) {
        duplicateSaleNumber = sale.sale_number;
        duplicateSoldAt = sale.sold_at;
      }
    }

    const ocrProvider = getActiveOcrProvider();
    if (!ocrProvider) {
      return NextResponse.json({
        ok: true,
        hasProvider: false,
        hash,
        isDuplicate,
        duplicateSaleNumber,
        duplicateSoldAt,
        message: "ยังไม่ได้ตั้งค่า OCR API Key (สามารถกรอกตัวเลขเองได้)",
      });
    }

    try {
      const ocrResult = await ocrProvider.readSlip(buffer, file.type || "image/webp");
      return NextResponse.json({
        ok: true,
        hasProvider: true,
        hash,
        isDuplicate,
        duplicateSaleNumber,
        duplicateSoldAt,
        result: ocrResult,
      });
    } catch (ocrErr: unknown) {
      console.error("OCR reading failed:", ocrErr);
      const msg = ocrErr instanceof Error ? ocrErr.message : "อ่านสลิปไม่สำเร็จ กรุณากรอกยอดเงินด้วยตนเอง";
      const isRateLimit = /429|resource_exhausted|quota|exceeded/i.test(msg);
      return NextResponse.json(
        {
          ok: false,
          hasProvider: true,
          hash,
          isDuplicate,
          duplicateSaleNumber,
          duplicateSoldAt,
          isRateLimit,
          error: isRateLimit
            ? "ระบบกำลังรอคิวอ่านสลิปจาก Google AI (โควตาชั่วคราว)"
            : msg,
        },
        { status: isRateLimit ? 429 : 200 }
      );
    }
  } catch (err: unknown) {
    console.error("Analyze slip route error:", err);
    const msg = err instanceof Error ? err.message : "เกิดข้อผิดพลาดในการประมวลผล";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
