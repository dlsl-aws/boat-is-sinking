"use client";

/**
 * The rising sea.
 *
 * This is the signature element of the projector view and it carries real
 * information, not just atmosphere: the water level *is* the countdown. Someone
 * at the back of the room who cannot read the digits can still see how much time
 * is left, and a room that can read the clock without looking at the clock keeps
 * its head up and keeps moving.
 *
 * Three wave layers drift at different speeds and opacities. The parallax is
 * what stops it reading as a flat coloured rectangle — each layer is a single
 * seamless SVG path, tiled twice and translated by exactly half its width, so
 * the loop has no visible seam.
 */

const WAVE_PATH =
  "M0,32 C120,64 240,0 360,32 C480,64 600,0 720,32 C840,64 960,0 1080,32 C1200,64 1320,0 1440,32 L1440,120 L0,120 Z";

function WaveLayer({
  color,
  opacity,
  duration,
  height,
  offset,
}: {
  color: string;
  opacity: number;
  duration: number;
  height: number;
  offset: string;
}) {
  return (
    <div
      className="absolute inset-x-0"
      style={{ bottom: offset, height, opacity }}
      aria-hidden
    >
      <div
        className="flex h-full w-[200%]"
        style={{ animation: `drift ${duration}s linear infinite` }}
      >
        {[0, 1].map((i) => (
          <svg
            key={i}
            viewBox="0 0 1440 120"
            preserveAspectRatio="none"
            className="h-full w-1/2 shrink-0"
          >
            <path d={WAVE_PATH} fill={color} />
          </svg>
        ))}
      </div>
    </div>
  );
}

/**
 * @param level How high the water sits, 0 (calm) to 1 (deck awash).
 * @param urgent Switches the sea from blue to a warning red near the deadline.
 */
export function Ocean({
  level = 0.12,
  urgent = false,
}: {
  level?: number;
  urgent?: boolean;
}) {
  const clamped = Math.min(1, Math.max(0, level));
  // Eased so the last few seconds surge rather than creeping linearly — the
  // water accelerating is what sells the panic.
  //
  // Capped at 42% rather than swallowing the screen: past roughly this point
  // the crest line starts slicing through the boat grid, and a hard band across
  // the content reads as a rendering glitch rather than as a sea. Drama is
  // worth a lot; legibility on a projector is worth more.
  const height = `${7 + clamped ** 1.6 * 35}%`;

  const body = urgent
    ? "linear-gradient(180deg, rgba(255,59,92,0.30) 0%, rgba(120,10,35,0.55) 100%)"
    : "linear-gradient(180deg, rgba(58,168,255,0.26) 0%, rgba(4,30,55,0.6) 100%)";

  const crest = urgent ? "#ff3b5c" : "#3aa8ff";

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-0 overflow-hidden transition-[height] duration-1000 ease-linear"
      style={{ height }}
      aria-hidden
    >
      <div className="absolute inset-0" style={{ background: body }} />
      {/* Softens the top edge so the water fades into the page instead of
          meeting it at a hard line. */}
      <div
        className="absolute inset-x-0 top-0 h-24"
        style={{
          background: `linear-gradient(180deg, transparent 0%, ${
            urgent ? "rgba(255,59,92,0.12)" : "rgba(58,168,255,0.10)"
          } 100%)`,
        }}
      />

      {/* Back to front: slower, dimmer, taller layers sit furthest away. */}
      <WaveLayer color={crest} opacity={0.14} duration={19} height={90} offset="88%" />
      <WaveLayer color={crest} opacity={0.2} duration={13} height={70} offset="92%" />
      <WaveLayer color={crest} opacity={0.32} duration={8} height={54} offset="96%" />
    </div>
  );
}

/**
 * A ship that lists further as the water rises, and finally goes under.
 *
 * Purely emotional — it tells the room nothing the countdown doesn't. It earns
 * its place because a listing ship is instantly legible to someone who has just
 * walked in, and because watching it tip is funny.
 */
export function SinkingShip({ level = 0 }: { level?: number }) {
  const clamped = Math.min(1, Math.max(0, level));
  return (
    <div
      className="transition-transform duration-1000 ease-linear"
      style={{
        transform: `rotate(${clamped * 26}deg) translateY(${clamped * 28}px)`,
      }}
      aria-hidden
    >
      <span className="block text-[8vw] leading-none">🚢</span>
    </div>
  );
}
