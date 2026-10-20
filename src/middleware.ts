import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  try {
    return await updateSession(request);
  } catch (error) {
    console.error("Top-level middleware invocation caught error:", error);
    return NextResponse.next({ request });
  }
}

export const config = {
  // Exclude static assets, icons, and discovery files so bots and crawlers get them directly without auth redirect
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|llms.txt|llms-full.txt|ai-catalog.json|.*\\.png$|.*\\.jpg$|.*\\.svg$|.*\\.webp$|\\.well-known).*)",
  ],
};
