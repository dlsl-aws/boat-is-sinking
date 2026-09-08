import { z } from "zod";
import { fail, loadRoomAsPlayer, ok, readJson } from "@/lib/api";
import { broadcast } from "@/lib/realtime/broadcast";
import { db } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ roomCode: z.string().min(1) });

/**
 * Volunteer as captain of the boat you were assigned to.
 *
 * The boat is derived from the caller's own assignment rather than accepted
 * from the request, so a player cannot nominate themselves for a cohort they
 * are not in. The response is the ONLY place the boat code is ever revealed,
 * and only to the captain — broadcasting it would let everyone board without
 * leaving their seat.
 */
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

  const { data: assignment } = await db()
    .from("assignments")
    .select("boat_id")
    .eq("round_id", roundId)
    .eq("player_id", playerId)
    .maybeSingle();

  if (!assignment) return fail("not-in-round", 409);

  const { data, error } = await db().rpc("claim_captain", {
    p_boat_id: assignment.boat_id as string,
    p_player_id: playerId,
  });

  if (error) return fail(`captain-failed: ${error.message}`, 500);

  const result = data as { ok: boolean; reason?: string; code?: string };
  if (!result.ok) return ok(result, 409);

  await broadcast(room.id, {
    type: "boat:captain",
    boatId: assignment.boat_id as string,
    auto: false,
  });

  return ok(result);
}
