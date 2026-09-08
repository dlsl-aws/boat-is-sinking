import "server-only";
import { NextResponse } from "next/server";
import { getHostToken, getPlayerToken, hashToken, type Viewer } from "./auth";
import { findRoomByCode } from "./db/state";
import { db } from "./supabase/server";
import { siteUrl } from "./env";

export type RoomRow = NonNullable<Awaited<ReturnType<typeof findRoomByCode>>>;

export const ok = <T,>(data: T, status = 200) => NextResponse.json(data, { status });

export const fail = (reason: string, status = 400, extra: object = {}) =>
  NextResponse.json({ error: reason, ...extra }, { status });

export function joinUrlFor(code: string): string {
  return `${siteUrl()}/join/${code.toUpperCase()}`;
}

/**
 * Work out who is asking.
 *
 * Host wins over player: a facilitator who also joined the game should still see
 * the dashboard. Anything with no recognised cookie is treated as the display —
 * the least privileged view, and the correct default for a projector that never
 * authenticates at all.
 */
export async function resolveViewer(room: RoomRow): Promise<Viewer> {
  const hostToken = await getHostToken(room.code);
  if (hostToken) {
    const { data } = await db()
      .from("rooms")
      .select("id")
      .eq("id", room.id)
      .eq("host_token_hash", await hashToken(hostToken))
      .maybeSingle();
    if (data) return { role: "host" };
  }

  const playerToken = await getPlayerToken(room.code);
  if (playerToken) {
    const { data } = await db()
      .from("players")
      .select("id")
      .eq("room_id", room.id)
      .eq("session_token_hash", await hashToken(playerToken))
      .maybeSingle();
    if (data) return { role: "player", playerId: data.id as string };
  }

  return { role: "display" };
}

/** Load a room or produce the 404, so every route reports it identically. */
export async function loadRoom(
  code: string,
): Promise<{ room: RoomRow } | { response: NextResponse }> {
  const room = await findRoomByCode(code);
  if (!room) return { response: fail("no-such-room", 404) };
  return { room };
}

/** Load a room and require the caller to hold its host token. */
export async function loadRoomAsHost(
  code: string,
): Promise<{ room: RoomRow } | { response: NextResponse }> {
  const loaded = await loadRoom(code);
  if ("response" in loaded) return loaded;

  const viewer = await resolveViewer(loaded.room);
  if (viewer.role !== "host") return { response: fail("not-the-host", 403) };

  return loaded;
}

/** Load a room and require a live player session in it. */
export async function loadRoomAsPlayer(
  code: string,
): Promise<{ room: RoomRow; playerId: string } | { response: NextResponse }> {
  const loaded = await loadRoom(code);
  if ("response" in loaded) return loaded;

  const playerToken = await getPlayerToken(loaded.room.code);
  if (!playerToken) return { response: fail("not-joined", 401) };

  const { data } = await db()
    .from("players")
    .select("id")
    .eq("room_id", loaded.room.id)
    .eq("session_token_hash", await hashToken(playerToken))
    .maybeSingle();

  if (!data) return { response: fail("not-joined", 401) };
  return { room: loaded.room, playerId: data.id as string };
}

/** Parse a JSON body, returning null rather than throwing on malformed input. */
export async function readJson<T = unknown>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
