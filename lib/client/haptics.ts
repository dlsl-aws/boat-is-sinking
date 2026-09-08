"use client";

/**
 * Haptics.
 *
 * The player's phone is often not being looked at — it is in a hand, at the end
 * of an arm, while its owner scans a room for a person. A buzz is the only
 * channel that reaches them in that moment, so the important state changes
 * (a round starting, a seat claimed, going under) all have one.
 *
 * `navigator.vibrate` is unsupported on iOS Safari and can be disabled by the
 * user anywhere. Everything is therefore additive: no state is communicated by
 * vibration alone.
 */

type Pattern = "tap" | "success" | "fail" | "alert" | "doom";

const PATTERNS: Record<Pattern, number | number[]> = {
  tap: 12,
  // Two quick pulses read as "yes" far more clearly than one long one.
  success: [22, 45, 22],
  fail: [55, 40, 55],
  // A round is starting — the most important buzz in the game.
  alert: [14, 60, 14, 60, 90],
  // Eliminated. One long, heavy, final pulse.
  doom: 260,
};

export function buzz(pattern: Pattern): void {
  if (typeof navigator === "undefined" || !("vibrate" in navigator)) return;
  try {
    navigator.vibrate(PATTERNS[pattern]);
  } catch {
    // Some browsers throw when vibration is blocked by user settings.
  }
}
