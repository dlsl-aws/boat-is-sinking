"use client";

import { Button } from "@/app/components/ui";
import { BOAT_CODE_LENGTH, isValidCode, normalizeCode } from "@/lib/game/codes";

/**
 * The phone's presentational pieces.
 *
 * Shared with `/preview` so the design harness mounts the real components — in
 * particular the captain's code card, which is the hardest thing in the game to
 * get right and the one most worth being able to look at without standing up a
 * whole room first.
 */

/**
 * The captain's code.
 *
 * More a physical artifact than a UI element: it gets held above a head and read
 * from two or three metres by people who are moving. So it is enormous,
 * near-black on gold for maximum contrast, widely letterspaced so characters
 * don't blur together, and it shimmers to catch the eye in a room where thirty
 * other phones are already lit up.
 */
export function CodeCard({ code, compact = false }: { code: string; compact?: boolean }) {
  return (
    <div
      className={`relative mt-3 overflow-hidden rounded-3xl bg-gradient-to-b from-amber-300 to-amber-500 ${
        compact ? "px-5 py-3" : "px-6 py-7"
      } shadow-[0_10px_40px_rgba(255,201,77,0.45)]`}
    >
      <div className="shimmer pointer-events-none absolute inset-0" aria-hidden />
      <p
        className={`font-display relative font-bold tracking-[0.22em] text-slate-950 ${
          compact ? "text-4xl" : "text-7xl"
        }`}
      >
        {code}
      </p>
    </div>
  );
}

/** A draining bar plus the numeral — the bar is readable without focusing. */
export function TimeBar({
  remaining,
  total,
  urgent,
}: {
  remaining: number;
  total: number;
  urgent: boolean;
}) {
  const progress = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;
  return (
    <div>
      <p
        className={`font-display tabular text-6xl font-bold ${
          urgent ? "animate-alarm text-danger" : "text-foam"
        }`}
      >
        {remaining}
      </p>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full transition-[width] duration-300 ease-linear"
          style={{
            width: `${progress * 100}%`,
            background: urgent ? "var(--color-danger)" : "var(--color-beacon)",
            boxShadow: `0 0 14px ${urgent ? "#ff3b5c" : "#3aa8ff"}`,
          }}
        />
      </div>
    </div>
  );
}

export function CodeForm({
  entry,
  setEntry,
  onSubmit,
  disabled,
}: {
  entry: string;
  setEntry: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  disabled: boolean;
}) {
  const ready = isValidCode(entry, BOAT_CODE_LENGTH);
  const rejected = entry.length > 0 && !ready && entry.length === BOAT_CODE_LENGTH;
  return (
    <>
      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          value={entry}
          onChange={(event) =>
            setEntry(normalizeCode(event.target.value).slice(0, BOAT_CODE_LENGTH))
          }
          placeholder="CODE"
          aria-label="Lifeboat code"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="font-display min-w-0 flex-1 rounded-2xl border-2 border-white/15 bg-black/40 px-4 py-4 text-center text-4xl font-bold tracking-[0.3em] uppercase placeholder:text-base placeholder:font-normal placeholder:tracking-normal placeholder:text-muted focus:border-gold focus:outline-none"
        />
        <Button type="submit" variant={ready ? "safe" : "ghost"} disabled={disabled || !ready}>
          Board
        </Button>
      </form>
      {rejected && (
        <p className="mt-2 text-sm text-mist">
          Lifeboat codes never use O, I, L, S, B, Z, 0, 1, 2, 5 or 8 — check the
          card again.
        </p>
      )}
    </>
  );
}

