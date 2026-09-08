"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser client, used for exactly one thing: subscribing to a room's realtime
 * channel. It holds the anon key, and RLS grants anon no access to any game
 * table, so it cannot read or write state even if someone opens the console.
 */
let cached: SupabaseClient | null = null;

export function realtimeClient(): SupabaseClient {
  if (!cached) {
    cached = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 20 } },
      },
    );
  }
  return cached;
}
