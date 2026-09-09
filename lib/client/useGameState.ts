"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { realtimeClient } from "../supabase/client";
import {
  BROADCAST_EVENT,
  REFETCH_EVENTS,
  parseGameEvent,
  roomChannel,
  type GameEvent,
} from "../realtime/events";
import type { GameState } from "../db/state";

export type ClientState = GameState & { viewerRole: "host" | "player" | "display" };

/**
 * Subscribe a surface to a room.
 *
 * The contract that keeps this stable at a live event: realtime is a
 * notification layer, never a source of truth. Phase changes trigger a refetch
 * of the authoritative snapshot; only the high-frequency, display-safe
 * `boat:progress` event is applied locally, and even that is idempotent. A
 * dropped or duplicated message can therefore never corrupt what is on screen.
 *
 * It also refetches on reconnect and whenever the tab becomes visible again,
 * which is what makes a phone that was locked mid-round recover correctly.
 */
export function useGameState(code: string) {
  const [state, setState] = useState<ClientState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  /** Server clock minus local clock, in ms. Drives every countdown. */
  const clockOffset = useRef(0);
  const inFlight = useRef(false);
  const pending = useRef(false);

  const refetch = useCallback(async () => {
    // Collapse overlapping refetches. Several events often land together at a
    // phase change, and 40 phones each firing a burst is real load.
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const sentAt = Date.now();
      const response = await fetch(`/api/rooms/${code}/state`, { cache: "no-store" });
      if (!response.ok) {
        if (response.status === 404) {
          setError("no-such-room");
        } else {
          const body = (await response.json().catch(() => null)) as
            | { message?: string }
            | null;
          setError(body?.message ?? "fetch-failed");
        }
        return;
      }
      const data = (await response.json()) as ClientState;
      const roundTrip = Date.now() - sentAt;
      clockOffset.current =
        new Date(data.serverTime).getTime() + roundTrip / 2 - Date.now();
      setState(data);
      setError(null);
    } catch {
      setError("offline");
    } finally {
      inFlight.current = false;
      if (pending.current) {
        pending.current = false;
        void refetch();
      }
    }
  }, [code]);

  const applyEvent = useCallback(
    (event: GameEvent) => {
      if (REFETCH_EVENTS.has(event.type)) {
        void refetch();
        return;
      }

      setState((current) => {
        if (!current) return current;

        switch (event.type) {
          case "boat:progress":
            return {
              ...current,
              boats: current.boats.map((boat) =>
                boat.id === event.boatId
                  ? { ...boat, filled: event.filled, locked: event.locked }
                  : boat,
              ),
            };

          case "player:joined": {
            if (current.players.some((p) => p.id === event.playerId)) return current;
            return {
              ...current,
              players: [
                ...current.players,
                {
                  id: event.playerId,
                  displayName: event.displayName,
                  avatarSeed: event.avatarSeed,
                  avatarColor: event.avatarColor,
                  status:
                    current.room.status === "lobby"
                      ? ("alive" as const)
                      : ("spectator" as const),
                  roundsSurvived: 0,
                  eliminatedRound: null,
                },
              ],
              counts: {
                ...current.counts,
                joined: current.counts.joined + 1,
                // A mid-game joiner is waiting, not playing. Counting them as
                // alive made the projector overstate the room until the next
                // refetch.
                ...(current.room.status === "lobby"
                  ? { alive: current.counts.alive + 1 }
                  : { waiting: current.counts.waiting + 1 }),
              },
            };
          }

          case "player:renamed":
            return {
              ...current,
              players: current.players.map((p) =>
                p.id === event.playerId ? { ...p, displayName: event.displayName } : p,
              ),
            };

          case "player:left":
            return {
              ...current,
              players: current.players.filter((p) => p.id !== event.playerId),
            };

          default:
            return current;
        }
      });
    },
    [refetch],
  );

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const roomId = state?.room.id;

  useEffect(() => {
    if (!roomId) return;

    const client = realtimeClient();
    const channel = client
      .channel(roomChannel(roomId))
      .on("broadcast", { event: BROADCAST_EVENT }, ({ payload }) => {
        const event = parseGameEvent(payload);
        if (event) applyEvent(event);
      })
      .subscribe((status) => {
        const live = status === "SUBSCRIBED";
        setConnected(live);
        // Anything could have changed while the socket was down.
        if (live) void refetch();
      });

    return () => {
      void client.removeChannel(channel);
    };
  }, [roomId, applyEvent, refetch]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [refetch]);

  /**
   * A slow safety net. Everything above is event-driven, but a room that has
   * silently lost its socket must still make progress — and this is also what
   * drives the lazy round resolution and auto-captain promotion that the state
   * endpoint performs.
   */
  useEffect(() => {
    const phase = state?.round?.phase;
    const interval = phase === "scramble" ? 5_000 : 15_000;
    const timer = setInterval(() => void refetch(), interval);
    return () => clearInterval(timer);
  }, [refetch, state?.round?.phase]);

  const serverNow = useCallback(() => Date.now() + clockOffset.current, []);

  return { state, error, connected, refetch, serverNow };
}
