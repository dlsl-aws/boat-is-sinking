/** What happens to a boat that never filled before the timer ran out. */
export type UnderfilledBoatPolicy = "lenient" | "strict";

export type ResolvableBoat = {
  id: string;
  symbolId: string;
  capacity: number;
  /** Player ids holding a seat, in claim order. Never longer than `capacity`. */
  seatedPlayerIds: readonly string[];
};

export type BoatOutcome = {
  boatId: string;
  symbolId: string;
  filled: number;
  capacity: number;
  /** True when the boat went down and took its passengers with it. */
  sank: boolean;
  survivorIds: string[];
  eliminatedIds: string[];
};

export type Resolution = {
  survivorIds: string[];
  eliminatedIds: string[];
  boats: BoatOutcome[];
};

/**
 * Decide who survives a round once the timer has expired.
 *
 * Pure and total: it takes the seat claims as already settled by the database
 * and only applies policy. All contention was resolved atomically at claim time,
 * so nothing here has to break a tie — which is what keeps resolution safe to
 * run more than once (see the lazy-resolution path in the round API).
 */
export function resolveRound(
  alivePlayerIds: readonly string[],
  boats: readonly ResolvableBoat[],
  policy: UnderfilledBoatPolicy = "lenient",
): Resolution {
  const alive = new Set(alivePlayerIds);
  const survivors = new Set<string>();
  const outcomes: BoatOutcome[] = [];

  for (const boat of boats) {
    // Only players still alive count; someone kicked mid-round leaves an
    // orphaned seat behind, and it must not resurrect them.
    const seated = boat.seatedPlayerIds.filter((id) => alive.has(id));
    const isFull = seated.length >= boat.capacity;
    const sank = !isFull && policy === "strict";

    if (!sank) for (const id of seated) survivors.add(id);

    outcomes.push({
      boatId: boat.id,
      symbolId: boat.symbolId,
      filled: seated.length,
      capacity: boat.capacity,
      sank,
      survivorIds: sank ? [] : seated,
      eliminatedIds: sank ? seated : [],
    });
  }

  // Anyone alive who never got a seat is in the water, whatever the policy.
  const eliminatedIds = alivePlayerIds.filter((id) => !survivors.has(id));

  return {
    survivorIds: alivePlayerIds.filter((id) => survivors.has(id)),
    eliminatedIds,
    boats: outcomes,
  };
}
