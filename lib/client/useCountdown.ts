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
 * Ask the server to resolve a round once its deadline passes.
 *
 * Vercel has no background worker, so the deadline has to be noticed by a
 * client. Every open client fires this, and `begin_resolve` grants ownership to
 * exactly one of them — the redundancy is the point, because it means the round
 * still ends if any single browser is asleep.
 *
 * A short jittered delay keeps 40 phones from arriving in the same millisecond.
 */
export function useResolveOnDeadline(
  roomCode: string,
  roundId: string | null | undefined,
  phase: string | null | undefined,
  expired: boolean,
  onResolved: () => void,
) {
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!roundId || phase !== "scramble" || !expired) return;
    if (firedFor.current === roundId) return;
    firedFor.current = roundId;

    const timer = setTimeout(
      () => {
        void fetch(`/api/rounds/${roundId}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomCode }),
        })
          .then(onResolved)
          .catch(() => {
            // Another client will get there; the slow poll is the backstop.
          });
      },
      Math.random() * 400,
    );

    return () => clearTimeout(timer);
  }, [roomCode, roundId, phase, expired, onResolved]);
}
