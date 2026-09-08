import {
  boatCount,
  isBoatCountClamped,
  MIN_GROUP_SIZE,
  projectedEliminations,
  type RoundShape,
} from "./assign";
import type { Rng } from "./rng";

export type RoundWarning =
  /** The round would eliminate nobody — the divisibility trap. */
  | "no-eliminations"
  /** The symbol pool, not the group size, is capping the boat count. */
  | "boat-pool-clamped"
  /** Not enough players left to launch a single boat. */
  | "too-few-players";

export type RoundProjection = {
  index: number;
  alive: number;
  shape: RoundShape;
  boats: number;
  survivors: number;
  eliminated: number;
  warnings: RoundWarning[];
};

/**
 * Describe what a round shape would do to a given number of players, including
 * anything the facilitator should be warned about. This backs both the auto
 * planner and the live warning on the admin dashboard when an `N` is typed by
 * hand.
 */
export function evaluateRound(
  alive: number,
  shape: RoundShape,
  index = 0,
): RoundProjection {
  const boats = boatCount(alive, shape);
  const survivors = boats * shape.targetGroupSize;
  const eliminated = alive - survivors;

  const warnings: RoundWarning[] = [];
  if (boats === 0) warnings.push("too-few-players");
  else if (eliminated === 0) warnings.push("no-eliminations");
  if (isBoatCountClamped(alive, shape)) warnings.push("boat-pool-clamped");

  return { index, alive, shape, boats, survivors, eliminated, warnings };
}

export type PlannerOptions = {
  minGroupSize?: number;
  maxGroupSize?: number;
  /** Stop once this many players remain. */
  targetWinners?: number;
  /** Share of the room eliminated by the first round. */
  startEliminationRate?: number;
  /** Share eliminated by the last, once the field has thinned. */
  endEliminationRate?: number;
  /** Hard stop so a pathological config can never loop forever. */
  maxRounds?: number;
  maxBoatsRemoved?: number;
  /** Avoid repeating the previous round's group size. */
  previousGroupSize?: number;
  rng?: Rng;
};

const DEFAULTS = {
  minGroupSize: MIN_GROUP_SIZE,
  maxGroupSize: 6,
  targetWinners: 2,
  startEliminationRate: 0.2,
  endEliminationRate: 0.45,
  maxRounds: 12,
  maxBoatsRemoved: 3,
} as const;

/**
 * Pick a shape for the next round.
 *
 * Two things are being balanced. Pace: hit an elimination rate that ramps up as
 * the field thins, so early rounds are inclusive and late ones are tense.
 * Mixing: prefer larger groups early (more people meet per round, which is the
 * actual point of an icebreaker) and smaller ones late (where the drama is).
 *
 * Returns `null` when no shape can eliminate anyone — the endgame.
 */
export function suggestShape(
  alive: number,
  initialAlive: number,
  options: PlannerOptions = {},
): RoundShape | null {
  const o = { ...DEFAULTS, ...options };

  // How far the game has run, 0 at kickoff and 1 at the target winner count.
  const span = Math.max(1, initialAlive - o.targetWinners);
  const progress = Math.min(1, Math.max(0, (initialAlive - alive) / span));
  const targetRate =
    o.startEliminationRate +
    (o.endEliminationRate - o.startEliminationRate) * progress;
  // Groups shrink as the game tightens: ~maxGroupSize early, minGroupSize late.
  const preferredSize =
    o.maxGroupSize - (o.maxGroupSize - o.minGroupSize) * progress;

  let best: { shape: RoundShape; score: number } | null = null;

  for (let n = o.minGroupSize; n <= Math.min(o.maxGroupSize, alive); n++) {
    for (let removed = 0; removed <= o.maxBoatsRemoved; removed++) {
      const shape: RoundShape = { targetGroupSize: n, boatsRemoved: removed };
      const boats = boatCount(alive, shape);
      if (boats < 1) continue;

      const eliminated = projectedEliminations(alive, shape);
      // A round that eliminates nobody cannot appear in an auto plan: the game
      // would not converge. `warmup` rounds are chosen explicitly, not here.
      if (eliminated <= 0) continue;
      // Never wipe the room out entirely.
      if (alive - eliminated < 1) continue;

      const rateMiss = Math.abs(eliminated / alive - targetRate);
      const sizeMiss = Math.abs(n - preferredSize) / o.maxGroupSize;
      // More boats means more simultaneous conversations, so withholding boats
      // is a cost even though it is the main pace lever.
      const removalCost = removed * 0.02;
      const repeatCost = n === options.previousGroupSize ? 0.05 : 0;

      // Group size is weighted heavily against pure pace-matching. Left to the
      // rate alone the planner reaches for pairs mid-game, and a group of two
      // is the weakest possible icebreaker unit — you meet one person. This
      // weight keeps the ramp monotonic (6,5,4,3,3,2,2 at 40 players), which
      // both mixes better and reads sensibly to a facilitator.
      const score = rateMiss + sizeMiss * 0.7 + removalCost + repeatCost;
      if (!best || score < best.score) best = { shape, score };
    }
  }

  return best?.shape ?? null;
}

export type GameProjection = {
  rounds: RoundProjection[];
  /** Players still standing when the plan runs out. */
  winners: number;
  /** True if the plan ended because no round could eliminate anyone. */
  endedEarly: boolean;
};

/**
 * Project a whole game so the facilitator can see, before starting, roughly how
 * many rounds it will take and how many people each one drops. Ten minutes is
 * the usual budget and this is what makes that budgetable.
 */
export function projectGame(
  initialAlive: number,
  options: PlannerOptions = {},
): GameProjection {
  const o = { ...DEFAULTS, ...options };
  const rounds: RoundProjection[] = [];

  let alive = initialAlive;
  let previousGroupSize = options.previousGroupSize;

  while (alive > o.targetWinners && rounds.length < o.maxRounds) {
    const shape = suggestShape(alive, initialAlive, { ...options, previousGroupSize });
    if (!shape) break;

    const projection = evaluateRound(alive, shape, rounds.length);
    // Defensive: `suggestShape` already rejects these, but a plan that failed to
    // shrink the field would loop until maxRounds and mislead the facilitator.
    if (projection.eliminated <= 0) break;

    rounds.push(projection);
    alive = projection.survivors;
    previousGroupSize = shape.targetGroupSize;
  }

  return {
    rounds,
    winners: alive,
    endedEarly: alive > o.targetWinners,
  };
}
