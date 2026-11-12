import { after, NextResponse } from "next/server";
import { hasSupabaseEnv } from "@/lib/env";
import {
  enqueueLoyaltyPushNotification,
  fetchShopLoyaltyServerCredentials,
  processPendingLoyaltyPushJobs,
  verifyLineLiffAccessToken,
} from "@/lib/line-messaging";
import {
  DEFAULT_LOYALTY_CARD_TITLE,
  type LoyaltyNotifyMode,
  buildLoyaltyCardUrl,
  buildStampAwardFlexMessage,
  buildStampAwardPlainText,
  formatValidTillDate,
  resolveTrustedAppOrigin,
  shouldSendStampPushNotification,
} from "@/lib/loyalty";
import { checkLoyaltyRateLimit, resolveClientIp } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const shopSecret = String(body.shopSecret ?? "").trim();
    const points = Math.round(Number(body.points ?? 0));
    const token = String(body.token ?? "").trim();
    const liffAccessToken = String(body.liffAccessToken ?? "").trim();
    const clientLineUserId = String(body.lineUserId ?? "").trim();
    const clientDisplayName = String(body.displayName ?? "ลูกค้า LINE").trim() || "ลูกค้า LINE";
    const clientPictureUrl = body.pictureUrl ? String(body.pictureUrl).trim() : null;

    if (!shopSecret || !token || points < 1 || points > 10) {
      return NextResponse.json(
        { ok: false, code: "INVALID_PARAMS", message: "ข้อมูลคิวอาร์โค้ดสะสมแต้มไม่ครบถ้วนหรือไม่ถูกต้อง" },
        { status: 400 },
      );
    }

    const rate = checkLoyaltyRateLimit({
      route: "claim",
      ip: resolveClientIp(request),
      shopSecret,
    });
    if (!rate.allowed) {
      return NextResponse.json(
        {
          ok: false,
          code: "RATE_LIMITED",
          message: `คำขอสแกนถี่เกินไป กรุณารอ ${rate.retryAfterSeconds} วินาทีแล้วลองใหม่`,
        },
        { status: 429 },
      );
    }

    const trustedOrigin = resolveTrustedAppOrigin(request.url);

    if (!hasSupabaseEnv) {
      const validTill = formatValidTillDate(new Date(Date.now() + 90 * 24 * 60 * 60 * 1000));
      const cardUrl = buildLoyaltyCardUrl(trustedOrigin, shopSecret, "");
      const flexMessage = buildStampAwardFlexMessage({
        cardTitle: DEFAULT_LOYALTY_CARD_TITLE,
        rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
        displayName: clientDisplayName,
        pointsAdded: points,
        newStamps: points % 10,
        stampsPerReward: 10,
        rewardsUnlocked: Math.floor(points / 10),
        validTill,
        cardUrl,
      });
      const plainText = buildStampAwardPlainText({
        cardTitle: DEFAULT_LOYALTY_CARD_TITLE,
        rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
        displayName: clientDisplayName,
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
          queued: false,
          pushReason: "DEMO_MODE",
        },
      });
    }

    const supabase = await createSupabaseServerClient();
    const creds = await fetchShopLoyaltyServerCredentials(supabase, shopSecret);

    let verifiedLineUserId = "";
    let verifiedDisplayName = clientDisplayName;
    let verifiedPictureUrl = clientPictureUrl;

    if (liffAccessToken) {
      const verification = await verifyLineLiffAccessToken(liffAccessToken, creds.liffId);
      if (!verification.ok) {
        return NextResponse.json(
          {
            ok: false,
            code: "LINE_AUTH_REQUIRED",
            message: "เชื่อมต่อ LINE ไม่สำเร็จ กรุณาเปิดสแกนผ่านแอป LINE อีกครั้ง",
          },
          { status: 401 },
        );
      }
      verifiedLineUserId = verification.userId;
      verifiedDisplayName = verification.displayName;
      verifiedPictureUrl = verification.pictureUrl;
    } else if (creds.liffId) {
      return NextResponse.json(
        {
          ok: false,
          code: "LINE_AUTH_REQUIRED",
          message: "กรุณาสแกนคิวอาร์โค้ดผ่านกล้อง LINE หรือเข้าสู่ระบบ LINE ก่อนรับแต้มสะสม",
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

    const { data, error } = await supabase.rpc("claim_loyalty_stamps", {
      p_shop_secret: shopSecret,
      p_points: points,
      p_token: token,
      p_line_user_id: verifiedLineUserId,
      p_display_name: verifiedDisplayName,
      p_picture_url: verifiedPictureUrl,
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
      const status =
        result.code === "COOLDOWN_ACTIVE"
          ? 429
          : result.code === "INVALID_QR_TOKEN"
            ? 403
            : result.code === "LINE_AUTH_REQUIRED"
              ? 401
              : 400;
      return NextResponse.json(result, { status });
    }

    const cardTitle = String(result.cardTitle ?? creds.cardTitle ?? DEFAULT_LOYALTY_CARD_TITLE);
    const rewardTitle = String(result.rewardTitle ?? creds.rewardTitle ?? "ลด 50% เมนูหลัก 1 กล่อง");
    const pointsAdded = Number(result.pointsAdded ?? points);
    const newStamps = Number(result.newStamps ?? 0);
    const stampsPerReward = Number(result.stampsPerReward ?? 10);
    const rewardsUnlocked = Number(result.rewardsUnlocked ?? 0);
    const expiresAt = result.expiresAt ? String(result.expiresAt) : null;
    const validTill = formatValidTillDate(expiresAt);

    const authoritativeLiffId = String(result.liffId ?? creds.liffId ?? "").trim();
    const rawNotifyMode = String(result.notifyMode ?? creds.notifyMode ?? "all").trim();
    const notifyMode: LoyaltyNotifyMode =
      rawNotifyMode === "reward_only" || rawNotifyMode === "off" ? rawNotifyMode : "all";

    const cardUrl = buildLoyaltyCardUrl(trustedOrigin, shopSecret, authoritativeLiffId);

    const flexMessage = buildStampAwardFlexMessage({
      cardTitle,
      rewardTitle,
      displayName: String(result.displayName ?? verifiedDisplayName),
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
      displayName: String(result.displayName ?? verifiedDisplayName),
      pointsAdded,
      newStamps,
      stampsPerReward,
      rewardsUnlocked,
      validTill,
    });

    let queued = false;
    let pushReason = "SKIPPED";

    if (!shouldSendStampPushNotification(notifyMode, rewardsUnlocked)) {
      pushReason = notifyMode === "off" ? "NOTIFY_MODE_OFF" : "NOTIFY_MODE_REWARD_ONLY";
    } else if (!verifiedLineUserId.startsWith("U")) {
      pushReason = "NOT_LINE_USER_ID";
    } else if (!creds.channelAccessToken) {
      pushReason = creds.credentialsLocked ? "CREDENTIALS_NEED_RESAVE" : "MISSING_CHANNEL_ACCESS_TOKEN";
    } else {
      // If claim_loyalty_stamps already atomically inserted the push job in the same DB transaction,
      // skip the extra RPC round-trip and immediately return the HTTP response while after() drains the queue!
      const atomicallyQueued = Boolean(result.pushQueued || result.pushJobId);
      if (!atomicallyQueued) {
        await enqueueLoyaltyPushNotification(supabase, {
          shopSecret,
          lineUserId: verifiedLineUserId,
          eventType: "stamp_claim",
          messages: [flexMessage],
          fallbackPlainText: plainText,
        });
      }
      queued = true;
      pushReason = "QUEUED_BACKGROUND";

      after(async () => {
        try {
          const bgSupabase = await createSupabaseServerClient();
          await processPendingLoyaltyPushJobs(
            bgSupabase,
            shopSecret,
            creds.channelAccessToken,
            {
              lineUserId: verifiedLineUserId,
              messages: [flexMessage],
              fallbackPlainText: plainText,
            },
            trustedOrigin,
          );
        } catch {
          // Background push errors are recorded in loyalty_push_queue
        }
      });
    }

    const safeResult = { ...result };
    delete safeResult.channelAccessToken;

    if (safeResult.member && typeof safeResult.member === "object") {
      const memberRaw = safeResult.member as Record<string, unknown>;
      const rawDisplayName = String(memberRaw.displayName ?? "").trim();
      const finalDisplayName =
        rawDisplayName && rawDisplayName !== "ลูกค้า LINE"
          ? rawDisplayName
          : verifiedDisplayName || "ลูกค้า LINE";
      const finalPictureUrl = memberRaw.pictureUrl
        ? String(memberRaw.pictureUrl)
        : verifiedPictureUrl;

      safeResult.member = {
        ...memberRaw,
        displayName: finalDisplayName,
        pictureUrl: finalPictureUrl,
        validTillFormatted: validTill,
      };
    }

    return NextResponse.json({
      ...safeResult,
      validTillFormatted: validTill,
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
      { ok: false, code: "SERVER_ERROR", message: err instanceof Error ? err.message : "เกิดข้อผิดพลาดในการสะสมแต้ม" },
      { status: 500 },
    );
  }
}
