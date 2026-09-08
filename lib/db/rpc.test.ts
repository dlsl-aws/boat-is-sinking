import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The migrations run against real Postgres (PGlite is the actual engine compiled
 * to WASM), so these tests catch SQL errors and logic bugs before anything is
 * deployed.
 *
 * The one thing PGlite cannot exercise is genuine lock contention — it is a
 * single embedded instance, so concurrent `for update` waiters never queue.
 * What is verified here is that the *sequence* of claims is correct: capacity is
 * never exceeded, a second captain is rejected, and replays are no-ops. Those
 * are the properties the row lock exists to preserve under concurrency.
 */

const MIGRATIONS = ["0001_init.sql", "0002_rpc.sql", "0003_rounds.sql"];

type Db = PGlite;

async function freshDb(): Promise<Db> {
  const db = new PGlite();
  for (const file of MIGRATIONS) {
    const sql = readFileSync(join(process.cwd(), "supabase", "migrations", file), "utf8");
    await db.exec(sql);
  }
  return db;
}

async function one<T>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<T>(sql, params);
  return result.rows[0] as T;
}

/** A room mid-scramble: one boat of `capacity`, with `holders` players on it. */
async function seedScramble(
  db: Db,
  { capacity = 3, holders = 4 }: { capacity?: number; holders?: number } = {},
) {
  const room = await one<{ id: string }>(
    db,
    `insert into rooms (code, host_token_hash) values ('ABC234', 'h') returning id`,
  );

  const playerIds: string[] = [];
  for (let i = 0; i < holders; i++) {
    const p = await one<{ id: string }>(
      db,
      `insert into players (room_id, display_name, name_key, avatar_seed, avatar_color, session_token_hash)
       values ($1, $2, $3, 'seed', '#fff', $4) returning id`,
      [room.id, `P${i}`, `p${i}`, `tok${i}`],
    );
    playerIds.push(p.id);
  }

  const round = await one<{ id: string }>(
    db,
    `insert into rounds (room_id, round_index, target_group_size, phase, ends_at, auto_captain_at)
     values ($1, 0, $2, 'scramble', now() + interval '60 seconds', now() - interval '1 second')
     returning id`,
    [room.id, capacity],
  );

  const boat = await one<{ id: string; code: string }>(
    db,
    `insert into boats (round_id, symbol_id, capacity, code)
     values ($1, 'octopus', $2, 'K7QM') returning id, code`,
    [round.id, capacity],
  );

  for (const pid of playerIds) {
    await db.query(
      `insert into assignments (round_id, player_id, boat_id, symbol_id)
       values ($1, $2, $3, 'octopus')`,
      [round.id, pid, boat.id],
    );
  }

  return { roomId: room.id, roundId: round.id, boat, playerIds };
}

type Json = Record<string, unknown>;

const captain = (db: Db, boatId: string, playerId: string) =>
  one<{ r: Json }>(db, `select claim_captain($1, $2) as r`, [boatId, playerId]).then(
    (x) => x.r,
  );

const board = (db: Db, roundId: string, code: string, playerId: string) =>
  one<{ r: Json }>(db, `select claim_seat($1, $2, $3) as r`, [roundId, code, playerId]).then(
    (x) => x.r,
  );

describe("claim_captain", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("gives the captaincy to exactly one player and seats them", async () => {
    const { boat, playerIds } = await seedScramble(db);

    const first = await captain(db, boat.id, playerIds[0]!);
    expect(first).toMatchObject({ ok: true, code: "K7QM", seatIndex: 0 });

    const second = await captain(db, boat.id, playerIds[1]!);
    expect(second).toMatchObject({ ok: false, reason: "captain-taken", captainName: "P0" });

    const seats = await db.query(`select * from seats`);
    expect(seats.rows).toHaveLength(1);
  });

  it("is idempotent for the winner, so a refresh returns their code", async () => {
    const { boat, playerIds } = await seedScramble(db);
    await captain(db, boat.id, playerIds[0]!);
    expect(await captain(db, boat.id, playerIds[0]!)).toMatchObject({
      ok: true,
      code: "K7QM",
    });
    expect((await db.query(`select * from seats`)).rows).toHaveLength(1);
  });

  it("refuses a player assigned to a different boat", async () => {
    const { roundId, playerIds } = await seedScramble(db);
    const other = await one<{ id: string }>(
      db,
      `insert into boats (round_id, symbol_id, capacity, code)
       values ($1, 'anchor', 3, 'WXY9') returning id`,
      [roundId],
    );
    expect(await captain(db, other.id, playerIds[0]!)).toMatchObject({
      ok: false,
      reason: "wrong-boat",
    });
  });

  it("refuses once the deadline has passed", async () => {
    const { roundId, boat, playerIds } = await seedScramble(db);
    await db.query(`update rounds set ends_at = now() - interval '1 second' where id = $1`, [
      roundId,
    ]);
    expect(await captain(db, boat.id, playerIds[0]!)).toMatchObject({
      ok: false,
      reason: "round-over",
    });
  });
});

describe("claim_seat", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("never seats more players than the boat has capacity for", async () => {
    // The core invariant: 6 players holding one symbol, 5 seats. This is the
    // N+1 race the whole design exists to get right.
    const { roundId, boat, playerIds } = await seedScramble(db, { capacity: 5, holders: 6 });

    await captain(db, boat.id, playerIds[0]!);
    const results = [];
    for (const pid of playerIds.slice(1)) {
      results.push(await board(db, roundId, boat.code, pid));
    }

    expect(results.filter((r) => r.ok)).toHaveLength(4);
    const rejected = results.filter((r) => !r.ok);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: "boat-full" });

    const seats = await db.query(`select * from seats`);
    expect(seats.rows).toHaveLength(5);

    // Seat indexes are dense and unique — no gaps, no collisions.
    const indexes = (seats.rows as { seat_index: number }[])
      .map((s) => s.seat_index)
      .sort((a, b) => a - b);
    expect(indexes).toEqual([0, 1, 2, 3, 4]);
  });

  it("locks the boat on the seat that fills it", async () => {
    const { roundId, boat, playerIds } = await seedScramble(db, { capacity: 3, holders: 4 });
    await captain(db, boat.id, playerIds[0]!);

    expect(await board(db, roundId, boat.code, playerIds[1]!)).toMatchObject({
      ok: true,
      filled: 2,
      locked: false,
    });
    expect(await board(db, roundId, boat.code, playerIds[2]!)).toMatchObject({
      ok: true,
      filled: 3,
      locked: true,
    });

    const b = await one<{ locked_at: string | null }>(
      db,
      `select locked_at from boats where id = $1`,
      [boat.id],
    );
    expect(b.locked_at).not.toBeNull();
  });

  it("rejects an unknown code without revealing anything", async () => {
    const { roundId, playerIds } = await seedScramble(db);
    expect(await board(db, roundId, "ZZZZ", playerIds[1]!)).toEqual({
      ok: false,
      reason: "bad-code",
    });
  });

  it("tells a player their own symbol when they board the wrong boat", async () => {
    const { roundId, playerIds } = await seedScramble(db);
    const other = await one<{ id: string; code: string }>(
      db,
      `insert into boats (round_id, symbol_id, capacity, code)
       values ($1, 'anchor', 3, 'WXY9') returning id, code`,
      [roundId],
    );
    const outsider = await one<{ id: string }>(
      db,
      `insert into players (room_id, display_name, name_key, avatar_seed, avatar_color, session_token_hash)
       select room_id, 'Zed', 'zed', 's', '#fff', 'tokz' from rounds where id = $1 returning id`,
      [roundId],
    );
    await db.query(
      `insert into assignments (round_id, player_id, boat_id, symbol_id) values ($1, $2, $3, 'anchor')`,
      [roundId, outsider.id, other.id],
    );

    // An Anchor typing the Octopus code.
    expect(await board(db, roundId, "K7QM", outsider.id)).toMatchObject({
      ok: false,
      reason: "wrong-boat",
      ownSymbolId: "anchor",
    });
  });

  it("is idempotent for a player already aboard", async () => {
    const { roundId, boat, playerIds } = await seedScramble(db, { capacity: 3, holders: 3 });
    await captain(db, boat.id, playerIds[0]!);
    const first = await board(db, roundId, boat.code, playerIds[1]!);
    const again = await board(db, roundId, boat.code, playerIds[1]!);

    expect(again).toMatchObject({ ok: true, alreadyAboard: true, seatIndex: first.seatIndex });
    expect((await db.query(`select * from seats`)).rows).toHaveLength(2);
  });

  it("stops an eliminated player from boarding", async () => {
    const { roundId, boat, playerIds } = await seedScramble(db);
    await captain(db, boat.id, playerIds[0]!);
    await db.query(`update players set status = 'eliminated' where id = $1`, [playerIds[1]!]);
    expect(await board(db, roundId, boat.code, playerIds[1]!)).toMatchObject({
      ok: false,
      reason: "not-playing",
    });
  });
});

describe("promote_auto_captains", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("appoints a captain when nobody volunteered", async () => {
    const { roundId, boat, playerIds } = await seedScramble(db);

    const result = await one<{ r: { promoted: Json[] } }>(
      db,
      `select promote_auto_captains($1) as r`,
      [roundId],
    );
    expect(result.r.promoted).toHaveLength(1);
    expect(result.r.promoted[0]).toMatchObject({ boatId: boat.id, symbolId: "octopus" });

    const b = await one<{ captain_player_id: string }>(
      db,
      `select captain_player_id from boats where id = $1`,
      [boat.id],
    );
    expect(playerIds).toContain(b.captain_player_id);
    expect((await db.query(`select * from seats`)).rows).toHaveLength(1);
  });

  it("leaves an existing captain alone and is safe to call twice", async () => {
    const { roundId, boat, playerIds } = await seedScramble(db);
    await captain(db, boat.id, playerIds[2]!);

    await db.query(`select promote_auto_captains($1)`, [roundId]);
    await db.query(`select promote_auto_captains($1)`, [roundId]);

    const b = await one<{ captain_player_id: string }>(
      db,
      `select captain_player_id from boats where id = $1`,
      [boat.id],
    );
    expect(b.captain_player_id).toBe(playerIds[2]);
    expect((await db.query(`select * from seats`)).rows).toHaveLength(1);
  });

  it("does nothing before the grace period elapses", async () => {
    const { roundId } = await seedScramble(db);
    await db.query(
      `update rounds set auto_captain_at = now() + interval '10 seconds' where id = $1`,
      [roundId],
    );
    const result = await one<{ r: { promoted: Json[] } }>(
      db,
      `select promote_auto_captains($1) as r`,
      [roundId],
    );
    expect(result.r.promoted).toHaveLength(0);
  });
});

describe("create_round", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("creates round, boats and assignments in one shot", async () => {
    const room = await one<{ id: string }>(
      db,
      `insert into rooms (code, host_token_hash) values ('ABC234', 'h') returning id`,
    );
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await one<{ id: string }>(
        db,
        `insert into players (room_id, display_name, name_key, avatar_seed, avatar_color, session_token_hash)
         values ($1, $2, $3, 's', '#fff', $4) returning id`,
        [room.id, `P${i}`, `p${i}`, `t${i}`],
      );
      ids.push(p.id);
    }

    const boats = [
      { symbolId: "octopus", capacity: 2, code: "K7QM", playerIds: ids.slice(0, 3) },
      { symbolId: "anchor", capacity: 2, code: "WXY9", playerIds: ids.slice(3) },
    ];

    const result = await one<{ r: Json }>(
      db,
      `select create_round($1, 2, 0, 45, 5, 'breakfast', $2::jsonb) as r`,
      [room.id, JSON.stringify(boats)],
    );
    expect(result.r).toMatchObject({ ok: true, roundIndex: 0 });

    expect((await db.query(`select * from boats`)).rows).toHaveLength(2);
    // Every player got exactly one assignment.
    expect((await db.query(`select * from assignments`)).rows).toHaveLength(5);

    const updated = await one<{
      current_round_id: string;
      status: string;
      initial_alive: number;
      symbol_offset: number;
    }>(db, `select current_round_id, status, initial_alive, symbol_offset from rooms where id = $1`, [
      room.id,
    ]);
    expect(updated.status).toBe("in_progress");
    expect(updated.initial_alive).toBe(5);
    expect(updated.symbol_offset).toBe(2);

    // The deadline comes from the database clock, not the caller's.
    const round = await one<{ gap: number }>(
      db,
      `select extract(epoch from (ends_at - now()))::int as gap from rounds where id = $1`,
      [(result.r as { roundId: string }).roundId],
    );
    expect(round.gap).toBeGreaterThan(40);
    expect(round.gap).toBeLessThanOrEqual(45);
  });

  it("keeps initial_alive fixed across rounds so the ramp does not drift", async () => {
    const room = await one<{ id: string }>(
      db,
      `insert into rooms (code, host_token_hash, initial_alive) values ('ABC234', 'h', 40) returning id`,
    );
    await db.query(`select create_round($1, 2, 0, 45, 5, null, '[]'::jsonb)`, [room.id]);
    const r = await one<{ initial_alive: number; symbol_offset: number }>(
      db,
      `select initial_alive, symbol_offset from rooms where id = $1`,
      [room.id],
    );
    expect(r.initial_alive).toBe(40);
  });

  it("numbers rounds sequentially", async () => {
    const room = await one<{ id: string }>(
      db,
      `insert into rooms (code, host_token_hash) values ('ABC234', 'h') returning id`,
    );
    for (const expected of [0, 1, 2]) {
      const r = await one<{ r: { roundIndex: number } }>(
        db,
        `select create_round($1, 2, 0, 45, 5, null, '[]'::jsonb) as r`,
        [room.id],
      );
      expect(r.r.roundIndex).toBe(expected);
    }
  });
});

describe("resolution", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("grants ownership to exactly one caller, and only after the deadline", async () => {
    const { roundId } = await seedScramble(db);

    // Still running.
    expect(
      (await one<{ r: Json }>(db, `select begin_resolve($1) as r`, [roundId])).r,
    ).toMatchObject({ owned: false, reason: "not-yet" });

    await db.query(`update rounds set ends_at = now() - interval '1 second' where id = $1`, [
      roundId,
    ]);

    const first = await one<{ r: Json }>(db, `select begin_resolve($1) as r`, [roundId]);
    const second = await one<{ r: Json }>(db, `select begin_resolve($1) as r`, [roundId]);
    expect(first.r).toMatchObject({ owned: true });
    expect(second.r).toMatchObject({ owned: false, reason: "already-resolved" });
  });

  it("applies an outcome once, however many times it is replayed", async () => {
    const { roundId, playerIds } = await seedScramble(db, { capacity: 3, holders: 4 });
    const survivors = playerIds.slice(0, 3);
    const drowned = playerIds.slice(3);

    for (let i = 0; i < 3; i++) {
      await db.query(`select apply_resolution($1, $2, $3, 'prompt', null)`, [
        roundId,
        survivors,
        drowned,
      ]);
    }

    const rows = await db.query<{ id: string; status: string; rounds_survived: number }>(
      `select id, status, rounds_survived from players order by display_name`,
    );
    for (const row of rows.rows) {
      if (survivors.includes(row.id)) {
        expect(row.status).toBe("alive");
        // The bug this guards: without the resolved_at check, replays would
        // increment this on every call.
        expect(row.rounds_survived).toBe(1);
      } else {
        expect(row.status).toBe("eliminated");
      }
    }

    expect((await db.query(`select * from eliminations`)).rows).toHaveLength(1);
  });
});
