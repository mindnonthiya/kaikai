import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";
import {
  decryptLoyaltySecret,
  getLegacyLoyaltyServerKeyHash,
  getLoyaltyServerKeyHash,
} from "@/lib/loyalty-crypto";
import {
  DEFAULT_LOYALTY_CARD_TITLE,
  type LoyaltyNotifyMode,
  buildCouponRedeemFlexMessage,
  buildCouponRedeemPlainText,
  buildLoyaltyCardUrl,
  buildStampAwardFlexMessage,
  buildStampAwardPlainText,
  formatThaiDateTime,
  formatValidTillDate,
  resolveTrustedAppOrigin,
} from "@/lib/loyalty";

export interface VerifiedLineProfile {
  ok: true;
  userId: string;
  displayName: string;
  pictureUrl: string | null;
}

export interface FailedLineVerification {
  ok: false;
  reason: string;
}

export type LineTokenVerificationResult = VerifiedLineProfile | FailedLineVerification;

const verifiedTokenCache = new Map<
  string,
  { profile: VerifiedLineProfile; expiresAtMs: number }
>();

export function extractLineChannelIdFromLiffId(liffId?: string | null): string {
  const clean = (liffId ?? "").trim();
  const match = /^([0-9]{8,14})-[A-Za-z0-9_-]{4,36}$/.exec(clean);
  return match ? match[1] : "";
}

export async function verifyLineLiffAccessToken(
  accessToken: string,
  expectedLiffId?: string | null,
): Promise<LineTokenVerificationResult> {
  const token = (accessToken ?? "").trim();
  if (!token || token.length < 12) {
    return { ok: false, reason: "MISSING_ACCESS_TOKEN" };
  }

  const expectedChannelId = extractLineChannelIdFromLiffId(expectedLiffId);
  const cacheKey = createHash("sha256")
    .update(`${expectedChannelId}:${token}`, "utf8")
    .digest("hex");

  const now = Date.now();
  const cached = verifiedTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now) {
    return cached.profile;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const verifyPromise = expectedChannelId
      ? fetch(
          `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(token)}`,
          { method: "GET", signal: controller.signal, cache: "no-store" },
        )
      : Promise.resolve(null);

    const profilePromise = fetch("https://api.line.me/v2/profile", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
      cache: "no-store",
    });

    const [verifyRes, profileRes] = await Promise.all([verifyPromise, profilePromise]);

    if (verifyRes) {
      if (!verifyRes.ok) {
        return { ok: false, reason: `LINE_VERIFY_${verifyRes.status}` };
      }
      const verifyData = (await verifyRes.json().catch(() => ({}))) as {
        client_id?: string;
        expires_in?: number;
      };
      if (
        expectedChannelId &&
        verifyData.client_id &&
        String(verifyData.client_id).trim() !== expectedChannelId
      ) {
        return { ok: false, reason: "CHANNEL_ID_MISMATCH" };
      }
      if (typeof verifyData.expires_in === "number" && verifyData.expires_in <= 0) {
        return { ok: false, reason: "TOKEN_EXPIRED" };
      }
    }

    if (!profileRes.ok) {
      return { ok: false, reason: `LINE_PROFILE_${profileRes.status}` };
    }

    const profileData = (await profileRes.json().catch(() => ({}))) as {
      userId?: string;
      displayName?: string;
      pictureUrl?: string;
    };

    const userId = String(profileData.userId ?? "").trim();
    if (!userId.startsWith("U")) {
      return { ok: false, reason: "INVALID_LINE_USER_ID" };
    }

    const verified: VerifiedLineProfile = {
      ok: true,
      userId,
      displayName: String(profileData.displayName ?? "ลูกค้า LINE").trim() || "ลูกค้า LINE",
      pictureUrl: profileData.pictureUrl ? String(profileData.pictureUrl).trim() : null,
    };

    if (verifiedTokenCache.size > 300) {
      verifiedTokenCache.clear();
    }
    verifiedTokenCache.set(cacheKey, {
      profile: verified,
      expiresAtMs: now + 60_000,
    });

    return verified;
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      reason: isAbort ? "LINE_VERIFY_TIMEOUT" : "LINE_VERIFY_NETWORK_ERROR",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function verifyLineWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  channelSecret: string,
): boolean {
  const secret = decryptLoyaltySecret(channelSecret).trim();
  if (!secret || !signatureHeader) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader.trim(), "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export async function sendLineReplyMessage(
  channelAccessToken: string,
  replyToken: string,
  messages: Array<Record<string, unknown>>,
): Promise<boolean> {
  const token = decryptLoyaltySecret(channelAccessToken).trim();
  if (!token || !replyToken || messages.length === 0) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: messages.slice(0, 5),
      }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export interface LinePushResult {
  ok: boolean;
  status?: number;
  reason?: string;
  transient?: boolean;
  retryKey?: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidLineRetryKey(value?: string | null): boolean {
  return UUID_REGEX.test(String(value ?? "").trim());
}

export function deriveFallbackRetryKey(baseKey: string): string {
  const hash = createHash("sha256").update(`kaikai:line:fallback:${baseKey}`, "utf8").digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Multi-stage exponential backoff spanning minutes and hours so temporary LINE outages
 * (> 10 seconds up to several hours) do not exhaust retry attempts immediately:
 * Attempt 1 -> 1 min (60s)
 * Attempt 2 -> 5 min (300s)
 * Attempt 3 -> 15 min (900s)
 * Attempt 4 -> 1 hour (3600s)
 * Attempt 5+ -> 3 hours (10800s)
 */
export function computePushRetryBackoffSeconds(attempts: number): number {
  const schedule = [60, 300, 900, 3600, 10800];
  const index = Math.max(0, Math.min(schedule.length - 1, Math.floor(attempts) - 1));
  return schedule[index];
}

export async function sendLinePushMessage(
  channelAccessToken: string,
  toLineUserId: string,
  messages: Array<Record<string, unknown>>,
  fallbackPlainText?: string,
  retryKey?: string,
): Promise<boolean> {
  const res = await sendLinePushMessageDetailed(
    channelAccessToken,
    toLineUserId,
    messages,
    fallbackPlainText,
    retryKey,
  );
  return res.ok;
}

export async function sendLinePushMessageDetailed(
  channelAccessToken: string,
  toLineUserId: string,
  messages: Array<Record<string, unknown>>,
  fallbackPlainText?: string,
  retryKey?: string,
): Promise<LinePushResult> {
  const token = decryptLoyaltySecret(channelAccessToken).trim();
  const to = toLineUserId.trim();
  const effectiveRetryKey = isValidLineRetryKey(retryKey)
    ? String(retryKey).trim().toLowerCase()
    : randomUUID().toLowerCase();

  if (!token) {
    return { ok: false, reason: "MISSING_CHANNEL_ACCESS_TOKEN", transient: false, retryKey: effectiveRetryKey };
  }
  if (!to.startsWith("U")) {
    return { ok: false, reason: "NOT_LINE_USER_ID", transient: false, retryKey: effectiveRetryKey };
  }
  if (messages.length === 0) {
    return { ok: false, reason: "EMPTY_MESSAGES", transient: false, retryKey: effectiveRetryKey };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Line-Retry-Key": effectiveRetryKey,
      },
      body: JSON.stringify({
        to,
        messages: messages.slice(0, 5),
      }),
      signal: controller.signal,
    });

    // HTTP 200 OK or HTTP 409 Conflict (already accepted with the same X-Line-Retry-Key) both count as delivered!
    if (response.ok || response.status === 409) {
      return {
        ok: true,
        status: response.status,
        reason: response.status === 409 ? "ALREADY_ACCEPTED_BY_LINE_409" : "PUSH_REQUEST_ACCEPTED",
        retryKey: effectiveRetryKey,
      };
    }

    // Do NOT retry plain text when error is 401 (Invalid Token), 403 (Forbidden), or 429 (Quota Exceeded)
    if (response.status === 401) {
      return { ok: false, status: 401, reason: "LINE_TOKEN_INVALID_401", transient: false, retryKey: effectiveRetryKey };
    }
    if (response.status === 403) {
      return { ok: false, status: 403, reason: "LINE_FORBIDDEN_403", transient: false, retryKey: effectiveRetryKey };
    }
    if (response.status === 429) {
      return { ok: false, status: 429, reason: "LINE_QUOTA_EXCEEDED_429", transient: false, retryKey: effectiveRetryKey };
    }

    const errBody = await response.text().catch(() => "");

    const isInvalidRecipient =
      errBody.includes("property, 'to'") || errBody.includes("Failed to send messages");

    if (response.status === 400 && !isInvalidRecipient && fallbackPlainText && fallbackPlainText.trim()) {
      const fallbackRetryKey = deriveFallbackRetryKey(effectiveRetryKey);
      const retryResponse = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-Line-Retry-Key": fallbackRetryKey,
        },
        body: JSON.stringify({
          to,
          messages: [{ type: "text", text: fallbackPlainText.trim() }],
        }),
        signal: controller.signal,
      });
      if (retryResponse.ok || retryResponse.status === 409) {
        return {
          ok: true,
          status: retryResponse.status,
          reason: retryResponse.status === 409 ? "ALREADY_ACCEPTED_BY_LINE_409" : "PUSH_REQUEST_ACCEPTED",
          retryKey: fallbackRetryKey,
        };
      }
    }

    if (response.status === 400 && isInvalidRecipient) {
      return {
        ok: false,
        status: 400,
        reason: "LINE_PROVIDER_OR_FRIEND_MISMATCH_400",
        transient: false,
        retryKey: effectiveRetryKey,
      };
    }

    return {
      ok: false,
      status: response.status,
      reason: `LINE_API_${response.status}: ${errBody.slice(0, 160)}`,
      transient: response.status >= 500,
      retryKey: effectiveRetryKey,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      reason: isAbort ? "LINE_API_TIMEOUT" : err instanceof Error ? err.message : "NETWORK_ERROR",
      transient: true,
      retryKey: effectiveRetryKey,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendLinePushMessageWithRetry(
  channelAccessToken: string,
  toLineUserId: string,
  messages: Array<Record<string, unknown>>,
  fallbackPlainText?: string,
  maxAttempts = 2,
  retryKey?: string,
): Promise<LinePushResult> {
  const consistentRetryKey = isValidLineRetryKey(retryKey)
    ? String(retryKey).trim().toLowerCase()
    : randomUUID().toLowerCase();
  let lastResult: LinePushResult = { ok: false, reason: "NOT_ATTEMPTED", retryKey: consistentRetryKey };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastResult = await sendLinePushMessageDetailed(
      channelAccessToken,
      toLineUserId,
      messages,
      fallbackPlainText,
      consistentRetryKey,
    );
    if (lastResult.ok || !lastResult.transient || attempt === maxAttempts) {
      return lastResult;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 450));
  }
  return lastResult;
}

export interface DecryptedShopLoyaltyCredentials {
  ok: boolean;
  enabled: boolean;
  shopSecret: string;
  channelSecret: string;
  channelAccessToken: string;
  credentialsLocked: boolean;
  liffId: string;
  notifyMode: LoyaltyNotifyMode;
  cardTitle: string;
  rewardTitle: string;
  stampsPerReward: number;
}

export async function fetchShopLoyaltyServerCredentials(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => any },
  lookupSecret: string,
): Promise<DecryptedShopLoyaltyCredentials> {
  const cleanSecret = (lookupSecret ?? "").trim();
  const empty: DecryptedShopLoyaltyCredentials = {
    ok: false,
    enabled: false,
    shopSecret: cleanSecret,
    channelSecret: "",
    channelAccessToken: "",
    credentialsLocked: false,
    liffId: "",
    notifyMode: "all",
    cardTitle: DEFAULT_LOYALTY_CARD_TITLE,
    rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
    stampsPerReward: 10,
  };

  if (!cleanSecret) return empty;

  const primaryHash = getLoyaltyServerKeyHash();
  const legacyHash = getLegacyLoyaltyServerKeyHash();

  let { data, error } = await supabase.rpc("get_loyalty_server_credentials", {
    p_lookup_secret: cleanSecret,
    p_server_key_hash: primaryHash,
    p_legacy_key_hash: legacyHash,
  });

  // Fallback if 2-argument signature is still active in DB
  if (error && (error.code === "PGRST202" || error.code === "42883")) {
    const retryTwoArg = await supabase.rpc("get_loyalty_server_credentials", {
      p_lookup_secret: cleanSecret,
      p_server_key_hash: primaryHash,
    });
    data = retryTwoArg.data;
    error = retryTwoArg.error;
  }

  if (!error && data && (data as Record<string, unknown>).ok) {
    const raw = data as Record<string, unknown>;
    const rawMode = String(raw.notifyMode ?? "all").trim();
    return {
      ok: true,
      enabled: Boolean(raw.enabled ?? true),
      shopSecret: String(raw.shopSecret ?? cleanSecret).trim(),
      channelSecret: decryptLoyaltySecret(String(raw.channelSecret ?? "")),
      channelAccessToken: decryptLoyaltySecret(String(raw.channelAccessToken ?? "")),
      credentialsLocked: Boolean(raw.credentialsLocked),
      liffId: String(raw.liffId ?? "").trim(),
      notifyMode: rawMode === "reward_only" || rawMode === "off" ? rawMode : "all",
      cardTitle: String(raw.cardTitle ?? DEFAULT_LOYALTY_CARD_TITLE),
      rewardTitle: String(raw.rewardTitle ?? "ลด 50% เมนูหลัก 1 กล่อง"),
      stampsPerReward: Number(raw.stampsPerReward ?? 10),
    };
  }

  return empty;
}

function classifyPushFailureStatus(reason?: string): string {
  const r = String(reason ?? "");
  if (
    r === "LINE_TOKEN_INVALID_401" ||
    r === "LINE_FORBIDDEN_403" ||
    r === "MISSING_CHANNEL_ACCESS_TOKEN"
  ) {
    return "failed_auth";
  }
  if (r === "LINE_QUOTA_EXCEEDED_429") {
    return "failed_quota";
  }
  if (r === "LINE_PROVIDER_OR_FRIEND_MISMATCH_400" || r === "NOT_LINE_USER_ID") {
    return "failed_recipient";
  }
  return "failed_network";
}

export async function enqueueLoyaltyPushNotification(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => any },
  params: {
    shopSecret: string;
    lineUserId: string;
    eventType: "stamp_claim" | "coupon_redeem";
    messages: Array<Record<string, unknown>>;
    fallbackPlainText?: string;
  },
): Promise<{ queued: boolean; jobId?: string }> {
  const primaryHash = getLoyaltyServerKeyHash();
  const legacyHash = getLegacyLoyaltyServerKeyHash();

  const { data, error } = await supabase.rpc("enqueue_loyalty_push_job", {
    p_shop_secret: params.shopSecret,
    p_server_key_hash: primaryHash,
    p_legacy_key_hash: legacyHash,
    p_line_user_id: params.lineUserId,
    p_event_type: params.eventType,
    p_messages: params.messages,
    p_fallback_text: params.fallbackPlainText ?? null,
  });

  if (!error && data && (data as Record<string, unknown>).ok) {
    return {
      queued: true,
      jobId: String((data as Record<string, unknown>).jobId ?? ""),
    };
  }
  return { queued: false };
}

function resolvePushJobMessages(
  job: {
    eventType?: string;
    messages?: unknown;
    fallbackText?: string | null;
  },
  shopSecret: string,
  trustedOrigin?: string,
): { messages: Array<Record<string, unknown>>; fallbackText?: string } {
  const origin = resolveTrustedAppOrigin(trustedOrigin ?? "https://kaikai.vercel.app");
  if (Array.isArray(job.messages) && job.messages.length > 0) {
    return {
      messages: job.messages as Array<Record<string, unknown>>,
      fallbackText: job.fallbackText ? String(job.fallbackText) : undefined,
    };
  }

  // Hydrate Flex Message from atomic SQL outbox metadata (`autoBuild: true`)
  if (job.messages && typeof job.messages === "object" && !Array.isArray(job.messages)) {
    const meta = job.messages as Record<string, unknown>;
    const cardTitle = String(meta.cardTitle ?? DEFAULT_LOYALTY_CARD_TITLE);
    const rewardTitle = String(meta.rewardTitle ?? "ลด 50% เมนูหลัก 1 กล่อง");
    const displayName = String(meta.displayName ?? "ลูกค้า LINE");

    if (job.eventType === "coupon_redeem") {
      const couponCode = String(meta.couponCode ?? "GT-COUPON");
      const claimedAtText = formatThaiDateTime(
        meta.claimedAt ? String(meta.claimedAt) : new Date().toISOString(),
      );
      const flexMessage = buildCouponRedeemFlexMessage({
        cardTitle,
        rewardTitle,
        couponCode,
        displayName,
        claimedAtText,
      });
      const plainText = buildCouponRedeemPlainText({
        cardTitle,
        rewardTitle,
        couponCode,
        displayName,
        claimedAtText,
      });
      return { messages: [flexMessage], fallbackText: plainText };
    }

    const pointsAdded = Number(meta.pointsAdded ?? 1);
    const newStamps = Number(meta.newStamps ?? 0);
    const stampsPerReward = Number(meta.stampsPerReward ?? 10);
    const rewardsUnlocked = Number(meta.rewardsUnlocked ?? 0);
    const validTill = formatValidTillDate(meta.expiresAt ? String(meta.expiresAt) : null);
    const liffId = String(meta.liffId ?? "").trim();
    const resolvedSecret = String(meta.shopSecret ?? shopSecret).trim();
    const cardUrl = buildLoyaltyCardUrl(origin, resolvedSecret, liffId);

    const flexMessage = buildStampAwardFlexMessage({
      cardTitle,
      rewardTitle,
      displayName,
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
      displayName,
      pointsAdded,
      newStamps,
      stampsPerReward,
      rewardsUnlocked,
      validTill,
    });
    return { messages: [flexMessage], fallbackText: plainText };
  }

  const fb = job.fallbackText ? String(job.fallbackText).trim() : "";
  return {
    messages: fb ? [{ type: "text", text: fb }] : [],
    fallbackText: fb || undefined,
  };
}

export async function processPendingLoyaltyPushJobs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => any },
  shopSecret: string,
  channelAccessToken: string,
  fallbackDirectJob?: {
    lineUserId: string;
    messages: Array<Record<string, unknown>>;
    fallbackPlainText?: string;
    retryKey?: string;
  },
  trustedOrigin?: string,
): Promise<void> {
  const token = decryptLoyaltySecret(channelAccessToken).trim();
  const primaryHash = getLoyaltyServerKeyHash();
  const legacyHash = getLegacyLoyaltyServerKeyHash();

  const { data: jobsData, error: jobsErr } = await supabase.rpc(
    "claim_pending_loyalty_push_jobs",
    {
      p_shop_secret: shopSecret,
      p_server_key_hash: primaryHash,
      p_legacy_key_hash: legacyHash,
      p_limit: 5,
    },
  );

  if (jobsErr || !Array.isArray(jobsData)) {
    // Fallback if queue table/RPC is not yet migrated in Supabase
    if (fallbackDirectJob && token) {
      await sendLinePushMessageWithRetry(
        token,
        fallbackDirectJob.lineUserId,
        fallbackDirectJob.messages,
        fallbackDirectJob.fallbackPlainText,
        2,
        fallbackDirectJob.retryKey,
      );
    }
    return;
  }

  const jobs = jobsData as Array<{
    id?: string;
    retryKey?: string;
    lineUserId?: string;
    eventType?: string;
    messages?: unknown;
    fallbackText?: string | null;
    attempts?: number;
    maxAttempts?: number;
  }>;

  for (const job of jobs) {
    const jobId = String(job.id ?? "");
    const retryKey = String(job.retryKey ?? job.id ?? "");
    const toUserId = String(job.lineUserId ?? "");
    const attempts = Number(job.attempts ?? 1);
    const maxAttempts = Number(job.maxAttempts ?? 6);

    if (!jobId) continue;

    if (!token) {
      await supabase.rpc("complete_loyalty_push_job", {
        p_job_id: jobId,
        p_shop_secret: shopSecret,
        p_server_key_hash: primaryHash,
        p_legacy_key_hash: legacyHash,
        p_status: "failed_auth",
        p_error: "MISSING_CHANNEL_ACCESS_TOKEN",
        p_retry_delay_seconds: 0,
      });
      continue;
    }

    const hydrated = resolvePushJobMessages(job, shopSecret, trustedOrigin);

    const pushRes = await sendLinePushMessageWithRetry(
      token,
      toUserId,
      hydrated.messages,
      hydrated.fallbackText,
      2,
      retryKey,
    );

    if (pushRes.ok) {
      await supabase.rpc("complete_loyalty_push_job", {
        p_job_id: jobId,
        p_shop_secret: shopSecret,
        p_server_key_hash: primaryHash,
        p_legacy_key_hash: legacyHash,
        p_status: "sent",
        p_error: null,
        p_retry_delay_seconds: 0,
      });
    } else if (pushRes.transient && attempts < maxAttempts) {
      await supabase.rpc("complete_loyalty_push_job", {
        p_job_id: jobId,
        p_shop_secret: shopSecret,
        p_server_key_hash: primaryHash,
        p_legacy_key_hash: legacyHash,
        p_status: "retry",
        p_error: pushRes.reason ?? "TRANSIENT_ERROR",
        p_retry_delay_seconds: computePushRetryBackoffSeconds(attempts),
      });
    } else {
      await supabase.rpc("complete_loyalty_push_job", {
        p_job_id: jobId,
        p_shop_secret: shopSecret,
        p_server_key_hash: primaryHash,
        p_legacy_key_hash: legacyHash,
        p_status: classifyPushFailureStatus(pushRes.reason),
        p_error: pushRes.reason ?? "PUSH_FAILED",
        p_retry_delay_seconds: 0,
      });
    }
  }
}

export async function processGlobalDueLoyaltyPushJobs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => any },
  trustedOrigin?: string,
): Promise<{
  ok: boolean;
  processed: number;
  sent: number;
  retried: number;
  failed: number;
  housekeeping?: Record<string, unknown>;
}> {
  const primaryHash = getLoyaltyServerKeyHash();
  const legacyHash = getLegacyLoyaltyServerKeyHash();

  if (!primaryHash) {
    return { ok: false, processed: 0, sent: 0, retried: 0, failed: 0 };
  }

  const { data, error } = await supabase.rpc("claim_due_loyalty_push_jobs_batch", {
    p_server_key_hash: primaryHash,
    p_legacy_key_hash: legacyHash,
    p_limit: 15,
  });

  if (error || !data || !(data as Record<string, unknown>).ok) {
    return { ok: false, processed: 0, sent: 0, retried: 0, failed: 0 };
  }

  const payload = data as {
    jobs?: Array<{
      id?: string;
      retryKey?: string;
      shopSecret?: string;
      channelAccessToken?: string;
      lineUserId?: string;
      eventType?: string;
      messages?: unknown;
      fallbackText?: string | null;
      attempts?: number;
      maxAttempts?: number;
    }>;
    housekeeping?: Record<string, unknown>;
  };

  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  let sent = 0;
  let retried = 0;
  let failed = 0;

  for (const job of jobs) {
    const jobId = String(job.id ?? "");
    const retryKey = String(job.retryKey ?? job.id ?? "");
    const shopSecret = String(job.shopSecret ?? "");
    const token = decryptLoyaltySecret(String(job.channelAccessToken ?? "")).trim();
    const toUserId = String(job.lineUserId ?? "");
    const attempts = Number(job.attempts ?? 1);
    const maxAttempts = Number(job.maxAttempts ?? 6);

    if (!jobId || !shopSecret) continue;

    if (!token) {
      failed += 1;
      await supabase.rpc("complete_loyalty_push_job", {
        p_job_id: jobId,
        p_shop_secret: shopSecret,
        p_server_key_hash: primaryHash,
        p_legacy_key_hash: legacyHash,
        p_status: "failed_auth",
        p_error: "MISSING_CHANNEL_ACCESS_TOKEN",
        p_retry_delay_seconds: 0,
      });
      continue;
    }

    const hydrated = resolvePushJobMessages(job, shopSecret, trustedOrigin);
    const pushRes = await sendLinePushMessageWithRetry(
      token,
      toUserId,
      hydrated.messages,
      hydrated.fallbackText,
      2,
      retryKey,
    );

    if (pushRes.ok) {
      sent += 1;
      await supabase.rpc("complete_loyalty_push_job", {
        p_job_id: jobId,
        p_shop_secret: shopSecret,
        p_server_key_hash: primaryHash,
        p_legacy_key_hash: legacyHash,
        p_status: "sent",
        p_error: null,
        p_retry_delay_seconds: 0,
      });
    } else if (pushRes.transient && attempts < maxAttempts) {
      retried += 1;
      await supabase.rpc("complete_loyalty_push_job", {
        p_job_id: jobId,
        p_shop_secret: shopSecret,
        p_server_key_hash: primaryHash,
        p_legacy_key_hash: legacyHash,
        p_status: "retry",
        p_error: pushRes.reason ?? "TRANSIENT_ERROR",
        p_retry_delay_seconds: computePushRetryBackoffSeconds(attempts),
      });
    } else {
      failed += 1;
      await supabase.rpc("complete_loyalty_push_job", {
        p_job_id: jobId,
        p_shop_secret: shopSecret,
        p_server_key_hash: primaryHash,
        p_legacy_key_hash: legacyHash,
        p_status: "failed_auth" === classifyPushFailureStatus(pushRes.reason)
          ? "failed_auth"
          : classifyPushFailureStatus(pushRes.reason),
        p_error: pushRes.reason ?? "PUSH_FAILED",
        p_retry_delay_seconds: 0,
      });
    }
  }

  return {
    ok: true,
    processed: jobs.length,
    sent,
    retried,
    failed,
    housekeeping: payload.housekeeping,
  };
}
