import { z } from "zod";

/**
 * Realtime events broadcast on a room's channel.
 *
 * TWO RULES GOVERN WHAT MAY APPEAR HERE.
 *
 * 1. Nothing secret. Every viewer of the room channel receives every event, so
 *    a boat code or a per-player symbol assignment in one of these payloads
 *    would let a player find their group from the sofa. That destroys the only
 *    mechanic that makes this an icebreaker rather than a tapping race. Boat
 *    codes are returned ONLY in the captain's own HTTP response; symbols come
 *    ONLY from the per-player state endpoint. Neither is ever broadcast.
 *
 * 2. Nothing authoritative. These are notifications, not state. A dropped or
 *    duplicated event must never corrupt a client, so events either carry
 *    display-safe data that is idempotent to apply, or simply tell the client
 *    to refetch.
 *
 * Events that carry data exist to avoid a refetch storm: 40 phones refetching
 * on every seat claim would be ~1,700 function invocations per round. Phase
 * changes are rare, so those trigger a refetch; per-seat progress does not.
 */

export const gameEventSchema = z.discriminatedUnion("type", [
  /** Roster, config or player status changed. Clients refetch. */
  z.object({ type: z.literal("room:updated") }),

  /** Display-safe, so the projector's deck fills without a refetch per join. */
  z.object({
    type: z.literal("player:joined"),
    playerId: z.string(),
    displayName: z.string(),
    avatarSeed: z.string(),
    avatarColor: z.string(),
  }),
  z.object({
    type: z.literal("player:renamed"),
    playerId: z.string(),
    displayName: z.string(),
  }),
  z.object({ type: z.literal("player:left"), playerId: z.string() }),

  /**
   * A round began. Deliberately carries no assignments — every player refetches
   * to learn their own symbol, and learns only their own.
   */
  z.object({
    type: z.literal("round:started"),
    roundId: z.string(),
    roundIndex: z.number(),
    targetGroupSize: z.number(),
    endsAt: z.string(),
  }),

  /**
   * Seat progress for one boat. Safe to broadcast: which symbols are filling up
   * is exactly what the projector is meant to show, and it reveals no code.
   * Idempotent to apply, so a duplicate is harmless.
   */
  z.object({
    type: z.literal("boat:progress"),
    boatId: z.string(),
    symbolId: z.string(),
    filled: z.number(),
    capacity: z.number(),
    locked: z.boolean(),
  }),

  /**
   * A boat has a captain. Carries the id only — the affected players refetch to
   * learn the name, and only the captain's own refetch returns the code.
   */
  z.object({
    type: z.literal("boat:captain"),
    boatId: z.string(),
    auto: z.boolean(),
  }),

  z.object({ type: z.literal("round:resolved"), roundId: z.string() }),
  z.object({
    type: z.literal("prompt:started"),
    roundId: z.string(),
    promptId: z.string(),
    endsAt: z.string(),
  }),
  z.object({ type: z.literal("game:over") }),
]);

export type GameEvent = z.infer<typeof gameEventSchema>;

/** The events that mean "your view is stale, go and refetch". */
export const REFETCH_EVENTS = new Set<GameEvent["type"]>([
  "room:updated",
  "round:started",
  "boat:captain",
  "round:resolved",
  "prompt:started",
  "game:over",
]);

export const BROADCAST_EVENT = "game";

/** Channel name for a room. Keyed by id, not code, so it survives a rename. */
export function roomChannel(roomId: string): string {
  return `room:${roomId}`;
}

/** Parse an inbound payload defensively; unknown shapes are ignored. */
export function parseGameEvent(payload: unknown): GameEvent | null {
  const result = gameEventSchema.safeParse(payload);
  return result.success ? result.data : null;
}
