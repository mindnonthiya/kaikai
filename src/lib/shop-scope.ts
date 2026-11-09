export const DEFAULT_SHOP_ID = "default";
export const ACTIVE_SHOP_COOKIE = "kaikai_active_shop";
export const SHOPS_REGISTRY_SETTINGS_KEY = "shops_registry";

const SHOP_ID_PATTERN = /^[a-zA-Z0-9_-]{2,36}$/;
const SHOP_PREFIX_REGEX = /^\[s:([a-zA-Z0-9_-]{2,36})\]([\s\S]*)$/;

export type ShopSummary = {
  id: string;
  shopName: string;
  displayName: string;
  avatarUrl: string | null;
  unitLabel: string;
  createdAt: string;
};

export function normalizeShopId(raw?: string | null): string {
  if (!raw) return DEFAULT_SHOP_ID;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === DEFAULT_SHOP_ID) return DEFAULT_SHOP_ID;
  return SHOP_ID_PATTERN.test(trimmed) ? trimmed : DEFAULT_SHOP_ID;
}

export function shopPrefix(shopId?: string | null): string {
  const id = normalizeShopId(shopId);
  return id === DEFAULT_SHOP_ID ? "" : `[s:${id}]`;
}

export function decodeShopText(raw: string | null | undefined): { shopId: string; text: string } {
  const str = raw ?? "";
  const match = SHOP_PREFIX_REGEX.exec(str);
  if (!match) {
    return { shopId: DEFAULT_SHOP_ID, text: str };
  }
  return {
    shopId: normalizeShopId(match[1]),
    text: match[2],
  };
}

export function stripShopPrefix(raw: string | null | undefined): string {
  return decodeShopText(raw).text;
}

export function encodeShopText(text: string, shopId?: string | null): string {
  const clean = stripShopPrefix(text);
  return `${shopPrefix(shopId)}${clean}`;
}

export function matchesShopText(raw: string | null | undefined, activeShopId?: string | null): boolean {
  return decodeShopText(raw).shopId === normalizeShopId(activeShopId);
}

export function scopedSettingsKey(baseKey: string, shopId?: string | null): string {
  const id = normalizeShopId(shopId);
  return id === DEFAULT_SHOP_ID ? baseKey : `s:${id}:${baseKey}`;
}

export function encodeSaleNotesForShop(notes: string | null | undefined, shopId?: string | null): string | null {
  const id = normalizeShopId(shopId);
  const clean = stripShopPrefix(notes ?? "").trim();
  if (id === DEFAULT_SHOP_ID) {
    return clean || null;
  }
  return clean ? `[s:${id}]${clean}` : `[s:${id}]`;
}

export function matchesSaleShop(
  row: { notes?: unknown; sale_items?: unknown },
  activeShopId?: string | null,
): boolean {
  const target = normalizeShopId(activeShopId);
  const rawNotes = typeof row.notes === "string" ? row.notes : "";
  if (rawNotes.startsWith("[s:")) {
    return decodeShopText(rawNotes).shopId === target;
  }
  if (Array.isArray(row.sale_items)) {
    for (const item of row.sale_items) {
      if (item && typeof item === "object") {
        const snap = (item as Record<string, unknown>).menu_name_snapshot;
        if (typeof snap === "string" && snap.startsWith("[s:")) {
          return decodeShopText(snap).shopId === target;
        }
      }
    }
  }
  return target === DEFAULT_SHOP_ID;
}

/** Reads active shop ID from browser document.cookie for client components. */
export function getClientActiveShopId(): string {
  if (typeof document === "undefined") return DEFAULT_SHOP_ID;
  const cookies = document.cookie.split(";");
  for (const part of cookies) {
    const [k, ...rest] = part.trim().split("=");
    if (k === ACTIVE_SHOP_COOKIE) {
      try {
        return normalizeShopId(decodeURIComponent(rest.join("=")));
      } catch {
        return DEFAULT_SHOP_ID;
      }
    }
  }
  return DEFAULT_SHOP_ID;
}
