import type { SupabaseClient } from "@supabase/supabase-js";
import { createBrowserClient } from "@supabase/ssr";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
      console.warn(
        "[Supabase] Env not loaded. Restart the dev server from the project root (folder with next.config.ts and .env.local)."
      );
    }
    return null;
  }
  if (!client) client = createBrowserClient(url, anonKey);
  return client;
}
