"use client";

import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import {
  Avatar,
  Button,
  ConnectionDot,
  Panel,
  SeatPips,
  SymbolBadge,
} from "@/app/components/ui";
import { Confetti } from "@/app/components/Confetti";
import { CodeCard, CodeForm, TimeBar } from "@/app/components/phone-views";
import { useGameState } from "@/lib/client/useGameState";
import { useCountdown, useResolveOnDeadline } from "@/lib/client/useCountdown";
import { useCountdownTicks, useGameFeedback } from "@/lib/client/useGameFeedback";
import { getSymbol } from "@/lib/game/symbols";

export default function PlayPage() {
  const params = useParams<{ code: string }>();
  const code = (params.code ?? "").toUpperCase();
  const { state, error, connected, refetch, serverNow } = useGameState(code);

  const round = state?.round ?? null;
  const self = state?.self ?? null;
  const { remainingSeconds, expired } = useCountdown(
    round?.phase === "scramble" ? round.endsAt : null,
    serverNow,
  );

  useResolveOnDeadline(code, round?.id, round?.phase, expired, refetch);
  useGameFeedback(state, "player");
  useCountdownTicks(
    remainingSeconds,
    round?.phase === "scramble" && self?.status === "alive",
    state?.room.config.soundEnabled ?? true,
  );

  if (error === "no-such-room") return <Centered>That room does not exist.</Centered>;
  if (!state && error) {
    return (
      <Centered>
        <p className="font-display mb-2 text-lg font-bold text-foam">
          Can&apos;t reach the game
        </p>
        <p>{error === "offline" ? "Check your connection and try again." : error}</p>
      </Centered>
    );
  }
  if (!state) return <Centered>Boarding…</Centered>;
  if (!self) {
    return (
      <Centered>
        <p className="mb-4">You haven&apos;t joined this room yet.</p>
        <a className="font-display font-bold text-beacon underline" href={`/join/${code}`}>
          Join now →
        </a>
      </Centered>
    );
  }

  const scrambling = round?.phase === "scramble" && self.status === "alive";
  const symbol = self.symbolId ? getSymbol(self.symbolId) : null;

  return (
    <main className="relative mx-auto flex min-h-dvh max-w-md flex-col p-4">
      {/*
        The phone becomes a beacon.

        During a scramble the whole screen glows in the player's symbol colour,
        so a room of forty people visibly sorts itself into colour-coded
        clusters. It cannot be used to cheat — the code is still the only way
        aboard — it just moves the bottleneck off *searching* and onto the
        talking, which is the part worth spending forty-five seconds on.
      */}
      {scrambling && symbol && (
        <div
          className="pointer-events-none fixed inset-0 -z-10 transition-colors duration-500"
          style={{
            background: `radial-gradient(ellipse 120% 70% at 50% 22%, ${symbol.color}55 0%, ${symbol.color}18 45%, transparent 72%)`,
          }}
          aria-hidden
        />
      )}

      <Confetti active={state.room.status === "finished" && self.status === "alive"} />

      <header className="relative z-10 mb-2 flex items-center justify-between text-sm">
        <span className="flex items-center gap-2">
          <Avatar seed={self.avatarSeed} color={self.avatarColor} size={30} />
          <span className="font-display font-semibold">{self.displayName}</span>
        </span>
        <ConnectionDot connected={connected} />
      </header>

      <div className="relative z-10 flex flex-1 flex-col justify-center">
        {state.room.status === "finished" ? (
          <GameOver self={self} />
        ) : self.status !== "alive" ? (
          <InTheWater self={self} phase={round?.phase} promptText={round?.promptText ?? null} />
        ) : round?.phase === "scramble" ? (
          <Scramble
            roomCode={code}
            roundId={round.id}
            targetGroupSize={round.targetGroupSize}
            remainingSeconds={remainingSeconds}
            totalSeconds={state.room.config.roundDurationSeconds}
            self={self}
            onChanged={refetch}
          />
        ) : round?.phase === "prompt" ? (
          <PromptPhase
            promptText={round.promptText}
            endsAt={round.promptEndsAt}
            serverNow={serverNow}
          />
        ) : round?.phase === "resolve" || round?.phase === "done" ? (
          <Survived self={self} />
        ) : (
          <Waiting roomCode={code} self={self} onRenamed={refetch} />
        )}
      </div>
    </main>
  );
}

type Self = NonNullable<NonNullable<ReturnType<typeof useGameState>["state"]>["self"]>;

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center p-6 text-center text-muted">
      {children}
    </main>
  );
}

/* ==========================================================================
   Lobby, and the gap between rounds — the only moments a rename is allowed.
   ========================================================================== */
function Waiting({
  roomCode,
  self,
  onRenamed,
}: {
  roomCode: string;
  self: Self;
  onRenamed: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(self.displayName);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const response = await fetch(`/api/rooms/${roomCode}/players/${self.playerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: name }),
    });
    const data = (await response.json()) as { message?: string };
    if (!response.ok) {
      setError(data.message ?? "Could not change that.");
      return;
    }
    setEditing(false);
    setError(null);
    onRenamed();
  }

  return (
    <div className="animate-rise text-center">
      <div className="animate-bob text-8xl" aria-hidden>
        ⛵
      </div>
      <h1 className="font-display mt-6 text-4xl font-bold">You&apos;re aboard</h1>
      <p className="mt-2 text-mist">
        Watch the big screen. When the boat sinks — <strong>find your symbol.</strong>
      </p>

      {self.roundsSurvived > 0 && (
        <Panel tone="safe" className="mt-6 inline-block px-5 py-2">
          <span className="font-display font-bold text-safe">
            🛟 {self.roundsSurvived} round{self.roundsSurvived === 1 ? "" : "s"} survived
          </span>
        </Panel>
      )}

      <div className="mt-10">
        {editing ? (
          <Panel>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={20}
              className="font-display w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-center text-lg font-semibold"
            />
            {error && <p className="mt-2 text-sm text-danger">{error}</p>}
            <div className="mt-3 flex gap-2">
              <Button variant="ghost" onClick={() => setEditing(false)} className="flex-1">
                Cancel
              </Button>
              <Button onClick={save} className="flex-1">
                Save
              </Button>
            </div>
          </Panel>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="text-sm text-muted underline"
          >
            Change my name
          </button>
        )}
      </div>
    </div>
  );
}

/* ==========================================================================
   The scramble. One symbol, one number, one action.
   ========================================================================== */
function Scramble({
  roomCode,
  roundId,
  targetGroupSize,
  remainingSeconds,
  totalSeconds,
  self,
  onChanged,
}: {
  roomCode: string;
  roundId: string;
  targetGroupSize: number;
  remainingSeconds: number;
  totalSeconds: number;
  self: Self;
  onChanged: () => void;
}) {
  const [entry, setEntry] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);
  const [lockedOutUntil, setLockedOutUntil] = useState(0);

  const symbol = self.symbolId ? getSymbol(self.symbolId) : null;
  const urgent = remainingSeconds <= 10;
  const aboard = self.seatIndex != null;

  const claimCaptain = useCallback(async () => {
    setBusy(true);
    const response = await fetch(`/api/rounds/${roundId}/captain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode }),
    });
    const data = (await response.json()) as {
      ok: boolean;
      reason?: string;
      captainName?: string;
    };
    if (!data.ok) {
      setMessage(
        data.reason === "captain-taken"
          ? `${data.captainName ?? "Someone else"} got there first — go find them!`
          : "Too late for that.",
      );
      setShake((n) => n + 1);
    }
    setBusy(false);
    onChanged();
  }, [roomCode, roundId, onChanged]);

  async function board(event: React.FormEvent) {
    event.preventDefault();
    if (Date.now() < lockedOutUntil) return;

    setBusy(true);
    const response = await fetch(`/api/rounds/${roundId}/board`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode, code: entry }),
    });
    const data = (await response.json()) as {
      ok: boolean;
      reason?: string;
      message?: string;
      ownSymbolId?: string;
    };

    if (data.ok) {
      setEntry("");
      setMessage(null);
    } else {
      const own = data.ownSymbolId ? getSymbol(data.ownSymbolId) : symbol;
      setMessage(
        {
          "wrong-boat": `Wrong boat! You're ${own ? `${own.emoji} ${own.name}` : "somewhere else"}.`,
          "boat-full": "That boat just filled up. Keep moving!",
          "bad-code": "No lifeboat with that code.",
          "round-over": "Too late — she's gone under.",
          "too-many-attempts": data.message ?? "Slow down.",
        }[data.reason ?? ""] ??
          data.message ??
          "That didn't work.",
      );
      setShake((n) => n + 1);
      // A brief lockout so a wrong guess costs something. The real protection
      // is that a code must also match your own symbol.
      setLockedOutUntil(Date.now() + 1500);
      setEntry("");
    }
    setBusy(false);
    onChanged();
  }

  /* ---------------------------------------------------------------- aboard */
  if (aboard) {
    return (
      <div className="animate-pop text-center">
        <p
          className={`font-display text-sm tracking-[0.35em] ${
            self.boatLocked ? "text-safe" : "text-mist"
          }`}
        >
          {self.boatLocked ? "LIFEBOAT FULL" : "YOU'RE ABOARD"}
        </p>

        <div className="my-5 text-8xl" aria-hidden>
          {self.boatLocked ? "🎉" : "🛟"}
        </div>

        {symbol && <SymbolBadge symbolId={symbol.id} size="lg" />}

        <div className="mt-6">
          <SeatPips
            filled={self.boatFilled}
            capacity={self.boatCapacity}
            color={symbol?.color}
            size={18}
          />
          <p className="font-display mt-3 text-lg text-mist">
            {self.boatFilled} of {self.boatCapacity} seats
            {!self.boatLocked && self.boatCapacity - self.boatFilled > 0 && (
              <span className="text-gold">
                {" "}
                · {self.boatCapacity - self.boatFilled} to go
              </span>
            )}
          </p>
        </div>

        {/* Still the captain, still needed: keep the code visible. */}
        {self.isCaptain && self.boatCode && !self.boatLocked && (
          <div className="mt-7">
            <p className="text-sm text-muted">Keep shouting it</p>
            <CodeCard code={self.boatCode} compact />
          </div>
        )}

        <p
          className={`font-display tabular mt-8 text-5xl font-bold ${
            urgent ? "text-danger" : "text-mist"
          }`}
        >
          {remainingSeconds}s
        </p>
      </div>
    );
  }

  /* ------------------------------------------------------------- scrambling */
  return (
    <div className="text-center">
      <div className="flex items-center justify-between">
        <p className="font-display text-xs tracking-[0.3em] text-danger">
          BOAT SINKING
        </p>
        <p className="font-display text-xs tracking-[0.3em] text-mist">
          GROUPS OF {targetGroupSize}
        </p>
      </div>

      {/* The hero. Everything else on this screen is subordinate to it. */}
      <div className="my-6">
        {symbol ? (
          <SymbolBadge symbolId={symbol.id} size="hero" glow />
        ) : (
          <p className="py-16 text-muted">Waiting for the next round…</p>
        )}
      </div>

      <TimeBar remaining={remainingSeconds} total={totalSeconds} urgent={urgent} />

      {symbol && (
        <div className="mt-7">
          {self.isCaptain && self.boatCode ? (
            <div className="animate-pop">
              <p className="font-display text-lg font-semibold text-gold">
                ⚓ You&apos;re the captain
              </p>
              <CodeCard code={self.boatCode} />
              <p className="mt-3 text-sm text-mist">
                Hold your phone up. Shout it. Don&apos;t move.
              </p>
            </div>
          ) : self.captainName ? (
            <>
              <Panel tone="warn" className="mb-4">
                <p className="text-sm text-mist">Your captain is</p>
                <p className="font-display text-3xl font-bold text-gold">
                  {self.captainName}
                </p>
                <p className="mt-1 text-sm text-mist">Find them and get the code</p>
              </Panel>
              <CodeForm entry={entry} setEntry={setEntry} onSubmit={board} disabled={busy} />
            </>
          ) : (
            <>
              <Button
                variant="gold"
                size="lg"
                onClick={claimCaptain}
                disabled={busy}
                className="animate-attention w-full"
              >
                ⚓ I&apos;m the Captain
              </Button>
              <p className="my-3 text-sm text-muted">
                …or wait for someone else to claim it
              </p>
              <CodeForm entry={entry} setEntry={setEntry} onSubmit={board} disabled={busy} />
            </>
          )}
        </div>
      )}

      {message && (
        <p
          key={shake}
          role="alert"
          className="font-display animate-shake mt-4 font-bold text-danger"
        >
          {message}
        </p>
      )}
    </div>
  );
}

function PromptPhase({
  promptText,
  endsAt,
  serverNow,
}: {
  promptText: string | null;
  endsAt: string | null;
  serverNow: () => number;
}) {
  const { remainingSeconds } = useCountdown(endsAt, serverNow);
  return (
    <div className="animate-rise text-center">
      <p className="font-display text-sm tracking-[0.35em] text-safe">
        SAFE — FOR NOW
      </p>
      <div className="my-6 text-7xl" aria-hidden>
        💬
      </div>
      <Panel tone="safe">
        <p className="font-display text-2xl leading-snug font-semibold text-balance">
          {promptText}
        </p>
      </Panel>
      {endsAt && (
        <p className="font-display tabular mt-8 text-5xl font-bold text-muted">
          {remainingSeconds}
        </p>
      )}
    </div>
  );
}

function Survived({ self }: { self: Self }) {
  return (
    <div className="animate-pop text-center">
      <div className="text-8xl" aria-hidden>
        🛟
      </div>
      <h1 className="font-display mt-6 text-4xl font-bold text-safe">Still afloat</h1>
      <p className="mt-2 text-mist">
        {self.roundsSurvived} round{self.roundsSurvived === 1 ? "" : "s"} survived. Watch the
        screen.
      </p>
    </div>
  );
}

/**
 * Eliminated.
 *
 * Still shows the prompt, so someone who has just gone out is not left holding a
 * dead screen while the rest of the room is talking. In a forty-person room half
 * the players are out by round four, and that is exactly where the energy dies.
 * The copy stays light — nobody enjoys being told off by a party game.
 */
function InTheWater({
  self,
  phase,
  promptText,
}: {
  self: Self;
  phase: string | undefined;
  promptText: string | null;
}) {
  const spectator = self.status === "spectator";
  return (
    <div className="animate-rise text-center">
      <div className="animate-bob text-8xl" aria-hidden>
        {spectator ? "👀" : "🌊"}
      </div>
      <h1 className="font-display mt-6 text-4xl font-bold">
        {spectator ? "You're up next round" : "Glub glub."}
      </h1>
      <p className="mt-2 text-mist">
        {spectator
          ? "You joined mid-game — you'll play from the next round."
          : `Overboard after ${self.roundsSurvived} round${self.roundsSurvived === 1 ? "" : "s"}. Heckle from the water.`}
      </p>

      {phase === "prompt" && promptText && (
        <Panel className="mt-8 text-left">
          <p className="mb-1 text-xs tracking-[0.25em] text-muted">
            THE SURVIVORS ARE ANSWERING
          </p>
          <p className="font-display text-lg font-semibold">{promptText}</p>
        </Panel>
      )}
    </div>
  );
}

function GameOver({ self }: { self: Self }) {
  const won = self.status === "alive";
  return (
    <div className="animate-pop text-center">
      <div className={won ? "animate-bob text-9xl" : "text-8xl"} aria-hidden>
        {won ? "🏆" : "🚢"}
      </div>
      <h1 className="font-display mt-6 text-5xl font-bold">
        {won ? "You survived!" : "Game over"}
      </h1>
      <p className="mt-3 text-lg text-mist">
        {self.roundsSurvived} round{self.roundsSurvived === 1 ? "" : "s"} survived
      </p>
    </div>
  );
}
