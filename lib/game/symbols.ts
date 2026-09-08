/**
 * The symbol pool. Each round, every alive player is given one of these and has
 * to physically find the other people holding it.
 *
 * Three independent channels carry the identity — emoji, name, and colour — so
 * the symbol is never distinguishable by colour alone. That matters for
 * colourblind players and for washed-out projectors, where two "similar" colours
 * become the same colour.
 */
export type GameSymbol = {
  /** Stable key stored in the database. Never change these. */
  id: string;
  emoji: string;
  /** Shouted across the room, so: short and phonetically distinct. */
  name: string;
  /** Hex, tuned for white text on a dark projector background. */
  color: string;
};

export const SYMBOLS: readonly GameSymbol[] = [
  { id: "octopus", emoji: "🐙", name: "Octopus", color: "#a855f7" },
  { id: "anchor", emoji: "⚓", name: "Anchor", color: "#ef4444" },
  { id: "whale", emoji: "🐳", name: "Whale", color: "#3b82f6" },
  { id: "crab", emoji: "🦀", name: "Crab", color: "#f97316" },
  { id: "shark", emoji: "🦈", name: "Shark", color: "#64748b" },
  { id: "turtle", emoji: "🐢", name: "Turtle", color: "#22c55e" },
  { id: "starfish", emoji: "⭐", name: "Star", color: "#eab308" },
  { id: "dolphin", emoji: "🐬", name: "Dolphin", color: "#06b6d4" },
  { id: "penguin", emoji: "🐧", name: "Penguin", color: "#e2e8f0" },
  { id: "shell", emoji: "🐚", name: "Shell", color: "#f472b6" },
  { id: "lighthouse", emoji: "🗼", name: "Beacon", color: "#fb923c" },
  { id: "compass", emoji: "🧭", name: "Compass", color: "#14b8a6" },
  { id: "wave", emoji: "🌊", name: "Wave", color: "#0ea5e9" },
  { id: "fish", emoji: "🐠", name: "Fish", color: "#f59e0b" },
  { id: "jellyfish", emoji: "🎐", name: "Jelly", color: "#c084fc" },
  { id: "seahorse", emoji: "🦄", name: "Seahorse", color: "#ec4899" },
  { id: "squid", emoji: "🦑", name: "Squid", color: "#8b5cf6" },
  { id: "lobster", emoji: "🦞", name: "Lobster", color: "#dc2626" },
  { id: "shrimp", emoji: "🦐", name: "Shrimp", color: "#fda4af" },
  { id: "coral", emoji: "🪸", name: "Coral", color: "#fb7185" },
  { id: "seal", emoji: "🦭", name: "Seal", color: "#94a3b8" },
  { id: "pufferfish", emoji: "🐡", name: "Puffer", color: "#facc15" },
  { id: "sailboat", emoji: "⛵", name: "Sailboat", color: "#4ade80" },
  { id: "buoy", emoji: "🛟", name: "Buoy", color: "#f43f5e" },
  { id: "trident", emoji: "🔱", name: "Trident", color: "#818cf8" },
  { id: "island", emoji: "🏝️", name: "Island", color: "#34d399" },
  { id: "bottle", emoji: "🍾", name: "Bottle", color: "#65a30d" },
  { id: "helm", emoji: "☸️", name: "Helm", color: "#a3e635" },
  { id: "treasure", emoji: "💎", name: "Treasure", color: "#38bdf8" },
  { id: "map", emoji: "🗺️", name: "Map", color: "#d97706" },
  { id: "gull", emoji: "🕊️", name: "Gull", color: "#cbd5e1" },
  { id: "kraken", emoji: "🐉", name: "Kraken", color: "#16a34a" },
] as const;

/**
 * Hard ceiling on boats per round, set by the size of the pool above.
 *
 * Only binding at small group sizes: 32 boats covers 64 players at N=2, well
 * past the ~40 this is built for. `boatCount` clamps to it rather than throwing
 * so an oversized room degrades into a harder round instead of a crash — but
 * `isBoatCountClamped` lets the admin dashboard warn that the round will
 * eliminate more players than the group size alone implies.
 */
export const MAX_BOATS = SYMBOLS.length;

const BY_ID = new Map(SYMBOLS.map((s) => [s.id, s]));

export function getSymbol(id: string): GameSymbol | undefined {
  return BY_ID.get(id);
}

/**
 * Symbols for a round.
 *
 * `offset` rotates the starting point so consecutive rounds don't reuse the same
 * few symbols. Players start to associate "I was an Octopus last round" with an
 * outcome, and rotating keeps each round feeling fresh.
 */
export function pickSymbols(count: number, offset = 0): GameSymbol[] {
  if (count < 0) throw new RangeError(`count must be >= 0, got ${count}`);
  if (count > MAX_BOATS) {
    throw new RangeError(`need ${count} symbols but only ${MAX_BOATS} exist`);
  }
  const out: GameSymbol[] = [];
  for (let i = 0; i < count; i++) {
    // Non-null: index is taken mod SYMBOLS.length, and count <= MAX_BOATS.
    out.push(SYMBOLS[(offset + i) % SYMBOLS.length]!);
  }
  return out;
}
