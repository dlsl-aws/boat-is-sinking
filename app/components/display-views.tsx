"use client";

import { Avatar, BoatCard, TimerRing } from "@/app/components/ui";
import { QrCode } from "@/app/components/QrCode";
import { SinkingShip } from "@/app/components/Ocean";
import { useCountdown } from "@/lib/client/useCountdown";
import type { ClientState } from "@/lib/client/useGameState";

/**
 * The projector's presentational layer.
 *
 * Split from the page so it renders from a plain `ClientState` with no data
 * fetching of its own. That is what makes `/preview` possible: the design
 * harness mounts these exact components against mock state, so what is tuned
 * there is literally what a room sees — no parallel "design version" to drift
 * out of sync with the real thing.
 */

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="display-scale relative z-10 flex min-h-dvh flex-col items-center justify-center p-[3vw]">
      {children}
    </main>
  );
}

/* ========================================================================== */

export function Lobby({ state }: { state: ClientState }) {
  const { joined } = state.counts;

  return (
    <div className="flex w-full max-w-[92rem] flex-col items-center gap-[3vh]">
      <div className="text-center">
        <div className="animate-bob text-[7vw] leading-none" aria-hidden>
          🚢
        </div>
        <h1 className="font-display text-[6.5vw] leading-none font-bold">
          The Boat Is Sinking
        </h1>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-[4vw]">
        <div className="animate-attention rounded-3xl p-2">
          <QrCode url={state.room.joinUrl} size={360} />
        </div>

        <div className="text-center">
          <p className="font-display text-[1.5vw] tracking-[0.35em] text-mist">
            ROOM CODE
          </p>
          <p className="font-display text-[9vw] leading-none font-bold tracking-[0.1em] text-gold">
            {state.room.code}
          </p>
          <p className="mt-[2vh] text-[1.5vw] text-mist">
            {state.room.joinUrl.replace(/^https?:\/\//, "").replace(/\/join\/.*$/, "")}
          </p>
        </div>
      </div>

      <div className="w-full">
        <p className="font-display mb-[2vh] text-center text-[2.4vw] font-semibold">
          {joined === 0 ? (
            <span className="text-mist">Waiting for the crew…</span>
          ) : (
            <>
              <span className="text-gold">{joined}</span> aboard
            </>
          )}
        </p>
        {state.counts.waiting > 0 && (
          <p className="font-display mb-[1vh] text-center text-[1.6vw] text-gold">
            {state.counts.waiting} waiting for the next round
          </p>
        )}

        <div className="stagger flex flex-wrap justify-center gap-[0.8vw]">
          {state.players.map((player) => (
            <span
              key={player.id}
              className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.07] py-2 pr-5 pl-2 backdrop-blur-sm"
            >
              <Avatar seed={player.avatarSeed} color={player.avatarColor} size={40} />
              <span className="font-display text-[1.4vw] font-semibold">
                {player.displayName}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The beat before the scramble. One idea, enormous, unmissable. */
export function Briefing({ targetGroupSize }: { targetGroupSize: number }) {
  return (
    <div className="animate-pop text-center">
      <p className="font-display animate-alarm text-[5vw] leading-none font-bold text-danger">
        THE BOAT IS SINKING!
      </p>
      <p className="font-display mt-[3vh] text-[13vw] leading-none font-bold">
        GROUPS OF {targetGroupSize}
      </p>
      <p className="mt-[3vh] text-[2vw] text-mist">Find your symbol. Go!</p>
    </div>
  );
}

export function Scramble({
  state,
  remainingSeconds,
  total,
  urgent,
  floodLevel,
}: {
  state: ClientState;
  remainingSeconds: number;
  total: number;
  urgent: boolean;
  floodLevel: number;
}) {
  const round = state.round!;
  const captainless = state.boats.filter((b) => !b.hasCaptain).length;

  /*
   * The boat grid is the hero, not the header.
   *
   * During a scramble the single most useful thing on the wall is which
   * lifeboats are still short — it is what a player checks after being turned
   * away, and what tells the facilitator where to shout. So the status row is
   * compressed to a band and the grid gets the remaining height, sized to fill
   * it rather than sitting as a strip along the bottom.
   */
  return (
    <div className="flex w-full max-w-[100rem] flex-col gap-[2.5vh]">
      <div className="flex items-center justify-between gap-[3vw]">
        <div className="text-left">
          <p className="font-display text-[1.2vw] tracking-[0.35em] text-danger">
            ROUND {round.roundIndex + 1}
          </p>
          <p className="font-display text-[4.6vw] leading-none font-bold">
            Groups of {round.targetGroupSize}
          </p>
          <p className="mt-[0.6vh] text-[1.3vw] text-mist">
            {state.counts.seated} of {state.counts.seatsAvailable} seats taken
          </p>
        </div>

        <TimerRing remaining={remainingSeconds} total={total} urgent={urgent} size={185}>
          <span
            className={`font-display tabular text-[4.2vw] leading-none font-bold ${
              urgent ? "animate-alarm text-danger" : ""
            }`}
          >
            {remainingSeconds}
          </span>
        </TimerRing>

        <div className="w-[12vw] text-right">
          <SinkingShip level={floodLevel} />
        </div>
      </div>

      {/* The facilitator's cue, big enough to act on from across the room. */}
      <div className="min-h-[2.4vw] text-center">
        {captainless > 0 && (
          <p className="font-display animate-alarm text-[1.7vw] font-semibold text-gold">
            ⚠ {captainless} lifeboat{captainless === 1 ? "" : "s"} still{" "}
            {captainless === 1 ? "needs" : "need"} a captain
          </p>
        )}
      </div>

      <div className="grid auto-rows-min grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-[1vw]">
        {state.boats.map((boat) => (
          <BoatCard
            key={boat.id}
            symbolId={boat.symbolId}
            filled={boat.filled}
            capacity={boat.capacity}
            locked={boat.locked}
            hasCaptain={boat.hasCaptain}
            captainName={boat.captainName}
          />
        ))}
      </div>
    </div>
  );
}

export function Aftermath({ state }: { state: ClientState }) {
  const round = state.round!;
  const drowned = state.players.filter((p) => p.eliminatedRound === round.roundIndex);
  const alive = state.players.filter((p) => p.status === "alive");

  return (
    <div className="w-full max-w-[85rem] text-center">
      <p className="font-display text-[1.6vw] tracking-[0.4em] text-mist">
        ROUND {round.roundIndex + 1} OVER
      </p>

      {drowned.length > 0 ? (
        <>
          <p className="font-display animate-pop mt-[2vh] text-[6vw] leading-none font-bold text-danger">
            {drowned.length === 1 ? "One overboard!" : `${drowned.length} overboard!`}
          </p>

          {/* Readable, not faded. Being named on the big screen is half the
              fun of going out — dimming it to a whisper wastes the moment. */}
          <div className="mt-[4vh] flex flex-wrap justify-center gap-[1vw]">
            {drowned.map((player, i) => (
              <span
                key={player.id}
                style={{ animationDelay: `${i * 0.09}s` }}
                className="animate-sink flex items-center gap-3 rounded-full border border-rose-400/50 bg-rose-500/20 py-2 pr-6 pl-2"
              >
                <Avatar
                  seed={player.avatarSeed}
                  color={player.avatarColor}
                  size={48}
                  dimmed
                />
                <span className="font-display text-[1.9vw] font-semibold text-rose-100 line-through decoration-rose-300/70">
                  {player.displayName}
                </span>
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="font-display mt-[2vh] text-[5vw] font-bold text-safe">
          Everybody made it! 🎉
        </p>
      )}

      <p className="font-display mt-[6vh] text-[2.6vw] font-semibold text-safe">
        🛟 {alive.length} still afloat
      </p>
    </div>
  );
}

export function PromptPhase({
  state,
  serverNow,
}: {
  state: ClientState;
  serverNow: () => number;
}) {
  const round = state.round!;
  const { remainingSeconds } = useCountdown(round.promptEndsAt, serverNow);

  return (
    <div className="w-full max-w-[75rem] text-center">
      <p className="font-display text-[1.6vw] tracking-[0.4em] text-safe">
        IN YOUR LIFEBOAT
      </p>

      <div className="my-[3vh] text-[6vw] leading-none" aria-hidden>
        💬
      </div>

      <p className="font-display text-[4.2vw] leading-tight font-bold text-balance">
        {round.promptText}
      </p>

      {round.promptEndsAt && (
        <p className="font-display tabular mt-[5vh] text-[6vw] leading-none font-bold text-mist">
          {remainingSeconds}
        </p>
      )}
    </div>
  );
}

export function Winners({ state }: { state: ClientState }) {
  const winners = state.players.filter((p) => p.status === "alive");
  const rounds = state.round ? state.round.roundIndex + 1 : 0;

  return (
    <div className="w-full max-w-[85rem] text-center">
      <div className="animate-bob text-[9vw] leading-none" aria-hidden>
        🏆
      </div>
      <p className="font-display mt-[1vh] text-[5.5vw] leading-none font-bold text-gold">
        {winners.length === 1 ? "Last one standing" : "The survivors"}
      </p>

      <div className="stagger mt-[4vh] flex flex-wrap justify-center gap-[1.2vw]">
        {winners.map((player) => (
          <span
            key={player.id}
            className="flex items-center gap-3 rounded-full border border-amber-400/40 bg-amber-400/15 py-3 pr-7 pl-3"
          >
            <Avatar seed={player.avatarSeed} color={player.avatarColor} size={64} />
            <span className="font-display text-[2.6vw] font-bold">{player.displayName}</span>
          </span>
        ))}
      </div>

      <p className="mt-[6vh] text-[1.6vw] text-mist">
        {state.counts.joined} played · {rounds} rounds · {state.counts.eliminated} went overboard
      </p>
    </div>
  );
}

/**
 * Between rounds.
 *
 * The reveal has had its moment and the icebreaker is over; replaying "3
 * overboard!" here would step on both. This holds the room's attention on the
 * count that matters while the facilitator decides what to do next.
 */
export function Standby({ state }: { state: ClientState }) {
  const alive = state.players.filter((p) => p.status === "alive").length;

  return (
    <div className="w-full max-w-[85rem] text-center">
      <div className="animate-bob text-[7vw] leading-none" aria-hidden>
        ⛵
      </div>
      <p className="font-display mt-[2vh] text-[5vw] leading-none font-bold text-safe">
        {alive} still afloat
      </p>
      <p className="mt-[3vh] text-[2vw] text-mist">Next round coming up…</p>
      {state.counts.waiting > 0 && (
        <p className="mt-[2vh] text-[1.6vw] text-gold">
          {state.counts.waiting} waiting to play
        </p>
      )}
    </div>
  );
}
