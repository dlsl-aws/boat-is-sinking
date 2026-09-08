import { fail, loadRoomAsHost, ok, readJson } from "@/lib/api";
import { parseConfig, roomConfigSchema } from "@/lib/config";
import { broadcast } from "@/lib/realtime/broadcast";
import { db } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Update room config. Host only.
 *
 * Merged over the stored value rather than replacing it, so the dashboard can
 * send a single changed field without having to round-trip the whole object and
 * risk clobbering a setting changed from another tab.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const loaded = await loadRoomAsHost(code);
  if ("response" in loaded) return loaded.response;
  const { room } = loaded;

  const body = roomConfigSchema.partial().safeParse(await readJson(request));
  if (!body.success) return fail("bad-request", 400);

  const merged = roomConfigSchema.parse({ ...parseConfig(room.config), ...body.data });

  const { error } = await db()
    .from("rooms")
    .update({ config: merged })
    .eq("id", room.id);

  if (error) return fail(`config-failed: ${error.message}`, 500);

  await broadcast(room.id, { type: "room:updated" });
  return ok({ config: merged });
}
