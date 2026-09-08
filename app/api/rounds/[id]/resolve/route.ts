import { z } from "zod";
import { fail, loadRoom, ok, readJson, resolveViewer } from "@/lib/api";
import { maybeResolveRound } from "@/lib/db/rounds";
import { db } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  roomCode: z.string().min(1),
  /** Host only: end the round now instead of waiting for the deadline. */
  force: z.boolean().optional(),
});

/**
 * Resolve a round.
 *
 * Called by whichever client first notices the deadline, which is how a round
 * ends without a background worker. `begin_resolve` inside `maybeResolveRound`
 * grants ownership to exactly one caller, so a whole room racing here is fine.
 *
 * `force` is the facilitator's escape hatch when the room has clearly finished
 * early — it pulls the deadline back rather than bypassing the resolution path,
 * so the same guarded, idempotent code runs either way.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: roundId } = await context.params;
  const body = bodySchema.safeParse(await readJson(request));
  if (!body.success) return fail("bad-request", 400);

  const loaded = await loadRoom(body.data.roomCode);
  if ("response" in loaded) return loaded.response;
  const { room } = loaded;

  if (body.data.force) {
    const viewer = await resolveViewer(room);
    if (viewer.role !== "host") return fail("not-the-host", 403);
    await db()
      .from("rounds")
      .update({ ends_at: new Date().toISOString() })
      .eq("id", roundId)
      .eq("room_id", room.id);
  }

  const resolved = await maybeResolveRound(room);
  return ok({ resolved });
}
