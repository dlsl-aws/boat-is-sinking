import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assignSymbols } from "../game/assign";
import { generateDistinctBoatCodes } from "../game/codes";
import { suggestShape } from "../game/plan";
import { resolveRound, type ResolvableBoat } from "../game/resolve";
import { seededRng } from "../game/rng";

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

const MIGRATIONS = ["0001_init.sql", "0002_rpc.sql", "0003_rounds.sql", "0004_seats.sql"];

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

    await db.query(`select apply_resolution($1, $2, $3, 'done', null)`, [
      roundId,
      resolution.survivorIds,
      resolution.eliminatedIds,
    ]);

    log.push({
      index: created.roundIndex,
      alive: alivePlayerIds.length,
      targetGroupSize: shape.targetGroupSize,
      boats: boatsPayload.length,
      survivors: resolution.survivorIds.length,
      eliminated: resolution.eliminatedIds.length,
      autoCaptains,
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
});
