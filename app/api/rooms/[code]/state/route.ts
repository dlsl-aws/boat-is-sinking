import { NextResponse } from "next/server";
import { joinUrlFor, loadRoom, ok, resolveViewer } from "@/lib/api";
import { buildGameState, findRoomByCode } from "@/lib/db/state";
import { maybeResolveRound, promoteAutoCaptains } from "@/lib/db/rounds";
import { parseConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * The authoritative snapshot every surface reads.
 *
 * Also the engine's heartbeat. Vercel gives us no background worker, so the two
 * things that must happen on a timer — appointing a captain nobody volunteered
 * for, and resolving a round at its deadline — are driven opportunistically from
 * here. Both are idempotent and both guard on the database clock, so a room full
 * of clients hitting this at once still produces exactly one of each.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;

  try {
    return await readState(code);
  } catch (error) {
    // Most often a missing Supabase env var. Without this the three surfaces
    // would sit on "Loading…" forever, which is a miserable thing to debug ten
    // minutes before a session starts.
    const message = error instanceof Error ? error.message : "unknown error";
    console.error("[state]", error);
    return NextResponse.json({ error: "server-misconfigured", message }, { status: 503 });
  }
}

async function readState(code: string) {
  const loaded = await loadRoom(code);
  if ("response" in loaded) return loaded.response;

  let room = loaded.room;
  const config = parseConfig(room.config);

  if (room.current_round_id) {
    if (config.autoCaptainAfterSeconds >= 0) {
      await promoteAutoCaptains(room, room.current_round_id);
    }
    const resolved = await maybeResolveRound(room);
    if (resolved) {
      // Resolution changes room status and round phase, so re-read rather than
      // returning the snapshot we took before it ran.
      room = (await findRoomByCode(code)) ?? room;
    }
  }

  const viewer = await resolveViewer(room);
  const state = await buildGameState(room, viewer, joinUrlFor(room.code));

  return ok({ ...state, viewerRole: viewer.role });
}
