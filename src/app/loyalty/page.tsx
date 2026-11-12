import type { Metadata } from "next";
import {
  LoyaltyStampCardClient,
  type InitialLoyaltyCardConfig,
} from "@/app/loyalty/loyalty-stamp-card-client";
import { hasSupabaseEnv } from "@/lib/env";
import {
  getCachedSsrLoyaltyConfig,
  setCachedSsrLoyaltyConfig,
} from "@/lib/line-messaging";
import {
  DEFAULT_LOYALTY_CARD_TITLE,
  DEFAULT_LOYALTY_RULES_TEXT,
  parseLoyaltyQueryParams,
  stripEmoji,
} from "@/lib/loyalty";
import {
  getLegacyLoyaltyServerKeyHash,
  getLoyaltyServerKeyHash,
} from "@/lib/loyalty-crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "บัตรสะสมแต้มสมาชิก",
  description: "สะสมแต้มและแลกรับส่วนลด 50% เมนูหลัก 1 กล่อง",
};

interface LoyaltyPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoyaltyPage({ searchParams }: LoyaltyPageProps) {
  const resolved = await searchParams;
  const urlSearch = new URLSearchParams();
  for (const [k, v] of Object.entries(resolved)) {
    if (typeof v === "string") {
      urlSearch.set(k, v);
    } else if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
      urlSearch.set(k, v[0]);
    }
  }

  const parsed = parseLoyaltyQueryParams(urlSearch);
  const queryLiffId = String(resolved.liffId ?? "").trim();

  let initialConfig: InitialLoyaltyCardConfig | null = null;

  if (parsed.shopSecret) {
    const cached = getCachedSsrLoyaltyConfig<InitialLoyaltyCardConfig & Record<string, unknown>>(
      parsed.shopSecret,
    );
    if (cached) {
      initialConfig = {
        ...cached,
        liffId: cached.liffId || queryLiffId,
      };
    } else if (hasSupabaseEnv) {
      try {
        const supabase = await createSupabaseServiceClient();
        const primaryHash = getLoyaltyServerKeyHash(parsed.shopSecret);
        const legacyHash = getLegacyLoyaltyServerKeyHash(parsed.shopSecret);
        const rpcPromise = supabase.rpc("get_loyalty_card_state", {
          p_shop_secret: parsed.shopSecret,
          p_line_user_id: null,
          p_display_name: null,
          p_picture_url: null,
          p_server_key_hash: primaryHash,
          p_legacy_key_hash: legacyHash,
        });
        const timeoutPromise = new Promise<{ data: null }>((resolve) =>
          setTimeout(() => resolve({ data: null }), 1200),
        );
        const { data } = await Promise.race([rpcPromise, timeoutPromise]);
        const res = (data ?? {}) as Record<string, unknown>;
        if (res.ok && res.config && typeof res.config === "object") {
          const cfg = res.config as Record<string, unknown>;
          initialConfig = {
            cardTitle: stripEmoji(String(cfg.cardTitle ?? DEFAULT_LOYALTY_CARD_TITLE)) || DEFAULT_LOYALTY_CARD_TITLE,
            cardHeadline: stripEmoji(String(cfg.cardHeadline ?? "สะสม 10 กล่อง ลด 50%")) || "สะสม 10 กล่อง ลด 50%",
            rewardTitle: stripEmoji(String(cfg.rewardTitle ?? "ลด 50% เมนูหลัก 1 กล่อง")) || "ลด 50% เมนูหลัก 1 กล่อง",
            stampsPerReward: Math.max(1, Number(cfg.stampsPerReward ?? 10)),
            validityMonths: Math.max(1, Number(cfg.validityMonths ?? 3)),
            cooldownMinutes: Math.max(0, Number(cfg.cooldownMinutes ?? 5)),
            rulesText: String(cfg.rulesText ?? DEFAULT_LOYALTY_RULES_TEXT),
            liffId: String(cfg.liffId ?? queryLiffId ?? ""),
            botBasicId: String(cfg.botBasicId ?? ""),
          };
          setCachedSsrLoyaltyConfig(
            parsed.shopSecret,
            initialConfig as unknown as Record<string, unknown>,
            45_000,
          );
        }
      } catch {
        // Fallback to client-side config fetch
      }
    }
  }

  return (
    <LoyaltyStampCardClient
      initialShopSecret={parsed.shopSecret}
      initialPoints={parsed.points}
      initialToken={parsed.token}
      initialLiffId={initialConfig?.liffId || queryLiffId}
      initialConfig={initialConfig}
    />
  );
}
