import { pickSymbols, type GameSymbol, MAX_BOATS } from "./symbols";
import { shuffle, type Rng } from "./rng";

export const MIN_GROUP_SIZE = 2;

/**
 * The shape of one round.
 *
 * `boatsRemoved` exists because of a hard arithmetic limit. Survivors are
 * always `boats * N`, so a round that launches every boat it can afford
 * eliminates only `alive mod N` players — capped at `N - 1`. At 40 players that
 * means N of 2, 4, 5 or 8 eliminates *nobody*, and even the best natural round
 * removes 5 people. Reaching a winner would take eight-plus rounds, far past the
 * ten minutes an icebreaker gets.
 *
 * Withholding boats is therefore the primary pace control, not a special case:
 * dropping `k` boats eliminates `(alive mod N) + k * N` players.
 */
export type RoundShape = {
  targetGroupSize: number;
  /** Boats deliberately withheld to force contention. 0 launches every boat. */
  boatsRemoved: number;
};

/** The coarse setting exposed in room config; the planner works in `RoundShape`. */
export type EliminationPressure = "natural" | "high";

export function pressureToShape(
  targetGroupSize: number,
  pressure: EliminationPressure,
): RoundShape {
  return { targetGroupSize, boatsRemoved: pressure === "high" ? 1 : 0 };
}

export type PlannedBoat = {
  symbol: GameSymbol;
  /** Seats available. Always exactly the round's target group size. */
  capacity: number;
  /**
   * Everyone holding this symbol. Length may EXCEED `capacity` — that overflow
   * is the game. Order is shuffled and carries no meaning; it must never be
   * used to decide who survives.
   */
  playerIds: string[];
};

export type Assignment =
  | {
      kind: "ok";
      boats: PlannedBoat[];
      /** Always `boats.length * capacity`. Fixed before anyone moves. */
      survivorCount: number;
      eliminationCount: number;
    }
  | {
      /** Not enough players to form even one boat. The caller runs the endgame. */
      kind: "too-few-players";
      alive: number;
      targetGroupSize: number;
    };

/** How many boats a given player count and round shape actually launches. */
export function boatCount(alive: number, shape: RoundShape): number {
  const natural = Math.floor(alive / shape.targetGroupSize);
  return Math.max(0, Math.min(natural - shape.boatsRemoved, MAX_BOATS));
}

/** Players eliminated by a round, known before it starts. */
export function projectedEliminations(alive: number, shape: RoundShape): number {
  return alive - boatCount(alive, shape) * shape.targetGroupSize;
}

/**
 * True when the symbol pool, not the round shape, is what caps the boat count.
 * Only reachable in rooms far larger than this is built for; the admin
 * dashboard surfaces it because such a round eliminates more than expected.
 */
export function isBoatCountClamped(alive: number, shape: RoundShape): boolean {
  return Math.floor(alive / shape.targetGroupSize) - shape.boatsRemoved > MAX_BOATS;
}

/**
 * Assign every alive player a symbol for one round.
 *
 * All players are distributed across the launched boats as evenly as possible,
 * which leaves some symbols held by more people than the boat has seats. That
 * overflow IS the game: survivor *count* is fixed the moment the round is built,
 * survivor *identity* is decided by who reaches their captain first.
 *
 * Crucially an overflow player's screen is identical to a safe player's, so
 * nobody can tell whether they are contested and everybody scrambles.
 */
export function assignSymbols(
  alivePlayerIds: readonly string[],
  shape: RoundShape,
  options: {
    /** Rotates the symbol pool so consecutive rounds look different. */
    symbolOffset?: number;
    rng?: Rng;
  } = {},
): Assignment {
  const { symbolOffset = 0, rng = Math.random } = options;
  const { targetGroupSize } = shape;

  if (!Number.isInteger(targetGroupSize) || targetGroupSize < MIN_GROUP_SIZE) {
    throw new RangeError(
      `targetGroupSize must be an integer >= ${MIN_GROUP_SIZE}, got ${targetGroupSize}`,
    );
  }
  if (!Number.isInteger(shape.boatsRemoved) || shape.boatsRemoved < 0) {
    throw new RangeError(
      `boatsRemoved must be a non-negative integer, got ${shape.boatsRemoved}`,
    );
  }

  const alive = alivePlayerIds.length;
  const boats = boatCount(alive, shape);

  if (boats === 0) {
    return { kind: "too-few-players", alive, targetGroupSize };
  }

  const symbols = pickSymbols(boats, symbolOffset);
  // Shuffling is what makes overflow risk land on a different, random person
  // each round rather than tracking a fixed position in the roster.
  const shuffled = shuffle(alivePlayerIds, rng);

  const planned: PlannedBoat[] = symbols.map((symbol) => ({
    symbol,
    capacity: targetGroupSize,
    playerIds: [],
  }));

  // Round-robin deals the remainder out one player at a time, so cohort sizes
  // differ by at most one and no single boat absorbs the whole overflow.
  for (let i = 0; i < shuffled.length; i++) {
    planned[i % boats]!.playerIds.push(shuffled[i]!);
  }

  return {
    kind: "ok",
    boats: planned,
    survivorCount: boats * targetGroupSize,
    eliminationCount: alive - boats * targetGroupSize,
  };
}
