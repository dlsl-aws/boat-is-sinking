"use client";

import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Avatar,
  BoatCard,
  Button,
  ConnectionDot,
  Panel,
  SymbolBadge,
} from "@/app/components/ui";
import { QrCode } from "@/app/components/QrCode";
import { SettingsPanel } from "@/app/components/SettingsPanel";
import { useGameState, type ClientState } from "@/lib/client/useGameState";
import { useCountdown, usePhaseDeadline } from "@/lib/client/useCountdown";
import { evaluateRound, projectGame } from "@/lib/game/plan";
import { useGameFeedback } from "@/lib/client/useGameFeedback";

/**
 * The facilitator's dashboard.
 *
 * Built around one question: what does the person standing in front of the room
 * need to see to know what to say next? The answer is mostly the unseated list
 * and the boat grid — who is stuck, and which cohort has no captain.
 */
export default function AdminPage() {
  const params = useParams<{ code: string }>();
  const code = (params.code ?? "").toUpperCase();
  const { state, error, connected, refetch, serverNow } = useGameState(code);

  const round = state?.round ?? null;
  const { remainingSeconds, expired } = useCountdown(
    round?.phase === "scramble" ? round.endsAt : null,
    serverNow,
  );
  usePhaseDeadline(code, round?.id, round?.phase, expired, refetch);
  useGameFeedback(state, "display");

  if (error === "no-such-room") {
    return <p className="p-8">No room with code {code}.</p>;
  }
  if (!state && error) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-black">Can&apos;t reach the game</h1>
        <p className="mt-2 text-muted">{error}</p>
        <p className="mt-4 text-sm text-muted">
          If this mentions a missing variable, set it in <code>.env.local</code> (or in the
          Vercel project settings) and reload.
        </p>
      </main>
    );
  }
  if (!state) return <p className="p-8 text-muted">Loading…</p>;

  if (state.viewerRole !== "host") {
    return (
      <main className="mx-auto max-w-md p-8 text-center">
        <h1 className="text-2xl font-black">Not your room</h1>
        <p className="mt-2 text-muted">
          The dashboard is only available in the browser that created this room.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <StatusBar
        state={state}
        connected={connected}
        remainingSeconds={remainingSeconds}
      />
      <Counts state={state} />
      <Controls code={code} state={state} onChanged={refetch} />
      <SettingsPanel code={code} state={state} onChanged={refetch} />
      {round && round.phase === "scramble" && <BoatGrid state={state} />}
      <Roster code={code} state={state} onChanged={refetch} />
      <Plan state={state} />
    </main>
  );
}

const PHASE_LABEL: Record<string, string> = {
  briefing: "Briefing",
  scramble: "Scramble",
  resolve: "Resolving",
  prompt: "Icebreaker",
  done: "Between rounds",
};

function StatusBar({
  state,
  connected,
  remainingSeconds,
}: {
  state: ClientState;
  connected: boolean;
  remainingSeconds: number;
}) {
  const round = state.round;
  const phase =
    state.room.status === "finished"
      ? "Game over"
      : state.room.status === "lobby"
        ? "Lobby"
        : (PHASE_LABEL[round?.phase ?? ""] ?? "Lobby");

  return (
    <Panel className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-4">
        <QrCode url={state.room.joinUrl} size={96} />
        <div>
          <p className="text-xs tracking-[0.3em] text-muted">ROOM CODE</p>
          <p className="text-4xl leading-none font-black tracking-[0.15em]">
            {state.room.code}
          </p>
          <a
            href={`/display/${state.room.code}`}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-sm text-sky-400 underline"
          >
            Open the projector view ↗
          </a>
        </div>
      </div>

      <div className="text-right">
        <ConnectionDot connected={connected} />
        <p className="mt-1 text-2xl font-bold">{phase}</p>
        {round && state.room.status !== "finished" && (
          <p className="text-sm text-muted">
            Round {round.roundIndex + 1} · groups of {round.targetGroupSize}
          </p>
        )}
        {round?.phase === "scramble" && (
          <p
            className={`text-5xl font-black tabular-nums ${
              remainingSeconds <= 10 ? "text-danger" : ""
            }`}
          >
            {remainingSeconds}s
          </p>
        )}
      </div>
    </Panel>
  );
}

function Counts({ state }: { state: ClientState }) {
  const tiles = [
    { label: "Joined", value: state.counts.joined, tone: "" },
    { label: "Still alive", value: state.counts.alive, tone: "text-safe" },
    { label: "Eliminated", value: state.counts.eliminated, tone: "text-danger" },
    { label: "Waiting", value: state.counts.waiting, tone: "text-gold" },
    {
      label: "Seated",
      value: state.round?.phase === "scramble"
        ? `${state.counts.seated}/${state.counts.seatsAvailable}`
        : "—",
      tone: "",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {tiles.map((tile) => (
        <Panel key={tile.label} className="text-center">
          <p className={`text-4xl font-black tabular-nums ${tile.tone}`}>{tile.value}</p>
          <p className="mt-1 text-xs tracking-widest text-muted uppercase">
            {tile.label}
          </p>
        </Panel>
      ))}
    </div>
  );
}

function Controls({
  code,
  state,
  onChanged,
}: {
  code: string;
  state: ClientState;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [manualSize, setManualSize] = useState<number | "">("");
  const [message, setMessage] = useState<string | null>(null);

  const alive = state.counts.alive;
  const scrambling = state.round?.phase === "scramble";

  // Live warning on a hand-picked group size. When players divide evenly there
  // are exactly enough seats and the round eliminates nobody — the trap that
  // makes a game fail to converge.
  const manualPreview = useMemo(() => {
    if (manualSize === "" || alive < 2) return null;
    return evaluateRound(alive, { targetGroupSize: manualSize, boatsRemoved: 0 });
  }, [manualSize, alive]);

  async function send(body: object, label: string) {
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/rooms/${code}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as { reason?: string };
    if (!response.ok || data.reason) {
      setMessage(
        data.reason === "too-few-players" || data.reason === "no-viable-round"
          ? "Not enough players left for another round — end the game."
          : `${label} failed.`,
      );
    }
    setBusy(false);
    onChanged();
  }

  async function forceResolve() {
    if (!state.round) return;
    setBusy(true);
    await fetch(`/api/rounds/${state.round.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomCode: code, force: true }),
    });
    setBusy(false);
    onChanged();
  }

  return (
    <Panel className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="gold"
          disabled={busy || scrambling || state.counts.alive < 2}
          onClick={() =>
            send(
              manualSize === "" ? { action: "start" } : { action: "start", targetGroupSize: manualSize },
              "Start",
            )
          }
        >
          {state.room.status === "lobby" ? "Start the game" : "Next round"}
        </Button>

        <label className="flex items-center gap-2 text-sm text-muted">
          Group size
          <select
            value={manualSize}
            onChange={(event) =>
              setManualSize(event.target.value === "" ? "" : Number(event.target.value))
            }
            className="rounded-lg border border-white/15 bg-black/30 px-2 py-1.5"
          >
            <option value="">Auto</option>
            {[2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <span className="flex-1" />

        {scrambling && (
          <Button variant="ghost" disabled={busy} onClick={forceResolve}>
            End round now
          </Button>
        )}
        {state.round?.phase === "prompt" && (
          <Button variant="ghost" disabled={busy} onClick={() => send({ action: "skip-prompt" }, "Skip")}>
            Skip icebreaker
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={() => send({ action: "end" }, "End")}>
          End game
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => send({ action: "reset" }, "Reset")}>
          Reset
        </Button>
      </div>

      {manualPreview && (
        <p
          className={`text-sm ${
            manualPreview.warnings.includes("no-eliminations")
              ? "font-semibold text-gold"
              : "text-muted"
          }`}
        >
          {manualPreview.warnings.includes("no-eliminations")
            ? `⚠ Groups of ${manualSize} divides ${alive} players evenly — nobody would be eliminated. Pick another size, or leave it on Auto.`
            : `${manualPreview.boats} boats · ${manualPreview.survivors} survive · ${manualPreview.eliminated} eliminated`}
        </p>
      )}

      {message && <p className="text-sm text-danger">{message}</p>}
    </Panel>
  );
}

/**
 * Situational awareness during a scramble.
 *
 * The captain's code is shown here and nowhere else on any shared screen — if a
 * captain's phone dies, the facilitator can read their code out and rescue the
 * cohort instead of watching it drown.
 */
function BoatGrid({ state }: { state: ClientState }) {
  const boats = state.admin?.boats ?? [];
  const nameById = new Map(state.players.map((p) => [p.id, p.displayName]));

  return (
    <Panel>
      <h2 className="font-display mb-3 font-semibold">Lifeboats</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
        {boats.map((boat) => (
          <BoatCard
            key={boat.id}
            symbolId={boat.symbolId}
            filled={boat.filled}
            capacity={boat.capacity}
            locked={boat.locked}
            hasCaptain={boat.hasCaptain}
            captainName={boat.captainName}
            code={boat.code}
            compact
            footer={
              <p className="mt-2 text-[0.7rem] leading-tight text-muted">
                {boat.memberIds.length - boat.seatedPlayerIds.length} still swimming
                {boat.seatedPlayerIds.length > 0 && (
                  <>
                    <br />
                    <span className="text-mist">
                      {boat.seatedPlayerIds.map((id) => nameById.get(id)).join(", ")}
                    </span>
                  </>
                )}
              </p>
            }
          />
        ))}
      </div>
    </Panel>
  );
}

type Filter = "all" | "alive" | "unseated" | "out";

function Roster({
  code,
  state,
  onChanged,
}: {
  code: string;
  state: ClientState;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");

  const symbolByPlayer = new Map(
    (state.admin?.assignments ?? []).map((a) => [a.playerId, a.symbolId]),
  );
  const seatByPlayer = new Map<string, { symbolId: string; index: number }>();
  for (const boat of state.admin?.boats ?? []) {
    boat.seatedPlayerIds.forEach((id, index) =>
      seatByPlayer.set(id, { symbolId: boat.symbolId, index }),
    );
  }
  const unseated = new Set(state.admin?.unseatedPlayerIds ?? []);

  const players = state.players.filter((player) => {
    if (filter === "alive") return player.status === "alive";
    if (filter === "out") return player.status !== "alive";
    if (filter === "unseated") return unseated.has(player.id);
    return true;
  });

  async function patch(id: string, body: object) {
    await fetch(`/api/rooms/${code}/players/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    onChanged();
  }

  async function kick(id: string) {
    await fetch(`/api/rooms/${code}/players/${id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <Panel>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="font-bold">Participants</h2>
        <span className="flex-1" />
        {(["all", "alive", "unseated", "out"] as Filter[]).map((value) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={`rounded-lg px-3 py-1.5 text-sm capitalize ${
              filter === value ? "bg-white/15 font-semibold" : "text-muted"
            }`}
          >
            {/* The list of who to shout at, mid-scramble. */}
            {value === "unseated" ? `still swimming (${unseated.size})` : value}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs tracking-wider text-muted uppercase">
            <tr>
              <th className="py-2">Player</th>
              <th>Status</th>
              <th>Symbol</th>
              <th>Seat</th>
              <th>Survived</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {players.map((player) => {
              const symbolId = symbolByPlayer.get(player.id);
              const seat = seatByPlayer.get(player.id);
              return (
                <tr key={player.id} className="border-t border-white/5">
                  <td className="flex items-center gap-2 py-2">
                    <Avatar
                      seed={player.avatarSeed}
                      color={player.avatarColor}
                      size={28}
                      dimmed={player.status !== "alive"}
                    />
                    <span
                      className={player.status !== "alive" ? "opacity-50 line-through" : ""}
                    >
                      {player.displayName}
                    </span>
                  </td>
                  <td className="capitalize">
                    {player.status === "alive" ? (
                      <span className="text-safe">alive</span>
                    ) : player.status === "spectator" ? (
                      <span className="text-muted">watching</span>
                    ) : (
                      <span className="text-danger">
                        out · R{(player.eliminatedRound ?? 0) + 1}
                      </span>
                    )}
                  </td>
                  <td>{symbolId ? <SymbolBadge symbolId={symbolId} size="sm" /> : "—"}</td>
                  <td>
                    {seat
                      ? `#${seat.index + 1}`
                      : player.status === "alive" && state.round?.phase === "scramble"
                        ? "—"
                        : ""}
                  </td>
                  <td className="tabular-nums">{player.roundsSurvived}</td>
                  <td className="text-right whitespace-nowrap">
                    {player.status === "alive" ? (
                      <button
                        onClick={() => patch(player.id, { status: "eliminated" })}
                        className="px-2 text-xs text-muted hover:text-danger"
                      >
                        eliminate
                      </button>
                    ) : (
                      <button
                        onClick={() => patch(player.id, { status: "alive" })}
                        className="px-2 text-xs text-muted hover:text-safe"
                      >
                        revive
                      </button>
                    )}
                    <button
                      onClick={() => kick(player.id)}
                      className="px-2 text-xs text-muted hover:text-danger"
                    >
                      kick
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {players.length === 0 && (
          <p className="py-6 text-center text-muted">Nobody here.</p>
        )}
      </div>
    </Panel>
  );
}

/**
 * How long this is going to take.
 *
 * A facilitator has roughly ten minutes. This projects the remaining rounds so
 * they can decide up front whether to shorten the timer or raise the winner
 * count, rather than discovering at round seven that the session has overrun.
 */
function Plan({ state }: { state: ClientState }) {
  const alive = state.counts.alive;
  const config = state.room.config;

  const plan = useMemo(
    () =>
      alive >= 2
        ? projectGame(alive, {
            minGroupSize: config.minGroupSize,
            maxGroupSize: config.maxGroupSize,
            targetWinners: config.targetWinners,
          })
        : null,
    [alive, config.minGroupSize, config.maxGroupSize, config.targetWinners],
  );

  if (!plan || plan.rounds.length === 0) return null;

  const seconds =
    plan.rounds.length *
    (config.roundDurationSeconds + (config.promptsEnabled ? config.promptDurationSeconds : 0) + 10);

  return (
    <Panel>
      <h2 className="mb-1 font-bold">If you start now</h2>
      <p className="mb-3 text-sm text-muted">
        {plan.rounds.length} more rounds · about {Math.round(seconds / 60)} minutes ·{" "}
        {plan.winners} winner{plan.winners === 1 ? "" : "s"}
      </p>
      <div className="flex flex-wrap gap-2">
        {plan.rounds.map((round) => (
          <div
            key={round.index}
            className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-center text-xs"
          >
            <p className="font-bold">Groups of {round.shape.targetGroupSize}</p>
            <p className="text-muted">
              {round.alive} → {round.survivors}
            </p>
            <p className="text-danger">−{round.eliminated}</p>
          </div>
        ))}
      </div>
    </Panel>
  );
}
