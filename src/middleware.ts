import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // CSV export is no longer excluded: it contains real sales data and must require login.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
