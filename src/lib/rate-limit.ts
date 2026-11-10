interface RateLimitEntry {
  count: number;
  resetAtMs: number;
}

const buckets = new Map<string, RateLimitEntry>();

export function resolveClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "127.0.0.1";
}

export function checkLoyaltyRateLimit(params: {
  route: "state" | "claim" | "redeem";
  ip: string;
  shopSecret: string;
  maxRequests?: number;
  windowMs?: number;
}): { allowed: boolean; retryAfterSeconds: number } {
  const maxRequests =
    params.maxRequests ?? (params.route === "state" ? 45 : 20);
  const windowMs = params.windowMs ?? 60_000;
  const now = Date.now();

  if (buckets.size > 2000) {
    for (const [k, v] of buckets.entries()) {
      if (v.resetAtMs <= now) {
        buckets.delete(k);
      }
    }
  }

  const key = `${params.route}:${params.ip}:${params.shopSecret.slice(0, 24)}`;
  const existing = buckets.get(key);

  if (!existing || existing.resetAtMs <= now) {
    buckets.set(key, {
      count: 1,
      resetAtMs: now + windowMs,
    });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (existing.count >= maxRequests) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((existing.resetAtMs - now) / 1000),
    );
    return { allowed: false, retryAfterSeconds };
  }

  existing.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}
