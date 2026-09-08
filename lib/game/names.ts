/**
 * Display names.
 *
 * Names are load-bearing in this game rather than decorative: the projector
 * announces survivors and casualties by name, and a captain shouts for their
 * group. So names must be readable at distance, pronounceable, and unambiguous
 * within a room.
 */

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 20;

export type NameRejection =
  | "empty"
  | "too-short"
  | "too-long"
  | "profane"
  | "taken";

export type NameCheck =
  | { ok: true; name: string }
  | { ok: false; reason: NameRejection; message: string };

/**
 * Zero-width and bidirectional-control characters. These render as nothing but
 * still count toward length, so without stripping them a player could submit a
 * blank-looking name or smuggle characters that reorder the display.
 */
const INVISIBLE = /[\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

/** Collapse runs of whitespace so " A   B " and "A B" are the same name. */
export function normalizeName(input: string): string {
  return input
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Case- and accent-insensitive key used for the uniqueness check. */
export function nameKey(input: string): string {
  return normalizeName(input)
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

/**
 * Deliberately small and matched on whole words only.
 *
 * A substring filter causes the Scunthorpe problem — it rejects real names and
 * real places, which in a room of strangers is worse than the slur it blocked.
 * The admin has a rename override for anything that gets through, and that
 * human check is the actual backstop; this list only stops the lazy cases.
 */
const BLOCKED_WORDS = [
  "fuck", "shit", "cunt", "bitch", "bastard", "dick", "cock", "pussy",
  "nigger", "nigga", "faggot", "fag", "retard", "whore", "slut", "rape",
  "nazi", "hitler", "penis", "vagina", "wanker", "twat",
];

/** Leetspeak folded back to letters, so `f4gg0t` is caught alongside `faggot`. */
function deLeet(value: string): string {
  return value
    .replace(/[4@]/g, "a")
    .replace(/[3]/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/[0]/g, "o")
    .replace(/[5$]/g, "s")
    .replace(/[7]/g, "t");
}

export function isProfane(input: string): boolean {
  const folded = deLeet(nameKey(input));
  // Split on anything that isn't a letter so separators can't hide a word,
  // then match whole tokens only.
  const tokens = folded.split(/[^a-z]+/).filter(Boolean);
  return tokens.some((token) => BLOCKED_WORDS.includes(token));
}

/**
 * Validate a name for a room.
 *
 * `takenKeys` holds `nameKey` values already in use. Collision is reported
 * rather than auto-resolved with a suffix: two people called "Sam" is a genuine
 * failure at reveal time and while a captain is shouting, and asking the second
 * one to differentiate produces a name they actually answer to.
 */
export function checkName(
  input: string,
  takenKeys: ReadonlySet<string> = new Set(),
): NameCheck {
  const name = normalizeName(input);

  if (name.length === 0) {
    return { ok: false, reason: "empty", message: "Enter a name." };
  }
  if (name.length < NAME_MIN_LENGTH) {
    return {
      ok: false,
      reason: "too-short",
      message: `Use at least ${NAME_MIN_LENGTH} characters.`,
    };
  }
  if (name.length > NAME_MAX_LENGTH) {
    return {
      ok: false,
      reason: "too-long",
      message: `Keep it to ${NAME_MAX_LENGTH} characters or fewer.`,
    };
  }
  if (isProfane(name)) {
    return {
      ok: false,
      reason: "profane",
      message: "Pick something you'd want on the big screen.",
    };
  }
  if (takenKeys.has(nameKey(name))) {
    return {
      ok: false,
      reason: "taken",
      message: "Someone here already has that name — add an initial?",
    };
  }
  return { ok: true, name };
}
