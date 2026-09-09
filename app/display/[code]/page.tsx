"use client";

import { useParams } from "next/navigation";
import { Ocean } from "@/app/components/Ocean";
import {
  Aftermath,
  Briefing,
  Lobby,
  PromptPhase,
  Scramble,
  Shell,
  Standby,
  Winners,
} from "@/app/components/display-views";
import { Confetti } from "@/app/components/Confetti";
import { useGameState } from "@/lib/client/useGameState";
import { useCountdown, usePhaseDeadline } from "@/lib/client/useCountdown";
import { useCountdownTicks, useGameFeedback } from "@/lib/client/useGameFeedback";

/**
 * The projector — the stage.
 *
 * Read from twelve metres by people who are moving, so: nothing small, nothing
 * that depends on colour alone, and one idea on screen at a time. The rising
 * ocean carries the countdown non-numerically, which is what lets the room keep
 * its head up and keep moving instead of staring at a clock.
 *
 * It shows no boat codes and no per-player symbols. A player who could read
 * their symbol off the wall would never have to speak to anyone, which is the
 * whole point of the game.
 */
export default function DisplayPage() {
  const params = useParams<{ code: string }>();
  const code = (params.code ?? "").toUpperCase();
  const { state, error, refetch, serverNow } = useGameState(code);

  const round = state?.round ?? null;
  const scrambling = round?.phase === "scramble";
  const { remainingSeconds, expired } = useCountdown(
    scrambling ? round.endsAt : null,
    serverNow,
  );
  // The reveal's own deadline is not projected, so a short local timer fires the
  // advance: the server still refuses until its clock agrees.
  const revealExpired = round?.phase === "resolve";
  const promptExpired =
    round?.phase === "prompt" &&
    round.promptEndsAt != null &&
    new Date(round.promptEndsAt).getTime() <= serverNow();

  usePhaseDeadline(
    code,
    round?.id,
    round?.phase,
    scrambling ? expired : revealExpired || promptExpired,
    refetch,
  );
  useGameFeedback(state, "display");
  useCountdownTicks(
    remainingSeconds,
    scrambling,
    state?.room.config.soundEnabled ?? true,
  );

  if (error === "no-such-room") {
    return (
      <Shell>
        <p className="font-display text-5xl">No room with code {code}</p>
      </Shell>
    );
  }
  if (!state && error) {
    return (
      <Shell>
        <p className="font-display text-5xl">Can&apos;t reach the game</p>
        <p className="mt-6 max-w-[60rem] text-center text-2xl text-mist">{error}</p>
      </Shell>
    );
  }
  if (!state) {
    return (
      <Shell>
        <p className="animate-bob text-8xl">⚓</p>
      </Shell>
    );
  }

  const total = state.room.config.roundDurationSeconds;
  // 0 calm → 1 deck awash. Drives the sea, the ship's list, and the colour shift.
  const floodLevel = scrambling ? 1 - Math.min(1, remainingSeconds / Math.max(1, total)) : 0.1;
  const urgent = scrambling && remainingSeconds <= 10;

  // A short beat right after a round starts, before anyone can act. Without it
  // the round simply appears and half the room misses the group size.
  const sinceStart = round ? serverNow() - new Date(round.startsAt).getTime() : Infinity;
  const briefing = scrambling && sinceStart < 2400;

  return (
    <>
      <Ocean level={floodLevel} urgent={urgent} />
      <Confetti active={state.room.status === "finished"} />

      <Shell>
        {state.room.status === "finished" ? (
          <Winners state={state} />
        ) : briefing ? (
          <Briefing targetGroupSize={round.targetGroupSize} />
        ) : scrambling ? (
          <Scramble
            state={state}
            remainingSeconds={remainingSeconds}
            total={total}
            urgent={urgent}
            floodLevel={floodLevel}
          />
        ) : round?.phase === "prompt" ? (
          <PromptPhase state={state} serverNow={serverNow} />
        ) : round?.phase === "resolve" ? (
          <Aftermath state={state} />
        ) : round?.phase === "done" ? (
          <Standby state={state} />
        ) : (
          <Lobby state={state} />
        )}
      </Shell>
    </>
  );
}
