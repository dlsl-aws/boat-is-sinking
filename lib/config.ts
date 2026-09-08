import { z } from "zod";

/**
 * Room configuration. Everything a facilitator can change before the game and
 * between rounds.
 *
 * Stored as jsonb on `rooms.config` and parsed through this schema on every
 * read, so a room created by an older deployment still loads with sane values
 * rather than crashing mid-event.
 */
export const roomConfigSchema = z.object({
  /** Length of the scramble. 45s is enough to cross a room and find a person. */
  roundDurationSeconds: z.number().int().min(10).max(300).default(45),
  promptDurationSeconds: z.number().int().min(10).max(300).default(45),
  promptsEnabled: z.boolean().default(true),

  /**
   * Let the planner choose each round's shape. Turning this off hands the
   * facilitator the group size directly, with a warning when their choice would
   * eliminate nobody.
   */
  autoPlan: z.boolean().default(true),
  minGroupSize: z.number().int().min(2).max(8).default(2),
  maxGroupSize: z.number().int().min(2).max(8).default(6),
  targetWinners: z.number().int().min(1).max(10).default(2),

  /** What happens to a boat that never filled. See lib/game/resolve.ts. */
  underfilledBoatPolicy: z.enum(["lenient", "strict"]).default("lenient"),

  /**
   * Grace period before a captain-less boat gets one appointed. The single most
   * important safety valve in the game: without it an entire cohort drowns
   * because nobody volunteered.
   */
  autoCaptainAfterSeconds: z.number().int().min(0).max(60).default(5),

  allowLateJoin: z.boolean().default(true),
  soundEnabled: z.boolean().default(true),
  profanityFilter: z.boolean().default(true),
});

export type RoomConfig = z.infer<typeof roomConfigSchema>;

export const DEFAULT_CONFIG: RoomConfig = roomConfigSchema.parse({});

/** Tolerant parse: unknown or invalid fields fall back to defaults. */
export function parseConfig(value: unknown): RoomConfig {
  const result = roomConfigSchema.safeParse(value ?? {});
  return result.success ? result.data : DEFAULT_CONFIG;
}
