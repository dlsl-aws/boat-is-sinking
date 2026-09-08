/**
 * Avatars are generated, not uploaded: nobody is going to pick a photo while
 * standing in a room waiting for a game to start.
 *
 * Colour is chosen from a fixed palette rather than a random hue so that every
 * avatar stays legible against the dark projector background, and so two
 * players are unlikely to look identical on the deck.
 */
export const AVATAR_COLORS = [
  "#f87171", "#fb923c", "#fbbf24", "#a3e635", "#34d399", "#22d3ee",
  "#60a5fa", "#a78bfa", "#f472b6", "#fb7185", "#4ade80", "#38bdf8",
] as const;

export const AVATAR_FACES = [
  "🐟", "🐬", "🦈", "🐙", "🦀", "🐢", "🐳", "🦑", "🦞", "🐧", "🦭", "🐡",
] as const;

export function randomAvatarSeed(): string {
  return Math.floor(Math.random() * AVATAR_FACES.length).toString();
}

export function randomAvatarColor(): string {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]!;
}

export function faceForSeed(seed: string): string {
  const n = Number.parseInt(seed, 10);
  return AVATAR_FACES[Number.isFinite(n) ? n % AVATAR_FACES.length : 0]!;
}
