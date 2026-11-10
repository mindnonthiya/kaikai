import { NextResponse } from "next/server";
import { hasSupabaseEnv } from "@/lib/env";
import { verifyLineLiffAccessToken } from "@/lib/line-messaging";
import { DEFAULT_LOYALTY_RULES_TEXT, formatValidTillDate } from "@/lib/loyalty";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const shopSecret = String(body.shopSecret ?? "").trim();
    const liffAccessToken = String(body.liffAccessToken ?? "").trim();
    const clientLineUserId = String(body.lineUserId ?? "").trim();
    const clientDisplayName = String(body.displayName ?? "ลูกค้า LINE").trim() || "ลูกค้า LINE";
    const clientPictureUrl = body.pictureUrl ? String(body.pictureUrl).trim() : null;

    if (!shopSecret) {
      return NextResponse.json(
        { ok: false, code: "MISSING_SHOP_SECRET", message: "ไม่พบรหัสร้านค้าในลิงก์บัตรสะสมแต้ม" },
        { status: 400 },
      );
    }

    // Verify LINE access token when provided; never allow unverified callers to query/mutate a real 'U...' LINE user ID
    let resolvedUserId = "";
    let resolvedDisplayName = clientDisplayName;
    let resolvedPictureUrl = clientPictureUrl;

    if (liffAccessToken) {
      const verified = await verifyLineLiffAccessToken(liffAccessToken);
      if (verified.ok) {
        resolvedUserId = verified.userId;
        resolvedDisplayName = verified.displayName;
        resolvedPictureUrl = verified.pictureUrl;
      }
    } else if (clientLineUserId && !clientLineUserId.startsWith("U")) {
      // Allow non-LINE local preview ID ('web_...') only when testing outside LINE
      resolvedUserId = clientLineUserId;
    }

    if (!hasSupabaseEnv) {
      const now = new Date();
      return NextResponse.json({
        ok: true,
        config: {
          cardTitle: "GaiTomNamPla 🐔",
          cardHeadline: "สะสม 10 กล่อง ลด 50%",
          rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
          stampsPerReward: 10,
          validityMonths: 3,
          cooldownMinutes: 5,
          rulesText: DEFAULT_LOYALTY_RULES_TEXT,
          liffId: "",
          botBasicId: "",
          notifyMode: "all",
        },
        member: {
          lineUserId: resolvedUserId || "demo-user",
          displayName: resolvedDisplayName,
          pictureUrl: resolvedPictureUrl,
          stamps: 1,
          lifetimeStamps: 1,
          expiresAt: new Date(now.getFullYear(), now.getMonth() + 3, now.getDate()).toISOString(),
          validTillFormatted: formatValidTillDate(new Date(now.getFullYear(), now.getMonth() + 3, now.getDate())),
          lastStampedAt: now.toISOString(),
          expiredReset: false,
        },
        coupons: [],
      });
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("get_loyalty_card_state", {
      p_shop_secret: shopSecret,
      p_line_user_id: resolvedUserId,
      p_display_name: resolvedDisplayName,
      p_picture_url: resolvedPictureUrl,
    });

    if (error) {
      if (error.code === "PGRST202" || error.code === "42883" || String(error.message ?? "").includes("get_loyalty_card_state")) {
        return NextResponse.json(
          {
            ok: false,
            code: "MIGRATION_REQUIRED",
            message: "กรุณานำไฟล์ supabase/migrations/202611110001_line_loyalty.sql ไปรันใน Supabase SQL Editor และกดบันทึกการตั้งค่าในหน้าตั้งค่าก่อนเริ่มใช้งาน",
          },
          { status: 503 },
        );
      }
      return NextResponse.json(
        { ok: false, code: "DB_ERROR", message: error.message },
        { status: 500 },
      );
    }

    const result = (data ?? {}) as Record<string, unknown>;
    if (!result.ok) {
      return NextResponse.json(result, { status: 404 });
    }

    const memberRaw = (result.member ?? {}) as Record<string, unknown>;
    const expiresAt = memberRaw.expiresAt ? String(memberRaw.expiresAt) : null;

    return NextResponse.json({
      ...result,
      member: {
        ...memberRaw,
        validTillFormatted: formatValidTillDate(expiresAt),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, code: "SERVER_ERROR", message: err instanceof Error ? err.message : "เกิดข้อผิดพลาด" },
      { status: 500 },
    );
  }
}
