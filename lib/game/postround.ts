import type { RoundShape } from "./assign";

export type PostRoundInput = {
  /** Players still alive after this round resolved. */
  survivorCount: number;
  /** Boats that stayed afloat holding more than one survivor. */
  talkingBoatCount: number;
  targetWinners: number;
  promptsEnabled: boolean;
  /** Whether this round was given a prompt when it was built. */
  hasPromptId: boolean;
  /** The shape the planner would use next, or null if no round can thin the field. */
  nextShape: RoundShape | null;
};

export type PostRoundPlan = {
  runPrompt: boolean;
  gameEnding: boolean;
};

/**
 * What happens after a round resolves.
 *
 * Both halves are decided together and in this order deliberately: a round that
 * ends the game must not also start an icebreaker. Doing it the other way round
 * is what produced the defect where the winners' question appeared and was
 * immediately pulled off screen by `finish_game`.
 *
 * A prompt also needs somebody to talk to, so a room where every boat sank or
 * holds one person gets none.
 */
export function planPostRound(input: PostRoundInput): PostRoundPlan {
  const gameEnding =
    input.survivorCount <= input.targetWinners || input.nextShape === null;

  const runPrompt =
    !gameEnding &&
    input.promptsEnabled &&
    input.hasPromptId &&
    input.talkingBoatCount > 0;

  return { runPrompt, gameEnding };
}
