import { z } from "zod";
import { fail, loadRoom, ok, readJson, resolveViewer } from "@/lib/api";
import { checkName, nameKey } from "@/lib/game/names";
import { broadcast } from "@/lib/realtime/broadcast";
import { db } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  displayName: z.string().min(1).max(64).optional(),
  avatarSeed: z.string().max(8).optional(),
  avatarColor: z.string().max(16).optional(),
  /** Host-only moderation. */
  status: z.enum(["alive", "eliminated", "spectator"]).optional(),
});

/**
 * Update a player.
 *
 * A player may edit themselves; the host may edit anyone, which is the backstop
 * for a name that slips past the filter, and the revive/eliminate control.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ code: string; id: string }> },
) {
  const { code, id } = await context.params;
  const loaded = await loadRoom(code);
  if ("response" in loaded) return loaded.response;
  const { room } = loaded;

  const viewer = await resolveViewer(room);
  const isHost = viewer.role === "host";
  const isSelf = viewer.role === "player" && viewer.playerId === id;
  if (!isHost && !isSelf) return fail("forbidden", 403);

  const body = patchSchema.safeParse(await readJson(request));
  if (!body.success) return fail("bad-request", 400);
  if (body.data.status && !isHost) return fail("forbidden", 403);

  const supabase = db();
  const update: Record<string, unknown> = {};

  if (body.data.displayName !== undefined) {
    // A player may not rename themselves mid-scramble. Five people are
    // physically hunting for them by name at that exact moment, so this is the
    // one point in the game where a rename actively breaks something. The host
    // can still override, because moderation cannot wait for a round to end.
    if (!isHost && room.current_round_id) {
      const { data: round } = await supabase
        .from("rounds")
        .select("phase")
        .eq("id", room.current_round_id)
        .maybeSingle();
      if (round?.phase === "scramble") {
        return fail("locked-during-round", 409, {
          message: "You can change your name between rounds.",
        });
      }
    }

    const { data: taken } = await supabase
      .from("players")
      .select("id, name_key")
      .eq("room_id", room.id);

    const takenKeys = new Set(
      (taken ?? []).filter((p) => p.id !== id).map((p) => p.name_key as string),
    );

    const check = checkName(body.data.displayName, takenKeys);
    if (!check.ok) return fail(check.reason, 422, { message: check.message });

    update.display_name = check.name;
    update.name_key = nameKey(check.name);
  }

  if (body.data.avatarSeed !== undefined) update.avatar_seed = body.data.avatarSeed;
  if (body.data.avatarColor !== undefined) update.avatar_color = body.data.avatarColor;

  if (body.data.status !== undefined) {
    update.status = body.data.status;
    // Reviving must clear the elimination record, or the roster keeps claiming
    // they went out in round three.
    if (body.data.status === "alive") {
      update.eliminated_at = null;
      update.eliminated_round = null;
    }
  }

  if (Object.keys(update).length === 0) return ok({ ok: true });

  const { data, error } = await supabase
    .from("players")
    .update(update)
    .eq("id", id)
    .eq("room_id", room.id)
    .select("id, display_name")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return fail("taken", 422, { message: "That name is already taken here." });
    }
    return fail(`update-failed: ${error.message}`, 500);
  }
  if (!data) return fail("no-such-player", 404);

  if (update.display_name) {
    await broadcast(room.id, {
      type: "player:renamed",
      playerId: id,
      displayName: data.display_name as string,
    });
  } else {
    await broadcast(room.id, { type: "room:updated" });
  }

  return ok({ ok: true });
}

/** Remove a player entirely. Host only. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ code: string; id: string }> },
) {
  const { code, id } = await context.params;
  const loaded = await loadRoom(code);
  if ("response" in loaded) return loaded.response;
  const { room } = loaded;

  const viewer = await resolveViewer(room);
  if (viewer.role !== "host") return fail("not-the-host", 403);

  const { error } = await db()
    .from("players")
    .delete()
    .eq("id", id)
    .eq("room_id", room.id);

  if (error) return fail(`delete-failed: ${error.message}`, 500);

  await broadcast(room.id, { type: "player:left", playerId: id });
  return ok({ ok: true });
}
