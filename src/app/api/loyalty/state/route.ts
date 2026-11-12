import { NextResponse } from "next/server";
import { hasSupabaseEnv } from "@/lib/env";
import {
  extractLineChannelIdFromLiffId,
  fetchShopLoyaltyServerCredentials,
  verifyLineLiffAccessToken,
} from "@/lib/line-messaging";
import {
  DEFAULT_LOYALTY_CARD_TITLE,
  DEFAULT_LOYALTY_RULES_TEXT,
  formatValidTillDate,
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
    const configOnly = Boolean(body.configOnly);
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

    const rate = checkLoyaltyRateLimit({
      route: "state",
      ip: resolveClientIp(request),
      shopSecret,
    });
    if (!rate.allowed) {
      return NextResponse.json(
        {
          ok: false,
          code: "RATE_LIMITED",
          message: `คำขอถี่เกินไป กรุณารอสักครู่ (${rate.retryAfterSeconds} วินาที) แล้วลองใหม่`,
        },
        { status: 429 },
      );
    }

    let resolvedUserId = "";
    let resolvedDisplayName = clientDisplayName;
    let resolvedPictureUrl = clientPictureUrl;
    let verifiedClientId = "";

    if (!hasSupabaseEnv) {
      if (!configOnly) {
        if (liffAccessToken) {
          const verified = await verifyLineLiffAccessToken(liffAccessToken);
          if (!verified.ok || !verified.clientId) {
            return NextResponse.json(
              {
                ok: false,
                code: "LINE_AUTH_FAILED",
                message: "เชื่อมต่อ LINE ไม่สำเร็จ กรุณาลองใหม่",
                reason: verified.ok ? "MISSING_CLIENT_ID" : verified.reason,
              },
              { status: 401 },
            );
          }
          resolvedUserId = verified.userId;
          resolvedDisplayName = verified.displayName;
          resolvedPictureUrl = verified.pictureUrl;
        } else if (clientLineUserId.startsWith("U")) {
          return NextResponse.json(
            {
              ok: false,
              code: "LINE_AUTH_REQUIRED",
              message: "เชื่อมต่อ LINE ไม่สำเร็จ กรุณาลองใหม่",
            },
            { status: 401 },
          );
        } else if (clientLineUserId) {
          resolvedUserId = clientLineUserId;
        }
      }

      const now = new Date();
      return NextResponse.json({
        ok: true,
        config: {
          cardTitle: DEFAULT_LOYALTY_CARD_TITLE,
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
        member: configOnly
          ? null
          : {
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

    const supabase = await createSupabaseServiceClient();

    // Verify LINE token AND shop LINE Channel ID BEFORE calling get_loyalty_card_state
    // so an invalid or cross-channel token never creates or updates a member row in DB.
    if (!configOnly) {
      const [creds, verified] = await Promise.all([
        fetchShopLoyaltyServerCredentials(supabase, shopSecret),
        liffAccessToken ? verifyLineLiffAccessToken(liffAccessToken) : Promise.resolve(null),
      ]);

      const expectedChannelId = extractLineChannelIdFromLiffId(creds.liffId);

      if (liffAccessToken && verified) {
        if (!verified.ok || !verified.clientId) {
          return NextResponse.json(
            {
              ok: false,
              code: "LINE_AUTH_FAILED",
              message: "เชื่อมต่อ LINE ไม่สำเร็จ กรุณาลองใหม่",
              reason: verified.ok ? "MISSING_CLIENT_ID" : verified.reason,
            },
            { status: 401 },
          );
        }
        if (expectedChannelId && verified.clientId !== expectedChannelId) {
          return NextResponse.json(
            {
              ok: false,
              code: "LINE_AUTH_REQUIRED",
              message: "เชื่อมต่อ LINE ไม่สำเร็จ กรุณาเปิดบัตรสะสมแต้มผ่านแอป LINE ของทางร้านแล้วลองใหม่",
            },
            { status: 401 },
          );
        }
        resolvedUserId = verified.userId;
        resolvedDisplayName = verified.displayName;
        resolvedPictureUrl = verified.pictureUrl;
        verifiedClientId = verified.clientId;
      } else if (creds.liffId || clientLineUserId.startsWith("U")) {
        return NextResponse.json(
          {
            ok: false,
            code: "LINE_AUTH_REQUIRED",
            message: "เชื่อมต่อ LINE ไม่สำเร็จ กรุณาเปิดบัตรสะสมแต้มผ่านแอป LINE แล้วลองใหม่",
          },
          { status: 401 },
        );
      } else if (clientLineUserId) {
        resolvedUserId = clientLineUserId;
      }
    }

    const primaryHash = getLoyaltyServerKeyHash(shopSecret);
    const legacyHash = getLegacyLoyaltyServerKeyHash(shopSecret);

    const { data, error } = await supabase.rpc("get_loyalty_card_state", {
      p_shop_secret: shopSecret,
      p_line_user_id: configOnly ? null : resolvedUserId || null,
      p_display_name: resolvedDisplayName,
      p_picture_url: resolvedPictureUrl,
      p_server_key_hash: primaryHash,
      p_legacy_key_hash: legacyHash,
    });

    if (error) {
      if (isMissingRpcError(error) || String(error.message ?? "").includes("get_loyalty_card_state")) {
        return NextResponse.json(
          {
            ok: false,
            code: "MIGRATION_REQUIRED",
            message: "กรุณานำไฟล์ supabase/migrations/202611120001_loyalty_security_hardening.sql ไปรันใน Supabase SQL Editor และกดบันทึกการตั้งค่าในหน้าตั้งค่าก่อนเริ่มใช้งาน",
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
        result.code === "LINE_AUTH_REQUIRED" || result.code === "UNAUTHORIZED_SERVER_KEY"
          ? 401
          : 404;
      return NextResponse.json(result, { status });
    }

    const cfg = (result.config ?? {}) as Record<string, unknown>;
    const shopLiffId = String(cfg.liffId ?? "").trim();
    const expectedChannelId = extractLineChannelIdFromLiffId(shopLiffId);

    // Defense-in-depth post-check on authoritative config returned by RPC
    if (
      !configOnly &&
      shopLiffId &&
      (!resolvedUserId ||
        !resolvedUserId.startsWith("U") ||
        !verifiedClientId ||
        (expectedChannelId && verifiedClientId !== expectedChannelId))
    ) {
      return NextResponse.json(
        {
          ok: false,
          code: "LINE_AUTH_REQUIRED",
          message: "เชื่อมต่อ LINE ไม่สำเร็จ กรุณาเปิดบัตรสะสมแต้มผ่านแอป LINE แล้วลองใหม่",
          config: cfg,
        },
        { status: 401 },
      );
    }

    if (configOnly || !result.member || typeof result.member !== "object") {
      return NextResponse.json({
        ...result,
        member: null,
        coupons: [],
      });
    }

    const memberRaw = result.member as Record<string, unknown>;
    const expiresAt = memberRaw.expiresAt ? String(memberRaw.expiresAt) : null;
    const rawDisplayName = String(memberRaw.displayName ?? "").trim();
    const finalDisplayName =
      rawDisplayName && rawDisplayName !== "ลูกค้า LINE"
        ? rawDisplayName
        : resolvedDisplayName || "ลูกค้า LINE";
    const finalPictureUrl = memberRaw.pictureUrl
      ? String(memberRaw.pictureUrl)
      : resolvedPictureUrl;

    return NextResponse.json({
      ...result,
      member: {
        ...memberRaw,
        displayName: finalDisplayName,
        pictureUrl: finalPictureUrl,
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
