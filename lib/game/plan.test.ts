import { describe, expect, it } from "vitest";
import { evaluateRound, projectGame, suggestShape } from "./plan";

describe("evaluateRound", () => {
  it("flags the divisibility trap", () => {
    const dud = evaluateRound(12, { targetGroupSize: 4, boatsRemoved: 0 });
    expect(dud.eliminated).toBe(0);
    expect(dud.warnings).toContain("no-eliminations");

    const fixed = evaluateRound(12, { targetGroupSize: 4, boatsRemoved: 1 });
    expect(fixed.eliminated).toBe(4);
    expect(fixed.warnings).toEqual([]);
  });

  it("flags a round nobody can play", () => {
    expect(evaluateRound(3, { targetGroupSize: 5, boatsRemoved: 0 }).warnings).toContain(
      "too-few-players",
    );
  });
});

describe("suggestShape", () => {
  it("never proposes a round that eliminates nobody", () => {
    for (let alive = 3; alive <= 60; alive++) {
      const shape = suggestShape(alive, 60);
      if (!shape) continue;
      const round = evaluateRound(alive, shape);
      expect(round.eliminated, `alive=${alive}`).toBeGreaterThan(0);
      expect(round.boats, `alive=${alive}`).toBeGreaterThanOrEqual(1);
      expect(round.survivors, `alive=${alive}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("ramps from bigger, gentler groups to smaller, harsher ones", () => {
    const early = suggestShape(40, 40)!;
    const late = suggestShape(6, 40)!;
    expect(early.targetGroupSize).toBeGreaterThan(late.targetGroupSize);

    const earlyRate = evaluateRound(40, early).eliminated / 40;
    const lateRate = evaluateRound(6, late).eliminated / 6;
    expect(lateRate).toBeGreaterThan(earlyRate);
  });

  it("returns null only when no round can thin the field", () => {
    expect(suggestShape(2, 40)).toBeNull();
    expect(suggestShape(1, 40)).toBeNull();
    expect(suggestShape(3, 40)).not.toBeNull();
  });
});

describe("projectGame", () => {
  it("converges to the target from every realistic room size", () => {
    for (let start = 4; start <= 60; start++) {
      const plan = projectGame(start);
      expect(plan.winners, `start=${start}`).toBeLessThanOrEqual(2);
      expect(plan.endedEarly, `start=${start}`).toBe(false);
      // Every round must actually shrink the field, or the plan is a lie.
      for (const round of plan.rounds) {
        expect(round.eliminated, `start=${start} r${round.index}`).toBeGreaterThan(0);
        expect(round.warnings, `start=${start} r${round.index}`).not.toContain(
          "no-eliminations",
        );
      }
      // Each round's survivors feed the next round's alive count.
      for (let i = 1; i < plan.rounds.length; i++) {
        expect(plan.rounds[i]!.alive).toBe(plan.rounds[i - 1]!.survivors);
      }
    }
  });

  it("fits an icebreaker slot for the room size this is built for", () => {
    // 20-40 players is the stated scale; a 10-minute slot allows ~4-8 rounds.
    for (const start of [20, 25, 30, 35, 40]) {
      const plan = projectGame(start);
      expect(plan.rounds.length, `start=${start}`).toBeGreaterThanOrEqual(3);
      expect(plan.rounds.length, `start=${start}`).toBeLessThanOrEqual(8);
    }
  });

  it("respects a custom winner target", () => {
    const plan = projectGame(30, { targetWinners: 5 });
    expect(plan.winners).toBeLessThanOrEqual(5);
    expect(plan.winners).toBeGreaterThan(1);
  });

  it("terminates on a degenerate config instead of looping", () => {
    const plan = projectGame(40, { minGroupSize: 2, maxGroupSize: 2, maxBoatsRemoved: 0 });
    // N=2 with no boats withheld eliminates nobody at an even count.
    expect(plan.rounds.length).toBeLessThan(12);
  });
});
