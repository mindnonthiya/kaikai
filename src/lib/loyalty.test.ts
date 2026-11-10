import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import {
  extractLineChannelIdFromLiffId,
  verifyLineWebhookSignature,
} from "@/lib/line-messaging";
import {
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
  isValidLiffId,
  normalizeLoyaltyConfig,
  parseLoyaltyQueryParams,
  shouldSendStampPushNotification,
} from "@/lib/loyalty";
import {
  decryptLoyaltySecret,
  encryptLoyaltySecret,
  getLoyaltyServerKeyHash,
  isEncryptedLoyaltySecret,
} from "@/lib/loyalty-crypto";
import { generateQrMatrix, qrMatrixToSvgPath } from "@/lib/qr-code";

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

  it("encrypts and decrypts LINE Channel Access Token with AES-256-GCM", () => {
    const rawToken = "eyJhbGciOiJIUzI1NiJ9.sample_line_channel_access_token_123456";
    const encrypted = encryptLoyaltySecret(rawToken);
    expect(isEncryptedLoyaltySecret(encrypted)).toBe(true);
    expect(encrypted).not.toContain(rawToken);
    expect(decryptLoyaltySecret(encrypted)).toBe(rawToken);
    expect(getLoyaltyServerKeyHash()).toMatch(/^[a-f0-9]{64}$/);
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
});
