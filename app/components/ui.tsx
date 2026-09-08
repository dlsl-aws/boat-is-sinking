"use client";

import { faceForSeed } from "@/lib/game/avatar";
import { getSymbol } from "@/lib/game/symbols";

/* ==========================================================================
   Shared vocabulary across all three surfaces.
   ========================================================================== */

export function Button({
  children,
  onClick,
  variant = "primary",
  size = "md",
  disabled,
  type = "button",
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger" | "gold" | "safe";
  size?: "sm" | "md" | "lg" | "hero";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  // A hard bottom shadow rather than a blur: it reads as a physical, pressable
  // slab, and the press state removes it so the button visibly travels.
  const variants = {
    primary: "bg-sky-500 text-white shadow-[0_5px_0_0_#0b5c9e]",
    gold: "bg-amber-400 text-slate-950 shadow-[0_5px_0_0_#a1730a]",
    safe: "bg-emerald-400 text-slate-950 shadow-[0_5px_0_0_#0b7a58]",
    danger: "bg-rose-500 text-white shadow-[0_5px_0_0_#8d1230]",
    ghost: "bg-white/[0.07] text-foam border border-white/15 shadow-none",
  }[variant];

  const sizes = {
    sm: "px-3.5 py-2 text-sm rounded-lg",
    md: "px-5 py-3 rounded-xl",
    lg: "px-7 py-4 text-lg rounded-2xl",
    hero: "px-8 py-6 text-2xl rounded-3xl",
  }[size];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`font-display font-semibold transition-all duration-100 active:translate-y-[5px] active:shadow-none disabled:cursor-not-allowed disabled:opacity-35 disabled:shadow-none ${variants} ${sizes} ${className}`}
    >
      {children}
    </button>
  );
}

export function Avatar({
  seed,
  color,
  size = 40,
  dimmed = false,
}: {
  seed: string;
  color: string;
  size?: number;
  dimmed?: boolean;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full ring-2 ring-black/25 transition-opacity"
      style={{
        width: size,
        height: size,
        background: color,
        fontSize: size * 0.55,
        opacity: dimmed ? 0.6 : 1,
        boxShadow: dimmed ? "none" : `0 0 ${size * 0.4}px ${color}55`,
      }}
      aria-hidden
    >
      {faceForSeed(seed)}
    </span>
  );
}

/**
 * A symbol.
 *
 * Emoji, name AND colour always travel together. "I'm the purple one" fails the
 * moment two colours look alike on a washed-out projector or to a colourblind
 * player, so the name is never optional — colour is decoration on top of two
 * channels that already work without it.
 *
 * At `hero` size this is the entire phone screen: the one thing a player needs
 * to read in the half-second before they start moving.
 */
export function SymbolBadge({
  symbolId,
  size = "md",
  glow = false,
}: {
  symbolId: string;
  size?: "sm" | "md" | "lg" | "xl" | "hero" | "screen";
  glow?: boolean;
}) {
  const symbol = getSymbol(symbolId);
  if (!symbol) return null;

  const scale = {
    sm: { emoji: "text-2xl", label: "text-[0.65rem]", gap: "gap-0.5" },
    md: { emoji: "text-5xl", label: "text-sm", gap: "gap-1" },
    lg: { emoji: "text-7xl", label: "text-xl", gap: "gap-2" },
    xl: { emoji: "text-[7rem] leading-none", label: "text-2xl", gap: "gap-3" },
    hero: { emoji: "text-[9.5rem] leading-none", label: "text-4xl", gap: "gap-4" },
    // Viewport-relative, for the projector: scales with the screen it is thrown
    // onto rather than staying a fixed pixel size.
    screen: { emoji: "text-[3.4vw] leading-none", label: "text-[1vw]", gap: "gap-[0.4vw]" },
  }[size];

  return (
    <div className={`flex flex-col items-center ${scale.gap}`}>
      <span
        className={`${scale.emoji} ${glow ? "animate-bob" : ""}`}
        style={
          glow
            ? { filter: `drop-shadow(0 0 42px ${symbol.color}) drop-shadow(0 0 90px ${symbol.color}66)` }
            : undefined
        }
        aria-hidden
      >
        {symbol.emoji}
      </span>
      <span
        className={`font-display font-bold tracking-[0.16em] uppercase ${scale.label}`}
        style={{ color: symbol.color }}
      >
        {symbol.name}
      </span>
    </div>
  );
}

/**
 * Seats on a lifeboat.
 *
 * Discrete pips rather than a progress bar: "two seats left" is a countable
 * quantity a player acts on, and a bar makes you do arithmetic. They read
 * correctly at a glance from the back of a room.
 */
export function SeatPips({
  filled,
  capacity,
  color,
  size = 12,
}: {
  filled: number;
  capacity: number;
  color?: string;
  size?: number;
}) {
  return (
    <div
      className="flex flex-wrap justify-center gap-1.5"
      role="img"
      aria-label={`${filled} of ${capacity} seats taken`}
    >
      {Array.from({ length: capacity }, (_, i) => {
        const taken = i < filled;
        return (
          <span
            key={i}
            className="rounded-full transition-all duration-300"
            style={{
              width: size,
              height: size,
              background: taken ? (color ?? "#2ee6a8") : "transparent",
              border: taken ? "none" : "2px solid rgba(255,255,255,0.22)",
              boxShadow: taken ? `0 0 ${size}px ${color ?? "#2ee6a8"}aa` : "none",
              transform: taken ? "scale(1)" : "scale(0.82)",
            }}
          />
        );
      })}
    </div>
  );
}

export function Panel({
  children,
  className = "",
  tone = "default",
}: {
  children: React.ReactNode;
  className?: string;
  tone?: "default" | "safe" | "warn" | "danger";
}) {
  const tones = {
    default: "border-white/10 bg-white/[0.045]",
    safe: "border-emerald-400/40 bg-emerald-400/[0.08]",
    warn: "border-amber-400/45 bg-amber-400/[0.08]",
    danger: "border-rose-500/40 bg-rose-500/[0.08]",
  }[tone];

  return (
    <div
      className={`relative rounded-2xl border p-4 backdrop-blur-sm ${tones} ${className}`}
    >
      {children}
    </div>
  );
}

export function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span
        className={`h-2 w-2 rounded-full ${
          connected ? "bg-emerald-400 shadow-[0_0_8px_#2ee6a8]" : "animate-pulse bg-amber-400"
        }`}
      />
      {connected ? "live" : "reconnecting"}
    </span>
  );
}

/**
 * The countdown, as a ring.
 *
 * On the projector the numeral alone is not enough: a ring draining is readable
 * peripherally, so people keep their heads up and moving instead of staring at
 * the wall waiting for a number to change.
 */
export function TimerRing({
  remaining,
  total,
  urgent,
  size = 260,
  children,
}: {
  remaining: number;
  total: number;
  urgent: boolean;
  size?: number;
  children: React.ReactNode;
}) {
  const stroke = size * 0.055;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(1, Math.max(0, total > 0 ? remaining / total : 0));

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.09)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={urgent ? "#ff3b5c" : "#3aa8ff"}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          style={{
            transition: "stroke-dashoffset 0.25s linear, stroke 0.4s ease",
            filter: `drop-shadow(0 0 ${urgent ? 22 : 12}px ${urgent ? "#ff3b5c" : "#3aa8ff"})`,
          }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

/**
 * One lifeboat, shared by the projector and the dashboard.
 *
 * Three states, each carried by border colour, fill, an icon AND a word — never
 * colour alone: amber means nobody has volunteered to captain it (the
 * facilitator's cue to shout), green means it is full, plain means it is filling.
 */
export function BoatCard({
  symbolId,
  filled,
  capacity,
  locked,
  hasCaptain,
  captainName,
  code,
  footer,
  compact = false,
}: {
  symbolId: string;
  filled: number;
  capacity: number;
  locked: boolean;
  hasCaptain: boolean;
  captainName: string | null;
  /** Host-only. Never rendered on the projector — see lib/db/state.ts. */
  code?: string;
  footer?: React.ReactNode;
  compact?: boolean;
}) {
  const symbol = getSymbol(symbolId);
  const state = locked ? "locked" : hasCaptain ? "filling" : "no-captain";

  const shell = {
    locked: "border-emerald-400/60 bg-emerald-400/[0.11] animate-glow-safe",
    filling: "border-white/12 bg-white/[0.05]",
    "no-captain": "border-amber-400/60 bg-amber-400/[0.09] animate-attention",
  }[state];

  return (
    <div
      className={`relative flex h-full flex-col items-center justify-center overflow-hidden rounded-2xl border p-3 text-center transition-colors duration-300 ${shell}`}
    >
      {locked && (
        <span className="absolute top-2 right-2 text-lg" aria-hidden>
          ✅
        </span>
      )}

      <SymbolBadge symbolId={symbolId} size={compact ? "sm" : "screen"} />

      {code && (
        <p className="font-display mt-2 text-2xl font-bold tracking-[0.25em] text-gold">
          {code}
        </p>
      )}

      <div className="mt-2.5">
        <SeatPips
          filled={filled}
          capacity={capacity}
          color={symbol?.color}
          size={compact ? 9 : 13}
        />
      </div>

      <p
        className={`mt-2 font-semibold ${compact ? "text-xs" : "text-[0.95vw]"} ${
          state === "no-captain"
            ? "text-gold"
            : state === "locked"
              ? "text-safe"
              : "text-muted"
        }`}
      >
        {locked
          ? "FULL"
          : hasCaptain
            ? `⚓ ${captainName}`
            : "⚠ needs a captain"}
      </p>

      {footer}
    </div>
  );
}
