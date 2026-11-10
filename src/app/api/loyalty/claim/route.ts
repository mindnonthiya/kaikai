import { NextResponse } from "next/server";
import { hasSupabaseEnv } from "@/lib/env";
import { sendLinePushMessage } from "@/lib/line-messaging";
import {
  buildLoyaltyCardUrl,
  buildStampAwardFlexMessage,
  buildStampAwardPlainText,
  formatValidTillDate,
} from "@/lib/loyalty";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const shopSecret = String(body.shopSecret ?? "").trim();
    const points = Math.round(Number(body.points ?? 0));
    const token = String(body.token ?? "").trim();
    const lineUserId = String(body.lineUserId ?? "").trim();
    const displayName = String(body.displayName ?? "ลูกค้า LINE").trim() || "ลูกค้า LINE";
    const pictureUrl = body.pictureUrl ? String(body.pictureUrl).trim() : null;
    const sendPush = Boolean(body.sendPush);

    if (!shopSecret || !token || !lineUserId || points < 1 || points > 10) {
      return NextResponse.json(
        { ok: false, code: "INVALID_PARAMS", message: "ข้อมูลคิวอาร์โค้ดสะสมแต้มไม่ครบถ้วนหรือไม่ถูกต้อง" },
        { status: 400 },
      );
    }

    const requestOrigin = new URL(request.url).origin;

    if (!hasSupabaseEnv) {
      const validTill = formatValidTillDate(new Date(Date.now() + 90 * 24 * 60 * 60 * 1000));
      const cardUrl = buildLoyaltyCardUrl(requestOrigin, shopSecret, "");
      const flexMessage = buildStampAwardFlexMessage({
        cardTitle: "GaiTomNamPla 🐔",
        rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
        displayName,
        pointsAdded: points,
        newStamps: points % 10,
        stampsPerReward: 10,
        rewardsUnlocked: Math.floor(points / 10),
        validTill,
        cardUrl,
      });
      const plainText = buildStampAwardPlainText({
        cardTitle: "GaiTomNamPla 🐔",
        rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
        displayName,
        pointsAdded: points,
        newStamps: points % 10,
        stampsPerReward: 10,
        rewardsUnlocked: Math.floor(points / 10),
        validTill,
      });
      return NextResponse.json({
        ok: true,
        pointsAdded: points,
        previousStamps: 0,
        newStamps: points % 10,
        stampsPerReward: 10,
        stampsRemaining: 10 - (points % 10),
        rewardsUnlocked: Math.floor(points / 10),
        validTillFormatted: validTill,
        notification: {
          plainText,
          flexMessage,
          pushed: false,
        },
      });
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("claim_loyalty_stamps", {
      p_shop_secret: shopSecret,
      p_points: points,
      p_token: token,
      p_line_user_id: lineUserId,
      p_display_name: displayName,
      p_picture_url: pictureUrl,
    });

    if (error) {
      if (error.code === "PGRST202" || error.code === "42883" || String(error.message ?? "").includes("claim_loyalty_stamps")) {
        return NextResponse.json(
          {
            ok: false,
            code: "MIGRATION_REQUIRED",
            message: "กรุณานำไฟล์ supabase/migrations/202611110001_line_loyalty.sql ไปรันใน Supabase SQL Editor ก่อนใช้งาน",
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
      const status = result.code === "COOLDOWN_ACTIVE" ? 429 : result.code === "INVALID_QR_TOKEN" ? 403 : 400;
      return NextResponse.json(result, { status });
    }

    const cardTitle = String(result.cardTitle ?? "GaiTomNamPla 🐔");
    const rewardTitle = String(result.rewardTitle ?? "ลด 50% เมนูหลัก 1 กล่อง");
    const pointsAdded = Number(result.pointsAdded ?? points);
    const newStamps = Number(result.newStamps ?? 0);
    const stampsPerReward = Number(result.stampsPerReward ?? 10);
    const rewardsUnlocked = Number(result.rewardsUnlocked ?? 0);
    const expiresAt = result.expiresAt ? String(result.expiresAt) : null;
    const validTill = formatValidTillDate(expiresAt);
    const cardUrl = buildLoyaltyCardUrl(requestOrigin, shopSecret, "");

    const flexMessage = buildStampAwardFlexMessage({
      cardTitle,
      rewardTitle,
      displayName: String(result.displayName ?? displayName),
      pointsAdded,
      newStamps,
      stampsPerReward,
      rewardsUnlocked,
      validTill,
      cardUrl,
    });

    const plainText = buildStampAwardPlainText({
      cardTitle,
      rewardTitle,
      displayName: String(result.displayName ?? displayName),
      pointsAdded,
      newStamps,
      stampsPerReward,
      rewardsUnlocked,
      validTill,
    });

    const channelAccessToken = String(result.channelAccessToken ?? "").trim();
    let pushed = false;
    if (sendPush && channelAccessToken) {
      pushed = await sendLinePushMessage(channelAccessToken, lineUserId, [flexMessage]);
    }

    // Never leak channelAccessToken in public response
    const safeResult = { ...result };
    delete safeResult.channelAccessToken;

    return NextResponse.json({
      ...safeResult,
      validTillFormatted: validTill,
      notification: {
        plainText,
        flexMessage,
        pushed,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, code: "SERVER_ERROR", message: err instanceof Error ? err.message : "เกิดข้อผิดพลาดในการสะสมแต้ม" },
      { status: 500 },
    );
  }
}
