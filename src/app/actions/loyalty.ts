"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import type { ActionState } from "@/lib/action-state";
import { invalidateQueryCache } from "@/lib/data/queries";
import { hasSupabaseEnv } from "@/lib/env";
import { processPendingLoyaltyPushJobs } from "@/lib/line-messaging";
import {
  LOYALTY_SETTINGS_KEY,
  type LoyaltyConfig,
  type LoyaltyCouponRecord,
  type LoyaltyMemberSummary,
  type LoyaltyNotifyMode,
  computeExpiryDateIso,
  computeStampAwardProgress,
  createDefaultQrTokens,
  formatThaiDateTime,
  generateCouponCode,
  isValidLiffId,
  normalizeLoyaltyConfig,
} from "@/lib/loyalty";
import {
  decryptLoyaltySecret,
  encryptLoyaltySecret,
  getLoyaltyServerKeyHash,
  isCurrentVersionEncryptedSecret,
} from "@/lib/loyalty-crypto";
import { InputError, dbError, optionalText, runAction, text } from "@/lib/server-action";
import { DEFAULT_SHOP_ID, normalizeShopId, scopedSettingsKey } from "@/lib/shop-scope";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface LoyaltyPushQueueSummary {
  id: string;
  eventType: "stamp_claim" | "coupon_redeem";
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface LoyaltyAdminSnapshot {
  config: LoyaltyConfig;
  persisted: boolean;
  isTableReady: boolean;
  members: LoyaltyMemberSummary[];
  recentCoupons: Array<LoyaltyCouponRecord & { displayName: string }>;
  recentPushJobs?: LoyaltyPushQueueSummary[];
}

function isMissingRelationError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST204") return true;
  const msg = String(error.message ?? "");
  return msg.includes("loyalty_") && (msg.includes("does not exist") || msg.includes("schema cache"));
}

function isMissingRpcError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  const msg = String(error.message ?? "");
  return msg.includes("Could not find the function") || msg.includes("does not exist");
}

export async function fetchLoyaltyAdminData(
  rawShopId: string,
  fallbackShopName = "GaiTomNamPla 🐔",
): Promise<LoyaltyAdminSnapshot> {
  const shopId = normalizeShopId(rawShopId || DEFAULT_SHOP_ID);
  if (!hasSupabaseEnv) {
    return {
      config: normalizeLoyaltyConfig(null, fallbackShopName),
      persisted: false,
      isTableReady: true,
      members: [],
      recentCoupons: [],
      recentPushJobs: [],
    };
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      config: normalizeLoyaltyConfig(null, fallbackShopName),
      persisted: false,
      isTableReady: true,
      members: [],
      recentCoupons: [],
      recentPushJobs: [],
    };
  }

  const settingKey = scopedSettingsKey(LOYALTY_SETTINGS_KEY, shopId);
  const { data: settingRow } = await supabase
    .from("settings")
    .select("value")
    .eq("owner_id", user.id)
    .eq("key", settingKey)
    .maybeSingle();

  const persisted = Boolean(settingRow?.value && typeof settingRow.value === "object");
  const normalized = normalizeLoyaltyConfig(settingRow?.value, fallbackShopName);
  const decryptedSecret = decryptLoyaltySecret(normalized.channelSecret);
  const decryptedAccessToken = decryptLoyaltySecret(normalized.channelAccessToken);

  // Automatically upgrade legacy unencrypted or v1-encrypted settings rows to v2 AES-256-GCM + current serverKeyHash
  const currentServerKeyHash = getLoyaltyServerKeyHash();
  if (
    persisted &&
    (normalized.serverKeyHash !== currentServerKeyHash ||
      (normalized.channelAccessToken && !isCurrentVersionEncryptedSecret(normalized.channelAccessToken)) ||
      (normalized.channelSecret && !isCurrentVersionEncryptedSecret(normalized.channelSecret)))
  ) {
    const upgradedConfig: LoyaltyConfig = {
      ...normalized,
      channelSecret: decryptedSecret ? encryptLoyaltySecret(decryptedSecret) : "",
      channelAccessToken: decryptedAccessToken ? encryptLoyaltySecret(decryptedAccessToken) : "",
      serverKeyHash: currentServerKeyHash,
    };
    await supabase.from("settings").upsert(
      {
        owner_id: user.id,
        key: settingKey,
        value: upgradedConfig,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_id,key" },
    );
  }

  const config: LoyaltyConfig = {
    ...normalized,
    channelSecret: decryptedSecret,
    channelAccessToken: decryptedAccessToken,
    serverKeyHash: currentServerKeyHash,
  };

  const [
    { data: memberRows, error: memberErr },
    { data: couponRows, error: couponErr },
    { data: pushRows },
  ] = await Promise.all([
    supabase
      .from("loyalty_members")
      .select("id,line_user_id,display_name,picture_url,stamps,lifetime_stamps,expires_at,last_stamped_at")
      .eq("owner_id", user.id)
      .eq("shop_scope_id", shopId)
      .order("updated_at", { ascending: false })
      .limit(100),
    supabase
      .from("loyalty_coupons")
      .select("id,member_id,line_user_id,code,title,status,issued_at,claimed_at")
      .eq("owner_id", user.id)
      .eq("shop_scope_id", shopId)
      .order("issued_at", { ascending: false })
      .limit(100),
    supabase
      .from("loyalty_push_queue")
      .select("id,event_type,status,attempts,last_error,created_at,sent_at")
      .eq("owner_id", user.id)
      .eq("shop_scope_id", shopId)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  if (isMissingRelationError(memberErr) || isMissingRelationError(couponErr)) {
    return {
      config,
      persisted,
      isTableReady: false,
      members: [],
      recentCoupons: [],
      recentPushJobs: [],
    };
  }

  const couponsList = ((couponRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    memberId: String(row.member_id ?? ""),
    lineUserId: String(row.line_user_id ?? ""),
    code: String(row.code ?? ""),
    title: String(row.title ?? config.rewardTitle),
    status: (row.status === "claimed" ? "claimed" : "unclaimed") as "unclaimed" | "claimed",
    issuedAt: String(row.issued_at ?? new Date().toISOString()),
    claimedAt: row.claimed_at ? String(row.claimed_at) : null,
  }));

  const unclaimedByMember = new Map<string, number>();
  const claimedByMember = new Map<string, number>();
  for (const c of couponsList) {
    if (c.status === "unclaimed") {
      unclaimedByMember.set(c.memberId, (unclaimedByMember.get(c.memberId) ?? 0) + 1);
    } else {
      claimedByMember.set(c.memberId, (claimedByMember.get(c.memberId) ?? 0) + 1);
    }
  }

  const memberNameById = new Map<string, string>();
  const members: LoyaltyMemberSummary[] = ((memberRows ?? []) as Array<Record<string, unknown>>).map((row) => {
    const id = String(row.id);
    const displayName = String(row.display_name ?? "ลูกค้า LINE");
    memberNameById.set(id, displayName);
    return {
      id,
      lineUserId: String(row.line_user_id ?? ""),
      displayName,
      pictureUrl: row.picture_url ? String(row.picture_url) : null,
      stamps: Math.max(0, Number(row.stamps ?? 0)),
      lifetimeStamps: Math.max(0, Number(row.lifetime_stamps ?? 0)),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      lastStampedAt: row.last_stamped_at ? String(row.last_stamped_at) : null,
      unclaimedCount: unclaimedByMember.get(id) ?? 0,
      claimedCount: claimedByMember.get(id) ?? 0,
    };
  });

  const recentCoupons = couponsList.slice(0, 30).map((c) => ({
    id: c.id,
    code: c.code,
    title: c.title,
    status: c.status,
    issuedAt: c.issuedAt,
    claimedAt: c.claimedAt,
    displayName: memberNameById.get(c.memberId) ?? "ลูกค้า LINE",
  }));

  const recentPushJobs: LoyaltyPushQueueSummary[] = ((pushRows ?? []) as Array<Record<string, unknown>>).map(
    (row) => ({
      id: String(row.id),
      eventType: row.event_type === "coupon_redeem" ? "coupon_redeem" : "stamp_claim",
      status: String(row.status ?? "pending"),
      attempts: Number(row.attempts ?? 0),
      lastError: row.last_error ? String(row.last_error) : null,
      createdAt: String(row.created_at ?? new Date().toISOString()),
      sentAt: row.sent_at ? String(row.sent_at) : null,
    }),
  );

  const hasPendingPush = recentPushJobs.some(
    (j) => j.status === "pending" || j.status === "processing",
  );
  if (hasPendingPush && config.channelAccessToken) {
    after(async () => {
      try {
        const bgSupabase = await createSupabaseServerClient();
        await processPendingLoyaltyPushJobs(
          bgSupabase,
          config.shopSecret,
          config.channelAccessToken,
        );
      } catch {
        // Ignore background errors
      }
    });
  }

  return {
    config,
    persisted,
    isTableReady: true,
    members,
    recentCoupons,
    recentPushJobs,
  };
}

export async function saveLoyaltyConfigAction(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, shopId }) => {
    const settingKey = scopedSettingsKey(LOYALTY_SETTINGS_KEY, shopId);
    const { data: existingRow, error: readErr } = await supabase
      .from("settings")
      .select("value")
      .eq("owner_id", user.id)
      .eq("key", settingKey)
      .maybeSingle();
    if (readErr) dbError(readErr);

    const current = normalizeLoyaltyConfig(existingRow?.value);

    const enabled = form.get("loyalty_enabled") === "on" || form.get("loyalty_enabled") === "true";
    const cardTitle = text(form, "card_title", "ชื่อบัตรสะสมแต้ม", { max: 80 });
    const cardHeadline = text(form, "card_headline", "ข้อความโปรโมชั่นบนบัตร", { max: 120 });
    const rewardTitle = text(form, "reward_title", "ชื่อรางวัลส่วนลด", { max: 120 });

    const rawStampsPerReward = Number(form.get("stamps_per_reward") ?? current.stampsPerReward);
    const stampsPerReward = Math.max(1, Math.min(30, Math.round(rawStampsPerReward || 10)));

    const rawValidityMonths = Number(form.get("validity_months") ?? current.validityMonths);
    const validityMonths = Math.max(1, Math.min(36, Math.round(rawValidityMonths || 3)));

    const rawCooldownMinutes = Number(form.get("cooldown_minutes") ?? current.cooldownMinutes);
    const cooldownMinutes = Math.max(0, Math.min(1440, Math.round(Number.isFinite(rawCooldownMinutes) ? rawCooldownMinutes : 5)));

    const rulesText = optionalText(form, "rules_text", "เงื่อนไขการสะสมแต้ม", 1500) ?? "";
    const liffId = (optionalText(form, "liff_id", "LIFF ID", 120) ?? "").trim();
    if (liffId && !isValidLiffId(liffId)) {
      throw new InputError("รูปแบบ LIFF ID ไม่ถูกต้อง (ตัวอย่างที่ถูกต้อง: 2009769853-BWR6D81k)");
    }

    const botBasicId = optionalText(form, "bot_basic_id", "LINE OA Basic ID", 80) ?? "";
    const rawNotifyMode = String(form.get("notify_mode") ?? current.notifyMode ?? "all").trim();
    const notifyMode: LoyaltyNotifyMode =
      rawNotifyMode === "reward_only" || rawNotifyMode === "off" ? rawNotifyMode : "all";

    const rawChannelSecret = optionalText(form, "channel_secret", "Channel Secret", 240) ?? "";
    const rawChannelAccessToken = optionalText(form, "channel_access_token", "Channel Access Token", 600) ?? "";

    const formShopSecret = optionalText(form, "shop_secret", "Shop Secret", 80) ?? "";
    const formWebhookSecret = optionalText(form, "webhook_secret", "Webhook Secret", 80) ?? "";
    const rawQrTokensJson = String(form.get("qr_tokens_json") ?? "").trim();
    let parsedQrTokens = current.qrTokens;
    if (!existingRow?.value && rawQrTokensJson) {
      try {
        const candidate = JSON.parse(rawQrTokensJson) as Record<string, string>;
        if (candidate && typeof candidate === "object") {
          parsedQrTokens = normalizeLoyaltyConfig({ qrTokens: candidate }).qrTokens;
        }
      } catch {
        // Ignore invalid JSON
      }
    }

    const nextConfig: LoyaltyConfig = {
      ...current,
      enabled,
      shopSecret: existingRow?.value ? current.shopSecret : formShopSecret || current.shopSecret,
      webhookSecret: existingRow?.value ? current.webhookSecret : formWebhookSecret || current.webhookSecret,
      cardTitle,
      cardHeadline,
      rewardTitle,
      stampsPerReward,
      validityMonths,
      cooldownMinutes,
      rulesText: rulesText || current.rulesText,
      liffId,
      botBasicId: botBasicId ? (botBasicId.startsWith("@") ? botBasicId : `@${botBasicId}`) : "",
      notifyMode,
      channelSecret: rawChannelSecret ? encryptLoyaltySecret(rawChannelSecret) : "",
      channelAccessToken: rawChannelAccessToken ? encryptLoyaltySecret(rawChannelAccessToken) : "",
      serverKeyHash: getLoyaltyServerKeyHash(),
      qrTokens: parsedQrTokens,
    };

    const { error: upsertErr } = await supabase.from("settings").upsert(
      {
        owner_id: user.id,
        key: settingKey,
        value: nextConfig,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_id,key" },
    );
    if (upsertErr) dbError(upsertErr);

    invalidateQueryCache();
    revalidatePath("/settings");
    revalidatePath("/loyalty");
    return {
      ok: true,
      message: enabled
        ? "บันทึกและเข้ารหัส Token ระบบสะสมแต้ม LINE OA สำหรับร้านนี้เรียบร้อยแล้ว"
        : "บันทึกการตั้งค่าระบบสะสมแต้ม LINE OA แล้ว (สถานะ: ปิดใช้งานสำหรับร้านนี้)",
    };
  });
}

export async function regenerateLoyaltyQrTokensAction(): Promise<ActionState> {
  return runAction(async ({ supabase, user, shopId }) => {
    const settingKey = scopedSettingsKey(LOYALTY_SETTINGS_KEY, shopId);
    const { data: existingRow, error: readErr } = await supabase
      .from("settings")
      .select("value")
      .eq("owner_id", user.id)
      .eq("key", settingKey)
      .maybeSingle();
    if (readErr) dbError(readErr);

    const current = normalizeLoyaltyConfig(existingRow?.value);
    const nextConfig: LoyaltyConfig = {
      ...current,
      channelSecret: current.channelSecret ? encryptLoyaltySecret(decryptLoyaltySecret(current.channelSecret)) : "",
      channelAccessToken: current.channelAccessToken
        ? encryptLoyaltySecret(decryptLoyaltySecret(current.channelAccessToken))
        : "",
      serverKeyHash: getLoyaltyServerKeyHash(),
      qrTokens: createDefaultQrTokens(),
    };

    const { error: upsertErr } = await supabase.from("settings").upsert(
      {
        owner_id: user.id,
        key: settingKey,
        value: nextConfig,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_id,key" },
    );
    if (upsertErr) dbError(upsertErr);

    invalidateQueryCache();
    revalidatePath("/settings");
    revalidatePath("/loyalty");
    return {
      ok: true,
      message: "รีเซ็ตรหัส QR Code ทั้ง 1–10 กล่องเรียบร้อยแล้ว (แต้มและคูปองของลูกค้าทุกคนยังอยู่ครบเหมือนเดิม)",
    };
  });
}

export async function adjustMemberStampsAction(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, shopId }) => {
    const memberId = String(form.get("member_id") ?? "").trim();
    const rawDelta = Number(form.get("delta_stamps") ?? 0);
    if (!Number.isFinite(rawDelta) || Math.round(rawDelta) === 0) {
      throw new InputError("กรุณาระบุจำนวนแต้มที่ต้องการเพิ่มหรือลด");
    }
    const delta = Math.max(-50, Math.min(50, Math.round(rawDelta)));

    const { data: rpcData, error: rpcErr } = await supabase.rpc("admin_adjust_loyalty_stamps", {
      p_shop_scope_id: shopId,
      p_member_id: memberId,
      p_delta: delta,
    });

    if (!rpcErr && rpcData) {
      const res = rpcData as Record<string, unknown>;
      if (!res.ok) {
        throw new InputError(String(res.message ?? "ไม่สามารถปรับแต้มลูกค้าได้"));
      }
      const displayName = String(res.displayName ?? "ลูกค้า LINE");
      const nextStamps = Number(res.nextStamps ?? 0);
      const stampsPerReward = Number(res.stampsPerReward ?? 10);
      const issuedCouponsCount = Number(res.issuedCouponsCount ?? 0);

      invalidateQueryCache();
      revalidatePath("/settings");
      return {
        ok: true,
        message:
          delta > 0
            ? `เพิ่ม +${delta} แต้มให้ “${displayName}” แล้ว (แต้มปัจจุบัน ${nextStamps}/${stampsPerReward}${issuedCouponsCount > 0 ? ` · ออกคูปองใหม่ +${issuedCouponsCount} ใบ` : ""})`
            : `ปรับลด ${delta} แต้มของ “${displayName}” แล้ว (แต้มปัจจุบัน ${nextStamps}/${stampsPerReward})`,
      };
    }

    if (rpcErr && !isMissingRpcError(rpcErr)) {
      dbError(rpcErr);
    }

    const settingKey = scopedSettingsKey(LOYALTY_SETTINGS_KEY, shopId);
    const { data: existingRow, error: readErr } = await supabase
      .from("settings")
      .select("value")
      .eq("owner_id", user.id)
      .eq("key", settingKey)
      .maybeSingle();
    if (readErr) dbError(readErr);
    const config = normalizeLoyaltyConfig(existingRow?.value);

    const { data: memberRow, error: memberReadErr } = await supabase
      .from("loyalty_members")
      .select("*")
      .eq("id", memberId)
      .eq("owner_id", user.id)
      .eq("shop_scope_id", shopId)
      .maybeSingle();

    if (isMissingRelationError(memberReadErr)) {
      throw new InputError("กรุณารันไฟล์ SQL 202611110001_line_loyalty.sql ใน Supabase ก่อนจัดการแต้มลูกค้า");
    }
    if (memberReadErr) dbError(memberReadErr);
    if (!memberRow) {
      throw new InputError("ไม่พบข้อมูลลูกค้ารายนี้");
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const nextExpiresIso = computeExpiryDateIso(now, config.validityMonths);

    let currentStamps = Math.max(0, Number(memberRow.stamps ?? 0));
    const currentLifetime = Math.max(0, Number(memberRow.lifetime_stamps ?? 0));

    if (
      delta > 0 &&
      memberRow.expires_at &&
      new Date(String(memberRow.expires_at)).getTime() < now.getTime() &&
      currentStamps > 0
    ) {
      currentStamps = 0;
    }

    let nextStamps = currentStamps;
    let issuedCouponsCount = 0;

    if (delta > 0) {
      const progress = computeStampAwardProgress(currentStamps, delta, config.stampsPerReward);
      nextStamps = progress.newStamps;
      issuedCouponsCount = progress.rewardsUnlocked;
    } else {
      nextStamps = Math.max(0, currentStamps + delta);
    }

    const { error: updErr } = await supabase
      .from("loyalty_members")
      .update({
        stamps: nextStamps,
        lifetime_stamps: delta > 0 ? currentLifetime + delta : currentLifetime,
        expires_at: delta > 0 ? nextExpiresIso : memberRow.expires_at,
        updated_at: nowIso,
      })
      .eq("id", memberId)
      .eq("owner_id", user.id);
    if (updErr) dbError(updErr);

    if (issuedCouponsCount > 0) {
      const couponsToInsert = Array.from({ length: issuedCouponsCount }, () => ({
        owner_id: user.id,
        shop_scope_id: shopId,
        member_id: memberId,
        line_user_id: String(memberRow.line_user_id),
        code: generateCouponCode(),
        title: config.rewardTitle,
        status: "unclaimed",
        issued_at: nowIso,
      }));
      const { error: couponInsErr } = await supabase.from("loyalty_coupons").insert(couponsToInsert);
      if (couponInsErr) dbError(couponInsErr);
    }

    const { error: logErr } = await supabase.from("loyalty_logs").insert({
      owner_id: user.id,
      shop_scope_id: shopId,
      member_id: memberId,
      line_user_id: String(memberRow.line_user_id),
      action: "manual_adjust",
      points_delta: delta,
      balance_after: nextStamps,
      note: delta > 0 ? `ร้านค้าเพิ่มแต้มพิเศษ +${delta}` : `ร้านค้าปรับลดแต้ม ${delta}`,
    });
    if (logErr) dbError(logErr);

    invalidateQueryCache();
    revalidatePath("/settings");
    return {
      ok: true,
      message:
        delta > 0
          ? `เพิ่ม +${delta} แต้มให้ “${String(memberRow.display_name)}” แล้ว (แต้มปัจจุบัน ${nextStamps}/${config.stampsPerReward}${issuedCouponsCount > 0 ? ` · ออกคูปองใหม่ +${issuedCouponsCount} ใบ` : ""})`
          : `ปรับลด ${delta} แต้มของ “${String(memberRow.display_name)}” แล้ว (แต้มปัจจุบัน ${nextStamps}/${config.stampsPerReward})`,
    };
  });
}

export async function verifyOrRedeemCouponByCodeAction(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, shopId }) => {
    const rawCode = String(form.get("coupon_code") ?? "").trim();
    const cleanCode = rawCode.replace(/^#/, "").trim().toUpperCase();
    if (cleanCode.length < 4) {
      throw new InputError("กรุณากรอกรหัสคูปอง เช่น GT-XXXXXX");
    }

    const { data: rpcData, error: rpcErr } = await supabase.rpc("admin_redeem_coupon_by_code", {
      p_shop_scope_id: shopId,
      p_coupon_code: cleanCode,
    });

    if (!rpcErr && rpcData) {
      const res = rpcData as Record<string, unknown>;
      if (!res.ok) {
        throw new InputError(String(res.message ?? `ไม่พบรหัสคูปอง #${cleanCode}`));
      }
      const alreadyClaimed = Boolean(res.alreadyClaimed);
      const code = String(res.code ?? cleanCode);
      const title = String(res.title ?? "ส่วนลด 50%");
      const displayName = String(res.displayName ?? "ลูกค้า LINE");
      const claimedAtText = formatThaiDateTime(res.claimedAt ? String(res.claimedAt) : new Date());

      invalidateQueryCache();
      revalidatePath("/settings");

      if (alreadyClaimed) {
        return {
          ok: true,
          message: `ℹ️ คูปอง #${code} (${title}) ของ “${displayName}” ถูกกดใช้สิทธิ์ไปแล้วเมื่อ ${claimedAtText}`,
        };
      }
      return {
        ok: true,
        message: `✅ ยืนยันและตัดสิทธิ์คูปอง #${code} (${title}) ของ “${displayName}” เรียบร้อยแล้ว (${claimedAtText})`,
      };
    }

    if (rpcErr && !isMissingRpcError(rpcErr)) {
      dbError(rpcErr);
    }

    const { data: couponRow, error: readErr } = await supabase
      .from("loyalty_coupons")
      .select("*")
      .eq("owner_id", user.id)
      .eq("shop_scope_id", shopId)
      .ilike("code", cleanCode)
      .order("issued_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (readErr) dbError(readErr);
    if (!couponRow) {
      throw new InputError(`ไม่พบรหัสคูปอง #${cleanCode} ในร้านนี้`);
    }

    const { data: memberRow } = await supabase
      .from("loyalty_members")
      .select("display_name,stamps")
      .eq("id", String(couponRow.member_id))
      .maybeSingle();

    const displayName = String(memberRow?.display_name ?? "ลูกค้า LINE");

    if (couponRow.status === "claimed") {
      return {
        ok: true,
        message: `ℹ️ คูปอง #${String(couponRow.code)} (${String(couponRow.title)}) ของ “${displayName}” ถูกใช้สิทธิ์ไปแล้วเมื่อ ${formatThaiDateTime(String(couponRow.claimed_at))}`,
      };
    }

    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("loyalty_coupons")
      .update({
        status: "claimed",
        claimed_at: nowIso,
      })
      .eq("id", String(couponRow.id))
      .eq("owner_id", user.id);
    if (updErr) dbError(updErr);

    await supabase.from("loyalty_logs").insert({
      owner_id: user.id,
      shop_scope_id: shopId,
      member_id: String(couponRow.member_id),
      line_user_id: String(couponRow.line_user_id),
      action: "admin_coupon_redeem",
      points_delta: 0,
      balance_after: Number(memberRow?.stamps ?? 0),
      note: `ร้านค้ายืนยันการตัดสิทธิ์คูปอง #${String(couponRow.code)}`,
    });

    invalidateQueryCache();
    revalidatePath("/settings");
    return {
      ok: true,
      message: `✅ ยืนยันและตัดสิทธิ์คูปอง #${String(couponRow.code)} (${String(couponRow.title)}) ของ “${displayName}” เรียบร้อยแล้ว`,
    };
  });
}
