import { describe, expect, it } from "vitest";
import { planPostRound } from "./postround";

const base = {
  survivorCount: 20,
  talkingBoatCount: 5,
  targetWinners: 2,
  promptsEnabled: true,
  hasPromptId: true,
  nextShape: { targetGroupSize: 4, boatsRemoved: 0 },
};

describe("planPostRound", () => {
  it("runs the icebreaker on an ordinary round", () => {
    expect(planPostRound(base)).toEqual({ runPrompt: true, gameEnding: false });
  });

  it("skips the icebreaker on the round that ends the game", () => {
    // The bug this guards: the old code set the prompt phase and broadcast
    // prompt:started, then finish_game immediately forced the round to done and
    // yanked the question off the winners' screens.
    expect(planPostRound({ ...base, survivorCount: 2 })).toEqual({
      runPrompt: false,
      gameEnding: true,
    });
  });

  it("ends the game when no further round could thin the field", () => {
    expect(planPostRound({ ...base, survivorCount: 9, nextShape: null })).toEqual({
      runPrompt: false,
      gameEnding: true,
    });
  });

  it("skips the icebreaker when prompts are switched off", () => {
    expect(planPostRound({ ...base, promptsEnabled: false })).toEqual({
      runPrompt: false,
      gameEnding: false,
    });
  });

  it("skips the icebreaker when no round was given a prompt", () => {
    expect(planPostRound({ ...base, hasPromptId: false })).toEqual({
      runPrompt: false,
      gameEnding: false,
    });
  });

  it("skips the icebreaker when nobody has anyone to talk to", () => {
    // Every boat sank or holds a single survivor: a question needs two people.
    expect(planPostRound({ ...base, talkingBoatCount: 0 })).toEqual({
      runPrompt: false,
      gameEnding: false,
    });
  });
});
