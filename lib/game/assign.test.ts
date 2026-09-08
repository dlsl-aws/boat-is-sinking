import { describe, expect, it } from "vitest";
import {
  assignSymbols,
  boatCount,
  isBoatCountClamped,
  projectedEliminations,
  pressureToShape,
  type Assignment,
  type RoundShape,
} from "./assign";
import { MAX_BOATS, SYMBOLS } from "./symbols";
import { seededRng } from "./rng";

const players = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
const shape = (targetGroupSize: number, boatsRemoved = 0): RoundShape => ({
  targetGroupSize,
  boatsRemoved,
});

function ok(result: Assignment) {
  if (result.kind !== "ok") {
    throw new Error(`expected an assignment, got ${result.kind}`);
  }
  return result;
}

describe("assignSymbols", () => {
  it("reproduces the worked examples from the plan", () => {
    // P=37, N=4 -> 9 boats, 36 seats, exactly 1 drowns.
    const a = ok(assignSymbols(players(37), shape(4), { rng: seededRng(1) }));
    expect(a.boats).toHaveLength(9);
    expect(a.survivorCount).toBe(36);
    expect(a.eliminationCount).toBe(1);
    expect(a.boats.map((b) => b.playerIds.length).sort()).toEqual([
      4, 4, 4, 4, 4, 4, 4, 4, 5,
    ]);

    // P=13, N=5 -> 2 boats, 10 seats, cohorts of 7 and 6, so 3 drown.
    const b = ok(assignSymbols(players(13), shape(5), { rng: seededRng(2) }));
    expect(b.boats).toHaveLength(2);
    expect(b.eliminationCount).toBe(3);
    expect(b.boats.map((x) => x.playerIds.length).sort()).toEqual([6, 7]);

    // P=7, N=3 -> 2 boats, 6 seats, 1 drowns.
    const c = ok(assignSymbols(players(7), shape(3), { rng: seededRng(3) }));
    expect(c.eliminationCount).toBe(1);
    expect(c.boats.map((x) => x.playerIds.length).sort()).toEqual([3, 4]);
  });

  it("holds its invariants across the whole realistic range", () => {
    for (let p = 2; p <= 60; p++) {
      for (let n = 2; n <= 8; n++) {
        const result = assignSymbols(players(p), shape(n), { rng: seededRng(p * 100 + n) });

        if (boatCount(p, shape(n)) === 0) {
          expect(result.kind).toBe("too-few-players");
          continue;
        }

        const a = ok(result);
        const label = `P=${p} N=${n}`;

        // Boat count and survivor count are fixed before anyone moves.
        expect(a.boats.length, label).toBe(Math.min(Math.floor(p / n), MAX_BOATS));
        expect(a.survivorCount, label).toBe(a.boats.length * n);
        expect(a.eliminationCount, label).toBe(p - a.survivorCount);
        expect(a.eliminationCount, label).toBeGreaterThanOrEqual(0);

        // Every alive player is assigned exactly one symbol, and none invented.
        const assigned = a.boats.flatMap((b) => b.playerIds);
        expect(assigned, label).toHaveLength(p);
        expect(new Set(assigned).size, label).toBe(p);

        // Every boat has exactly N seats, and cohorts differ by at most one so
        // no single group carries the whole overflow.
        const sizes = a.boats.map((b) => b.playerIds.length);
        expect(new Set(a.boats.map((b) => b.capacity)), label).toEqual(new Set([n]));
        expect(Math.max(...sizes) - Math.min(...sizes), label).toBeLessThanOrEqual(1);

        // Symbols are distinct, or two cohorts would collide on one boat.
        expect(new Set(a.boats.map((b) => b.symbol.id)).size, label).toBe(a.boats.length);
      }
    }
  });

  it("eliminates nobody when players divide evenly — the divisibility trap", () => {
    const a = ok(assignSymbols(players(12), shape(4), { rng: seededRng(7) }));
    expect(a.eliminationCount).toBe(0);
    expect(projectedEliminations(12, shape(4))).toBe(0);

    // Withholding a boat is the fix: same announced N, real stakes.
    expect(projectedEliminations(12, shape(4, 1))).toBe(4);
    expect(pressureToShape(4, "high")).toEqual(shape(4, 1));
    const b = ok(assignSymbols(players(12), shape(4, 1), { rng: seededRng(7) }));
    expect(b.boats).toHaveLength(2);
    expect(b.eliminationCount).toBe(4);
    // All 12 still get a symbol; there are just only 8 seats.
    expect(b.boats.flatMap((x) => x.playerIds)).toHaveLength(12);
  });

  it("reports too-few-players instead of throwing at the endgame", () => {
    expect(assignSymbols(players(3), shape(4)).kind).toBe("too-few-players");
    expect(assignSymbols(players(2), shape(3, 1)).kind).toBe("too-few-players");
  });

  it("clamps to the symbol pool rather than throwing on an oversized room", () => {
    // 200 players at N=2 wants 100 boats; only MAX_BOATS symbols exist.
    expect(isBoatCountClamped(200, shape(2))).toBe(true);
    expect(boatCount(200, shape(2))).toBe(MAX_BOATS);

    const a = ok(assignSymbols(players(200), shape(2), { rng: seededRng(9) }));
    expect(a.boats).toHaveLength(MAX_BOATS);
    // Everyone still gets a symbol; the round is just brutal.
    expect(a.boats.flatMap((b) => b.playerIds)).toHaveLength(200);
    expect(a.survivorCount).toBe(MAX_BOATS * 2);

    // Not clamped anywhere in the size this is actually built for.
    expect(isBoatCountClamped(40, shape(2))).toBe(false);
    expect(isBoatCountClamped(64, shape(2))).toBe(false);
  });

  it("rejects group sizes below 2", () => {
    expect(() => assignSymbols(players(10), shape(1))).toThrow(RangeError);
    expect(() => assignSymbols(players(10), shape(2.5))).toThrow(RangeError);
    expect(() => assignSymbols(players(10), shape(3, -1))).toThrow(RangeError);
  });

  it("is deterministic for a seed and varies without one", () => {
    const a = ok(assignSymbols(players(20), shape(3), { rng: seededRng(42) }));
    const b = ok(assignSymbols(players(20), shape(3), { rng: seededRng(42) }));
    expect(a.boats.map((x) => x.playerIds)).toEqual(b.boats.map((x) => x.playerIds));
  });

  it("rotates symbols between rounds so consecutive rounds feel different", () => {
    const r1 = ok(assignSymbols(players(20), shape(5), { symbolOffset: 0 }));
    const r2 = ok(assignSymbols(players(20), shape(5), { symbolOffset: 4 }));
    expect(r1.boats.map((b) => b.symbol.id)).not.toEqual(r2.boats.map((b) => b.symbol.id));
  });
});
