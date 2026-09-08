"use client";

import { useState } from "react";
import { Ocean } from "@/app/components/Ocean";
import { Confetti } from "@/app/components/Confetti";
import {
  Aftermath,
  Briefing,
  Lobby,
  PromptPhase,
  Scramble,
  Shell,
  Winners,
} from "@/app/components/display-views";
import { CodeCard, TimeBar } from "@/app/components/phone-views";
import { Panel, SeatPips, SymbolBadge, Button } from "@/app/components/ui";
import { DEFAULT_CONFIG } from "@/lib/config";
import { SYMBOLS } from "@/lib/game/symbols";
import type { ClientState } from "@/lib/client/useGameState";

/**
 * Design harness for the projector.
 *
 * Every phase of a game, on demand, against mock state — so the display can be
 * tuned without standing up a room of forty people first. It mounts the *same*
 * components the real projector uses, which is the point: there is no parallel
 * "design version" that can drift out of sync with what a room actually sees.
 *
 * Not linked from anywhere in the game. It costs one static route.
 */

const NAMES = [
  "Ada", "Bo", "Cleo", "Dev", "Emre", "Fay", "Gus", "Hana", "Iris", "Jai",
  "Kit", "Lena", "Mo", "Nia", "Otto", "Pia", "Quinn", "Rui", "Sam K", "Tao",
  "Uma", "Vik", "Wren", "Xu", "Yara", "Zed", "Anya", "Bram", "Cira", "Dane",
];

const PALETTE = ["#f87171", "#fb923c", "#fbbf24", "#a3e635", "#34d399", "#22d3ee", "#60a5fa", "#a78bfa"];

function mockPlayers(count: number, eliminatedFrom = count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    displayName: NAMES[i % NAMES.length]!,
    avatarSeed: String(i % 12),
    avatarColor: PALETTE[i % PALETTE.length]!,
    status: (i < eliminatedFrom ? "alive" : "eliminated") as "alive" | "eliminated",
    roundsSurvived: i < eliminatedFrom ? 3 : 1,
    eliminatedRound: i < eliminatedFrom ? null : 2,
  }));
}

function mockState(overrides: Partial<ClientState> = {}): ClientState {
  const players = mockPlayers(24);
  return {
    room: {
      id: "room-1",
      code: "K7QM94",
      status: "in_progress",
      config: DEFAULT_CONFIG,
      joinUrl: "https://boat-is-sinking.example.com/join/K7QM94",
    },
    round: {
      id: "round-1",
      roundIndex: 2,
      targetGroupSize: 4,
      phase: "scramble",
      startsAt: new Date(Date.now() - 20_000).toISOString(),
      endsAt: new Date(Date.now() + 25_000).toISOString(),
      promptEndsAt: new Date(Date.now() + 40_000).toISOString(),
      promptText: "Names first — then: one thing you'd grab before the ship went down.",
    },
    players,
    boats: SYMBOLS.slice(0, 5).map((symbol, i) => ({
      id: `b${i}`,
      symbolId: symbol.id,
      capacity: 4,
      filled: [4, 3, 1, 2, 0][i]!,
      locked: i === 0,
      captainName: i === 4 ? null : NAMES[i * 3]!,
      hasCaptain: i !== 4,
    })),
    counts: { joined: 24, alive: 20, eliminated: 4, seated: 10, seatsAvailable: 20 },
    self: null,
    admin: null,
    serverTime: new Date().toISOString(),
    viewerRole: "display",
    ...overrides,
  };
}

type Scene =
  | "phones"
  | "lobby"
  | "briefing"
  | "scramble-calm"
  | "scramble-urgent"
  | "aftermath"
  | "prompt"
  | "winners";

const SCENES: { id: Scene; label: string }[] = [
  { id: "phones", label: "📱 Phones" },
  { id: "lobby", label: "Lobby" },
  { id: "briefing", label: "Briefing" },
  { id: "scramble-calm", label: "Scramble" },
  { id: "scramble-urgent", label: "Scramble · final 10s" },
  { id: "aftermath", label: "Reveal" },
  { id: "prompt", label: "Icebreaker" },
  { id: "winners", label: "Winners" },
];

export default function PreviewPage() {
  const [scene, setScene] = useState<Scene>("scramble-calm");
  const serverNow = () => Date.now();

  const urgent = scene === "scramble-urgent";
  const remaining = urgent ? 6 : 28;
  const flood =
    scene === "scramble-urgent" ? 0.87 : scene === "scramble-calm" ? 0.38 : 0.08;

  const lobbyState = mockState({
    room: { ...mockState().room, status: "lobby" },
    players: mockPlayers(14),
    counts: { joined: 14, alive: 14, eliminated: 0, seated: 0, seatsAvailable: 0 },
    round: null,
  });

  const aftermathState = mockState({
    players: mockPlayers(20, 16),
    round: { ...mockState().round!, phase: "resolve" },
  });

  const winnersState = mockState({
    room: { ...mockState().room, status: "finished" },
    players: mockPlayers(20, 2),
    counts: { joined: 20, alive: 2, eliminated: 18, seated: 0, seatsAvailable: 0 },
    round: { ...mockState().round!, roundIndex: 6, phase: "done" },
  });

  return (
    <>
      <Ocean level={flood} urgent={urgent} />
      <Confetti active={scene === "winners"} />

      {/* Harness chrome. Deliberately small and out of the way — everything
          below it is exactly what a projector would render. */}
      <nav className="fixed top-0 right-0 left-0 z-50 flex flex-wrap items-center gap-1.5 border-b border-white/10 bg-black/70 px-3 py-2 backdrop-blur">
        <span className="font-display mr-2 text-xs tracking-[0.25em] text-muted">
          PROJECTOR PREVIEW
        </span>
        {SCENES.map((option) => (
          <button
            key={option.id}
            onClick={() => setScene(option.id)}
            className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
              scene === option.id
                ? "bg-white/20 font-semibold text-white"
                : "text-muted hover:text-white"
            }`}
          >
            {option.label}
          </button>
        ))}
      </nav>

      {scene === "phones" ? (
        <PhoneGallery />
      ) : (
      <div className="pt-10">
        <Shell>
          {scene === "lobby" && <Lobby state={lobbyState} />}
          {scene === "briefing" && <Briefing targetGroupSize={4} />}
          {(scene === "scramble-calm" || scene === "scramble-urgent") && (
            <Scramble
              state={mockState()}
              remainingSeconds={remaining}
              total={45}
              urgent={urgent}
              floodLevel={flood}
            />
          )}
          {scene === "aftermath" && <Aftermath state={aftermathState} />}
          {scene === "prompt" && <PromptPhase state={mockState()} serverNow={serverNow} />}
          {scene === "winners" && <Winners state={winnersState} />}
        </Shell>
      </div>
      )}
    </>
  );
}

/**
 * Every phone state at once, at roughly real handset width.
 *
 * Seeing them side by side is the only way to check the thing that actually
 * matters on a phone: that each state has exactly one obvious next action, and
 * that the important element is the biggest thing on the screen.
 */
function PhoneGallery() {
  const octopus = SYMBOLS[0]!;

  return (
    <div className="relative z-10 flex flex-wrap items-start justify-center gap-6 p-6 pt-16">
      <Phone label="Scramble · no captain yet" tint={octopus.color}>
        <div className="flex items-center justify-between">
          <p className="font-display text-xs tracking-[0.3em] text-danger">BOAT SINKING</p>
          <p className="font-display text-xs tracking-[0.3em] text-mist">GROUPS OF 4</p>
        </div>
        <div className="my-6">
          <SymbolBadge symbolId={octopus.id} size="hero" glow />
        </div>
        <TimeBar remaining={28} total={45} urgent={false} />
        <div className="mt-7">
          <Button variant="gold" size="lg" className="animate-attention w-full">
            ⚓ I&apos;m the Captain
          </Button>
          <p className="my-3 text-sm text-muted">…or wait for someone else to claim it</p>
        </div>
      </Phone>

      <Phone label="Scramble · you are the captain" tint={octopus.color}>
        <div className="my-4">
          <SymbolBadge symbolId={octopus.id} size="xl" glow />
        </div>
        <TimeBar remaining={22} total={45} urgent={false} />
        <div className="mt-6">
          <p className="font-display text-lg font-semibold text-gold">⚓ You&apos;re the captain</p>
          <CodeCard code="K7QM" />
          <p className="mt-3 text-sm text-mist">Hold your phone up. Shout it. Don&apos;t move.</p>
        </div>
      </Phone>

      <Phone label="Scramble · find your captain" tint={octopus.color}>
        <div className="my-4">
          <SymbolBadge symbolId={octopus.id} size="xl" glow />
        </div>
        <TimeBar remaining={9} total={45} urgent />
        <div className="mt-6">
          <Panel tone="warn" className="mb-4">
            <p className="text-sm text-mist">Your captain is</p>
            <p className="font-display text-3xl font-bold text-gold">Sam K</p>
            <p className="mt-1 text-sm text-mist">Find them and get the code</p>
          </Panel>
          <p className="font-display animate-shake font-bold text-danger">
            Wrong boat! You&apos;re 🐙 Octopus.
          </p>
        </div>
      </Phone>

      <Phone label="Aboard · boat full">
        <p className="font-display text-sm tracking-[0.35em] text-safe">LIFEBOAT FULL</p>
        <div className="my-5 text-8xl">🎉</div>
        <SymbolBadge symbolId={octopus.id} size="lg" />
        <div className="mt-6">
          <SeatPips filled={4} capacity={4} color={octopus.color} size={18} />
          <p className="font-display mt-3 text-lg text-mist">4 of 4 seats</p>
        </div>
        <p className="font-display tabular mt-8 text-5xl font-bold text-mist">14s</p>
      </Phone>

      <Phone label="Icebreaker">
        <p className="font-display text-sm tracking-[0.35em] text-safe">SAFE — FOR NOW</p>
        <div className="my-6 text-7xl">💬</div>
        <Panel tone="safe">
          <p className="font-display text-2xl leading-snug font-semibold text-balance">
            Names first — then: one thing you&apos;d grab before the ship went down.
          </p>
        </Panel>
        <p className="font-display tabular mt-8 text-5xl font-bold text-muted">38</p>
      </Phone>

      <Phone label="Eliminated">
        <div className="animate-bob text-8xl">🌊</div>
        <h1 className="font-display mt-6 text-4xl font-bold">Glub glub.</h1>
        <p className="mt-2 text-mist">
          Overboard after 3 rounds. Heckle from the water.
        </p>
        <Panel className="mt-8 text-left">
          <p className="mb-1 text-xs tracking-[0.25em] text-muted">
            THE SURVIVORS ARE ANSWERING
          </p>
          <p className="font-display text-lg font-semibold">
            Names first — then: your very first job.
          </p>
        </Panel>
      </Phone>
    </div>
  );
}

function Phone({
  label,
  tint,
  children,
}: {
  label: string;
  tint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-2 text-center text-xs tracking-[0.2em] text-muted uppercase">{label}</p>
      <div className="relative w-[340px] overflow-hidden rounded-[2.2rem] border-4 border-white/15 bg-abyss p-5 shadow-2xl">
        {tint && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background: `radial-gradient(ellipse 120% 70% at 50% 22%, ${tint}55 0%, ${tint}18 45%, transparent 72%)`,
            }}
          />
        )}
        <div className="relative min-h-[560px] text-center">{children}</div>
      </div>
    </div>
  );
}
