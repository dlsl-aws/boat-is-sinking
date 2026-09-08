import "server-only";
import { supabaseServiceKey, supabaseUrl } from "../env";
import { BROADCAST_EVENT, roomChannel, type GameEvent } from "./events";

/**
 * Broadcast an event to a room from the server.
 *
 * Uses Supabase's HTTP broadcast endpoint rather than opening a WebSocket. A
 * serverless function lives for milliseconds; making it connect a socket, send,
 * and tear down would add latency and a failure mode for no benefit. One POST
 * fans out to every subscriber.
 *
 * Never throws. A failed broadcast means some clients refresh a beat later —
 * every client also refetches authoritative state on reconnect and on
 * visibility change, so a lost notification degrades latency, never
 * correctness. Failing the caller's write because a notification did not send
 * would be strictly worse.
 */
export async function broadcast(roomId: string, event: GameEvent): Promise<void> {
  try {
    const response = await fetch(`${supabaseUrl()}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseServiceKey(),
        Authorization: `Bearer ${supabaseServiceKey()}`,
      },
      body: JSON.stringify({
        messages: [
          {
            topic: roomChannel(roomId),
            event: BROADCAST_EVENT,
            payload: event,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.warn(
        `[broadcast] ${event.type} -> ${response.status} ${await response.text()}`,
      );
    }
  } catch (error) {
    console.warn(`[broadcast] ${event.type} failed`, error);
  }
}

/** Fire several events in one request. */
export async function broadcastAll(
  roomId: string,
  events: readonly GameEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await Promise.all(events.map((event) => broadcast(roomId, event)));
}
