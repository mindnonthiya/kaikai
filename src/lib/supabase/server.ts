import { createServerClient } from "@supabase/ssr";
import { createClient as createStatelessSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { publicEnv } from "@/lib/env";

export async function createClient() {
  const cookieStore = await cookies();
  const { url, key } = publicEnv();
  // Untyped on purpose: rows are mapped into explicit record types in src/lib/data/queries.ts.
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot set cookies; middleware refreshes the session.
        }
      },
    },
  });
}

export const createSupabaseServerClient = createClient;

/**
 * Stateless server-only Supabase client for Loyalty API routes, webhooks, and background workers.
 * Uses SUPABASE_SERVICE_ROLE_KEY when configured so RPCs execute under `service_role`,
 * and never attaches browser user session cookies.
 */
export async function createSupabaseServiceClient() {
  const { url, key } = publicEnv();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  return createStatelessSupabaseClient(url, serviceRoleKey || key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
