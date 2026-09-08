import { z } from "zod";
import { fail, loadRoom, ok, readJson } from "@/lib/api";
import { getPlayerToken, hashToken, newToken, setPlayerToken } from "@/lib/auth";
import { parseConfig } from "@/lib/config";
import { randomAvatarColor, randomAvatarSeed } from "@/lib/game/avatar";
import { checkName, nameKey } from "@/lib/game/names";
import { broadcast } from "@/lib/realtime/broadcast";
import { db } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  displayName: z.string().min(1).max(64),
  avatarSeed: z.string().max(8).optional(),
  avatarColor: z.string().max(16).optional(),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const loaded = await loadRoom(code);
  if ("response" in loaded) return loaded.response;
  const { room } = loaded;

  const body = bodySchema.safeParse(await readJson(request));
  if (!body.success) return fail("bad-request", 400);

  const config = parseConfig(room.config);
  const supabase = db();

  // Rejoining is not joining: a phone that locked, or a tab that was closed and
  // reopened, must land back on the same player rather than creating a ghost
  // that occupies a symbol nobody is holding.
  const existingToken = await getPlayerToken(room.code);
  if (existingToken) {
    const { data } = await supabase
      .from("players")
      .select("id, display_name")
      .eq("room_id", room.id)
      .eq("session_token_hash", await hashToken(existingToken))
      .maybeSingle();
    if (data) {
      return ok({ playerId: data.id as string, rejoined: true });
    }
  }

  if (room.status !== "lobby" && !config.allowLateJoin) {
    return fail("game-already-started", 409);
  }

  const { data: taken } = await supabase
    .from("players")
    .select("name_key")
    .eq("room_id", room.id);

  const check = checkName(
    body.data.displayName,
    new Set((taken ?? []).map((p) => p.name_key as string)),
  );
  if (!check.ok) {
    return fail(check.reason, 422, { message: check.message });
  }

  const token = newToken();
  const { data, error } = await supabase
    .from("players")
    .insert({
      room_id: room.id,
      display_name: check.name,
      name_key: nameKey(check.name),
      avatar_seed: body.data.avatarSeed ?? randomAvatarSeed(),
      avatar_color: body.data.avatarColor ?? randomAvatarColor(),
      session_token_hash: await hashToken(token),
      // Someone arriving mid-game watches until the next round rather than
      // being dropped into one that has already assigned its symbols.
      status: room.status === "lobby" ? "alive" : "spectator",
    })
    .select("id, display_name, avatar_seed, avatar_color")
    .single();

  if (error) {
    // The unique index is the real arbiter; two people can pass the check above
    // simultaneously and only one insert wins.
    if (error.code === "23505") {
      return fail("taken", 422, {
        message: "Someone here already has that name — add an initial?",
      });
    }
    return fail(`join-failed: ${error.message}`, 500);
  }

  await setPlayerToken(room.code, token);

  await broadcast(room.id, {
    type: "player:joined",
    playerId: data.id as string,
    displayName: data.display_name as string,
    avatarSeed: data.avatar_seed as string,
    avatarColor: data.avatar_color as string,
  });

  return ok({ playerId: data.id as string, rejoined: false }, 201);
}
