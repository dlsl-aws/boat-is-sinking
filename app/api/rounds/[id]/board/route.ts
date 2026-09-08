import { z } from "zod";
import { fail, loadRoomAsPlayer, ok, readJson } from "@/lib/api";
import { BOAT_CODE_LENGTH, isValidCode, normalizeCode } from "@/lib/game/codes";
import { broadcast } from "@/lib/realtime/broadcast";
import { db } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ roomCode: z.string().min(1), code: z.string().min(1) });

/**
 * Best-effort throttle on wrong codes.
 *
 * Per function instance, so it is not a real rate limit — Vercel may route the
 * next attempt elsewhere. It is not carrying much weight: the code space is
 * 390,625, at most a couple of dozen boats are live, a guess must also match the
 * guesser's own assigned symbol, and the round lasts 45 seconds. This exists to
 * blunt a scripted burst, not to be the security boundary.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();
const ATTEMPT_LIMIT = 12;
const ATTEMPT_WINDOW_MS = 15_000;

function tooManyAttempts(playerId: string): boolean {
  const now = Date.now();
  const entry = attempts.get(playerId);
  if (!entry || now > entry.resetAt) {
    attempts.set(playerId, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > ATTEMPT_LIMIT;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: roundId } = await context.params;
  const body = bodySchema.safeParse(await readJson(request));
  if (!body.success) return fail("bad-request", 400);

  const loaded = await loadRoomAsPlayer(body.data.roomCode);
  if ("response" in loaded) return loaded.response;
  const { room, playerId } = loaded;

  const code = normalizeCode(body.data.code);
  if (!isValidCode(code, BOAT_CODE_LENGTH)) {
    return fail("bad-code", 422, { message: "That is not a valid boat code." });
  }

  if (tooManyAttempts(playerId)) {
    return fail("too-many-attempts", 429, {
      message: "Slow down — find your captain first.",
    });
  }

  const { data, error } = await db().rpc("claim_seat", {
    p_round_id: roundId,
    p_code: code,
    p_player_id: playerId,
  });

  if (error) return fail(`board-failed: ${error.message}`, 500);

  const result = data as {
    ok: boolean;
    reason?: string;
    seatIndex?: number;
    filled?: number;
    capacity?: number;
    locked?: boolean;
    alreadyAboard?: boolean;
    ownSymbolId?: string;
  };

  if (!result.ok) return ok(result, 409);

  // Only broadcast a genuine change. A double-tap already aboard would otherwise
  // re-announce the same fill count to the whole room.
  if (!result.alreadyAboard && result.filled != null) {
    const { data: boat } = await db()
      .from("boats")
      .select("id, symbol_id, capacity")
      .eq("round_id", roundId)
      .eq("code", code)
      .maybeSingle();

    if (boat) {
      await broadcast(room.id, {
        type: "boat:progress",
        boatId: boat.id as string,
        symbolId: boat.symbol_id as string,
        filled: result.filled,
        capacity: boat.capacity as number,
        locked: result.locked ?? false,
      });
    }
  }

  return ok(result);
}
