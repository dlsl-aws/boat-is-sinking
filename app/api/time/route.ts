import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Server clock, used once per client to measure its offset.
 *
 * The countdown is rendered locally against a deadline rather than streamed, so
 * a phone with a clock two minutes fast would otherwise show a round as already
 * over. The client measures round-trip time here and shifts its own clock by
 * half of it.
 */
export function GET(): NextResponse {
  return NextResponse.json(
    { serverTime: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } },
  );
}
