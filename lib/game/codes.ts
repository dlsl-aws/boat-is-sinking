/**
 * Room codes and lifeboat codes.
 *
 * These get read off a projector at the back of a room and shouted across a
 * noisy one, so the alphabet drops every character pair that is easy to confuse
 * visually:
 *
 *   0/O   1/I/L   5/S   8/B   2/Z
 *
 * ...keeping 20 letters and 5 digits. 25^4 = 390,625 lifeboat codes, which is
 * far more than the <=24 boats ever live at once; the space exists to make a
 * lucky guess implausible, and `board` rate-limits on top of that.
 */
export const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679";

export const ROOM_CODE_LENGTH = 6;
export const BOAT_CODE_LENGTH = 4;

/**
 * Rejection sampling rather than `% alphabet.length`. Modulo would bias toward
 * the first `256 % 25` characters — irrelevant for fairness here, but this is
 * the same helper that generates session tokens, so it should be unbiased.
 */
function randomChars(length: number): string {
  const alphabet = CODE_ALPHABET;
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = "";
  const buf = new Uint8Array(length * 2);

  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (out.length === length) break;
      if (byte < limit) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

export function generateRoomCode(): string {
  return randomChars(ROOM_CODE_LENGTH);
}

export function generateBoatCode(): string {
  return randomChars(BOAT_CODE_LENGTH);
}

/**
 * Generate `count` codes guaranteed distinct from each other and from `exclude`.
 * Boats in one round must never share a code — a duplicate would let a player
 * board the wrong boat with a correct-looking code.
 */
export function generateDistinctBoatCodes(
  count: number,
  exclude: Iterable<string> = [],
): string[] {
  const seen = new Set<string>();
  for (const code of exclude) seen.add(code.toUpperCase());

  const out: string[] = [];
  while (out.length < count) {
    const code = generateBoatCode();
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * Fold what a player typed into canonical form: uppercase, and drop spaces,
 * dashes and anything else non-alphanumeric that someone might add for
 * readability.
 *
 * Deliberately does NOT try to repair excluded characters. The alphabet already
 * removed every confusable pair, so an `O` or a `1` in the input has no
 * unambiguous intended twin — `O` could equally be a misread `Q` or `D`.
 * Guessing could silently board a player onto the wrong boat with a
 * correct-looking code, which is far worse than asking them to retype. Invalid
 * characters therefore fail `isValidCode` and surface a clear error.
 */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isValidCode(input: string, length: number): boolean {
  if (input.length !== length) return false;
  for (const ch of input) {
    if (!CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}
