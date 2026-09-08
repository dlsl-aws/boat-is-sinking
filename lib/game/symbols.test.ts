import { describe, expect, it } from "vitest";
import { MAX_BOATS, SYMBOLS, getSymbol, pickSymbols } from "./symbols";

describe("symbol pool", () => {
  it("keeps every identity channel distinct", () => {
    // Two boats sharing any of these are indistinguishable across a noisy room.
    for (const key of ["id", "emoji", "name", "color"] as const) {
      const values = SYMBOLS.map((s) => s[key]);
      expect(new Set(values).size, `duplicate ${key}`).toBe(SYMBOLS.length);
    }
  });

  it("covers the largest realistic round", () => {
    // 40 players at the smallest group size is the worst case for this event.
    expect(MAX_BOATS).toBeGreaterThanOrEqual(Math.floor(40 / 2));
  });

  it("wraps and rotates without repeating within one round", () => {
    const picked = pickSymbols(MAX_BOATS, 5);
    expect(new Set(picked.map((s) => s.id)).size).toBe(MAX_BOATS);
    expect(() => pickSymbols(MAX_BOATS + 1)).toThrow(RangeError);
  });

  it("resolves stored ids back to symbols", () => {
    expect(getSymbol("octopus")?.name).toBe("Octopus");
    expect(getSymbol("nope")).toBeUndefined();
  });
});
