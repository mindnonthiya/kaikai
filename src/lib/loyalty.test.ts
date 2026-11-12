import { createHash, createHmac } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { getCached, invalidateQueryCache, setCached } from "@/lib/data/queries";
import {
  clearVerifiedLineTokenCache,
  computePushRetryBackoffSeconds,
  deriveFallbackRetryKey,
  extractLineChannelIdFromLiffId,
  isValidLineRetryKey,
  sendLinePushMessageDetailed,
  verifyLineLiffAccessToken,
  verifyLineWebhookSignature,
} from "@/lib/line-messaging";
import {
  LOYALTY_ADMIN_PAGE_SIZE,
  LOYALTY_POINT_TIERS,
  buildCouponRedeemFlexMessage,
  buildCouponRedeemPlainText,
  buildLoyaltyCardUrl,
  buildLoyaltyClaimUrl,
  buildStampAwardFlexMessage,
  buildStampAwardPlainText,
  computeExpiryDateIso,
  computeStampAwardProgress,
  formatValidTillDate,
  isMissingRelationError,
  isMissingRpcError,
  isValidLiffId,
  normalizeLoyaltyConfig,
  parseLoyaltyQueryParams,
  redactLoyaltyConfigForClient,
  shouldSendStampPushNotification,
  stripEmoji,
} from "@/lib/loyalty";
import {
  decryptLoyaltySecret,
  encryptLoyaltySecret,
  getLoyaltyServerKeyHash,
  getLoyaltyServerKeyVerifier,
  hasLoyaltyServerSecret,
  isCurrentVersionEncryptedSecret,
  isEncryptedLoyaltySecret,
  resolveCronSecret,
  verifyCronAuthorization,
} from "@/lib/loyalty-crypto";
import { generateQrMatrix, qrMatrixToSvgPath } from "@/lib/qr-code";
import { checkLoyaltyRateLimit } from "@/lib/rate-limit";

describe("LINE Loyalty Stamp Card & QR System", () => {
  it("normalizes default loyalty config with 1..10 distinct QR tokens", () => {
    const config = normalizeLoyaltyConfig(null, "GaiTomNamPla 🐔");
    expect(config.enabled).toBe(false);
    expect(config.cardTitle).toBe("GaiTomNamPla 🐔");
    expect(config.cardHeadline).toBe("สะสม 10 กล่อง ลด 50%");
    expect(config.rewardTitle).toBe("ลด 50% เมนูหลัก 1 กล่อง");
    expect(config.stampsPerReward).toBe(10);
    expect(config.validityMonths).toBe(3);

    const tokenSet = new Set<string>();
    for (const tier of LOYALTY_POINT_TIERS) {
      const token = config.qrTokens[String(tier)];
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThanOrEqual(8);
      tokenSet.add(token);
    }
    expect(tokenSet.size).toBe(10);
  });

  it("computes stamp rollover and unlocked rewards accurately", () => {
    // 1 stamp + 3 boxes = 4/10, 0 rewards
    const step1 = computeStampAwardProgress(1, 3, 10);
    expect(step1).toEqual({
      previousStamps: 1,
      pointsAdded: 3,
      newStamps: 4,
      stampsPerReward: 10,
      rewardsUnlocked: 0,
      stampsRemaining: 6,
    });

    // 8 stamps + 2 boxes = 0/10 on next card, 1 reward unlocked
    const step2 = computeStampAwardProgress(8, 2, 10);
    expect(step2).toEqual({
      previousStamps: 8,
      pointsAdded: 2,
      newStamps: 0,
      stampsPerReward: 10,
      rewardsUnlocked: 1,
      stampsRemaining: 10,
    });

    // 8 stamps + 5 boxes = 3/10 on next card, 1 reward unlocked
    const step3 = computeStampAwardProgress(8, 5, 10);
    expect(step3).toEqual({
      previousStamps: 8,
      pointsAdded: 5,
      newStamps: 3,
      stampsPerReward: 10,
      rewardsUnlocked: 1,
      stampsRemaining: 7,
    });
  });

  it("builds and parses both direct URLs and LINE liff.state query params", () => {
    const directUrl = buildLoyaltyClaimUrl("https://kaikai.vercel.app", "shop_abc123", 4, "tok_xyz987", "");
    expect(directUrl).toBe("https://kaikai.vercel.app/loyalty?s=shop_abc123&p=4&t=tok_xyz987");

    const parsedDirect = parseLoyaltyQueryParams(new URL(directUrl).searchParams);
    expect(parsedDirect).toEqual({
      shopSecret: "shop_abc123",
      points: 4,
      token: "tok_xyz987",
    });

    // Simulate LINE LIFF redirect where params are nested inside ?liff.state=
    const liffRedirectSearch = new URLSearchParams({
      "liff.state": "?s=shop_abc123&p=7&t=tok_seven777",
    });
    const parsedLiffState = parseLoyaltyQueryParams(liffRedirectSearch);
    expect(parsedLiffState).toEqual({
      shopSecret: "shop_abc123",
      points: 7,
      token: "tok_seven777",
    });

    const liffCardUrl = buildLoyaltyCardUrl("https://kaikai.vercel.app", "shop_abc123", "2006000000-AbCdEfGh");
    expect(liffCardUrl).toBe("https://liff.line.me/2006000000-AbCdEfGh?s=shop_abc123");
  });

  it("formats Valid till dates as DD.MM.YYYY matching LINE Stamp Card", () => {
    const iso = computeExpiryDateIso(new Date("2026-06-12T05:00:00.000Z"), 3);
    expect(formatValidTillDate(iso)).toBe("12.09.2026");
  });

  it("builds valid LINE Flex and plain text messages for stamp awards and coupon redemptions", () => {
    const stampText = buildStampAwardPlainText({
      cardTitle: "GaiTomNamPla 🐔",
      rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
      displayName: "คุณนนท์",
      pointsAdded: 3,
      newStamps: 7,
      stampsPerReward: 10,
      rewardsUnlocked: 0,
      validTill: "12.09.2026",
    });
    expect(stampText).toContain("สะสมแต้มสำเร็จ +3 แต้ม");
    expect(stampText).toContain("7 / 10 แต้ม");
    expect(stampText).not.toContain("🐔");
    expect(stampText).not.toContain("🎉");
    expect(stripEmoji("GaiTomNamPla 🐔")).toBe("GaiTomNamPla");

    const stampFlex = buildStampAwardFlexMessage({
      cardTitle: "GaiTomNamPla 🐔",
      rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
      displayName: "คุณนนท์",
      pointsAdded: 3,
      newStamps: 7,
      stampsPerReward: 10,
      rewardsUnlocked: 1,
      validTill: "12.09.2026",
      cardUrl: "https://kaikai.vercel.app/loyalty?s=abc",
    });
    expect(stampFlex.type).toBe("flex");
    expect((stampFlex.contents as Record<string, unknown>).size).toBe("kilo");
    expect(JSON.stringify(stampFlex)).not.toContain("🐔");
    expect(JSON.stringify(stampFlex)).not.toContain("🎉");
    expect(JSON.stringify(stampFlex)).not.toContain("สมาชิก:");
    expect(JSON.stringify(stampFlex)).toContain("#FCE254");

    const redeemText = buildCouponRedeemPlainText({
      cardTitle: "GaiTomNamPla 🐔",
      rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
      couponCode: "GT-8899AA",
      displayName: "คุณนนท์",
      claimedAtText: "10/11/2026 21:00 น.",
    });
    expect(redeemText).toContain("#GT-8899AA");

    const redeemFlex = buildCouponRedeemFlexMessage({
      cardTitle: "GaiTomNamPla 🐔",
      rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
      couponCode: "GT-8899AA",
      displayName: "คุณนนท์",
      claimedAtText: "10/11/2026 21:00 น.",
    });
    expect(redeemFlex.type).toBe("flex");
    expect((redeemFlex.contents as Record<string, unknown>).size).toBe("kilo");
    expect(JSON.stringify(redeemFlex)).not.toContain("สมาชิก:");
  });

  it("generates ISO/IEC 18004 QR matrices with intact finder patterns and SVG paths", () => {
    const url = "https://kaikai.vercel.app/loyalty?s=shop_secret_123456&p=10&t=token_12345678";
    const matrix = generateQrMatrix(url);
    expect(matrix.length).toBeGreaterThanOrEqual(21);
    expect(matrix.length % 4).toBe(1); // 4*V + 17

    // Top-left 7x7 finder pattern outer corners and center (3,3) must be dark (true)
    expect(matrix[0][0]).toBe(true);
    expect(matrix[0][6]).toBe(true);
    expect(matrix[6][0]).toBe(true);
    expect(matrix[6][6]).toBe(true);
    expect(matrix[3][3]).toBe(true);
    // Finder inner ring (1,1) must be light (false)
    expect(matrix[1][1]).toBe(false);

    const svg = qrMatrixToSvgPath(matrix, 2);
    expect(svg.viewBoxSize).toBe(matrix.length + 4);
    expect(svg.pathData).toContain("M2,2h1v1h-1z");
  });

  it("verifies LINE Webhook HMAC-SHA256 signatures accurately (both plaintext and encrypted secret)", () => {
    const body = JSON.stringify({ events: [] });
    const secret = "my_line_channel_secret";
    const validSignature = createHmac("sha256", secret).update(body, "utf8").digest("base64");

    expect(verifyLineWebhookSignature(body, validSignature, secret)).toBe(true);
    expect(verifyLineWebhookSignature(body, validSignature, encryptLoyaltySecret(secret))).toBe(true);
    expect(verifyLineWebhookSignature(body, "invalid_signature", secret)).toBe(false);
  });

  it("encrypts and decrypts LINE Channel Access Token with dedicated v2 AES-256-GCM key", () => {
    expect(hasLoyaltyServerSecret()).toBe(true);
    const rawToken = "eyJhbGciOiJIUzI1NiJ9.sample_line_channel_access_token_123456";
    const encrypted = encryptLoyaltySecret(rawToken);
    expect(isEncryptedLoyaltySecret(encrypted)).toBe(true);
    expect(isCurrentVersionEncryptedSecret(encrypted)).toBe(true);
    expect(encrypted).toMatch(/^enc:v2:/);
    expect(encrypted).not.toContain(rawToken);
    expect(decryptLoyaltySecret(encrypted)).toBe(rawToken);
    expect(getLoyaltyServerKeyHash()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("enforces sliding-window rate limits per IP and shop secret", () => {
    const ip = "203.0.113.55";
    const shop = "ls_test_rate_limit_shop";
    for (let i = 0; i < 3; i += 1) {
      const okRes = checkLoyaltyRateLimit({
        route: "claim",
        ip,
        shopSecret: shop,
        maxRequests: 3,
        windowMs: 10_000,
      });
      expect(okRes.allowed).toBe(true);
    }
    const blockedRes = checkLoyaltyRateLimit({
      route: "claim",
      ip,
      shopSecret: shop,
      maxRequests: 3,
      windowMs: 10_000,
    });
    expect(blockedRes.allowed).toBe(false);
    expect(blockedRes.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("validates LIFF IDs and quota-saving notification modes", () => {
    expect(isValidLiffId("")).toBe(true);
    expect(isValidLiffId("2009769853-BWR6D81k")).toBe(true);
    expect(isValidLiffId("https://evil.example.com")).toBe(false);
    expect(extractLineChannelIdFromLiffId("2009769853-BWR6D81k")).toBe("2009769853");

    expect(shouldSendStampPushNotification("all", 0)).toBe(true);
    expect(shouldSendStampPushNotification("reward_only", 0)).toBe(false);
    expect(shouldSendStampPushNotification("reward_only", 1)).toBe(true);
    expect(shouldSendStampPushNotification("off", 1)).toBe(false);
  });

  it("enforces fail-closed CRON_SECRET verification and multi-hour retry backoff with X-Line-Retry-Key idempotency", async () => {
    const previousCronSecret = process.env.CRON_SECRET;
    try {
      // 1) Unconfigured CRON_SECRET must fail closed
      process.env.CRON_SECRET = "";
      expect(resolveCronSecret()).toBe("");
      expect(verifyCronAuthorization(null)).toEqual({ ok: false, configured: false });
      expect(verifyCronAuthorization("Bearer anything")).toEqual({ ok: false, configured: false });

      // 2) Configured CRON_SECRET (>= 16 chars) must verify Bearer token accurately
      const testSecret = "cron_test_secret_1234567890abcdef";
      process.env.CRON_SECRET = testSecret;
      const cronSecret = resolveCronSecret();
      expect(cronSecret.length).toBeGreaterThanOrEqual(16);
      expect(verifyCronAuthorization(null)).toEqual({ ok: false, configured: true });
      expect(verifyCronAuthorization("Bearer wrong_secret")).toEqual({ ok: false, configured: true });
      expect(verifyCronAuthorization(`Bearer ${cronSecret}`)).toEqual({ ok: true, configured: true });
    } finally {
      if (previousCronSecret === undefined) {
        delete process.env.CRON_SECRET;
      } else {
        process.env.CRON_SECRET = previousCronSecret;
      }
    }

    // Multi-stage backoff schedule (1m -> 5m -> 15m -> 1h -> 3h)
    expect(computePushRetryBackoffSeconds(1)).toBe(60);
    expect(computePushRetryBackoffSeconds(2)).toBe(300);
    expect(computePushRetryBackoffSeconds(3)).toBe(900);
    expect(computePushRetryBackoffSeconds(4)).toBe(3600);
    expect(computePushRetryBackoffSeconds(5)).toBe(10800);

    const jobRetryKey = "550e8400-e29b-41d4-a716-446655440000";
    expect(isValidLineRetryKey(jobRetryKey)).toBe(true);
    expect(isValidLineRetryKey(deriveFallbackRetryKey(jobRetryKey))).toBe(true);

    // Verify X-Line-Retry-Key header is sent and HTTP 409 is treated as already accepted (ok: true)
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "The retry key is already processed" }), {
        status: 409,
      }),
    );

    const pushRes = await sendLinePushMessageDetailed(
      "sample_access_token",
      "U1234567890abcdef1234567890abcdef",
      [{ type: "text", text: "ทดสอบ" }],
      undefined,
      jobRetryKey,
    );

    expect(pushRes.ok).toBe(true);
    expect(pushRes.status).toBe(409);
    expect(pushRes.reason).toBe("ALREADY_ACCEPTED_BY_LINE_409");
    expect(pushRes.retryKey).toBe(jobRetryKey);

    const calledHeaders = (fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(calledHeaders?.["X-Line-Retry-Key"]).toBe(jobRetryKey);
    fetchSpy.mockRestore();
  });

  it("redacts LINE Channel Secret, Channel Access Token, and serverKeyHash before returning config to browser clients", () => {
    const rawConfig = normalizeLoyaltyConfig(
      {
        enabled: true,
        liffId: "2009769853-BWR6D81k",
        channelSecret: "super_secret_channel_secret_value",
        channelAccessToken: "super_secret_channel_access_token_value",
        serverKeyHash: getLoyaltyServerKeyVerifier("shop_a_secret"),
        webhookKeyHash: getLoyaltyServerKeyVerifier("webhook_a_secret"),
        serverKeyVersion: 2,
      },
      "GaiTomNamPla",
    );

    const clientSafe = redactLoyaltyConfigForClient(rawConfig);
    expect(clientSafe.channelSecret).toBe("");
    expect(clientSafe.channelAccessToken).toBe("");
    expect(clientSafe.serverKeyHash).toBe("");
    expect(clientSafe.webhookKeyHash).toBeUndefined();
    expect(clientSafe.serverKeyVersion).toBeUndefined();
    expect(clientSafe.hasChannelSecret).toBe(true);
    expect(clientSafe.hasChannelAccessToken).toBe(true);
    expect(clientSafe.liffId).toBe("2009769853-BWR6D81k");

    // Per-shop derived RPC tokens and one-way SHA-256 verifiers must be distinct per shop and irreversible
    const shopAToken = getLoyaltyServerKeyHash("shop_a_secret");
    const shopBToken = getLoyaltyServerKeyHash("shop_b_secret");
    const shopAVerifier = getLoyaltyServerKeyVerifier("shop_a_secret");
    const shopBVerifier = getLoyaltyServerKeyVerifier("shop_b_secret");
    expect(shopAToken).toMatch(/^[a-f0-9]{64}$/);
    expect(shopBToken).toMatch(/^[a-f0-9]{64}$/);
    expect(shopAToken).not.toBe(shopBToken);
    expect(shopAVerifier).not.toBe(shopBVerifier);
    expect(shopAVerifier).not.toBe(shopAToken);
    expect(createHash("sha256").update(shopAToken, "utf8").digest("hex")).toBe(shopAVerifier);

    const emptySafe = redactLoyaltyConfigForClient(normalizeLoyaltyConfig(null, "GaiTomNamPla"));
    expect(emptySafe.channelSecret).toBe("");
    expect(emptySafe.channelAccessToken).toBe("");
    expect(emptySafe.serverKeyHash).toBe("");
    expect(emptySafe.hasChannelSecret).toBe(false);
    expect(emptySafe.hasChannelAccessToken).toBe(false);
    expect(LOYALTY_ADMIN_PAGE_SIZE).toBe(20);
  });

  it("clears sales_win, sales_superset, expenses_win, and expenses_superset caches on any mutation invalidation", () => {
    setCached("user1:sales_win:default:100:200", [{ id: "s1" }]);
    setCached("user1:sales_superset:default", { startMs: 100, endMs: 200, rows: [{ id: "s1" }] });
    setCached("user1:expenses_win:default:100:200", [{ id: "e1" }]);
    setCached("user1:expenses_superset:default", { startMs: 100, endMs: 200, rows: [{ id: "e1" }] });

    invalidateQueryCache("pooled_rate");

    expect(getCached("user1:sales_win:default:100:200")).toBeUndefined();
    expect(getCached("user1:sales_superset:default")).toBeUndefined();
    expect(getCached("user1:expenses_win:default:100:200")).toBeUndefined();
    expect(getCached("user1:expenses_superset:default")).toBeUndefined();
  });

  it("distinguishes missing RPC errors from missing table errors so overview fallback works before 0002 migration", () => {
    const missingOverviewRpcSchemaCache = {
      code: "PGRST202",
      message:
        "Could not find the function public.get_loyalty_admin_overview_stats(p_seven_days_ago, p_shop_scope_id, p_today_start) in the schema cache",
    };
    const missingOverviewRpcPg = {
      code: "42883",
      message: "function public.get_loyalty_admin_overview_stats(text, timestamptz, timestamptz) does not exist",
    };
    const missingOverviewRpcWithoutCode = {
      message:
        "Could not find the function public.get_loyalty_admin_overview_stats in the schema cache",
    };

    expect(isMissingRpcError(missingOverviewRpcSchemaCache)).toBe(true);
    expect(isMissingRpcError(missingOverviewRpcPg)).toBe(true);
    expect(isMissingRpcError(missingOverviewRpcWithoutCode)).toBe(true);

    // Must NOT misclassify missing RPC as missing relation (table)
    expect(isMissingRelationError(missingOverviewRpcSchemaCache)).toBe(false);
    expect(isMissingRelationError(missingOverviewRpcPg)).toBe(false);
    expect(isMissingRelationError(missingOverviewRpcWithoutCode)).toBe(false);

    // Real missing table errors must be classified as missing relation
    const missingMembersTable = {
      code: "42P01",
      message: 'relation "public.loyalty_members" does not exist',
    };
    const missingMembersSchemaCache = {
      code: "PGRST205",
      message: "Could not find the table 'public.loyalty_members' in the schema cache",
    };
    const missingMembersMsgOnly = {
      message: 'relation "public.loyalty_members" does not exist',
    };

    expect(isMissingRelationError(missingMembersTable)).toBe(true);
    expect(isMissingRelationError(missingMembersSchemaCache)).toBe(true);
    expect(isMissingRelationError(missingMembersMsgOnly)).toBe(true);
    expect(isMissingRpcError(missingMembersTable)).toBe(false);
  });

  it("enforces two-layer housekeeping security: revokes direct RPC execute and verifies serverKeyHash before worker housekeeping", () => {
    for (const file of [
      "supabase/migrations/202611110001_line_loyalty.sql",
      "supabase/migrations/202611110002_loyalty_admin_rpcs.sql",
    ]) {
      const sql = readFileSync(join(process.cwd(), file), "utf8");

      // Layer 1: Direct RPC execution must be revoked from public, anon, authenticated (and never granted to anon/authenticated)
      expect(sql).toContain(
        "revoke all on function public.run_loyalty_housekeeping(uuid) from public, anon, authenticated;",
      );
      expect(sql).not.toContain("grant execute on function public.run_loyalty_housekeeping");

      // Layer 2: Inside claim_due_loyalty_push_jobs_batch, serverKeyHash must be verified against public.settings BEFORE run_loyalty_housekeeping(null)
      const batchFnStart = sql.indexOf("create or replace function public.claim_due_loyalty_push_jobs_batch");
      expect(batchFnStart).toBeGreaterThan(-1);
      const batchFnBody = sql.slice(batchFnStart, batchFnStart + 2500);
      const verifyIdx = batchFnBody.indexOf("if not exists (");
      const housekeepingIdx = batchFnBody.indexOf("v_housekeeping := public.run_loyalty_housekeeping(null);");
      expect(verifyIdx).toBeGreaterThan(0);
      expect(housekeepingIdx).toBeGreaterThan(verifyIdx);
    }

    const mainSql = readFileSync(
      join(process.cwd(), "supabase/migrations/202611110001_line_loyalty.sql"),
      "utf8",
    );
    // Hot scan/redeem paths must NOT invoke run_loyalty_housekeeping per request
    expect(mainSql).not.toContain("perform public.run_loyalty_housekeeping(v_owner_id);");

    // Legacy unauthenticated 4-arg/6-arg RPC grants must be replaced with serverKeyHash-authenticated signatures
    expect(mainSql).not.toContain(
      "grant execute on function public.get_loyalty_card_state(text, text, text, text)",
    );
    expect(mainSql).not.toContain(
      "grant execute on function public.claim_loyalty_stamps(text, integer, text, text, text, text)",
    );
    expect(mainSql).not.toContain(
      "grant execute on function public.redeem_loyalty_coupon(text, uuid, text, text)",
    );
    expect(mainSql).toContain(
      "grant execute on function public.get_loyalty_card_state(text, text, text, text, text, text) to anon, authenticated;",
    );
    expect(mainSql).toContain(
      "grant execute on function public.claim_loyalty_stamps(text, integer, text, text, text, text, text, text) to anon, authenticated;",
    );
    expect(mainSql).toContain(
      "grant execute on function public.redeem_loyalty_coupon(text, uuid, text, text, text, text) to anon, authenticated;",
    );
  });

  it("strictly rejects LINE access tokens when verify fails, client_id is missing/mismatched, or expires_in <= 0", async () => {
    clearVerifiedLineTokenCache();

    // Case 1: /oauth2/v2.1/verify fails (400) even though /v2/profile succeeds (200) -> MUST REJECT
    const spy1 = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ userId: "U1234567890abcdef1234567890abcdef", displayName: "Test" }),
          { status: 200 },
        ),
      );
    const res1 = await verifyLineLiffAccessToken("token_verify_fail_123456");
    expect(res1).toEqual({ ok: false, reason: "LINE_VERIFY_400" });
    spy1.mockRestore();

    // Case 2: /oauth2/v2.1/verify succeeds (200) but has expires_in <= 0 -> MUST REJECT
    const spy2 = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ client_id: "2009769853", expires_in: 0 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ userId: "U1234567890abcdef1234567890abcdef", displayName: "Test" }),
          { status: 200 },
        ),
      );
    const res2 = await verifyLineLiffAccessToken("token_expired_123456");
    expect(res2).toEqual({ ok: false, reason: "TOKEN_EXPIRED" });
    spy2.mockRestore();

    // Case 3: /oauth2/v2.1/verify succeeds (200) with valid client_id & expires_in > 0 -> ACCEPTS & caches clientId
    const spy3 = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ client_id: "2009769853", expires_in: 1200 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ userId: "U1234567890abcdef1234567890abcdef", displayName: "คุณนนท์" }),
          { status: 200 },
        ),
      );
    const res3 = await verifyLineLiffAccessToken("token_valid_123456", "2009769853-BWR6D81k");
    expect(res3).toEqual({
      ok: true,
      userId: "U1234567890abcdef1234567890abcdef",
      displayName: "คุณนนท์",
      pictureUrl: null,
      clientId: "2009769853",
    });

    // Cached token checked against a DIFFERENT shop LIFF ID -> MUST REJECT with CHANNEL_ID_MISMATCH
    const resMismatch = await verifyLineLiffAccessToken("token_valid_123456", "9999999999-OtherApp");
    expect(resMismatch).toEqual({ ok: false, reason: "CHANNEL_ID_MISMATCH" });
    spy3.mockRestore();
  });

  it("enforces migration 202611120001 security hardening, removes legacy RPC fallbacks, and checks LINE Channel ID before DB writes in state route", () => {
    const adminMigration = readFileSync(
      join(process.cwd(), "supabase/migrations/202611110002_loyalty_admin_rpcs.sql"),
      "utf8",
    );
    // 202611110002 must be safe when run standalone (must not drop RPCs without recreating them)
    expect(adminMigration).not.toContain(
      "drop function if exists public.get_loyalty_card_state(text, text, text, text);",
    );

    const hardeningMigration = readFileSync(
      join(process.cwd(), "supabase/migrations/202611120001_loyalty_security_hardening.sql"),
      "utf8",
    );
    expect(hardeningMigration).toContain(
      "create or replace function public.verify_loyalty_server_key(",
    );
    expect(hardeningMigration).toContain(
      "drop function if exists public.get_loyalty_card_state(text, text, text, text);",
    );
    expect(hardeningMigration).toContain(
      "drop function if exists public.claim_loyalty_stamps(text, integer, text, text, text, text);",
    );
    expect(hardeningMigration).toContain(
      "drop function if exists public.redeem_loyalty_coupon(text, uuid, text, text);",
    );
    expect(hardeningMigration).toContain(
      "create or replace function public.get_loyalty_card_state(",
    );
    expect(hardeningMigration).toContain(
      "create or replace function public.claim_loyalty_stamps(",
    );
    expect(hardeningMigration).toContain(
      "create or replace function public.redeem_loyalty_coupon(",
    );

    // API routes must NOT fall back to unauthenticated 4-arg/6-arg RPCs
    const claimRoute = readFileSync(
      join(process.cwd(), "src/app/api/loyalty/claim/route.ts"),
      "utf8",
    );
    const redeemRoute = readFileSync(
      join(process.cwd(), "src/app/api/loyalty/redeem/route.ts"),
      "utf8",
    );
    const stateRoute = readFileSync(
      join(process.cwd(), "src/app/api/loyalty/state/route.ts"),
      "utf8",
    );
    expect(claimRoute).not.toContain("fallbackRes");
    expect(redeemRoute).not.toContain("fallbackRes");
    expect(stateRoute).not.toContain("fallbackRes");

    // /api/loyalty/state must verify LINE Channel ID BEFORE calling get_loyalty_card_state RPC
    const channelCheckIdx = stateRoute.indexOf("verified.clientId !== expectedChannelId");
    const rpcCallIdx = stateRoute.indexOf('supabase.rpc("get_loyalty_card_state"');
    expect(channelCheckIdx).toBeGreaterThan(0);
    expect(rpcCallIdx).toBeGreaterThan(channelCheckIdx);
  });
});
