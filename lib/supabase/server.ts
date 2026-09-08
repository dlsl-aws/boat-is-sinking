import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseServiceKey, supabaseUrl } from "../env";

/**
 * Service-role client. Bypasses RLS, so it is the only thing that can touch
 * game tables — every mutation in this app goes through a route handler holding
 * this client, never from the browser.
 *
 * Cached per process: a Vercel function instance is reused across invocations,
 * and rebuilding the client each time wastes the connection.
 */
let cached: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!cached) {
    cached = createClient(supabaseUrl(), supabaseServiceKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}
