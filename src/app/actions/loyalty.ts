"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import type { ActionState } from "@/lib/action-state";
import { readCostRows } from "@/lib/cost-rows";
import { getCached, invalidateQueryCache, setCached } from "@/lib/data/queries";
import { hasSupabaseEnv } from "@/lib/env";
import { processPendingLoyaltyPushJobs } from "@/lib/line-messaging";
import {
  LOYALTY_ADMIN_PAGE_SIZE,
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
  isMissingRelationError,
  isMissingRpcError,
  isValidLiffId,
  normalizeLoyaltyConfig,
  redactLoyaltyConfigForClient,
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
  memberId?: string;
  lineUserId?: string;
  displayName?: string;
  pictureUrl?: string | null;
  eventType: "stamp_claim" | "coupon_redeem";
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface LoyaltyActivityLogItem {
  id: string;
  memberId: string;
  lineUserId: string;
  displayName: string;
  pictureUrl: string | null;
  action: string;
  pointsDelta: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
}

export interface LoyaltyOverviewMetrics {
  totalMembers: number;
  scansTodayCount: number;
  pointsTodayCount: number;
  scans7dCount: number;
  points7dCount: number;
  readyCouponsCount: number;
  usedCouponsCount: number;
  failedPushCount: number;
  pendingPushCount: number;
}

export interface LoyaltyAdminCouponItem extends LoyaltyCouponRecord {
  memberId: string;
  lineUserId: string;
  displayName: string;
  pictureUrl: string | null;
}

export interface LoyaltyPaginatedResult<T> {
  ok: boolean;
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  message?: string;
}

export interface LoyaltyMemberDetailResult {
  ok: boolean;
  member: LoyaltyMemberSummary | null;
  coupons: LoyaltyAdminCouponItem[];
  logs: LoyaltyActivityLogItem[];
  couponsTotal?: number;
  logsTotal?: number;
  message?: string;
}

export interface LoyaltyAdminSnapshot {
  config: LoyaltyConfig;
  persisted: boolean;
  isTableReady: boolean;
  members: LoyaltyMemberSummary[];
  recentCoupons: LoyaltyAdminCouponItem[];
  recentPushJobs?: LoyaltyPushQueueSummary[];
  recentLogs?: LoyaltyActivityLogItem[];
  metrics?: LoyaltyOverviewMetrics;
  membersTotal?: number;
  couponsTotal?: number;
  logsTotal?: number;
  loadedTabs?: string[];
}

export interface LoyaltySettingsSummary {
  config: LoyaltyConfig;
  persisted: boolean;
  isTableReady: boolean;
  totalMembers: number;
  readyCouponsCount: number;
  failedPushCount: number;
}

function getBangkokStartOfDayMs(now = new Date()): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dateStr = formatter.format(now); // YYYY-MM-DD in Asia/Bangkok
  return new Date(`${dateStr}T00:00:00+07:00`).getTime();
}

function sanitizePostgrestSearch(raw: string): string {
  return raw.replace(/[,()*%\\]/g, " ").trim();
}

// Cache whether migration 0002 RPCs exist so we don't waste a failed RPC round-trip on every request
let adminRpcsMissingUntilMs = 0;
function shouldTryAdminRpcs(): boolean {
  return Date.now() >= adminRpcsMissingUntilMs;
}
function markAdminRpcsMissing(): void {
  adminRpcsMissingUntilMs = Date.now() + 60_000;
}

async function fetchMemberProfilesByIds(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  ownerId: string,
  shopId: string,
  memberIds: string[],
  lineUserIds: string[] = [],
): Promise<{
  nameById: Map<string, string>;
  picById: Map<string, string | null>;
  nameByLineId: Map<string, string>;
  picByLineId: Map<string, string | null>;
}> {
  const nameById = new Map<string, string>();
  const picById = new Map<string, string | null>();
  const nameByLineId = new Map<string, string>();
  const picByLineId = new Map<string, string | null>();

  const uniqueMemberIds = Array.from(new Set(memberIds.filter(Boolean)));
  const uniqueLineIds = Array.from(new Set(lineUserIds.filter(Boolean)));

  if (uniqueMemberIds.length > 0) {
    const { data } = await supabase
      .from("loyalty_members")
      .select("id,line_user_id,display_name,picture_url")
      .eq("owner_id", ownerId)
      .eq("shop_scope_id", shopId)
      .in("id", uniqueMemberIds);

    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const id = String(row.id ?? "");
      const lineId = String(row.line_user_id ?? "");
      const name = String(row.display_name ?? "ลูกค้า LINE");
      const pic = row.picture_url ? String(row.picture_url) : null;
      if (id) {
        nameById.set(id, name);
        picById.set(id, pic);
      }
      if (lineId) {
        nameByLineId.set(lineId, name);
        picByLineId.set(lineId, pic);
      }
    }
  }

  const missingLineIds = uniqueLineIds.filter((lid) => !nameByLineId.has(lid));
  if (missingLineIds.length > 0) {
    const { data } = await supabase
      .from("loyalty_members")
      .select("id,line_user_id,display_name,picture_url")
      .eq("owner_id", ownerId)
      .eq("shop_scope_id", shopId)
      .in("line_user_id", missingLineIds);

    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const id = String(row.id ?? "");
      const lineId = String(row.line_user_id ?? "");
      const name = String(row.display_name ?? "ลูกค้า LINE");
      const pic = row.picture_url ? String(row.picture_url) : null;
      if (id) {
        nameById.set(id, name);
        picById.set(id, pic);
      }
      if (lineId) {
        nameByLineId.set(lineId, name);
        picByLineId.set(lineId, pic);
      }
    }
  }

  return { nameById, picById, nameByLineId, picByLineId };
}

async function queryMembersPageWithClient(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  ownerId: string,
  shopId: string,
  options: {
    query?: string;
    filter?: "all" | "has_coupon" | "near_reward";
    page?: number;
    pageSize?: number;
    stampsPerReward?: number;
  },
): Promise<{ items: LoyaltyMemberSummary[]; total: number; page: number; pageSize: number; error?: { code?: string; message?: string } | null }> {
  const pageSize = Math.max(1, Math.min(100, Math.round(options.pageSize ?? LOYALTY_ADMIN_PAGE_SIZE)));
  const page = Math.max(1, Math.round(options.page ?? 1));
  const filter = options.filter ?? "all";
  const cleanSearch = sanitizePostgrestSearch(options.query ?? "");
  const stampsPerReward = Math.max(1, Math.round(options.stampsPerReward ?? 10));

  const selectCols: string =
    filter === "has_coupon"
      ? "id,line_user_id,display_name,picture_url,stamps,lifetime_stamps,expires_at,last_stamped_at,loyalty_coupons!inner(status)"
      : "id,line_user_id,display_name,picture_url,stamps,lifetime_stamps,expires_at,last_stamped_at,loyalty_coupons(status)";

  let dbQuery = supabase
    .from("loyalty_members")
    .select(selectCols, {
      count: "exact",
    })
    .eq("owner_id", ownerId)
    .eq("shop_scope_id", shopId);

  if (cleanSearch) {
    dbQuery = dbQuery.or(`display_name.ilike.%${cleanSearch}%,line_user_id.ilike.%${cleanSearch}%`);
  }
  if (filter === "near_reward") {
    dbQuery = dbQuery.gte("stamps", Math.max(1, stampsPerReward - 2));
  }
  if (filter === "has_coupon") {
    dbQuery = dbQuery.eq("loyalty_coupons.status", "unclaimed");
  }

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data: memberRows, count, error } = await dbQuery
    .order("updated_at", { ascending: false })
    .range(from, to);

  if (error) {
    return { items: [], total: 0, page, pageSize, error };
  }

  const rowsList = (memberRows ?? []) as unknown as Array<Record<string, unknown>>;
  const pageMemberIds = rowsList.map((r) => String(r.id ?? "")).filter(Boolean);

  const unclaimedByMember = new Map<string, number>();
  const claimedByMember = new Map<string, number>();

  const hasEmbeddedCoupons =
    filter !== "has_coupon" &&
    rowsList.every((r) => Array.isArray(r.loyalty_coupons));

  if (hasEmbeddedCoupons) {
    for (const row of rowsList) {
      const mId = String(row.id ?? "");
      if (!mId) continue;
      const embedded = (row.loyalty_coupons ?? []) as Array<Record<string, unknown>>;
      for (const c of embedded) {
        if (c.status === "claimed") {
          claimedByMember.set(mId, (claimedByMember.get(mId) ?? 0) + 1);
        } else {
          unclaimedByMember.set(mId, (unclaimedByMember.get(mId) ?? 0) + 1);
        }
      }
    }
  } else if (pageMemberIds.length > 0) {
    const { data: memberCoupons } = await supabase
      .from("loyalty_coupons")
      .select("member_id,status")
      .eq("owner_id", ownerId)
      .eq("shop_scope_id", shopId)
      .in("member_id", pageMemberIds);

    for (const c of (memberCoupons ?? []) as Array<Record<string, unknown>>) {
      const mId = String(c.member_id ?? "");
      if (!mId) continue;
      if (c.status === "claimed") {
        claimedByMember.set(mId, (claimedByMember.get(mId) ?? 0) + 1);
      } else {
        unclaimedByMember.set(mId, (unclaimedByMember.get(mId) ?? 0) + 1);
      }
    }
  }

  const items: LoyaltyMemberSummary[] = rowsList.map((row) => {
    const id = String(row.id ?? "");
    return {
      id,
      lineUserId: String(row.line_user_id ?? ""),
      displayName: String(row.display_name ?? "ลูกค้า LINE"),
      pictureUrl: row.picture_url ? String(row.picture_url) : null,
      stamps: Math.max(0, Number(row.stamps ?? 0)),
      lifetimeStamps: Math.max(0, Number(row.lifetime_stamps ?? 0)),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      lastStampedAt: row.last_stamped_at ? String(row.last_stamped_at) : null,
      unclaimedCount: unclaimedByMember.get(id) ?? 0,
      claimedCount: claimedByMember.get(id) ?? 0,
    };
  });

  return {
    items,
    total: count ?? items.length,
    page,
    pageSize,
  };
}

async function queryCouponsPageWithClient(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  ownerId: string,
  shopId: string,
  rewardTitleFallback: string,
  options: {
    query?: string;
    status?: "unclaimed" | "claimed" | "all";
    page?: number;
    pageSize?: number;
  },
): Promise<{ items: LoyaltyAdminCouponItem[]; total: number; page: number; pageSize: number; error?: { code?: string; message?: string } | null }> {
  const pageSize = Math.max(1, Math.min(100, Math.round(options.pageSize ?? LOYALTY_ADMIN_PAGE_SIZE)));
  const page = Math.max(1, Math.round(options.page ?? 1));
  const status = options.status ?? "unclaimed";
  const rawSearch = (options.query ?? "").replace(/^#/, "").trim();
  const cleanSearch = sanitizePostgrestSearch(rawSearch);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  if (shouldTryAdminRpcs()) {
    const { data: rpcData, error: rpcErr } = await supabase.rpc("admin_query_loyalty_coupons", {
      p_shop_scope_id: shopId,
      p_status: status,
      p_query: cleanSearch,
      p_limit: pageSize,
      p_offset: from,
    });

    if (rpcErr && isMissingRpcError(rpcErr)) {
      markAdminRpcsMissing();
    } else if (!rpcErr && rpcData && typeof rpcData === "object") {
      const payload = rpcData as Record<string, unknown>;
      if (payload.ok) {
        const rpcItems = Array.isArray(payload.items) ? (payload.items as Array<Record<string, unknown>>) : [];
        return {
          items: rpcItems.map((row) => ({
            id: String(row.id ?? ""),
            memberId: String(row.memberId ?? ""),
            lineUserId: String(row.lineUserId ?? ""),
            code: String(row.code ?? ""),
            title: String(row.title ?? rewardTitleFallback),
            status: row.status === "claimed" ? "claimed" : "unclaimed",
            issuedAt: String(row.issuedAt ?? new Date().toISOString()),
            claimedAt: row.claimedAt ? String(row.claimedAt) : null,
            displayName: String(row.displayName ?? "ลูกค้า LINE"),
            pictureUrl: row.pictureUrl ? String(row.pictureUrl) : null,
          })),
          total: Math.max(0, Number(payload.total ?? 0)),
          page,
          pageSize,
        };
      }
    }
  }

  let matchingMemberIds: string[] = [];
  if (cleanSearch) {
    const { data: matchedMembers } = await supabase
      .from("loyalty_members")
      .select("id")
      .eq("owner_id", ownerId)
      .eq("shop_scope_id", shopId)
      .or(`display_name.ilike.%${cleanSearch}%,line_user_id.ilike.%${cleanSearch}%`)
      .limit(500);

    matchingMemberIds = ((matchedMembers ?? []) as Array<Record<string, unknown>>)
      .map((m) => String(m.id ?? ""))
      .filter(Boolean);
  }

  let dbQuery = supabase
    .from("loyalty_coupons")
    .select("id,member_id,line_user_id,code,title,status,issued_at,claimed_at", { count: "exact" })
    .eq("owner_id", ownerId)
    .eq("shop_scope_id", shopId);

  if (status === "unclaimed" || status === "claimed") {
    dbQuery = dbQuery.eq("status", status);
  }

  if (cleanSearch) {
    if (matchingMemberIds.length > 0) {
      dbQuery = dbQuery.or(`code.ilike.%${cleanSearch}%,title.ilike.%${cleanSearch}%,member_id.in.(${matchingMemberIds.join(",")})`);
    } else {
      dbQuery = dbQuery.or(`code.ilike.%${cleanSearch}%,title.ilike.%${cleanSearch}%`);
    }
  }

  const { data: couponRows, count, error } = await dbQuery
    .order("issued_at", { ascending: false })
    .range(from, to);

  if (error) {
    return { items: [], total: 0, page, pageSize, error };
  }

  const rowsList = (couponRows ?? []) as Array<Record<string, unknown>>;
  const { nameById, picById, nameByLineId, picByLineId } = await fetchMemberProfilesByIds(
    supabase,
    ownerId,
    shopId,
    rowsList.map((r) => String(r.member_id ?? "")),
    rowsList.map((r) => String(r.line_user_id ?? "")),
  );

  const items: LoyaltyAdminCouponItem[] = rowsList.map((row) => {
    const memberId = String(row.member_id ?? "");
    const lineUserId = String(row.line_user_id ?? "");
    return {
      id: String(row.id ?? ""),
      memberId,
      lineUserId,
      code: String(row.code ?? ""),
      title: String(row.title ?? rewardTitleFallback),
      status: row.status === "claimed" ? "claimed" : "unclaimed",
      issuedAt: String(row.issued_at ?? new Date().toISOString()),
      claimedAt: row.claimed_at ? String(row.claimed_at) : null,
      displayName: nameById.get(memberId) ?? nameByLineId.get(lineUserId) ?? "ลูกค้า LINE",
      pictureUrl: picById.get(memberId) ?? picByLineId.get(lineUserId) ?? null,
    };
  });

  return {
    items,
    total: count ?? items.length,
    page,
    pageSize,
  };
}

async function queryLogsPageWithClient(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  ownerId: string,
  shopId: string,
  options: {
    query?: string;
    page?: number;
    pageSize?: number;
  },
): Promise<{ items: LoyaltyActivityLogItem[]; total: number; page: number; pageSize: number; error?: { code?: string; message?: string } | null }> {
  const pageSize = Math.max(1, Math.min(100, Math.round(options.pageSize ?? LOYALTY_ADMIN_PAGE_SIZE)));
  const page = Math.max(1, Math.round(options.page ?? 1));
  const cleanSearch = sanitizePostgrestSearch(options.query ?? "");
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  if (shouldTryAdminRpcs()) {
    const { data: rpcData, error: rpcErr } = await supabase.rpc("admin_query_loyalty_logs", {
      p_shop_scope_id: shopId,
      p_query: cleanSearch,
      p_limit: pageSize,
      p_offset: from,
    });

    if (rpcErr && isMissingRpcError(rpcErr)) {
      markAdminRpcsMissing();
    } else if (!rpcErr && rpcData && typeof rpcData === "object") {
      const payload = rpcData as Record<string, unknown>;
      if (payload.ok) {
        const rpcItems = Array.isArray(payload.items) ? (payload.items as Array<Record<string, unknown>>) : [];
        return {
          items: rpcItems.map((row) => ({
            id: String(row.id ?? ""),
            memberId: String(row.memberId ?? ""),
            lineUserId: String(row.lineUserId ?? ""),
            displayName: String(row.displayName ?? "ลูกค้า LINE"),
            pictureUrl: row.pictureUrl ? String(row.pictureUrl) : null,
            action: String(row.action ?? "qr_claim"),
            pointsDelta: Number(row.pointsDelta ?? 0),
            balanceAfter: Number(row.balanceAfter ?? 0),
            note: row.note ? String(row.note) : null,
            createdAt: String(row.createdAt ?? new Date().toISOString()),
          })),
          total: Math.max(0, Number(payload.total ?? 0)),
          page,
          pageSize,
        };
      }
    }
  }

  let matchingMemberIds: string[] = [];
  if (cleanSearch) {
    const { data: matchedMembers } = await supabase
      .from("loyalty_members")
      .select("id")
      .eq("owner_id", ownerId)
      .eq("shop_scope_id", shopId)
      .or(`display_name.ilike.%${cleanSearch}%,line_user_id.ilike.%${cleanSearch}%`)
      .limit(500);

    matchingMemberIds = ((matchedMembers ?? []) as Array<Record<string, unknown>>)
      .map((m) => String(m.id ?? ""))
      .filter(Boolean);
  }

  let dbQuery = supabase
    .from("loyalty_logs")
    .select("id,member_id,line_user_id,action,points_delta,balance_after,note,created_at", { count: "exact" })
    .eq("owner_id", ownerId)
    .eq("shop_scope_id", shopId);

  if (cleanSearch) {
    if (matchingMemberIds.length > 0) {
      dbQuery = dbQuery.or(`note.ilike.%${cleanSearch}%,action.ilike.%${cleanSearch}%,member_id.in.(${matchingMemberIds.join(",")})`);
    } else {
      dbQuery = dbQuery.or(`note.ilike.%${cleanSearch}%,action.ilike.%${cleanSearch}%`);
    }
  }

  const { data: logRows, count, error } = await dbQuery
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) {
    return { items: [], total: 0, page, pageSize, error };
  }

  const rowsList = (logRows ?? []) as Array<Record<string, unknown>>;
  const { nameById, picById, nameByLineId, picByLineId } = await fetchMemberProfilesByIds(
    supabase,
    ownerId,
    shopId,
    rowsList.map((r) => String(r.member_id ?? "")),
    rowsList.map((r) => String(r.line_user_id ?? "")),
  );

  const items: LoyaltyActivityLogItem[] = rowsList.map((row) => {
    const memberId = String(row.member_id ?? "");
    const lineUserId = String(row.line_user_id ?? "");
    return {
      id: String(row.id ?? ""),
      memberId,
      lineUserId,
      displayName: nameById.get(memberId) ?? nameByLineId.get(lineUserId) ?? "ลูกค้า LINE",
      pictureUrl: picById.get(memberId) ?? picByLineId.get(lineUserId) ?? null,
      action: String(row.action ?? "qr_claim"),
      pointsDelta: Number(row.points_delta ?? 0),
      balanceAfter: Number(row.balance_after ?? 0),
      note: row.note ? String(row.note) : null,
      createdAt: String(row.created_at ?? new Date().toISOString()),
    };
  });

  return {
    items,
    total: count ?? items.length,
    page,
    pageSize,
  };
}

export async function fetchLoyaltySettingsSummary(
  rawShopId: string,
  fallbackShopName = "GaiTomNamPla 🐔",
): Promise<LoyaltySettingsSummary> {
  const shopId = normalizeShopId(rawShopId || DEFAULT_SHOP_ID);
  if (!hasSupabaseEnv) {
    return {
      config: redactLoyaltyConfigForClient(normalizeLoyaltyConfig(null, fallbackShopName), "", ""),
      persisted: false,
      isTableReady: true,
      totalMembers: 0,
      readyCouponsCount: 0,
      failedPushCount: 0,
    };
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      config: redactLoyaltyConfigForClient(normalizeLoyaltyConfig(null, fallbackShopName), "", ""),
      persisted: false,
      isTableReady: true,
      totalMembers: 0,
      readyCouponsCount: 0,
      failedPushCount: 0,
    };
  }

  const cacheKey = `${user.id}:loyalty_summary:${shopId}`;
  const cached = getCached<LoyaltySettingsSummary>(cacheKey);
  if (cached) return cached;

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

  const config = redactLoyaltyConfigForClient(
    {
      ...normalized,
      serverKeyHash: getLoyaltyServerKeyHash(),
    },
    decryptedSecret,
    decryptedAccessToken,
  );

  const [
    { count: memberCount, error: memberErr },
    { count: readyCouponsCount, error: couponErr },
    { count: failedPushCount },
  ] = await Promise.all([
    supabase
      .from("loyalty_members")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", user.id)
      .eq("shop_scope_id", shopId),
    supabase
      .from("loyalty_coupons")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", user.id)
      .eq("shop_scope_id", shopId)
      .eq("status", "unclaimed"),
    supabase
      .from("loyalty_push_queue")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", user.id)
      .eq("shop_scope_id", shopId)
      .in("status", ["failed_network", "failed_quota", "failed_auth", "failed_recipient"]),
  ]);

  if (isMissingRelationError(memberErr) || isMissingRelationError(couponErr)) {
    return {
      config,
      persisted,
      isTableReady: false,
      totalMembers: 0,
      readyCouponsCount: 0,
      failedPushCount: 0,
    };
  }

  const summary: LoyaltySettingsSummary = {
    config,
    persisted,
    isTableReady: true,
    totalMembers: memberCount ?? 0,
    readyCouponsCount: readyCouponsCount ?? 0,
    failedPushCount: failedPushCount ?? 0,
  };

  return setCached(cacheKey, summary, 30_000);
}

export async function fetchLoyaltyAdminData(
  rawShopId: string,
  fallbackShopName = "GaiTomNamPla 🐔",
  initialTab: "overview" | "qr" | "members" | "coupons" | "settings" = "overview",
): Promise<LoyaltyAdminSnapshot> {
  const shopId = normalizeShopId(rawShopId || DEFAULT_SHOP_ID);
  const emptyMetrics: LoyaltyOverviewMetrics = {
    totalMembers: 0,
    scansTodayCount: 0,
    pointsTodayCount: 0,
    scans7dCount: 0,
    points7dCount: 0,
    readyCouponsCount: 0,
    usedCouponsCount: 0,
    failedPushCount: 0,
    pendingPushCount: 0,
  };

  if (!hasSupabaseEnv) {
    return {
      config: redactLoyaltyConfigForClient(normalizeLoyaltyConfig(null, fallbackShopName), "", ""),
      persisted: false,
      isTableReady: true,
      members: [],
      recentCoupons: [],
      recentPushJobs: [],
      recentLogs: [],
      metrics: emptyMetrics,
      membersTotal: 0,
      couponsTotal: 0,
      logsTotal: 0,
      loadedTabs: [initialTab],
    };
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      config: redactLoyaltyConfigForClient(normalizeLoyaltyConfig(null, fallbackShopName), "", ""),
      persisted: false,
      isTableReady: true,
      members: [],
      recentCoupons: [],
      recentPushJobs: [],
      recentLogs: [],
      metrics: emptyMetrics,
      membersTotal: 0,
      couponsTotal: 0,
      logsTotal: 0,
      loadedTabs: [initialTab],
    };
  }

  const snapshotCacheKey = `${user.id}:loyalty_admin_snapshot:${shopId}`;
  const cachedSnapshot = getCached<LoyaltyAdminSnapshot>(snapshotCacheKey);
  if (cachedSnapshot) {
    return cachedSnapshot;
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

  // Never send decrypted secrets to Client Components
  const config = redactLoyaltyConfigForClient(
    {
      ...normalized,
      serverKeyHash: currentServerKeyHash,
    },
    decryptedSecret,
    decryptedAccessToken,
  );

  const todayStartMs = getBangkokStartOfDayMs();
  const todayStartIso = new Date(todayStartMs).toISOString();
  const sevenDaysAgoMs = todayStartMs - 6 * 24 * 60 * 60 * 1000;
  const sevenDaysAgoIso = new Date(sevenDaysAgoMs).toISOString();

  // Fetch overview stats + first page of members, coupons, and logs in parallel so all tabs switch instantly
  const [
    overviewRpcResult,
    { data: pushRows },
    overviewLogsRes,
    initialMembersRes,
    initialCouponsRes,
  ] = await Promise.all([
    shouldTryAdminRpcs()
      ? supabase.rpc("get_loyalty_admin_overview_stats", {
          p_shop_scope_id: shopId,
          p_today_start: todayStartIso,
          p_seven_days_ago: sevenDaysAgoIso,
        })
      : Promise.resolve({ data: null, error: { code: "PGRST202", message: "skipped" } }),
    supabase
      .from("loyalty_push_queue")
      .select("id,member_id,line_user_id,event_type,status,attempts,last_error,created_at,sent_at")
      .eq("owner_id", user.id)
      .eq("shop_scope_id", shopId)
      .order("created_at", { ascending: false })
      .limit(15),
    queryLogsPageWithClient(supabase, user.id, shopId, {
      page: 1,
      pageSize: LOYALTY_ADMIN_PAGE_SIZE,
    }),
    queryMembersPageWithClient(supabase, user.id, shopId, {
      page: 1,
      pageSize: LOYALTY_ADMIN_PAGE_SIZE,
      stampsPerReward: config.stampsPerReward,
    }),
    queryCouponsPageWithClient(supabase, user.id, shopId, config.rewardTitle, {
      status: "unclaimed",
      page: 1,
      pageSize: LOYALTY_ADMIN_PAGE_SIZE,
    }),
  ]);

  const { data: overviewRpcData, error: overviewRpcErr } = overviewRpcResult;
  if (overviewRpcErr && isMissingRpcError(overviewRpcErr)) {
    markAdminRpcsMissing();
  }

  let exactTotalMembers = 0;
  let exactReadyCoupons = 0;
  let exactUsedCoupons = 0;
  let exactFailedPush = 0;
  let exactPendingPush = 0;
  let scansTodayCount = 0;
  let pointsTodayCount = 0;
  let scans7dCount = 0;
  let points7dCount = 0;

  if (!overviewRpcErr && overviewRpcData && typeof overviewRpcData === "object") {
    const rpcMetrics = overviewRpcData as Record<string, unknown>;
    exactTotalMembers = Math.max(0, Number(rpcMetrics.totalMembers ?? 0));
    exactReadyCoupons = Math.max(0, Number(rpcMetrics.readyCouponsCount ?? 0));
    exactUsedCoupons = Math.max(0, Number(rpcMetrics.usedCouponsCount ?? 0));
    exactFailedPush = Math.max(0, Number(rpcMetrics.failedPushCount ?? 0));
    exactPendingPush = Math.max(0, Number(rpcMetrics.pendingPushCount ?? 0));
    scansTodayCount = Math.max(0, Number(rpcMetrics.scansTodayCount ?? 0));
    pointsTodayCount = Math.max(0, Number(rpcMetrics.pointsTodayCount ?? 0));
    scans7dCount = Math.max(0, Number(rpcMetrics.scans7dCount ?? 0));
    points7dCount = Math.max(0, Number(rpcMetrics.points7dCount ?? 0));
  } else {
    // Fallback when `get_loyalty_admin_overview_stats` RPC is not yet migrated in Supabase:
    // Use exact counts (`head: true`) + paginated `readCostRows` over 7-day logs (no 5,000-row ceiling)
    let scanLogsErr: { code?: string; message?: string } | null = null;
    const [
      { count: totalMembersCount, error: memberCountErr },
      { count: readyCouponsCount, error: readyCouponErr },
      { count: usedCouponsCount },
      { count: failedPushCount },
      { count: pendingPushCount },
      scanLogs7d,
    ] = await Promise.all([
      supabase
        .from("loyalty_members")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", user.id)
        .eq("shop_scope_id", shopId),
      supabase
        .from("loyalty_coupons")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", user.id)
        .eq("shop_scope_id", shopId)
        .eq("status", "unclaimed"),
      supabase
        .from("loyalty_coupons")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", user.id)
        .eq("shop_scope_id", shopId)
        .eq("status", "claimed"),
      supabase
        .from("loyalty_push_queue")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", user.id)
        .eq("shop_scope_id", shopId)
        .in("status", ["failed_network", "failed_quota", "failed_auth", "failed_recipient"]),
      supabase
        .from("loyalty_push_queue")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", user.id)
        .eq("shop_scope_id", shopId)
        .in("status", ["pending", "processing"]),
      readCostRows((from, to) =>
        supabase
          .from("loyalty_logs")
          .select("id,points_delta,created_at")
          .eq("owner_id", user.id)
          .eq("shop_scope_id", shopId)
          .eq("action", "qr_claim")
          .gte("created_at", sevenDaysAgoIso)
          .order("id")
          .range(from, to),
      ).catch((err) => {
        scanLogsErr = err as { code?: string; message?: string };
        return [] as Array<Record<string, unknown>>;
      }),
    ]);

    if (
      isMissingRelationError(memberCountErr) ||
      isMissingRelationError(readyCouponErr) ||
      isMissingRelationError(scanLogsErr)
    ) {
      return {
        config,
        persisted,
        isTableReady: false,
        members: [],
        recentCoupons: [],
        recentPushJobs: [],
        recentLogs: [],
        metrics: emptyMetrics,
        membersTotal: 0,
        couponsTotal: 0,
        logsTotal: 0,
        loadedTabs: [initialTab],
      };
    }

    exactTotalMembers = totalMembersCount ?? 0;
    exactReadyCoupons = readyCouponsCount ?? 0;
    exactUsedCoupons = usedCouponsCount ?? 0;
    exactFailedPush = failedPushCount ?? 0;
    exactPendingPush = pendingPushCount ?? 0;

    for (const row of (scanLogs7d ?? []) as Array<Record<string, unknown>>) {
      const delta = Math.max(0, Number(row.points_delta ?? 0));
      const createdMs = new Date(String(row.created_at ?? "")).getTime();
      if (!Number.isFinite(createdMs)) continue;
      if (createdMs >= sevenDaysAgoMs) {
        scans7dCount += 1;
        points7dCount += delta;
      }
      if (createdMs >= todayStartMs) {
        scansTodayCount += 1;
        pointsTodayCount += delta;
      }
    }
  }

  const pushRowsList = (pushRows ?? []) as Array<Record<string, unknown>>;
  const { nameById: pushNameById, picById: pushPicById, nameByLineId: pushNameByLineId, picByLineId: pushPicByLineId } =
    await fetchMemberProfilesByIds(
      supabase,
      user.id,
      shopId,
      pushRowsList.map((r) => String(r.member_id ?? "")),
      pushRowsList.map((r) => String(r.line_user_id ?? "")),
    );

  const recentPushJobs: LoyaltyPushQueueSummary[] = pushRowsList.map((row) => {
    const memberId = String(row.member_id ?? "");
    const lineUserId = String(row.line_user_id ?? "");
    return {
      id: String(row.id ?? ""),
      memberId,
      lineUserId,
      displayName: pushNameById.get(memberId) ?? pushNameByLineId.get(lineUserId) ?? "ลูกค้า LINE",
      pictureUrl: pushPicById.get(memberId) ?? pushPicByLineId.get(lineUserId) ?? null,
      eventType: row.event_type === "coupon_redeem" ? "coupon_redeem" : "stamp_claim",
      status: String(row.status ?? "pending"),
      attempts: Number(row.attempts ?? 0),
      lastError: row.last_error ? String(row.last_error) : null,
      createdAt: String(row.created_at ?? new Date().toISOString()),
      sentAt: row.sent_at ? String(row.sent_at) : null,
    };
  });

  if (exactPendingPush > 0 && decryptedAccessToken) {
    after(async () => {
      try {
        const bgSupabase = await createSupabaseServerClient();
        await processPendingLoyaltyPushJobs(bgSupabase, config.shopSecret, decryptedAccessToken);
      } catch {
        // Ignore background errors
      }
    });
  }

  const snapshot: LoyaltyAdminSnapshot = {
    config,
    persisted,
    isTableReady: true,
    members: initialMembersRes.items,
    recentCoupons: initialCouponsRes.items,
    recentPushJobs,
    recentLogs: overviewLogsRes.items,
    metrics: {
      totalMembers: exactTotalMembers,
      scansTodayCount,
      pointsTodayCount,
      scans7dCount,
      points7dCount,
      readyCouponsCount: exactReadyCoupons,
      usedCouponsCount: exactUsedCoupons,
      failedPushCount: exactFailedPush,
      pendingPushCount: exactPendingPush,
    },
    membersTotal: initialMembersRes.total || exactTotalMembers,
    couponsTotal: initialCouponsRes.total || exactReadyCoupons,
    logsTotal: overviewLogsRes.total,
    loadedTabs: ["overview", "qr", "members", "coupons", "settings"],
  };

  return setCached(snapshotCacheKey, snapshot, 15_000);
}

export async function queryLoyaltyMembersPageAction(input: {
  shopId?: string;
  query?: string;
  filter?: "all" | "has_coupon" | "near_reward";
  page?: number;
  pageSize?: number;
  stampsPerReward?: number;
}): Promise<LoyaltyPaginatedResult<LoyaltyMemberSummary>> {
  const shopId = normalizeShopId(input.shopId || DEFAULT_SHOP_ID);
  if (!hasSupabaseEnv) {
    return { ok: true, items: [], total: 0, page: 1, pageSize: LOYALTY_ADMIN_PAGE_SIZE };
  }
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, items: [], total: 0, page: 1, pageSize: LOYALTY_ADMIN_PAGE_SIZE, message: "กรุณาเข้าสู่ระบบ" };
  }

  const res = await queryMembersPageWithClient(supabase, user.id, shopId, input);
  if (res.error) {
    return {
      ok: false,
      items: [],
      total: 0,
      page: res.page,
      pageSize: res.pageSize,
      message: res.error.message ?? "โหลดรายชื่อลูกค้าไม่สำเร็จ",
    };
  }
  return {
    ok: true,
    items: res.items,
    total: res.total,
    page: res.page,
    pageSize: res.pageSize,
  };
}

export async function queryLoyaltyCouponsPageAction(input: {
  shopId?: string;
  query?: string;
  status?: "unclaimed" | "claimed" | "all";
  page?: number;
  pageSize?: number;
  rewardTitleFallback?: string;
}): Promise<LoyaltyPaginatedResult<LoyaltyAdminCouponItem>> {
  const shopId = normalizeShopId(input.shopId || DEFAULT_SHOP_ID);
  if (!hasSupabaseEnv) {
    return { ok: true, items: [], total: 0, page: 1, pageSize: LOYALTY_ADMIN_PAGE_SIZE };
  }
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, items: [], total: 0, page: 1, pageSize: LOYALTY_ADMIN_PAGE_SIZE, message: "กรุณาเข้าสู่ระบบ" };
  }

  const res = await queryCouponsPageWithClient(
    supabase,
    user.id,
    shopId,
    input.rewardTitleFallback ?? "ส่วนลด 50%",
    input,
  );
  if (res.error) {
    return {
      ok: false,
      items: [],
      total: 0,
      page: res.page,
      pageSize: res.pageSize,
      message: res.error.message ?? "โหลดรายการคูปองไม่สำเร็จ",
    };
  }
  return {
    ok: true,
    items: res.items,
    total: res.total,
    page: res.page,
    pageSize: res.pageSize,
  };
}

export async function queryLoyaltyLogsPageAction(input: {
  shopId?: string;
  query?: string;
  page?: number;
  pageSize?: number;
}): Promise<LoyaltyPaginatedResult<LoyaltyActivityLogItem>> {
  const shopId = normalizeShopId(input.shopId || DEFAULT_SHOP_ID);
  if (!hasSupabaseEnv) {
    return { ok: true, items: [], total: 0, page: 1, pageSize: LOYALTY_ADMIN_PAGE_SIZE };
  }
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, items: [], total: 0, page: 1, pageSize: LOYALTY_ADMIN_PAGE_SIZE, message: "กรุณาเข้าสู่ระบบ" };
  }

  const res = await queryLogsPageWithClient(supabase, user.id, shopId, input);
  if (res.error) {
    return {
      ok: false,
      items: [],
      total: 0,
      page: res.page,
      pageSize: res.pageSize,
      message: res.error.message ?? "โหลดประวัติแต้มไม่สำเร็จ",
    };
  }
  return {
    ok: true,
    items: res.items,
    total: res.total,
    page: res.page,
    pageSize: res.pageSize,
  };
}

export async function fetchLoyaltyMemberDetailAction(input: {
  shopId?: string;
  memberId: string;
  rewardTitleFallback?: string;
}): Promise<LoyaltyMemberDetailResult> {
  const shopId = normalizeShopId(input.shopId || DEFAULT_SHOP_ID);
  const memberId = String(input.memberId ?? "").trim();
  if (!hasSupabaseEnv || !memberId) {
    return { ok: false, member: null, coupons: [], logs: [], message: "ไม่พบรหัสลูกค้า" };
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, member: null, coupons: [], logs: [], message: "กรุณาเข้าสู่ระบบ" };
  }

  const [
    { data: memberRow, error: memberErr },
    { count: unclaimedCount },
    { count: claimedCount },
    { data: couponRows },
    { data: logRows, count: logsTotalCount },
  ] = await Promise.all([
    supabase
      .from("loyalty_members")
      .select("id,line_user_id,display_name,picture_url,stamps,lifetime_stamps,expires_at,last_stamped_at")
      .eq("owner_id", user.id)
      .eq("shop_scope_id", shopId)
      .eq("id", memberId)
      .maybeSingle(),
    supabase
      .from("loyalty_coupons")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", user.id)
      .eq("shop_scope_id", shopId)
      .eq("member_id", memberId)
      .eq("status", "unclaimed"),
    supabase
      .from("loyalty_coupons")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", user.id)
      .eq("shop_scope_id", shopId)
      .eq("member_id", memberId)
      .eq("status", "claimed"),
    supabase
      .from("loyalty_coupons")
      .select("id,member_id,line_user_id,code,title,status,issued_at,claimed_at")
      .eq("owner_id", user.id)
      .eq("shop_scope_id", shopId)
      .eq("member_id", memberId)
      .order("issued_at", { ascending: false })
      .limit(100),
    supabase
      .from("loyalty_logs")
      .select("id,member_id,line_user_id,action,points_delta,balance_after,note,created_at", { count: "exact" })
      .eq("owner_id", user.id)
      .eq("shop_scope_id", shopId)
      .eq("member_id", memberId)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (memberErr || !memberRow) {
    return { ok: false, member: null, coupons: [], logs: [], message: "ไม่พบข้อมูลลูกค้ารายนี้" };
  }

  const displayName = String(memberRow.display_name ?? "ลูกค้า LINE");
  const pictureUrl = memberRow.picture_url ? String(memberRow.picture_url) : null;
  const lineUserId = String(memberRow.line_user_id ?? "");

  const member: LoyaltyMemberSummary = {
    id: String(memberRow.id),
    lineUserId,
    displayName,
    pictureUrl,
    stamps: Math.max(0, Number(memberRow.stamps ?? 0)),
    lifetimeStamps: Math.max(0, Number(memberRow.lifetime_stamps ?? 0)),
    expiresAt: memberRow.expires_at ? String(memberRow.expires_at) : null,
    lastStampedAt: memberRow.last_stamped_at ? String(memberRow.last_stamped_at) : null,
    unclaimedCount: unclaimedCount ?? 0,
    claimedCount: claimedCount ?? 0,
  };

  const coupons: LoyaltyAdminCouponItem[] = ((couponRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id ?? ""),
    memberId,
    lineUserId,
    code: String(row.code ?? ""),
    title: String(row.title ?? input.rewardTitleFallback ?? "ส่วนลด 50%"),
    status: row.status === "claimed" ? "claimed" : "unclaimed",
    issuedAt: String(row.issued_at ?? new Date().toISOString()),
    claimedAt: row.claimed_at ? String(row.claimed_at) : null,
    displayName,
    pictureUrl,
  }));

  const logs: LoyaltyActivityLogItem[] = ((logRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id ?? ""),
    memberId,
    lineUserId,
    displayName,
    pictureUrl,
    action: String(row.action ?? "qr_claim"),
    pointsDelta: Number(row.points_delta ?? 0),
    balanceAfter: Number(row.balance_after ?? 0),
    note: row.note ? String(row.note) : null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
  }));

  return {
    ok: true,
    member,
    coupons,
    logs,
    couponsTotal: (unclaimedCount ?? 0) + (claimedCount ?? 0),
    logsTotal: logsTotalCount ?? logs.length,
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
    const clearChannelSecret =
      form.get("clear_channel_secret") === "true" || form.get("clear_channel_secret") === "on";
    const clearChannelAccessToken =
      form.get("clear_channel_access_token") === "true" || form.get("clear_channel_access_token") === "on";

    const existingDecryptedSecret = decryptLoyaltySecret(current.channelSecret);
    const existingDecryptedToken = decryptLoyaltySecret(current.channelAccessToken);

    const resolvedSecretPlain = rawChannelSecret
      ? rawChannelSecret
      : clearChannelSecret
        ? ""
        : existingDecryptedSecret;

    const resolvedTokenPlain = rawChannelAccessToken
      ? rawChannelAccessToken
      : clearChannelAccessToken
        ? ""
        : existingDecryptedToken;

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
      channelSecret: resolvedSecretPlain ? encryptLoyaltySecret(resolvedSecretPlain) : "",
      channelAccessToken: resolvedTokenPlain ? encryptLoyaltySecret(resolvedTokenPlain) : "",
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
    revalidatePath("/rewards");
    revalidatePath("/settings");
    revalidatePath("/loyalty");
    return {
      ok: true,
      message: enabled
        ? "บันทึกการตั้งค่าระบบสะสมแต้มเรียบร้อยแล้ว"
        : "บันทึกการตั้งค่าแล้ว (สถานะ: ปิดใช้งานสำหรับร้านนี้)",
    };
  });
}

export async function testLineConnectionAction(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, shopId }) => {
    const rawTokenFromForm = String(form.get("channel_access_token") ?? "").trim();
    let accessToken = rawTokenFromForm;

    if (!accessToken) {
      const settingKey = scopedSettingsKey(LOYALTY_SETTINGS_KEY, shopId);
      const { data: existingRow } = await supabase
        .from("settings")
        .select("value")
        .eq("owner_id", user.id)
        .eq("key", settingKey)
        .maybeSingle();

      const config = normalizeLoyaltyConfig(existingRow?.value);
      accessToken = decryptLoyaltySecret(config.channelAccessToken);
    }

    if (!accessToken) {
      throw new InputError("กรุณากรอกหรือบันทึก Channel Access Token ก่อนกดทดสอบการเชื่อมต่อ");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch("https://api.line.me/v2/bot/info", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: controller.signal,
        cache: "no-store",
      });

      if (!res.ok) {
        if (res.status === 401) {
          throw new InputError("Channel Access Token ไม่ถูกต้องหรือหมดอายุ (HTTP 401)");
        }
        throw new InputError(`เชื่อมต่อ LINE Messaging API ไม่สำเร็จ (HTTP ${res.status})`);
      }

      const data = (await res.json()) as Record<string, unknown>;
      const botName = String(data.displayName ?? "LINE Official Account");
      const basicId = data.basicId ? ` (${String(data.basicId)})` : "";

      return {
        ok: true,
        message: `เชื่อมต่อสำเร็จ: บัญชี LINE OA “${botName}”${basicId} พร้อมส่งข้อความแจ้งเตือน`,
      };
    } catch (err) {
      if (err instanceof InputError) throw err;
      throw new InputError(
        err instanceof Error ? `เชื่อมต่อ LINE API ไม่สำเร็จ: ${err.message}` : "เชื่อมต่อ LINE API ไม่สำเร็จ",
      );
    } finally {
      clearTimeout(timer);
    }
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
    revalidatePath("/rewards");
    revalidatePath("/settings");
    revalidatePath("/loyalty");
    return {
      ok: true,
      message: "รีเซ็ตรหัส QR Code ทั้ง 1–10 กล่องเรียบร้อยแล้ว (แต้มและคูปองของลูกค้ายังอยู่ครบเหมือนเดิม)",
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
      revalidatePath("/rewards");
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
    revalidatePath("/rewards");
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
      revalidatePath("/rewards");
      revalidatePath("/settings");

      if (alreadyClaimed) {
        return {
          ok: true,
          message: `คูปอง #${code} (${title}) ของ “${displayName}” ถูกใช้สิทธิ์ไปแล้วเมื่อ ${claimedAtText}`,
        };
      }
      return {
        ok: true,
        message: `ยืนยันและตัดสิทธิ์คูปอง #${code} (${title}) ของ “${displayName}” เรียบร้อยแล้ว (${claimedAtText})`,
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
        message: `คูปอง #${String(couponRow.code)} (${String(couponRow.title)}) ของ “${displayName}” ถูกใช้สิทธิ์ไปแล้วเมื่อ ${formatThaiDateTime(String(couponRow.claimed_at))}`,
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
    revalidatePath("/rewards");
    revalidatePath("/settings");
    return {
      ok: true,
      message: `ยืนยันและตัดสิทธิ์คูปอง #${String(couponRow.code)} (${String(couponRow.title)}) ของ “${displayName}” เรียบร้อยแล้ว`,
    };
  });
}

export async function retryFailedLoyaltyPushJobsAction(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, shopId }) => {
    const rawJobId = String(form.get("job_id") ?? "").trim();
    const jobId = rawJobId || null;

    const settingKey = scopedSettingsKey(LOYALTY_SETTINGS_KEY, shopId);
    const { data: settingRow } = await supabase
      .from("settings")
      .select("value")
      .eq("owner_id", user.id)
      .eq("key", settingKey)
      .maybeSingle();

    const config = normalizeLoyaltyConfig(settingRow?.value);
    const decryptedAccessToken = decryptLoyaltySecret(config.channelAccessToken);

    if (!decryptedAccessToken) {
      throw new InputError("กรุณากรอกและบันทึก Channel Access Token ของ LINE OA ก่อนสั่งส่งข้อความซ้ำ");
    }

    const { data: rpcData, error: rpcErr } = await supabase.rpc("admin_retry_failed_loyalty_push_jobs", {
      p_shop_scope_id: shopId,
      p_job_id: jobId,
    });

    if (rpcErr && !isMissingRpcError(rpcErr)) {
      dbError(rpcErr);
    }

    // Fallback direct update if the new RPC hasn't been migrated yet
    if (rpcErr && isMissingRpcError(rpcErr)) {
      let query = supabase
        .from("loyalty_push_queue")
        .update({
          status: "pending",
          attempts: 0,
          max_attempts: 6,
          next_retry_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("owner_id", user.id)
        .eq("shop_scope_id", shopId)
        .in("status", ["failed_network", "failed_quota", "failed_auth", "failed_recipient"]);

      if (jobId) {
        query = query.eq("id", jobId);
      }
      await query;
    }

    await processPendingLoyaltyPushJobs(supabase, config.shopSecret, decryptedAccessToken);

    const resetCount = Number((rpcData as Record<string, unknown> | null)?.resetCount ?? 1);
    invalidateQueryCache();
    revalidatePath("/rewards");
    revalidatePath("/settings");
    return {
      ok: true,
      message:
        resetCount > 0
          ? `สั่งส่งข้อความแจ้งเตือน LINE ซ้ำเรียบร้อยแล้ว (${resetCount} รายการ)`
          : "สั่งประมวลผลคิวแจ้งเตือน LINE OA ซ้ำเรียบร้อยแล้ว",
    };
  });
}
