import type { Metadata } from "next";
import { LoyaltyStampCardClient } from "@/app/loyalty/loyalty-stamp-card-client";
import { parseLoyaltyQueryParams } from "@/lib/loyalty";

export const metadata: Metadata = {
  title: "GaiTomNamPla 🐔 — บัตรสะสมแต้ม LINE Stamp Card",
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
  const initialLiffId = String(resolved.liffId ?? "").trim();

  return (
    <LoyaltyStampCardClient
      initialShopSecret={parsed.shopSecret}
      initialPoints={parsed.points}
      initialToken={parsed.token}
      initialLiffId={initialLiffId}
    />
  );
}
