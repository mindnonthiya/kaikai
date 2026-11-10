import { NextResponse } from "next/server";
import { hasSupabaseEnv } from "@/lib/env";
import { sendLinePushMessage } from "@/lib/line-messaging";
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
    const lineUserId = String(body.lineUserId ?? "").trim();
    const displayName = String(body.displayName ?? "ลูกค้า LINE").trim() || "ลูกค้า LINE";
    const sendPush = Boolean(body.sendPush);

    if (!shopSecret || !couponId || !lineUserId) {
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
        displayName,
        claimedAtText,
      });
      const plainText = buildCouponRedeemPlainText({
        cardTitle: "GaiTomNamPla 🐔",
        rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
        couponCode: "GT-DEMO01",
        displayName,
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
        displayName,
        notification: {
          plainText,
          flexMessage,
          pushed: false,
        },
      });
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("redeem_loyalty_coupon", {
      p_shop_secret: shopSecret,
      p_coupon_id: couponId,
      p_line_user_id: lineUserId,
      p_display_name: displayName,
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

    const cardTitle = String(result.cardTitle ?? "GaiTomNamPla 🐔");
    const rewardTitle = String(result.title ?? "ลด 50% เมนูหลัก 1 กล่อง");
    const couponCode = String(result.code ?? "GT-COUPON");
    const claimedAt = String(result.claimedAt ?? new Date().toISOString());
    const claimedAtText = formatThaiDateTime(claimedAt);
    const resolvedName = String(result.displayName ?? displayName);

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

    const channelAccessToken = String(result.channelAccessToken ?? "").trim();
    let pushed = false;
    if (sendPush && channelAccessToken && !result.alreadyClaimed) {
      pushed = await sendLinePushMessage(channelAccessToken, lineUserId, [flexMessage]);
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
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, code: "SERVER_ERROR", message: err instanceof Error ? err.message : "เกิดข้อผิดพลาดในการใช้คูปอง" },
      { status: 500 },
    );
  }
}
