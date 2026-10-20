import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Pages anyone can open without signing in. */
const PUBLIC_PATHS = [
  "/login",
  "/signup",
  "/forgot-password",
  "/auth/",
  "/robots.txt",
  "/sitemap.xml",
  "/llms.txt",
  "/llms-full.txt",
  "/.well-known/",
  "/ai-catalog.json",
  "/favicon.ico",
];
/** Signed-in users are sent from these to the dashboard. */
const GUEST_ONLY_PATHS = ["/login", "/signup", "/forgot-password"];

const matches = (pathname: string, paths: string[]) => paths.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`)));

export async function updateSession(request: NextRequest) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return NextResponse.next({ request });

    let response = NextResponse.next({ request });
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });

    let user = null;
    try {
      const { data, error } = await supabase.auth.getUser();
      if (error) {
        request.cookies.getAll()
          .filter((c) => c.name.includes("-auth-token"))
          .forEach((c) => response.cookies.delete(c.name));
      }
      user = data?.user ?? null;
    } catch (e) {
      console.error("Middleware auth check failed:", e);
      user = null;
      try {
        request.cookies.getAll()
          .filter((c) => c.name.includes("-auth-token"))
          .forEach((c) => response.cookies.delete(c.name));
      } catch {
        // Ignore
      }
    }

    const { pathname } = request.nextUrl;

    if (!user && !matches(pathname, PUBLIC_PATHS)) {
      if (pathname.startsWith("/api/")) return NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
      const target = request.nextUrl.clone();
      target.pathname = "/login";
      target.search = "";
      target.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
      return NextResponse.redirect(target);
    }
    if (user && matches(pathname, GUEST_ONLY_PATHS)) {
      const target = request.nextUrl.clone();
      target.pathname = "/dashboard";
      target.search = "";
      return NextResponse.redirect(target);
    }
    return response;
  } catch (error) {
    console.error("Middleware execution failed gracefully:", error);
    const fallbackResponse = NextResponse.next({ request });
    try {
      request.cookies.getAll()
        .filter((c) => c.name.includes("-auth-token"))
        .forEach((c) => fallbackResponse.cookies.delete(c.name));
    } catch {
      // Ignore
    }
    return fallbackResponse;
  }
}
