"use client";

import { useEffect, useRef } from "react";
import { play, unlock } from "./sound";
import { buzz } from "./haptics";
import type { ClientState } from "./useGameState";

/**
 * Turns game state changes into sound and haptics.
 *
 * Kept in one place rather than scattered through the components so the cue
 * palette can be read, tuned and reasoned about as a whole — and so no cue can
 * accidentally fire twice from two different render paths.
 *
 * Everything is edge-triggered off the previous value: cues fire on the
 * *transition*, never on the state, which matters because this state refetches
 * every few seconds and a level-triggered cue would machine-gun.
 */
export function useGameFeedback(
  state: ClientState | null,
  role: "player" | "display",
) {
  const previous = useRef<{
    phase?: string;
    roundId?: string;
    seated: boolean;
    locked: boolean;
    captain: boolean;
    status?: string;
    finished: boolean;
    playerCount: number;
  }>({
    seated: false,
    locked: false,
    captain: false,
    finished: false,
    playerCount: 0,
  });

  // Browsers will not start audio without a gesture. Arm on the first
  // interaction anywhere on the page, whatever it was.
  useEffect(() => {
    const arm = () => unlock();
    window.addEventListener("pointerdown", arm, { once: true });
    window.addEventListener("keydown", arm, { once: true });
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    const previousValue = previous.current;
    const self = state.self;
    const round = state.round;
    const muted = !state.room.config.soundEnabled;

    const cue = (name: Parameters<typeof play>[0]) => {
      if (!muted) play(name);
    };

    // A new round starting is the single most important cue in the game: it is
    // what makes forty people look up at once.
    if (round && round.id !== previousValue.roundId && round.phase === "scramble") {
      cue("bell");
      window.setTimeout(() => cue("alarm"), 260);
      if (role === "player") buzz("alert");
    }

    if (role === "player" && self) {
      if (self.isCaptain && !previousValue.captain) {
        cue("captain");
        buzz("success");
      }
      // Claiming a seat, but not if the same event also locked the boat —
      // otherwise two positive cues collide and neither lands.
      if (self.seatIndex != null && !previousValue.seated && !self.boatLocked) {
        cue("aboard");
        buzz("success");
      }
      if (self.boatLocked && !previousValue.locked && self.seatIndex != null) {
        cue("lock");
        buzz("success");
      }
      if (self.status === "eliminated" && previousValue.status === "alive") {
        cue("splash");
        buzz("doom");
      }
    }

    if (role === "display") {
      // Someone went overboard.
      if (round?.phase === "resolve" && previousValue.phase === "scramble") {
        cue("splash");
      }
      if (state.counts.joined > previousValue.playerCount && state.room.status === "lobby") {
        cue("join");
      }
    }

    if (state.room.status === "finished" && !previousValue.finished) {
      cue("fanfare");
    }

    previous.current = {
      phase: round?.phase,
      roundId: round?.id,
      seated: self?.seatIndex != null,
      locked: self?.boatLocked ?? false,
      captain: self?.isCaptain ?? false,
      status: self?.status,
      finished: state.room.status === "finished",
      playerCount: state.counts.joined,
    };
  }, [state, role]);
}

/**
 * The accelerating countdown tick.
 *
 * Pitch and volume climb over the final stretch. This is the cue that actually
 * moves a room — people start moving faster without ever looking at the clock,
 * the same way a heart-rate monitor conveys urgency without a number.
 */
export function useCountdownTicks(
  remainingSeconds: number,
  active: boolean,
  enabled: boolean,
) {
  const lastTick = useRef<number>(-1);

  useEffect(() => {
    if (!active || !enabled) {
      lastTick.current = -1;
      return;
    }
    // Only the closing stretch. Ticking for a full 45 seconds is maddening.
    if (remainingSeconds > 15 || remainingSeconds <= 0) return;
    if (remainingSeconds === lastTick.current) return;

    lastTick.current = remainingSeconds;
    play("tick", 1 - remainingSeconds / 15);
  }, [remainingSeconds, active, enabled]);
}
