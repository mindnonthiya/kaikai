import { NextResponse } from "next/server";
import { hasSupabaseEnv } from "@/lib/env";
import {
  fetchShopLoyaltyServerCredentials,
  sendLinePushMessageDetailed,
  verifyLineLiffAccessToken,
} from "@/lib/line-messaging";
import {
  buildCouponRedeemFlexMessage,
  buildCouponRedeemPlainText,
  formatThaiDateTime,
} from "@/lib/loyalty";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const shopSecret = String(body.shopSecret ?? "").trim();
    const couponId = String(body.couponId ?? "").trim();
    const liffAccessToken = String(body.liffAccessToken ?? "").trim();
    const clientLineUserId = String(body.lineUserId ?? "").trim();
    const clientDisplayName = String(body.displayName ?? "ลูกค้า LINE").trim() || "ลูกค้า LINE";

    if (!shopSecret || !couponId) {
      return NextResponse.json(
        { ok: false, code: "INVALID_PARAMS", message: "ข้อมูลคูปองส่วนลดไม่ครบถ้วน" },
        { status: 400 },
      );
    }

    if (!hasSupabaseEnv) {
      const nowIso = new Date().toISOString();
      const claimedAtText = formatThaiDateTime(nowIso);
      const flexMessage = buildCouponRedeemFlexMessage({
        cardTitle: "GaiTomNamPla 🐔",
        rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
        couponCode: "GT-DEMO01",
        displayName: clientDisplayName,
        claimedAtText,
      });
      const plainText = buildCouponRedeemPlainText({
        cardTitle: "GaiTomNamPla 🐔",
        rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
        couponCode: "GT-DEMO01",
        displayName: clientDisplayName,
        claimedAtText,
      });
      return NextResponse.json({
        ok: true,
        alreadyClaimed: false,
        couponId,
        code: "GT-DEMO01",
        title: "ลด 50% เมนูหลัก 1 กล่อง",
        claimedAt: nowIso,
        claimedAtFormatted: claimedAtText,
        displayName: clientDisplayName,
        notification: {
          plainText,
          flexMessage,
          pushed: false,
          pushReason: "DEMO_MODE",
        },
      });
    }

    const supabase = await createSupabaseServerClient();
    const creds = await fetchShopLoyaltyServerCredentials(supabase, shopSecret);

    let verifiedLineUserId = "";
    let verifiedDisplayName = clientDisplayName;

    if (liffAccessToken) {
      const verification = await verifyLineLiffAccessToken(liffAccessToken, creds.liffId);
      if (!verification.ok) {
        return NextResponse.json(
          {
            ok: false,
            code: "LINE_AUTH_REQUIRED",
            message: "ยืนยันตัวตน LINE ไม่สำเร็จหรือเซสชันหมดอายุ กรุณาเปิดผ่านแอป LINE อีกครั้ง",
          },
          { status: 401 },
        );
      }
      verifiedLineUserId = verification.userId;
      verifiedDisplayName = verification.displayName;
    } else if (creds.liffId) {
      return NextResponse.json(
        {
          ok: false,
          code: "LINE_AUTH_REQUIRED",
          message: "กรุณาเปิดบัตรสะสมแต้มผ่านแอป LINE เพื่อยืนยันตัวตนก่อนใช้คูปอง",
        },
        { status: 401 },
      );
    } else if (clientLineUserId && !clientLineUserId.startsWith("U")) {
      verifiedLineUserId = clientLineUserId;
    } else {
      return NextResponse.json(
        {
          ok: false,
          code: "LINE_AUTH_REQUIRED",
          message: "ไม่พบข้อมูลยืนยันตัวตนลูกค้า กรุณาเปิดผ่านแอป LINE",
        },
        { status: 401 },
      );
    }

    const { data, error } = await supabase.rpc("redeem_loyalty_coupon", {
      p_shop_secret: shopSecret,
      p_coupon_id: couponId,
      p_line_user_id: verifiedLineUserId,
      p_display_name: verifiedDisplayName,
    });

    if (error) {
      return NextResponse.json(
        { ok: false, code: "DB_ERROR", message: error.message },
        { status: 500 },
      );
    }

    const result = (data ?? {}) as Record<string, unknown>;
    if (!result.ok) {
      return NextResponse.json(result, { status: 404 });
    }

    const cardTitle = String(result.cardTitle ?? creds.cardTitle ?? "GaiTomNamPla 🐔");
    const rewardTitle = String(result.title ?? creds.rewardTitle ?? "ลด 50% เมนูหลัก 1 กล่อง");
    const couponCode = String(result.code ?? "GT-COUPON");
    const claimedAt = String(result.claimedAt ?? new Date().toISOString());
    const claimedAtText = formatThaiDateTime(claimedAt);
    const resolvedName = String(result.displayName ?? verifiedDisplayName);

    const flexMessage = buildCouponRedeemFlexMessage({
      cardTitle,
      rewardTitle,
      couponCode,
      displayName: resolvedName,
      claimedAtText,
    });

    const plainText = buildCouponRedeemPlainText({
      cardTitle,
      rewardTitle,
      couponCode,
      displayName: resolvedName,
      claimedAtText,
    });

    const finalCredentials = creds.channelAccessToken
      ? creds
      : await fetchShopLoyaltyServerCredentials(supabase, shopSecret, {
          channelAccessToken: typeof result.channelAccessToken === "string" ? result.channelAccessToken : "",
          liffId: String(result.liffId ?? ""),
          notifyMode: String(result.notifyMode ?? "all"),
        });

    let pushed = false;
    let pushReason = "ALREADY_CLAIMED";
    if (!result.alreadyClaimed) {
      if (finalCredentials.notifyMode === "off") {
        pushReason = "NOTIFY_MODE_OFF";
      } else {
        const pushRes = await sendLinePushMessageDetailed(
          finalCredentials.channelAccessToken,
          verifiedLineUserId,
          [flexMessage],
          plainText,
        );
        pushed = pushRes.ok;
        pushReason = pushRes.reason ?? (pushRes.ok ? "PUSH_REQUEST_ACCEPTED" : "PUSH_FAILED");
      }
    }

    const safeResult = { ...result };
    delete safeResult.channelAccessToken;

    return NextResponse.json({
      ...safeResult,
      claimedAtFormatted: claimedAtText,
      notification: {
        plainText,
        flexMessage,
        pushed,
        pushReason,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, code: "SERVER_ERROR", message: err instanceof Error ? err.message : "เกิดข้อผิดพลาดในการใช้คูปอง" },
      { status: 500 },
    );
  }
}
