"use client";

import { useEffect, useRef } from "react";

/**
 * Celebration confetti.
 *
 * Canvas rather than DOM nodes: a few hundred animated elements will drop frames
 * on the kind of laptop that usually ends up driving a projector, and this runs
 * at the exact moment everyone is looking at the screen.
 *
 * Respects `prefers-reduced-motion` by simply not running — the win state is
 * fully communicated by the text and the trophy without it.
 */

type Piece = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rotation: number;
  spin: number;
  color: string;
};

const COLORS = ["#ffc94d", "#2ee6a8", "#3aa8ff", "#ff3b5c", "#eaf6ff", "#a78bfa"];

export function Confetti({ active, count = 160 }: { active: boolean; count?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!active) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const width = () => canvas.width / dpr;
    const height = () => canvas.height / dpr;

    // Two bursts from the lower corners, angled inward — reads as cannons
    // rather than as a uniform rain, which looks far more like a celebration.
    const pieces: Piece[] = Array.from({ length: count }, (_, i) => {
      const fromLeft = i % 2 === 0;
      const spread = (Math.random() - 0.5) * 0.9;
      const speed = 11 + Math.random() * 13;
      return {
        x: fromLeft ? -10 : width() + 10,
        y: height() * (0.72 + Math.random() * 0.2),
        vx: (fromLeft ? 1 : -1) * speed * (0.7 + Math.random() * 0.5),
        vy: -speed * (0.85 + Math.random() * 0.5) + spread * 4,
        size: 5 + Math.random() * 8,
        rotation: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.28,
        color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
      };
    });

    let frame = 0;
    let elapsed = 0;

    const tick = () => {
      elapsed += 1;
      context.clearRect(0, 0, width(), height());

      for (const piece of pieces) {
        piece.vy += 0.32;      // gravity
        piece.vx *= 0.992;     // drag
        piece.x += piece.vx;
        piece.y += piece.vy;
        piece.rotation += piece.spin;

        context.save();
        context.translate(piece.x, piece.y);
        context.rotate(piece.rotation);
        context.fillStyle = piece.color;
        // Scaling height by the spin phase fakes a flat ribbon tumbling in 3D.
        context.fillRect(
          -piece.size / 2,
          -piece.size / 2,
          piece.size,
          piece.size * Math.abs(Math.cos(piece.rotation)),
        );
        context.restore();
      }

      // ~8 seconds, then stop burning frames for the rest of the session.
      if (elapsed < 480) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, [active, count]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-50"
      aria-hidden
    />
  );
}
