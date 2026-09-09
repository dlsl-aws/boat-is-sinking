import "server-only";
import { db } from "../supabase/server";
import { parseConfig } from "../config";
import { assignSymbols, type RoundShape } from "../game/assign";
import { suggestShape } from "../game/plan";
import { generateDistinctBoatCodes } from "../game/codes";
import { nextPrompt } from "../game/prompts";
import { resolveRound, type ResolvableBoat } from "../game/resolve";
import { planPostRound } from "../game/postround";
import { broadcast } from "../realtime/broadcast";

type RoomRow = {
  id: string;
  code: string;
  status: string;
  config: unknown;
  current_round_id: string | null;
  initial_alive: number | null;
  symbol_offset: number;
};

export type StartRoundResult =
  | { ok: true; roundId: string; endsAt: string; shape: RoundShape; boats: number }
  | { ok: false; reason: "too-few-players" | "no-viable-round"; alive: number };

/**
 * Build and launch a round.
 *
 * The shape is either given by the facilitator or chosen by the planner. Either
 * way the assignment happens here in TypeScript — the tested implementation —
 * and is handed to `create_round` to be written atomically.
 */
export async function startRound(
  room: RoomRow,
  options: { shape?: RoundShape } = {},
): Promise<StartRoundResult> {
  const supabase = db();
  const config = parseConfig(room.config);

  const { data: aliveRows } = await supabase
    .from("players")
    .select("id")
    .eq("room_id", room.id)
    .eq("status", "alive");

  const alivePlayerIds = (aliveRows ?? []).map((p) => p.id as string);
  const alive = alivePlayerIds.length;

  const shape =
    options.shape ??
    suggestShape(alive, room.initial_alive ?? alive, {
      minGroupSize: config.minGroupSize,
      maxGroupSize: config.maxGroupSize,
      targetWinners: config.targetWinners,
    });

  if (!shape) return { ok: false, reason: "no-viable-round", alive };

  const assignment = assignSymbols(alivePlayerIds, shape, {
    symbolOffset: room.symbol_offset,
  });

  if (assignment.kind === "too-few-players") {
    return { ok: false, reason: "too-few-players", alive };
  }

  const codes = generateDistinctBoatCodes(assignment.boats.length);
  const boats = assignment.boats.map((boat, i) => ({
    symbolId: boat.symbol.id,
    capacity: boat.capacity,
    code: codes[i]!,
    playerIds: boat.playerIds,
  }));

  // Chosen now rather than at resolve time so the whole round is one write.
  const { data: usedRows } = await supabase
    .from("rounds")
    .select("prompt_id")
    .eq("room_id", room.id)
    .not("prompt_id", "is", null);

  const promptId = config.promptsEnabled
    ? nextPrompt((usedRows ?? []).map((r) => r.prompt_id as string)).id
    : null;

  const { data, error } = await supabase.rpc("create_round", {
    p_room_id: room.id,
    p_target_group_size: shape.targetGroupSize,
    p_boats_removed: shape.boatsRemoved,
    p_duration_seconds: config.roundDurationSeconds,
    p_auto_captain_seconds: config.autoCaptainAfterSeconds,
    p_prompt_id: promptId,
    p_boats: boats,
  });

  if (error) throw new Error(`create_round failed: ${error.message}`);

  const result = data as { roundId: string; roundIndex: number; endsAt: string };

  await broadcast(room.id, {
    type: "round:started",
    roundId: result.roundId,
    roundIndex: result.roundIndex,
    targetGroupSize: shape.targetGroupSize,
    endsAt: result.endsAt,
  });

  return {
    ok: true,
    roundId: result.roundId,
    endsAt: result.endsAt,
    shape,
    boats: boats.length,
  };
}

/**
 * Resolve a round if its deadline has passed.
 *
 * Vercel has no background workers, so nothing wakes up at the deadline. Instead
 * this runs opportunistically: any state read after `ends_at` calls it, as does
 * an explicit request from the display. `begin_resolve` hands ownership to
 * exactly one caller, so a room full of phones all noticing at once still
 * resolves the round precisely once.
 *
 * The consequence worth stating: a round cannot get stuck because a browser was
 * backgrounded, and it cannot be resolved early by a client with a fast clock —
 * the deadline check lives in the database.
 */
export async function maybeResolveRound(
  room: RoomRow,
  options: { skipClockPrecheck?: boolean } = {},
): Promise<boolean> {
  if (!room.current_round_id) return false;
  const supabase = db();
  const config = parseConfig(room.config);

  const { data: roundRow } = await supabase
    .from("rounds")
    .select("id, phase, ends_at, round_index, prompt_id")
    .eq("id", room.current_round_id)
    .maybeSingle();

  if (!roundRow) return false;
  if (roundRow.phase !== "scramble") return false;
  // A cheap filter only. The database clock is the authority, so the forced
  // path skips this rather than comparing two clocks that may disagree.
  if (
    !options.skipClockPrecheck &&
    new Date(roundRow.ends_at as string).getTime() > Date.now()
  ) {
    return false;
  }

  const { data: owned } = await supabase.rpc("begin_resolve", {
    p_round_id: roundRow.id,
  });
  if (!(owned as { owned: boolean })?.owned) return false;

  const [{ data: aliveRows }, { data: boatRows }, { data: seatRows }] =
    await Promise.all([
      supabase.from("players").select("id").eq("room_id", room.id).eq("status", "alive"),
      supabase.from("boats").select("id, symbol_id, capacity").eq("round_id", roundRow.id),
      supabase
        .from("seats")
        .select("boat_id, player_id, seat_index")
        .eq("round_id", roundRow.id)
        .order("seat_index", { ascending: true }),
    ]);

  const seatsByBoat = new Map<string, string[]>();
  for (const seat of seatRows ?? []) {
    const list = seatsByBoat.get(seat.boat_id as string) ?? [];
    list.push(seat.player_id as string);
    seatsByBoat.set(seat.boat_id as string, list);
  }

  const boats: ResolvableBoat[] = (boatRows ?? []).map((b) => ({
    id: b.id as string,
    symbolId: b.symbol_id as string,
    capacity: b.capacity as number,
    seatedPlayerIds: seatsByBoat.get(b.id as string) ?? [],
  }));

  const alivePlayerIds = (aliveRows ?? []).map((p) => p.id as string);
  const resolution = resolveRound(alivePlayerIds, boats, config.underfilledBoatPolicy);

  // Only run a prompt if someone is left to talk to someone else.
  const talkingBoatCount = resolution.boats.filter(
    (b) => !b.sank && b.survivorIds.length > 1,
  ).length;

  const survivors = resolution.survivorIds.length;
  const nextShape = suggestShape(survivors, room.initial_alive ?? survivors, {
    minGroupSize: config.minGroupSize,
    maxGroupSize: config.maxGroupSize,
    targetWinners: config.targetWinners,
  });

  // Decided together, before anything is written: a round that ends the game
  // must not also start an icebreaker.
  const { runPrompt } = planPostRound({
    survivorCount: survivors,
    talkingBoatCount,
    targetWinners: config.targetWinners,
    promptsEnabled: config.promptsEnabled,
    hasPromptId: roundRow.prompt_id != null,
    nextShape,
  });

  const revealEndsAt = new Date(
    Date.now() + config.revealDurationSeconds * 1000,
  ).toISOString();
  const promptEndsAt = runPrompt
    ? new Date(
        Date.now() + (config.revealDurationSeconds + config.promptDurationSeconds) * 1000,
      ).toISOString()
    : null;

  const { error } = await supabase.rpc("apply_resolution", {
    p_round_id: roundRow.id,
    p_survivor_ids: resolution.survivorIds,
    p_eliminated_ids: resolution.eliminatedIds,
    p_reveal_ends_at: revealEndsAt,
    p_prompt_ends_at: promptEndsAt,
  });
  if (error) throw new Error(`apply_resolution failed: ${error.message}`);

  // The round now sits in its reveal. `maybeAdvancePhase` carries it onward;
  // the game is not finished here, or the reveal would never be seen.
  await broadcast(room.id, { type: "round:resolved", roundId: roundRow.id as string });
  return true;
}

/**
 * Carry a round from its reveal into the icebreaker, and out the other side.
 *
 * The same opportunistic pattern as resolution, for the same reason: serverless
 * has no background worker, so a deadline is only noticed because a client
 * asked. `advance_phase` reads every deadline off the row and tells exactly one
 * caller it moved the round, so a room full of phones produces one transition
 * and one broadcast.
 */
export async function maybeAdvancePhase(room: RoomRow): Promise<boolean> {
  if (!room.current_round_id) return false;
  if (room.status === "finished") return false;
  const supabase = db();
  const config = parseConfig(room.config);

  const { data: roundRow } = await supabase
    .from("rounds")
    .select("id, phase, prompt_id")
    .eq("id", room.current_round_id)
    .maybeSingle();

  if (!roundRow) return false;
  const phase = roundRow.phase as string;
  // `done` is still processed here, not just `resolve`/`prompt`: the game-end
  // decision below can fail (a transient query error, or `finish_game` itself
  // failing) and must be retried on a later poll. If we returned early for
  // `done`, a single failure would leave the game undecidable forever.
  if (phase !== "resolve" && phase !== "prompt" && phase !== "done") return false;

  const roundId = roundRow.id as string;

  if (phase === "resolve" || phase === "prompt") {
    const { data } = await supabase.rpc("advance_phase", { p_round_id: roundId });
    const result = data as { moved: boolean; phase?: string } | null;
    if (!result?.moved) {
      console.warn(`advance_phase did not move round ${roundId} (phase: ${phase})`);
      return false;
    }

    if (result.phase === "prompt") {
      const { data: fresh } = await supabase
        .from("rounds")
        .select("prompt_ends_at")
        .eq("id", roundId)
        .maybeSingle();
      await broadcast(room.id, {
        type: "prompt:started",
        roundId,
        promptId: roundRow.prompt_id as string,
        endsAt: (fresh?.prompt_ends_at as string) ?? new Date().toISOString(),
      });
      return true;
    }

    // result.phase === "done": fall through to the game-end decision below.
    await broadcast(room.id, { type: "round:done", roundId });
  }

  // The game is over when no further round could thin the field. Recomputed
  // from the same pure function the resolution used, so the two cannot disagree.
  const { data: aliveRows, error: aliveError } = await supabase
    .from("players")
    .select("id")
    .eq("room_id", room.id)
    .eq("status", "alive");

  if (aliveError) {
    console.warn(`failed to read alive players for room ${room.id}: ${aliveError.message}`);
    return false;
  }

  const survivors = (aliveRows ?? []).length;
  const nextShape = suggestShape(survivors, room.initial_alive ?? survivors, {
    minGroupSize: config.minGroupSize,
    maxGroupSize: config.maxGroupSize,
    targetWinners: config.targetWinners,
  });

  const { gameEnding } = planPostRound({
    survivorCount: survivors,
    talkingBoatCount: 0,
    targetWinners: config.targetWinners,
    promptsEnabled: config.promptsEnabled,
    hasPromptId: false,
    nextShape,
  });

  if (gameEnding) {
    const { error: finishError } = await supabase.rpc("finish_game", { p_room_id: room.id });
    if (finishError) {
      console.warn(`finish_game failed for room ${room.id}: ${finishError.message}`);
      return false;
    }
    await broadcast(room.id, { type: "game:over" });
  }

  return true;
}

/**
 * Appoint captains for any boat nobody volunteered to lead.
 *
 * Called opportunistically from state reads during a scramble, for the same
 * reason resolution is: there is no worker to run it on a timer.
 */
export async function promoteAutoCaptains(
  room: RoomRow,
  roundId: string,
): Promise<void> {
  const { data } = await db().rpc("promote_auto_captains", { p_round_id: roundId });
  const promoted = (data as { promoted?: { boatId: string }[] } | null)?.promoted ?? [];

  for (const boat of promoted) {
    await broadcast(room.id, { type: "boat:captain", boatId: boat.boatId, auto: true });
  }
}
