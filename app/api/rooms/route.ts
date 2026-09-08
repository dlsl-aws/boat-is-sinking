import { z } from "zod";
import { fail, joinUrlFor, ok, readJson } from "@/lib/api";
import { hashToken, newToken, setHostToken } from "@/lib/auth";
import { roomConfigSchema } from "@/lib/config";
import { generateRoomCode } from "@/lib/game/codes";
import { db } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ config: roomConfigSchema.partial().optional() });

/**
 * Create a room and make the caller its host.
 *
 * The host token goes into an httpOnly cookie, which is what lets a facilitator
 * refresh the dashboard — or close the laptop lid — without losing control of a
 * running game.
 */
export async function POST(request: Request) {
  const body = bodySchema.safeParse((await readJson(request)) ?? {});
  if (!body.success) return fail("bad-request", 400);

  const config = roomConfigSchema.parse(body.data.config ?? {});
  const hostToken = newToken();
  const hostTokenHash = await hashToken(hostToken);

  // Codes are short enough to read off a projector, so a collision is possible.
  // Retry a few times rather than failing a facilitator standing in front of a
  // room; the unique index is what actually guarantees correctness.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateRoomCode();
    const { data, error } = await db()
      .from("rooms")
      .insert({ code, host_token_hash: hostTokenHash, config })
      .select("id, code")
      .single();

    if (!error && data) {
      await setHostToken(data.code as string, hostToken);
      return ok(
        {
          roomId: data.id as string,
          code: data.code as string,
          joinUrl: joinUrlFor(data.code as string),
        },
        201,
      );
    }

    // 23505 is unique_violation: a code collision. Anything else is real.
    if (error && error.code !== "23505") {
      return fail(`create-failed: ${error.message}`, 500);
    }
  }

  return fail("code-collision", 503);
}
