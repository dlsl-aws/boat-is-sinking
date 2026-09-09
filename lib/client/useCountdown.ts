"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Count down to a server-issued deadline.
 *
 * Nothing is streamed. The server sets `ends_at` once, the client corrects for
 * its own clock skew, and this ticks locally. That is what keeps a 45-second
 * round with 40 phones at essentially zero realtime traffic — the alternative,
 * broadcasting a tick, would be 40 messages a second against a 100/s budget.
 */
export function useCountdown(
  endsAt: string | null | undefined,
  serverNow: () => number,
): { remainingMs: number; remainingSeconds: number; expired: boolean } {
  const [remainingMs, setRemainingMs] = useState(() =>
    endsAt ? Math.max(0, new Date(endsAt).getTime() - serverNow()) : 0,
  );

  useEffect(() => {
    if (!endsAt) {
      setRemainingMs(0);
      return;
    }

    const deadline = new Date(endsAt).getTime();
    let frame = 0;

    const tick = () => {
      setRemainingMs(Math.max(0, deadline - serverNow()));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [endsAt, serverNow]);

  return {
    remainingMs,
    remainingSeconds: Math.ceil(remainingMs / 1000),
    expired: endsAt != null && remainingMs <= 0,
  };
}

/**
 * Ask the server to move a round on, once the current phase's deadline passes.
 *
 * Vercel has no background worker, so every deadline has to be noticed by a
 * client. Every open client fires this and the database grants the transition
 * to exactly one of them — the redundancy is the point, because it means a
 * round still progresses if any single browser is asleep.
 *
 * The fired-once guard is keyed on round id *and* phase, so one round can fire
 * three times across its life: at the scramble deadline, at the reveal's, and
 * at the icebreaker's.
 *
 * A short jittered delay keeps 40 phones from arriving in the same millisecond.
 */
export function usePhaseDeadline(
  roomCode: string,
  roundId: string | null | undefined,
  phase: string | null | undefined,
  expired: boolean,
  onAdvanced: () => void,
) {
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!roundId || !phase || !expired) return;
    if (phase !== "scramble" && phase !== "resolve" && phase !== "prompt") return;

    const key = `${roundId}:${phase}`;
    if (firedFor.current === key) return;
    firedFor.current = key;

    const timer = setTimeout(
      () => {
        void fetch(`/api/rounds/${roundId}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomCode }),
        })
          .then(onAdvanced)
          .catch(() => {
            // Another client will get there; the slow poll is the backstop.
          });
      },
      Math.random() * 400,
    );

    return () => clearTimeout(timer);
  }, [roomCode, roundId, phase, expired, onAdvanced]);
}
