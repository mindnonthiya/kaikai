import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { GeminiOcrProvider } from "@/lib/ocr/gemini";
import { createClient } from "@/lib/supabase/server";

function getActiveOcrProvider() {
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
          if (mKey && mKey[1]?.trim()) {
            apiKey = mKey[1].trim().replace(/^["']|["']$/g, "");
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
    const context = String(formData.get("context") ?? "sale");

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

    // 1. Initial file hash check (owner-scoped)
    let hashDuplicate: { saleNumber?: number; soldAt?: string; expenseDesc?: string } | null = null;
    if (hash) {
      if (context === "expense") {
        const { data: existingExp } = await supabase
          .from("expenses")
          .select("id, description, spent_at")
          .eq("owner_id", user.id)
          .ilike("receipt_path", `%${hash.slice(0, 16)}%`)
          .limit(1)
          .maybeSingle();
        if (existingExp) {
          hashDuplicate = {
            soldAt: existingExp.spent_at,
            expenseDesc: existingExp.description,
          };
        }
      } else {
        const { data: existingSlip } = await supabase
          .from("slip_uploads")
          .select("id, sale_id, created_at, sales(sale_number, sold_at)")
          .eq("owner_id", user.id)
          .eq("file_hash_sha256", hash)
          .maybeSingle();

        if (existingSlip) {
          const rawSale = (existingSlip as unknown as { sales?: { sale_number: number; sold_at: string } | Array<{ sale_number: number; sold_at: string }> | null })?.sales;
          const sale = Array.isArray(rawSale) ? rawSale[0] : rawSale;
          if (sale?.sale_number) {
            hashDuplicate = {
              saleNumber: sale.sale_number,
              soldAt: sale.sold_at,
            };
          } else {
            hashDuplicate = {
              saleNumber: undefined,
              soldAt: existingSlip.created_at,
            };
          }
        }
      }
    }

    let isDuplicate = Boolean(hashDuplicate);
    let duplicateReason = isDuplicate
      ? hashDuplicate?.expenseDesc
        ? `ไฟล์สลิปนี้เคยบันทึกในค่าใช้จ่าย “${hashDuplicate.expenseDesc}” แล้ว`
        : `ไฟล์รูปภาพนี้เคยบันทึกในบิล #${hashDuplicate?.saleNumber ?? "เดิม"}`
      : undefined;
    let duplicateSaleNumber = hashDuplicate?.saleNumber;
    let duplicateSoldAt = hashDuplicate?.soldAt;

    const ocrProvider = getActiveOcrProvider();
    if (!ocrProvider) {
      return NextResponse.json({
        ok: true,
        hasProvider: false,
        hash,
        isDuplicate,
        duplicateReason,
        duplicateSaleNumber,
        duplicateSoldAt,
        message: "ยังไม่ได้ตั้งค่า OCR API Key (สามารถกรอกตัวเลขเองได้)",
      });
    }

    try {
      const ocrResult = await ocrProvider.readSlip(buffer, file.type || "image/webp");

      // 2. Reference Number check (Unique per banking transaction)
      let refDuplicate: { saleNumber?: number; soldAt?: string; ref: string; expenseDesc?: string } | null = null;
      const cleanRef = ocrResult?.referenceNumber?.trim();

      if (cleanRef && cleanRef.length >= 6) {
        if (context === "expense") {
          const { data: expRefMatch } = await supabase
            .from("expenses")
            .select("id, description, spent_at")
            .eq("owner_id", user.id)
            .ilike("notes", `%${cleanRef}%`)
            .limit(1)
            .maybeSingle();
          if (expRefMatch) {
            refDuplicate = {
              soldAt: expRefMatch.spent_at,
              ref: cleanRef,
              expenseDesc: expRefMatch.description,
            };
          }
        } else {
          // A. Check in payments table by reference_number
          const { data: paymentMatch } = await supabase
            .from("payments")
            .select("sale_id, sales(sale_number, sold_at)")
            .eq("owner_id", user.id)
            .eq("reference_number", cleanRef)
            .maybeSingle();

          if (paymentMatch) {
            const rawSale = (paymentMatch as unknown as { sales?: { sale_number: number; sold_at: string } | Array<{ sale_number: number; sold_at: string }> | null })?.sales;
            const sale = Array.isArray(rawSale) ? rawSale[0] : rawSale;
            if (sale?.sale_number) {
              refDuplicate = {
                saleNumber: sale.sale_number,
                soldAt: sale.sold_at,
                ref: cleanRef,
              };
            }
          }

          // B. Check in slip_uploads table by ocr_reference_number
          if (!refDuplicate) {
            const { data: slipRefMatch } = await supabase
              .from("slip_uploads")
              .select("id, sale_id, created_at, sales(sale_number, sold_at)")
              .eq("owner_id", user.id)
              .eq("ocr_reference_number", cleanRef)
              .maybeSingle();

            if (slipRefMatch) {
              const rawSale = (slipRefMatch as unknown as { sales?: { sale_number: number; sold_at: string } | Array<{ sale_number: number; sold_at: string }> | null })?.sales;
              const sale = Array.isArray(rawSale) ? rawSale[0] : rawSale;
              if (sale?.sale_number) {
                refDuplicate = {
                  saleNumber: sale.sale_number,
                  soldAt: sale.sold_at,
                  ref: cleanRef,
                };
              }
            }
          }

          // C. Check in sales.notes if payments/slip_uploads didn't have it
          if (!refDuplicate) {
            const { data: noteMatch } = await supabase
              .from("sales")
              .select("id, sale_number, sold_at")
              .eq("owner_id", user.id)
              .ilike("notes", `%${cleanRef}%`)
              .maybeSingle();

            if (noteMatch) {
              refDuplicate = {
                saleNumber: noteMatch.sale_number,
                soldAt: noteMatch.sold_at,
                ref: cleanRef,
              };
            }
          }
        }
      }

      // If reference duplicate found, it takes highest precedence (more descriptive than file hash)
      if (refDuplicate) {
        isDuplicate = true;
        duplicateSaleNumber = refDuplicate.saleNumber;
        duplicateSoldAt = refDuplicate.soldAt;
        duplicateReason = refDuplicate.expenseDesc
          ? `เลขอ้างอิง Ref: ${cleanRef} ตรงกับค่าใช้จ่าย “${refDuplicate.expenseDesc}”`
          : `เลขอ้างอิง Ref: ${cleanRef} ตรงกับบิล #${refDuplicate.saleNumber ?? "เดิม"}`;
      } else if (hashDuplicate) {
        isDuplicate = true;
        duplicateSaleNumber = hashDuplicate.saleNumber;
        duplicateSoldAt = hashDuplicate.soldAt;
        duplicateReason = hashDuplicate.expenseDesc
          ? `ไฟล์สลิปนี้เคยบันทึกในค่าใช้จ่าย “${hashDuplicate.expenseDesc}” แล้ว`
          : `ไฟล์รูปภาพนี้เคยบันทึกในบิล #${hashDuplicate.saleNumber ?? "เดิม"}`;
      }

      return NextResponse.json({
        ok: true,
        hasProvider: true,
        hash,
        isDuplicate,
        duplicateReason,
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
          duplicateReason,
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
