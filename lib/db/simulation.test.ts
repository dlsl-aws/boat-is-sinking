import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assignSymbols } from "../game/assign";
import { generateDistinctBoatCodes } from "../game/codes";
import { suggestShape } from "../game/plan";
import { resolveRound, type ResolvableBoat } from "../game/resolve";
import { seededRng } from "../game/rng";
import { planPostRound } from "../game/postround";

/**
 * A whole game, end to end, against real Postgres.
 *
 * This is the test that would have caught the failures that only show up in
 * front of a room: a round that eliminates nobody so the game never ends, a
 * cohort that drowns because nobody volunteered as captain, a boat that seats
 * more players than it has seats, a game that runs to twenty rounds.
 *
 * It drives the same code paths production does — the planner and resolver in
 * TypeScript, `create_round` / `claim_captain` / `claim_seat` /
 * `apply_resolution` in SQL — with virtual players who board in a random order
 * and sometimes never board at all.
 */

const MIGRATIONS = ["0001_init.sql", "0002_rpc.sql", "0003_rounds.sql", "0004_seats.sql", "0005_phases.sql"];

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  for (const file of MIGRATIONS) {
    await db.exec(
      readFileSync(join(process.cwd(), "supabase", "migrations", file), "utf8"),
    );
  }
  return db;
}

type Json = Record<string, unknown>;

async function call<T = Json>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<{ r: T }>(sql, params);
  return result.rows[0]!.r;
}

type SimOptions = {
  playerCount: number;
  seed: number;
  /** Chance a given player simply never reaches their boat in time. */
  strandedChance?: number;
  /** Chance a cohort produces no volunteer, forcing auto-captain promotion. */
  noVolunteerChance?: number;
};

type RoundLog = {
  index: number;
  alive: number;
  targetGroupSize: number;
  boats: number;
  survivors: number;
  eliminated: number;
  autoCaptains: number;
  phases: string[];
};

async function playGame(db: PGlite, options: SimOptions) {
  const { playerCount, seed, strandedChance = 0.15, noVolunteerChance = 0.1 } = options;
  const rng = seededRng(seed);

  const room = (
    await db.query<{ id: string }>(
      `insert into rooms (code, host_token_hash) values ('SIM234', 'h') returning id`,
    )
  ).rows[0]!;

  for (let i = 0; i < playerCount; i++) {
    await db.query(
      `insert into players (room_id, display_name, name_key, avatar_seed, avatar_color, session_token_hash)
       values ($1, $2, $3, '0', '#fff', $4)`,
      [room.id, `Player ${i}`, `player ${i}`, `token-${i}`],
    );
  }

  const log: RoundLog[] = [];
  let symbolOffset = 0;

  for (let guard = 0; guard < 30; guard++) {
    const aliveRows = await db.query<{ id: string }>(
      `select id from players where room_id = $1 and status = 'alive' order by id`,
      [room.id],
    );
    const alivePlayerIds = aliveRows.rows.map((r) => r.id);
    if (alivePlayerIds.length <= 2) break;

    const shape = suggestShape(alivePlayerIds.length, playerCount);
    if (!shape) break;

    const assignment = assignSymbols(alivePlayerIds, shape, { symbolOffset, rng });
    if (assignment.kind !== "ok") break;
    symbolOffset += assignment.boats.length;

    const codes = generateDistinctBoatCodes(assignment.boats.length);
    const boatsPayload = assignment.boats.map((boat, i) => ({
      symbolId: boat.symbol.id,
      capacity: boat.capacity,
      code: codes[i]!,
      playerIds: boat.playerIds,
    }));

    const created = await call<{ roundId: string; roundIndex: number }>(
      db,
      `select create_round($1, $2, $3, 45, 5, null, $4::jsonb) as r`,
      [room.id, shape.targetGroupSize, shape.boatsRemoved, JSON.stringify(boatsPayload)],
    );
    const roundId = created.roundId;

    const boatRows = await db.query<{ id: string; code: string; symbol_id: string }>(
      `select id, code, symbol_id from boats where round_id = $1`,
      [roundId],
    );
    const boatIdByCode = new Map(boatRows.rows.map((b) => [b.code, b.id]));

    // Everybody scrambles at once, so interleave the boats rather than
    // finishing one cohort before starting the next.
    let autoCaptains = 0;
    const queues: { code: string; playerIds: string[] }[] = [];

    for (const boat of boatsPayload) {
      const holders = [...boat.playerIds].sort(() => rng() - 0.5);
      const skipVolunteer = rng() < noVolunteerChance;

      if (!skipVolunteer && holders.length > 0) {
        const result = await call<{ ok: boolean }>(
          db,
          `select claim_captain($1, $2) as r`,
          [boatIdByCode.get(boat.code)!, holders[0]!],
        );
        expect(result.ok, "a first volunteer must always become captain").toBe(true);
        queues.push({ code: boat.code, playerIds: holders.slice(1) });
      } else {
        queues.push({ code: boat.code, playerIds: holders });
      }
    }

    // The safety valve: any cohort with no volunteer gets one appointed.
    //
    // `auto_captain_at` is a real grace period — five seconds in which a human
    // might still volunteer — so the virtual clock has to be wound past it.
    // Calling this before it elapses correctly does nothing.
    await db.query(
      `update rounds set auto_captain_at = now() - interval '1 second' where id = $1`,
      [roundId],
    );
    const promoted = await call<{ promoted: unknown[] }>(
      db,
      `select promote_auto_captains($1) as r`,
      [roundId],
    );
    autoCaptains = promoted.promoted.length;

    const stillGoing = queues.filter((q) => q.playerIds.length > 0);
    while (stillGoing.some((q) => q.playerIds.length > 0)) {
      for (const queue of stillGoing) {
        const playerId = queue.playerIds.shift();
        if (!playerId) continue;
        // Some players simply never make it across the room in time.
        if (rng() < strandedChance) continue;
        await db.query(`select claim_seat($1, $2, $3)`, [roundId, queue.code, playerId]);
      }
    }

    // Deadline reached.
    await db.query(`update rounds set ends_at = now() - interval '1 second' where id = $1`, [
      roundId,
    ]);
    const owned = await call<{ owned: boolean }>(db, `select begin_resolve($1) as r`, [roundId]);
    expect(owned.owned).toBe(true);

    const seatRows = await db.query<{ boat_id: string; player_id: string }>(
      `select boat_id, player_id from seats where round_id = $1 order by seat_index`,
      [roundId],
    );
    const seatsByBoat = new Map<string, string[]>();
    for (const seat of seatRows.rows) {
      const list = seatsByBoat.get(seat.boat_id) ?? [];
      list.push(seat.player_id);
      seatsByBoat.set(seat.boat_id, list);
    }

    const resolvable: ResolvableBoat[] = boatRows.rows.map((b) => ({
      id: b.id,
      symbolId: b.symbol_id,
      capacity: shape.targetGroupSize,
      seatedPlayerIds: seatsByBoat.get(b.id) ?? [],
    }));

    // No boat may ever hold more players than it has seats. This is the whole
    // point of the row lock in `claim_seat`.
    for (const boat of resolvable) {
      expect(
        boat.seatedPlayerIds.length,
        `boat ${boat.symbolId} oversubscribed`,
      ).toBeLessThanOrEqual(shape.targetGroupSize);
    }

    const resolution = resolveRound(alivePlayerIds, resolvable, "lenient");

    const talkingBoatCount = resolution.boats.filter(
      (b) => !b.sank && b.survivorIds.length > 1,
    ).length;
    const nextShape = suggestShape(resolution.survivorIds.length, playerCount);
    const { runPrompt } = planPostRound({
      survivorCount: resolution.survivorIds.length,
      talkingBoatCount,
      targetWinners: 2,
      promptsEnabled: true,
      hasPromptId: true,
      nextShape,
    });

    await db.query(
      `select apply_resolution($1, $2, $3, now() + interval '6 seconds', ${
        runPrompt ? "now() + interval '51 seconds'" : "null"
      })`,
      [roundId, resolution.survivorIds, resolution.eliminatedIds],
    );

    // Walk the round through its phases the way a room of clients does, winding
    // each deadline back rather than waiting for it.
    const phases: string[] = ["resolve"];
    for (let hop = 0; hop < 3; hop++) {
      // `least()` ignores nulls in Postgres rather than propagating them, so a
      // round with no icebreaker (prompt_ends_at null) must be left alone here
      // — otherwise this wind-back would fabricate a past deadline out of thin
      // air and walk the round through a `prompt` phase it was never meant to
      // have.
      await db.query(
        `update rounds
            set reveal_ends_at = least(reveal_ends_at, now() - interval '1 second'),
                prompt_ends_at = case
                  when prompt_ends_at is null then null
                  else least(prompt_ends_at, now() - interval '1 second')
                end
          where id = $1`,
        [roundId],
      );
      const moved = await call<{ moved: boolean; phase?: string }>(
        db,
        `select advance_phase($1) as r`,
        [roundId],
      );
      if (!moved.moved) break;
      phases.push(moved.phase!);
    }

    log.push({
      index: created.roundIndex,
      alive: alivePlayerIds.length,
      targetGroupSize: shape.targetGroupSize,
      boats: boatsPayload.length,
      survivors: resolution.survivorIds.length,
      eliminated: resolution.eliminatedIds.length,
      autoCaptains,
      phases,
    });
  }

  const finalAlive = await db.query<{ count: number }>(
    `select count(*)::int as count from players where room_id = $1 and status = 'alive'`,
    [room.id],
  );

  return { log, winners: finalAlive.rows[0]!.count, roomId: room.id };
}

describe("full game simulation", () => {
  it("runs a 40-player game to a winner in a sensible number of rounds", async () => {
    const db = await freshDb();
    const { log, winners } = await playGame(db, { playerCount: 40, seed: 1 });

    expect(winners).toBeGreaterThanOrEqual(1);
    expect(winners).toBeLessThanOrEqual(3);

    // A ten-minute slot cannot absorb a twenty-round game.
    expect(log.length).toBeGreaterThanOrEqual(4);
    expect(log.length).toBeLessThanOrEqual(10);

    for (const round of log) {
      // Every round must thin the field, or the game never converges.
      expect(round.eliminated, `round ${round.index} eliminated nobody`).toBeGreaterThan(0);
      expect(round.survivors + round.eliminated).toBe(round.alive);
    }

    // Rounds chain: each one starts with the previous one's survivors.
    for (let i = 1; i < log.length; i++) {
      expect(log[i]!.alive).toBe(log[i - 1]!.survivors);
    }

    for (const round of log) {
      // Every round reaches a real end, and the reveal is always seen.
      expect(round.phases[0], `round ${round.index}`).toBe("resolve");
      expect(round.phases.at(-1), `round ${round.index}`).toBe("done");
    }

    // The round that ends the game runs no icebreaker: it used to set the
    // prompt phase and have finish_game yank it off the winners' screens.
    expect(log.at(-1)!.phases).not.toContain("prompt");
  }, 60_000);

  it("never strands a cohort, even when nobody ever volunteers", async () => {
    const db = await freshDb();
    // Every single boat is left without a volunteer.
    const { log, winners } = await playGame(db, {
      playerCount: 30,
      seed: 7,
      noVolunteerChance: 1,
    });

    expect(log.length).toBeGreaterThan(0);
    expect(winners).toBeGreaterThanOrEqual(1);
    // Auto-promotion must have carried every boat in every round.
    for (const round of log) {
      expect(round.autoCaptains, `round ${round.index}`).toBe(round.boats);
      expect(round.survivors).toBeGreaterThan(0);
    }
  }, 60_000);

  it("survives a room where most players never reach their boat", async () => {
    const db = await freshDb();
    const { log, winners } = await playGame(db, {
      playerCount: 24,
      seed: 11,
      strandedChance: 0.6,
    });

    expect(winners).toBeGreaterThanOrEqual(1);
    // Under the lenient policy a half-empty boat still saves whoever is in it,
    // so the game keeps moving instead of wiping the room out at once.
    for (const round of log) {
      expect(round.survivors).toBeGreaterThan(0);
    }
  }, 60_000);

  it("holds up across many room sizes", async () => {
    for (const [playerCount, seed] of [
      [8, 2],
      [15, 3],
      [23, 5],
      [37, 8],
    ] as const) {
      const db = await freshDb();
      const { log, winners } = await playGame(db, { playerCount, seed });
      expect(winners, `n=${playerCount}`).toBeGreaterThanOrEqual(1);
      expect(winners, `n=${playerCount}`).toBeLessThanOrEqual(3);
      for (const round of log) {
        expect(round.eliminated, `n=${playerCount} r${round.index}`).toBeGreaterThan(0);
      }
    }
  }, 120_000);

  it("brings a mid-game joiner into the next round", async () => {
    // The bug this guards: a late joiner was parked as a spectator and nothing
    // ever promoted them, so the phone's "You're up next round" was a lie and
    // they sat out the whole game.
    //
    // `startRound` itself cannot be called from these tests — it talks to
    // Supabase via supabase-js, and these tests run against PGlite — so this
    // is the honest best available coverage: it runs the exact promote-then-
    // select sequence `startRound` uses, then builds a real round from the
    // resulting alive list via `create_round` and checks the latecomer
    // actually receives a seat assignment, not just a flipped status column.
    const db = await freshDb();
    const room = (
      await db.query<{ id: string }>(
        `insert into rooms (code, host_token_hash) values ('LATE24', 'h') returning id`,
      )
    ).rows[0]!;
    const latecomer = (
      await db.query<{ id: string }>(
        `insert into players (room_id, display_name, name_key, avatar_seed, avatar_color, session_token_hash, status)
         values ($1, 'Latecomer', 'latecomer', '0', '#fff', 'tok-late', 'spectator') returning id`,
        [room.id],
      )
    ).rows[0]!;
    // An already-alive player, so the round built below has enough people to
    // form a real boat (a boat needs at least MIN_GROUP_SIZE occupants).
    await db.query(
      `insert into players (room_id, display_name, name_key, avatar_seed, avatar_color, session_token_hash, status)
       values ($1, 'Incumbent', 'incumbent', '0', '#fff', 'tok-inc', 'alive')`,
      [room.id],
    );

    // BEFORE: the query that builds a round only ever selects status = 'alive',
    // so a spectator must not show up in it yet.
    const beforeAlive = await db.query<{ count: number }>(
      `select count(*)::int as count from players where room_id = $1 and status = 'alive'`,
      [room.id],
    );
    expect(beforeAlive.rows[0]!.count).toBe(1);

    // The same promote-then-select sequence `startRound` runs: promotion has
    // to happen before the alive list is read, or the latecomer misses this
    // round's assignment entirely.
    await db.query(
      `update players set status = 'alive' where room_id = $1 and status = 'spectator'`,
      [room.id],
    );

    const aliveRows = await db.query<{ id: string }>(
      `select id from players where room_id = $1 and status = 'alive' order by id`,
      [room.id],
    );
    const alivePlayerIds = aliveRows.rows.map((r) => r.id);
    expect(alivePlayerIds.length).toBe(2);

    // Built directly rather than through `suggestShape` — the planner refuses
    // any shape that eliminates nobody, and a single boat holding everyone
    // never does. One boat sized to hold the whole (tiny) alive list is all
    // this test needs from `create_round`.
    const shape = { targetGroupSize: alivePlayerIds.length, boatsRemoved: 0 };

    const assignment = assignSymbols(alivePlayerIds, shape, { symbolOffset: 0 });
    expect(assignment.kind).toBe("ok");
    if (assignment.kind !== "ok") return;

    const codes = generateDistinctBoatCodes(assignment.boats.length);
    const boatsPayload = assignment.boats.map((boat, i) => ({
      symbolId: boat.symbol.id,
      capacity: boat.capacity,
      code: codes[i]!,
      playerIds: boat.playerIds,
    }));

    const created = await call<{ roundId: string; roundIndex: number }>(
      db,
      `select create_round($1, $2, $3, 45, 5, null, $4::jsonb) as r`,
      [room.id, shape.targetGroupSize, shape.boatsRemoved, JSON.stringify(boatsPayload)],
    );

    // AFTER: the latecomer must actually hold a symbol and a boat in this
    // round's assignments — not merely a status column that says 'alive'.
    const assignmentRows = await db.query<{ player_id: string; boat_id: string; symbol_id: string }>(
      `select player_id, boat_id, symbol_id from assignments where round_id = $1 and player_id = $2`,
      [created.roundId, latecomer.id],
    );
    expect(assignmentRows.rows.length).toBe(1);
    expect(assignmentRows.rows[0]!.boat_id).toBeTruthy();
    expect(assignmentRows.rows[0]!.symbol_id).toBeTruthy();
  });

  it("retries the done-phase decision harmlessly after a failed finish_game", async () => {
    // The bug this guards: `finish_game` can fail after a round has already
    // moved to `done`. `advance_phase` is deliberately still willing to look
    // at a `done` round, so the caller can retry the ending decision on the
    // next poll instead of the game becoming stuck forever. Nothing exercised
    // that path, so a change that made advance_phase reject a `done` round
    // outright — or, worse, move it back into `prompt` — would have gone
    // unnoticed.
    const db = await freshDb();
    const room = (
      await db.query<{ id: string }>(
        `insert into rooms (code, host_token_hash) values ('DONE24', 'h') returning id`,
      )
    ).rows[0]!;
    const playerIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const row = (
        await db.query<{ id: string }>(
          `insert into players (room_id, display_name, name_key, avatar_seed, avatar_color, session_token_hash)
           values ($1, $2, $3, '0', '#fff', $4) returning id`,
          [room.id, `Finisher ${i}`, `finisher ${i}`, `tok-fin-${i}`],
        )
      ).rows[0]!;
      playerIds.push(row.id);
    }

    // Built directly rather than through `suggestShape`, for the same reason
    // as above: a single boat holding everyone eliminates nobody, which the
    // planner refuses to propose, but is exactly what this test needs from
    // `create_round`.
    const shape = { targetGroupSize: playerIds.length, boatsRemoved: 0 };
    const assignment = assignSymbols(playerIds, shape, { symbolOffset: 0 });
    expect(assignment.kind).toBe("ok");
    if (assignment.kind !== "ok") return;
    const codes = generateDistinctBoatCodes(assignment.boats.length);
    const boatsPayload = assignment.boats.map((boat, i) => ({
      symbolId: boat.symbol.id,
      capacity: boat.capacity,
      code: codes[i]!,
      playerIds: boat.playerIds,
    }));
    const created = await call<{ roundId: string }>(
      db,
      `select create_round($1, $2, $3, 45, 5, null, $4::jsonb) as r`,
      [room.id, shape.targetGroupSize, shape.boatsRemoved, JSON.stringify(boatsPayload)],
    );
    const roundId = created.roundId;

    // Drive the round to `done` with no icebreaker (this round ends the game).
    await db.query(`select apply_resolution($1, $2, $3, now() - interval '1 second', null)`, [
      roundId,
      playerIds,
      [],
    ]);
    const firstMove = await call<{ moved: boolean; phase?: string }>(
      db,
      `select advance_phase($1) as r`,
      [roundId],
    );
    expect(firstMove.moved).toBe(true);
    expect(firstMove.phase).toBe("done");

    const phaseAfterFirst = await db.query<{ phase: string }>(
      `select phase from rounds where id = $1`,
      [roundId],
    );
    expect(phaseAfterFirst.rows[0]!.phase).toBe("done");

    // Simulate `finish_game` failing: nothing else changes the round, and the
    // next poll calls advance_phase again on a round that is already `done`.
    for (let retry = 0; retry < 3; retry++) {
      const moved = await call<{ moved: boolean; phase?: string }>(
        db,
        `select advance_phase($1) as r`,
        [roundId],
      );
      expect(moved.moved, `retry ${retry}`).toBe(false);

      const phaseNow = await db.query<{ phase: string }>(
        `select phase from rounds where id = $1`,
        [roundId],
      );
      // Critically: the extra calls must never re-enter `prompt`, and the
      // round's phase and resolution must stay exactly as they were.
      expect(phaseNow.rows[0]!.phase, `retry ${retry}`).toBe("done");
    }

    const players = await db.query<{ status: string }>(
      `select status from players where room_id = $1`,
      [room.id],
    );
    for (const p of players.rows) {
      expect(p.status).toBe("alive");
    }
  });
});
