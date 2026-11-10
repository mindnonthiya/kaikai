"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { invalidateQueryCache } from "@/lib/data/queries";
import { hasSupabaseEnv } from "@/lib/env";
import {
  LOYALTY_SETTINGS_KEY,
  type LoyaltyConfig,
  type LoyaltyCouponRecord,
  type LoyaltyMemberSummary,
  computeExpiryDateIso,
  computeStampAwardProgress,
  createDefaultQrTokens,
  generateCouponCode,
  normalizeLoyaltyConfig,
} from "@/lib/loyalty";
import { InputError, dbError, optionalText, runAction, text } from "@/lib/server-action";
import { DEFAULT_SHOP_ID, normalizeShopId, scopedSettingsKey } from "@/lib/shop-scope";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface LoyaltyAdminSnapshot {
  config: LoyaltyConfig;
  persisted: boolean;
  isTableReady: boolean;
  members: LoyaltyMemberSummary[];
  recentCoupons: Array<LoyaltyCouponRecord & { displayName: string }>;
}

function isMissingRelationError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST204") return true;
  const msg = String(error.message ?? "");
  return msg.includes("loyalty_") && (msg.includes("does not exist") || msg.includes("schema cache"));
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
  const config = normalizeLoyaltyConfig(settingRow?.value, fallbackShopName);

  const [{ data: memberRows, error: memberErr }, { data: couponRows, error: couponErr }] =
    await Promise.all([
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
    ]);

  if (isMissingRelationError(memberErr) || isMissingRelationError(couponErr)) {
    return {
      config,
      persisted,
      isTableReady: false,
      members: [],
      recentCoupons: [],
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

  return {
    config,
    persisted,
    isTableReady: true,
    members,
    recentCoupons,
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
    const liffId = optionalText(form, "liff_id", "LIFF ID", 120) ?? "";
    const botBasicId = optionalText(form, "bot_basic_id", "LINE OA Basic ID", 80) ?? "";
    const channelSecret = optionalText(form, "channel_secret", "Channel Secret", 160) ?? "";
    const channelAccessToken = optionalText(form, "channel_access_token", "Channel Access Token", 400) ?? "";

    // Allow preserving existing secrets passed from hidden inputs if not yet persisted
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
      channelSecret,
      channelAccessToken,
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
        ? "บันทึกและเปิดใช้งานระบบสะสมแต้ม LINE OA สำหรับร้านนี้แล้ว"
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
    const settingKey = scopedSettingsKey(LOYALTY_SETTINGS_KEY, shopId);
    const { data: existingRow, error: readErr } = await supabase
      .from("settings")
      .select("value")
      .eq("owner_id", user.id)
      .eq("key", settingKey)
      .maybeSingle();
    if (readErr) dbError(readErr);
    const config = normalizeLoyaltyConfig(existingRow?.value);

    const memberId = String(form.get("member_id") ?? "").trim();
    const rawDelta = Number(form.get("delta_stamps") ?? 0);
    if (!Number.isFinite(rawDelta) || Math.round(rawDelta) === 0) {
      throw new InputError("กรุณาระบุจำนวนแต้มที่ต้องการเพิ่มหรือลด");
    }
    const delta = Math.max(-50, Math.min(50, Math.round(rawDelta)));

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

    const currentStamps = Math.max(0, Number(memberRow.stamps ?? 0));
    const currentLifetime = Math.max(0, Number(memberRow.lifetime_stamps ?? 0));
    const now = new Date();
    const nowIso = now.toISOString();
    const nextExpiresIso = computeExpiryDateIso(now, config.validityMonths);

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

    await supabase.from("loyalty_logs").insert({
      owner_id: user.id,
      shop_scope_id: shopId,
      member_id: memberId,
      line_user_id: String(memberRow.line_user_id),
      action: "manual_adjust",
      points_delta: delta,
      balance_after: nextStamps,
      note: delta > 0 ? `ร้านค้าเพิ่มแต้มพิเศษ +${delta}` : `ร้านค้าปรับลดแต้ม ${delta}`,
    });

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
