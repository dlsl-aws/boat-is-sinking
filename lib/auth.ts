import "server-only";
import { cookies } from "next/headers";

/**
 * Identity for a game that has no accounts.
 *
 * Two kinds of bearer token, both stored as httpOnly cookies and persisted only
 * as SHA-256 hashes. Hashing matters less for secrecy than for blast radius: a
 * leaked database dump of a finished icebreaker should not hand anyone a live
 * session.
 *
 * Cookies are scoped per room code, so one browser can host one room and play
 * in another — which is exactly what happens when a facilitator tests the game
 * on their own phone, and during local development.
 */

const TOKEN_BYTES = 32;

export function newToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest).toString("hex");
}

const hostCookie = (code: string) => `bis_host_${code.toUpperCase()}`;
const playerCookie = (code: string) => `bis_player_${code.toUpperCase()}`;

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  // A session outlasts the game but not the day; nothing here is worth keeping.
  maxAge: 60 * 60 * 12,
  secure: process.env.NODE_ENV === "production",
} as const;

export async function setHostToken(code: string, token: string): Promise<void> {
  (await cookies()).set(hostCookie(code), token, COOKIE_OPTIONS);
}

export async function getHostToken(code: string): Promise<string | null> {
  return (await cookies()).get(hostCookie(code))?.value ?? null;
}

export async function setPlayerToken(code: string, token: string): Promise<void> {
  (await cookies()).set(playerCookie(code), token, COOKIE_OPTIONS);
}

export async function getPlayerToken(code: string): Promise<string | null> {
  return (await cookies()).get(playerCookie(code))?.value ?? null;
}

export async function clearPlayerToken(code: string): Promise<void> {
  (await cookies()).delete(playerCookie(code));
}

/** Who is asking, which decides how much of the game state they get to see. */
/**
 * Role decides privileges; `playerId` decides identity. They are independent,
 * because a facilitator can host a room AND play in it — testing on their own
 * phone, or running a small session they are also part of. Collapsing the two
 * is what previously left such a host with no identity at all, so their phone
 * showed the join screen forever however many times they joined.
 */
export type Viewer =
  | { role: "host"; playerId: string | null }
  | { role: "player"; playerId: string }
  | { role: "display" };
