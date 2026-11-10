import { NextResponse } from "next/server";
import { hasSupabaseEnv } from "@/lib/env";
import { processGlobalDueLoyaltyPushJobs } from "@/lib/line-messaging";
import { hasLoyaltyServerSecret, verifyCronAuthorization } from "@/lib/loyalty-crypto";
import { checkLoyaltyRateLimit, resolveClientIp } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";

async function handleWorkerRequest(request: Request) {
  const rate = checkLoyaltyRateLimit({
    route: "state",
    ip: resolveClientIp(request),
    shopSecret: "worker",
    maxRequests: 20,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { ok: false, code: "RATE_LIMITED", retryAfterSeconds: rate.retryAfterSeconds },
      { status: 429 },
    );
  }

  // Strictly fail-closed: NEVER allow external access unless CRON_SECRET is configured and matches
  const cronAuth = verifyCronAuthorization(request.headers.get("authorization"));
  if (!cronAuth.configured) {
    return NextResponse.json(
      {
        ok: false,
        code: "CRON_SECRET_NOT_CONFIGURED",
        message: "ต้องตั้งค่า CRON_SECRET ใน Environment Variables ก่อนเรียกใช้งาน Worker",
      },
      { status: 503 },
    );
  }
  if (!cronAuth.ok) {
    return NextResponse.json(
      { ok: false, code: "UNAUTHORIZED_CRON" },
      { status: 401 },
    );
  }

  if (!hasSupabaseEnv) {
    return NextResponse.json({
      ok: true,
      mode: "demo",
      processed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
    });
  }

  if (!hasLoyaltyServerSecret()) {
    return NextResponse.json(
      {
        ok: false,
        code: "MISSING_LOYALTY_SERVER_SECRET",
        message: "กรุณาตั้งค่า LOYALTY_SERVER_SECRET ใน Environment Variables",
      },
      { status: 503 },
    );
  }

  try {
    const supabase = await createSupabaseServerClient();
    const summary = await processGlobalDueLoyaltyPushJobs(supabase, request.url);
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        code: "WORKER_ERROR",
        message: err instanceof Error ? err.message : "Failed to run loyalty worker",
      },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return handleWorkerRequest(request);
}

export async function POST(request: Request) {
  return handleWorkerRequest(request);
}
