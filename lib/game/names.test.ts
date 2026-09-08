import { describe, expect, it } from "vitest";
import { checkName, isProfane, nameKey, normalizeName } from "./names";

describe("normalizeName", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeName("  Ada   Lovelace  ")).toBe("Ada Lovelace");
  });

  it("strips invisible characters that fake a blank or reorder the display", () => {
    expect(normalizeName("\u200B\u200BAda\u200B")).toBe("Ada");
    expect(normalizeName("\u200B \u200B")).toBe("");
  });
});

describe("nameKey", () => {
  it("ignores case, accents and spacing so near-duplicates collide", () => {
    expect(nameKey("José")).toBe(nameKey("jose"));
    expect(nameKey("Sam")).toBe(nameKey("  sam "));
  });

  it("keeps genuinely different names apart", () => {
    expect(nameKey("Sam")).not.toBe(nameKey("Samir"));
  });
});

describe("isProfane", () => {
  it("catches whole words and their leetspeak spellings", () => {
    expect(isProfane("fuck")).toBe(true);
    expect(isProfane("Big Sh1t")).toBe(true);
    expect(isProfane("f4gg0t")).toBe(true);
  });

  it("does not fall for the Scunthorpe problem", () => {
    // Real places and names that contain a blocked word as a substring.
    for (const name of ["Scunthorpe", "Penistone", "Cockburn", "Dickens", "Assisi"]) {
      expect(isProfane(name), name).toBe(false);
    }
  });
});

describe("checkName", () => {
  it("accepts an ordinary name", () => {
    const result = checkName("  Ada  ");
    expect(result).toEqual({ ok: true, name: "Ada" });
  });

  it("enforces the length bounds on the normalized value", () => {
    expect(checkName("A")).toMatchObject({ ok: false, reason: "too-short" });
    expect(checkName("   ")).toMatchObject({ ok: false, reason: "empty" });
    expect(checkName("x".repeat(21))).toMatchObject({ ok: false, reason: "too-long" });
    // 21 visible chars, but invisible padding shouldn't push it over.
    expect(checkName(`${"x".repeat(20)}\u200B`)).toMatchObject({ ok: true });
  });

  it("rejects a name already taken, case-insensitively", () => {
    const taken = new Set([nameKey("Sam")]);
    expect(checkName("sam", taken)).toMatchObject({ ok: false, reason: "taken" });
    expect(checkName("Sam K", taken)).toMatchObject({ ok: true });
  });
});
