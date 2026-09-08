import { z } from "zod";
import { fail, loadRoomAsHost, ok, readJson } from "@/lib/api";
import { MIN_GROUP_SIZE } from "@/lib/game/assign";
import { startRound } from "@/lib/db/rounds";
import { broadcast } from "@/lib/realtime/broadcast";
import { db } from "@/lib/supabase/server";
import { findRoomByCode } from "@/lib/db/state";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(["start", "skip-prompt", "end", "reset"]),
  /** Explicit round shape, when the facilitator is not using the planner. */
  targetGroupSize: z.number().int().min(MIN_GROUP_SIZE).max(12).optional(),
  boatsRemoved: z.number().int().min(0).max(8).optional(),
});

/** Every game-flow control the facilitator has, in one host-only endpoint. */
export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const loaded = await loadRoomAsHost(code);
  if ("response" in loaded) return loaded.response;

  const body = bodySchema.safeParse(await readJson(request));
  if (!body.success) return fail("bad-request", 400);

  const supabase = db();
  const { room } = loaded;

  switch (body.data.action) {
    case "start": {
      // Close out a prompt still on screen so the previous round cannot sit in
      // a half-finished phase behind the new one.
      if (room.current_round_id) {
        await supabase
          .from("rounds")
          .update({ phase: "done" })
          .eq("id", room.current_round_id)
          .in("phase", ["prompt", "resolve"]);
      }

      const shape =
        body.data.targetGroupSize != null
          ? {
              targetGroupSize: body.data.targetGroupSize,
              boatsRemoved: body.data.boatsRemoved ?? 0,
            }
          : undefined;

      // Re-read: the update above changed the row we are about to plan from.
      const fresh = (await findRoomByCode(code)) ?? room;
      const result = await startRound(fresh, shape ? { shape } : {});

      if (!result.ok) {
        return ok(result, 409);
      }
      return ok(result);
    }

    case "skip-prompt": {
      if (!room.current_round_id) return fail("no-round", 409);
      await supabase
        .from("rounds")
        .update({ phase: "done" })
        .eq("id", room.current_round_id)
        .eq("phase", "prompt");
      await broadcast(room.id, { type: "room:updated" });
      return ok({ ok: true });
    }

    case "end": {
      await supabase.rpc("finish_game", { p_room_id: room.id });
      await broadcast(room.id, { type: "game:over" });
      return ok({ ok: true });
    }

    case "reset": {
      // Same people, fresh game. Rounds cascade-delete their boats, seats and
      // assignments, so clearing them is enough to start clean.
      await supabase.from("rooms").update({ current_round_id: null }).eq("id", room.id);
      await supabase.from("rounds").delete().eq("room_id", room.id);
      await supabase
        .from("players")
        .update({
          status: "alive",
          eliminated_at: null,
          eliminated_round: null,
          rounds_survived: 0,
        })
        .eq("room_id", room.id);
      await supabase
        .from("rooms")
        .update({ status: "lobby", initial_alive: null, symbol_offset: 0 })
        .eq("id", room.id);
      await broadcast(room.id, { type: "room:updated" });
      return ok({ ok: true });
    }
  }
}
