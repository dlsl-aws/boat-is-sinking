/** A function returning a float in [0, 1). `Math.random` satisfies this. */
export type Rng = () => number;

/**
 * mulberry32 — small, fast, and good enough for shuffling a room of people.
 * Its purpose is reproducibility: the same seed yields the same assignment, so
 * the round engine can be tested and a bad round can be replayed exactly.
 */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates. Returns a new array; does not mutate the input. */
export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    // Non-null: i and j are both in bounds of `out`.
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
