import { after, NextResponse } from "next/server";
import { hasSupabaseEnv } from "@/lib/env";
import {
  enqueueLoyaltyPushNotification,
  extractLineChannelIdFromLiffId,
  fetchShopLoyaltyServerCredentials,
  processPendingLoyaltyPushJobs,
  verifyLineLiffAccessToken,
} from "@/lib/line-messaging";
import {
  DEFAULT_LOYALTY_CARD_TITLE,
  buildCouponRedeemFlexMessage,
  buildCouponRedeemPlainText,
  formatThaiDateTime,
  isMissingRpcError,
} from "@/lib/loyalty";
import {
  getLegacyLoyaltyServerKeyHash,
  getLoyaltyServerKeyHash,
} from "@/lib/loyalty-crypto";
import { checkLoyaltyRateLimit, resolveClientIp } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

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

    const rate = checkLoyaltyRateLimit({
      route: "redeem",
      ip: resolveClientIp(request),
      shopSecret,
    });
    if (!rate.allowed) {
      return NextResponse.json(
        {
          ok: false,
          code: "RATE_LIMITED",
          message: `คำขอถี่เกินไป กรุณารอ ${rate.retryAfterSeconds} วินาทีแล้วลองใหม่`,
        },
        { status: 429 },
      );
    }

    if (!hasSupabaseEnv) {
      const nowIso = new Date().toISOString();
      const claimedAtText = formatThaiDateTime(nowIso);
      const flexMessage = buildCouponRedeemFlexMessage({
        cardTitle: DEFAULT_LOYALTY_CARD_TITLE,
        rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
        couponCode: "GT-DEMO01",
        displayName: clientDisplayName,
        claimedAtText,
      });
      const plainText = buildCouponRedeemPlainText({
        cardTitle: DEFAULT_LOYALTY_CARD_TITLE,
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
          queued: false,
          pushReason: "DEMO_MODE",
        },
      });
    }

    const supabase = await createSupabaseServiceClient();
    const [creds, verification] = await Promise.all([
      fetchShopLoyaltyServerCredentials(supabase, shopSecret),
      liffAccessToken ? verifyLineLiffAccessToken(liffAccessToken) : Promise.resolve(null),
    ]);

    let verifiedLineUserId = "";
    let verifiedDisplayName = clientDisplayName;

    if (liffAccessToken && verification) {
      const expectedChannelId = extractLineChannelIdFromLiffId(creds.liffId);
      if (
        !verification.ok ||
        !verification.clientId ||
        (expectedChannelId && verification.clientId !== expectedChannelId)
      ) {
        return NextResponse.json(
          {
            ok: false,
            code: "LINE_AUTH_REQUIRED",
            message: "เชื่อมต่อ LINE ไม่สำเร็จ กรุณาเปิดผ่านแอป LINE อีกครั้ง",
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
          message: "เชื่อมต่อ LINE ไม่สำเร็จ กรุณาลองใหม่",
        },
        { status: 401 },
      );
    }

    const primaryHash = getLoyaltyServerKeyHash(shopSecret);
    const legacyHash = getLegacyLoyaltyServerKeyHash(shopSecret);

    const { data, error } = await supabase.rpc("redeem_loyalty_coupon", {
      p_shop_secret: shopSecret,
      p_coupon_id: couponId,
      p_line_user_id: verifiedLineUserId,
      p_display_name: verifiedDisplayName,
      p_server_key_hash: primaryHash,
      p_legacy_key_hash: legacyHash,
    });

    if (error) {
      if (isMissingRpcError(error) || String(error.message ?? "").includes("redeem_loyalty_coupon")) {
        return NextResponse.json(
          {
            ok: false,
            code: "MIGRATION_REQUIRED",
            message: "กรุณานำไฟล์ supabase/migrations/202611120001_loyalty_security_hardening.sql ไปรันใน Supabase SQL Editor ก่อนใช้งาน",
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

    const cardTitle = String(result.cardTitle ?? creds.cardTitle ?? DEFAULT_LOYALTY_CARD_TITLE);
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

    let queued = false;
    let pushReason = "ALREADY_CLAIMED";
    if (!result.alreadyClaimed) {
      if (creds.notifyMode === "off") {
        pushReason = "NOTIFY_MODE_OFF";
      } else if (!verifiedLineUserId.startsWith("U")) {
        pushReason = "NOT_LINE_USER_ID";
      } else if (!creds.channelAccessToken) {
        pushReason = creds.credentialsLocked ? "CREDENTIALS_NEED_RESAVE" : "MISSING_CHANNEL_ACCESS_TOKEN";
      } else {
        const atomicallyQueued = Boolean(result.pushQueued || result.pushJobId);
        queued = true;
        pushReason = "QUEUED_BACKGROUND";

        after(async () => {
          try {
            const bgSupabase = await createSupabaseServiceClient();
            if (!atomicallyQueued) {
              await enqueueLoyaltyPushNotification(bgSupabase, {
                shopSecret,
                lineUserId: verifiedLineUserId,
                eventType: "coupon_redeem",
                messages: [flexMessage],
                fallbackPlainText: plainText,
              });
            }
            await processPendingLoyaltyPushJobs(
              bgSupabase,
              shopSecret,
              creds.channelAccessToken,
              {
                lineUserId: verifiedLineUserId,
                messages: [flexMessage],
                fallbackPlainText: plainText,
              },
              request.url,
            );
          } catch {
            // Background push errors are recorded in loyalty_push_queue
          }
        });
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
        pushed: queued,
        queued,
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
