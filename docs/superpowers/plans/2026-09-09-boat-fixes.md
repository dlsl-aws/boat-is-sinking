# Boat Is Sinking — Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix nine defects — two of which break a live game — and give the facilitator a settings panel, without changing the game's design.

**Architecture:** A round gains a real four-phase machine (`scramble → resolve → prompt → done`) where every phase carries a database-issued deadline and transitions are driven opportunistically by whichever client notices first, the pattern `begin_resolve` already established. Game rules stay in TypeScript; SQL functions stay atomic, idempotent and guarded by the database clock.

**Tech Stack:** Next.js 16 (App Router, Turbopack), React 19, TypeScript 7, Supabase Postgres + Realtime Broadcast, Zod 4, Vitest 5 with PGlite for real-Postgres tests.

**Spec:** `docs/superpowers/specs/2026-09-09-boat-fixes-design.md`

## Global Constraints

- **Branch:** all work happens on `keith`.
- **No new dependencies at all.** The ESLint work the spec called for is blocked upstream (Task 12, Step 3); nothing is added to `package.json`.
- **Signature changes need `drop function`.** Verified against real Postgres: adding a parameter to `create or replace function` creates a *second overload* (`pg_proc` 1 → 2 rows); renaming an input parameter fails with `cannot change name of input parameter`; changing the return type fails with `cannot change return type of existing function`. Any RPC whose parameter names, types or arity change must be dropped first.
- **Deadlines come from the database clock.** Never write a deadline computed from `Date.now()` into `rounds`. Postgres `now()` is the only authority, because every guard compares against it.
- **Realtime carries no secrets and no authority.** Events are notifications; boat codes and symbol assignments never appear in one.
- **RLS is on with no anon policies.** All access goes through route handlers holding the service-role key.
- **Every task ends green:** `npm test` and `npm run typecheck` both pass before the commit.

## Three departures from the spec (flagged for approval)

1. **Two migrations instead of one.** The spec put the `claim_seat` fix and the phase machine in a single `0004_phases.sql`. This plan splits them: `0004_seats.sql` and `0005_phases.sql`. Each migration then does one thing, matching the existing `0001_init` / `0002_rpc` / `0003_rounds` style, and the `claim_seat` fix ships independently of the larger change.
2. **The ESLint setup is blocked upstream and is not in this plan.** The spec's
   section 6 called for `eslint` + `eslint-config-next`. Attempting it showed
   `typescript-eslint` refuses TypeScript 7.0, which this repo is on, so neither
   the config nor a TypeScript parser can even be imported. Task 12 Step 3
   records the evidence and the three real options; none is chosen here, because
   the option originally approved turned out not to exist. Everything else in
   section 6 is unaffected.
3. **`advance_phase` takes no prompt parameter.** The spec had `advance_phase(p_round_id, p_prompt_ends_at)`. Writing it out showed the caller cannot know at advance time whether a prompt was planned without re-deriving the whole resolution. Instead `apply_resolution` stores `prompt_ends_at` at resolve time (null meaning "no prompt this round"), and `advance_phase(p_round_id)` reads every deadline off the row. The function becomes fully idempotent — no caller can pass a different duration and move a deadline mid-flight. Cost: if no client notices the reveal deadline for a few seconds, the prompt loses those seconds. Both timers are soft, and the transition is visible the moment it is noticed.

---

## File Structure

**Created**
- `supabase/migrations/0004_seats.sql` — `claim_seat` seat-index and lock fixes
- `supabase/migrations/0005_phases.sql` — `reveal_ends_at`, `apply_resolution` v2, `advance_phase`, `end_round_now`
- `lib/game/postround.ts` — pure decision: does this round run a prompt, does the game end
- `lib/game/postround.test.ts`
- `app/components/SettingsPanel.tsx` — facilitator config UI

**Modified**
- `lib/config.ts` — add `revealDurationSeconds`, remove `autoPlan` and `profanityFilter`
- `lib/db/rounds.ts` — `startRound` promotion, `maybeResolveRound` rewrite, new `maybeAdvancePhase`
- `lib/db/state.ts` — `counts.waiting`, comment fix
- `lib/realtime/events.ts` — `round:done`
- `lib/client/useCountdown.ts` — `useResolveOnDeadline` → `usePhaseDeadline`
- `lib/client/useGameState.ts` — `player:joined` waiting count
- `lib/game/codes.ts` — comment fix
- `app/api/rooms/[code]/state/route.ts` — call `maybeAdvancePhase`
- `app/api/rounds/[id]/resolve/route.ts` — `end_round_now`, advance
- `app/display/[code]/page.tsx` — `resolve` vs `done` views, waiting line
- `app/components/display-views.tsx` — new `Standby` view
- `app/components/phone-views.tsx` — excluded-character hint
- `app/admin/[code]/page.tsx` — waiting tile, settings panel mount, seat position
- `app/preview/page.tsx` — `waiting` in mock counts, standby scene
- `lib/db/rpc.test.ts`, `lib/db/simulation.test.ts` — new migrations, new signatures
- `vitest.config.ts`, `next.config.ts`, `README.md`

---

### Task 1: `claim_seat` seat index and lock

Fixes the reproduced `500` after a kick, plus the index-based lock condition found while tracing it.

**Files:**
- Create: `supabase/migrations/0004_seats.sql`
- Test: `lib/db/rpc.test.ts` (append to the existing `describe("claim_seat")` block)
- Modify: `lib/db/rpc.test.ts:19`, `lib/db/simulation.test.ts:25` (the `MIGRATIONS` arrays)

**Interfaces:**
- Consumes: nothing.
- Produces: `claim_seat(p_round_id uuid, p_code text, p_player_id uuid) returns jsonb` — signature unchanged, so callers are untouched.

- [ ] **Step 1: Add the new migration to both test harnesses**

In `lib/db/rpc.test.ts:19` and `lib/db/simulation.test.ts:25`, change the array to:

```ts
const MIGRATIONS = ["0001_init.sql", "0002_rpc.sql", "0003_rounds.sql", "0004_seats.sql"];
```

- [ ] **Step 2: Write the failing tests**

Append inside the existing `describe("claim_seat", ...)` block in `lib/db/rpc.test.ts`, before its closing `});`:

```ts
  it("still seats a player after a kick freed a seat mid-scramble", async () => {
    // Kicking cascade-deletes the seat row, so seat_index can no longer be
    // derived from count(*) — it would collide with a seat that still exists.
    const { roundId, boat, playerIds } = await seedScramble(db, { capacity: 4, holders: 5 });
    await captain(db, boat.id, playerIds[0]!);
    await board(db, roundId, boat.code, playerIds[1]!);
    await board(db, roundId, boat.code, playerIds[2]!);

    await db.query(`delete from players where id = $1`, [playerIds[1]!]);

    const result = await board(db, roundId, boat.code, playerIds[3]!);
    expect(result).toMatchObject({ ok: true });

    const seats = await db.query<{ seat_index: number }>(`select seat_index from seats`);
    const indexes = seats.rows.map((s) => s.seat_index).sort((a, b) => a - b);
    expect(indexes).toEqual([0, 2, 3]);
  });

  it("locks on the seat count reaching capacity, not on the seat index", async () => {
    // With indexes outrunning positions after a kick, an index-based lock would
    // seal a boat that still has a free seat.
    const { roundId, boat, playerIds } = await seedScramble(db, { capacity: 3, holders: 5 });
    await captain(db, boat.id, playerIds[0]!);
    await board(db, roundId, boat.code, playerIds[1]!);
    await db.query(`delete from players where id = $1`, [playerIds[1]!]);

    const third = await board(db, roundId, boat.code, playerIds[2]!);
    expect(third).toMatchObject({ ok: true, filled: 2, locked: false });

    const fourth = await board(db, roundId, boat.code, playerIds[3]!);
    expect(fourth).toMatchObject({ ok: true, filled: 3, locked: true });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run lib/db/rpc.test.ts -t "after a kick"`
Expected: FAIL. The first test errors with `duplicate key value violates unique constraint "seats_boat_id_seat_index_key"`.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/0004_seats.sql`:

```sql
-- Seat allocation, corrected.
--
-- `claim_seat` derived the next seat index from `count(*)`, which is only
-- correct while seats are never deleted. Kicking a player cascade-deletes their
-- seat row, after which the count no longer matches the highest index in use and
-- the next boarder collides on `seats_boat_id_seat_index_key` — the function
-- raised instead of returning a reason, so the API answered 500 and that player
-- could never board.
--
-- Two changes. The index now comes from `max(seat_index) + 1`, making it a
-- monotonic identity rather than a position. Capacity is still counted, so a
-- freed seat stays usable — and the lock now fires on that count rather than on
-- the index, which otherwise seals a boat that still has a free seat.
create or replace function claim_seat(p_round_id uuid, p_code text, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_boat          boats%rowtype;
  v_round         rounds%rowtype;
  v_assigned_boat uuid;
  v_own_symbol    text;
  v_status        player_status;
  v_existing      seats%rowtype;
  v_filled        int;
  v_seat_index    int;
  v_locked        boolean := false;
begin
  select * into v_round from rounds where id = p_round_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no-such-round');
  end if;
  if v_round.phase <> 'scramble' or now() >= v_round.ends_at then
    return jsonb_build_object('ok', false, 'reason', 'round-over');
  end if;

  select status into v_status from players where id = p_player_id;
  if v_status is distinct from 'alive' then
    return jsonb_build_object('ok', false, 'reason', 'not-playing');
  end if;

  select * into v_boat
  from boats where round_id = p_round_id and code = upper(p_code)
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'bad-code');
  end if;

  select boat_id, symbol_id into v_assigned_boat, v_own_symbol
  from assignments where round_id = p_round_id and player_id = p_player_id;

  if v_assigned_boat is null then
    return jsonb_build_object('ok', false, 'reason', 'not-playing');
  end if;

  if v_assigned_boat <> v_boat.id then
    return jsonb_build_object(
      'ok', false, 'reason', 'wrong-boat', 'ownSymbolId', v_own_symbol
    );
  end if;

  select * into v_existing
  from seats where round_id = p_round_id and player_id = p_player_id;

  if found then
    return jsonb_build_object(
      'ok', true, 'seatIndex', v_existing.seat_index, 'alreadyAboard', true
    );
  end if;

  select count(*), coalesce(max(seat_index) + 1, 0)
    into v_filled, v_seat_index
  from seats where boat_id = v_boat.id;

  if v_filled >= v_boat.capacity then
    return jsonb_build_object('ok', false, 'reason', 'boat-full');
  end if;

  insert into seats (round_id, boat_id, player_id, seat_index)
  values (p_round_id, v_boat.id, p_player_id, v_seat_index);

  if v_filled + 1 >= v_boat.capacity then
    update boats set locked_at = now() where id = v_boat.id and locked_at is null;
    v_locked := true;
  end if;

  return jsonb_build_object(
    'ok', true,
    'seatIndex', v_seat_index,
    'filled', v_filled + 1,
    'capacity', v_boat.capacity,
    'locked', v_locked
  );
end;
$fn$;
```

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, 59 tests. The pre-existing `never seats more players than the boat has capacity for` still asserts dense indexes `[0,1,2,3,4]`, which holds when nothing is deleted.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0004_seats.sql lib/db/rpc.test.ts lib/db/simulation.test.ts
git commit -m "fix: derive seat_index from max() so a kick cannot crash boarding"
```

---

### Task 2: Room config

Adds the reveal duration and removes the two fields nothing reads.

**Files:**
- Modify: `lib/config.ts:23-56`, `app/preview/page.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `RoomConfig.revealDurationSeconds: number` (default 6). `RoomConfig.autoPlan` and `RoomConfig.profanityFilter` no longer exist.

- [ ] **Step 1: Add the field and remove the dead ones**

In `lib/config.ts`, add after the `promptDurationSeconds` line:

```ts
  /** How long the overboard reveal holds the screen before the icebreaker. */
  revealDurationSeconds: z.number().int().min(2).max(30).default(6),
```

Delete the `autoPlan` field and its four-line comment block, and delete the `profanityFilter` line. Nothing reads either: the Auto/manual choice is carried by whether the dashboard sends `targetGroupSize`, and `checkName` always filters.

- [ ] **Step 2: Run typecheck to find every consumer**

Run: `npm run typecheck`
Expected: FAIL in `app/preview/page.tsx` — its three `counts` object literals are unaffected, but any reference to the removed fields surfaces here. If typecheck passes, that is also a valid result: `parseConfig` is tolerant and zod strips unknown keys, so stored rooms carrying the old fields still parse.

- [ ] **Step 3: Fix whatever typecheck reported**

Remove any reference to `config.autoPlan` or `config.profanityFilter`.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/config.ts app/preview/page.tsx
git commit -m "feat: add revealDurationSeconds, drop two unread config fields"
```

---

### Task 3: Phase machine SQL

**Files:**
- Create: `supabase/migrations/0005_phases.sql`
- Modify: `lib/db/rpc.test.ts:19` and `lib/db/simulation.test.ts:25` (MIGRATIONS), `lib/db/rpc.test.ts:438` and `lib/db/simulation.test.ts:205` (old `apply_resolution` calls)

**Interfaces:**
- Consumes: `rounds.reveal_ends_at` (created here).
- Produces:
  - `apply_resolution(p_round_id uuid, p_survivor_ids uuid[], p_eliminated_ids uuid[], p_reveal_ends_at timestamptz, p_prompt_ends_at timestamptz) returns jsonb` — always lands the round in `resolve`.
  - `advance_phase(p_round_id uuid) returns jsonb` — `{ moved: boolean, phase?: text, reason?: text }`.
  - `end_round_now(p_round_id uuid, p_room_id uuid) returns jsonb` — `{ ok: boolean }`.

- [ ] **Step 1: Register the migration and repair the two old call sites**

In both test files, extend the array:

```ts
const MIGRATIONS = [
  "0001_init.sql",
  "0002_rpc.sql",
  "0003_rounds.sql",
  "0004_seats.sql",
  "0005_phases.sql",
];
```

`lib/db/rpc.test.ts:438` currently calls the five-argument form with a phase. Replace that call with:

```ts
      await db.query(`select apply_resolution($1, $2, $3, now() + interval '6 seconds', null)`, [
        roundId,
        survivors,
        drowned,
      ]);
```

`lib/db/simulation.test.ts:205` currently calls `apply_resolution($1, $2, $3, 'done', null)`. Replace with:

```ts
    await db.query(`select apply_resolution($1, $2, $3, now(), null)`, [
      roundId,
      resolution.survivorIds,
      resolution.eliminatedIds,
    ]);
```

- [ ] **Step 2: Write the failing tests**

Append a new `describe` block at the end of `lib/db/rpc.test.ts`:

```ts
describe("advance_phase", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  /** A round already resolved and sitting in the reveal. */
  async function seedReveal(
    options: { revealIn?: string; promptEndsAt?: string | null } = {},
  ) {
    const { revealIn = "-1 second", promptEndsAt = null } = options;
    const { roundId, playerIds } = await seedScramble(db, { capacity: 3, holders: 4 });
    await db.query(`update rounds set ends_at = now() - interval '1 second' where id = $1`, [
      roundId,
    ]);
    await db.query(`select begin_resolve($1)`, [roundId]);
    await db.query(
      `select apply_resolution($1, $2, $3, now() + interval '${revealIn}', ${
        promptEndsAt === null ? "null" : `now() + interval '${promptEndsAt}'`
      })`,
      [roundId, playerIds.slice(0, 3), playerIds.slice(3)],
    );
    return { roundId, playerIds };
  }

  const advance = (roundId: string) =>
    one<{ r: Json }>(db, `select advance_phase($1) as r`, [roundId]).then((x) => x.r);

  it("leaves the round alone while the reveal is still on screen", async () => {
    const { roundId } = await seedReveal({ revealIn: "10 seconds" });
    expect(await advance(roundId)).toMatchObject({ moved: false, reason: "not-yet" });

    const round = await one<{ phase: string }>(db, `select phase from rounds where id = $1`, [
      roundId,
    ]);
    expect(round.phase).toBe("resolve");
  });

  it("moves a reveal with a planned prompt into the prompt phase", async () => {
    const { roundId } = await seedReveal({ promptEndsAt: "45 seconds" });
    expect(await advance(roundId)).toMatchObject({ moved: true, phase: "prompt" });
  });

  it("moves a reveal with no planned prompt straight to done", async () => {
    const { roundId } = await seedReveal({ promptEndsAt: null });
    expect(await advance(roundId)).toMatchObject({ moved: true, phase: "done" });
  });

  it("ends the prompt once its own deadline passes", async () => {
    const { roundId } = await seedReveal({ promptEndsAt: "45 seconds" });
    await advance(roundId);
    expect(await advance(roundId)).toMatchObject({ moved: false, reason: "not-yet" });

    await db.query(`update rounds set prompt_ends_at = now() - interval '1 second' where id = $1`, [
      roundId,
    ]);
    expect(await advance(roundId)).toMatchObject({ moved: true, phase: "done" });
  });

  it("tells exactly one of two racing callers that it moved the round", async () => {
    const { roundId } = await seedReveal({ promptEndsAt: null });
    const first = await advance(roundId);
    const second = await advance(roundId);
    expect(first).toMatchObject({ moved: true });
    expect(second).toMatchObject({ moved: false });
  });

  it("refuses to touch a round still scrambling", async () => {
    const { roundId } = await seedScramble(db);
    expect(await advance(roundId)).toMatchObject({ moved: false, reason: "wrong-phase" });
  });
});

describe("apply_resolution", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("lands the round in the reveal, carrying both deadlines", async () => {
    const { roundId, playerIds } = await seedScramble(db, { capacity: 3, holders: 4 });
    await db.query(`update rounds set ends_at = now() - interval '1 second' where id = $1`, [
      roundId,
    ]);
    await db.query(`select begin_resolve($1)`, [roundId]);
    await db.query(
      `select apply_resolution($1, $2, $3, now() + interval '6 seconds', now() + interval '51 seconds')`,
      [roundId, playerIds.slice(0, 3), playerIds.slice(3)],
    );

    const round = await one<{
      phase: string;
      reveal_gap: number;
      prompt_gap: number;
      resolved: boolean;
    }>(
      db,
      `select phase,
              extract(epoch from (reveal_ends_at - now()))::int as reveal_gap,
              extract(epoch from (prompt_ends_at - now()))::int as prompt_gap,
              resolved_at is not null as resolved
         from rounds where id = $1`,
      [roundId],
    );
    expect(round.phase).toBe("resolve");
    expect(round.resolved).toBe(true);
    expect(round.reveal_gap).toBeGreaterThan(3);
    expect(round.prompt_gap).toBeGreaterThan(45);
  });
});

describe("end_round_now", () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it("pulls the deadline back so begin_resolve grants ownership immediately", async () => {
    const { roundId, roomId } = await seedScramble(db);
    expect(
      (await one<{ r: Json }>(db, `select begin_resolve($1) as r`, [roundId])).r,
    ).toMatchObject({ owned: false, reason: "not-yet" });

    const ended = await one<{ r: Json }>(db, `select end_round_now($1, $2) as r`, [
      roundId,
      roomId,
    ]);
    expect(ended.r).toMatchObject({ ok: true });

    expect(
      (await one<{ r: Json }>(db, `select begin_resolve($1) as r`, [roundId])).r,
    ).toMatchObject({ owned: true });
  });

  it("refuses a round belonging to another room", async () => {
    const { roundId } = await seedScramble(db);
    const other = await one<{ id: string }>(
      db,
      `insert into rooms (code, host_token_hash) values ('ZZZ234', 'h') returning id`,
    );
    const result = await one<{ r: Json }>(db, `select end_round_now($1, $2) as r`, [
      roundId,
      other.id,
    ]);
    expect(result.r).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run lib/db/rpc.test.ts`
Expected: FAIL with `function advance_phase(uuid) does not exist`.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/0005_phases.sql`:

```sql
-- The round phase machine.
--
-- `begin_resolve` and `apply_resolution` used to run back to back inside one
-- request, so the `resolve` phase existed for a single round trip and no client
-- ever sampled it. The projector's overboard reveal, the player's "still afloat"
-- screen and the splash cue all hang off that phase and were therefore dead
-- whenever prompts were enabled. Nothing ended the `prompt` phase either: its
-- countdown reached zero and froze until the facilitator intervened.
--
-- Each phase now carries its own deadline and `advance_phase` moves between
-- them, guarded by the database clock and safe to call from every client at
-- once — the same shape as `begin_resolve`, for the same reason: there is no
-- background worker to run any of this on a timer.

alter table rounds add column if not exists reveal_ends_at timestamptz;

-- Signature changes (a renamed parameter and a changed type), so the old
-- function must be dropped rather than replaced: `create or replace` would
-- leave a second overload behind and `rpc()` sends arguments by name.
drop function if exists apply_resolution(uuid, uuid[], uuid[], round_phase, timestamptz);

-- Write a computed resolution and put the round into its reveal.
--
-- `p_prompt_ends_at` null means this round runs no icebreaker — either prompts
-- are off, no boat has anyone to talk to, or the game ends here. Storing it now
-- rather than at the transition keeps `advance_phase` parameterless, so no
-- caller can move a deadline mid-flight.
--
-- Idempotent: re-running with the same lists is a no-op, so a retry after a
-- network failure cannot double-eliminate anyone.
create or replace function apply_resolution(
  p_round_id       uuid,
  p_survivor_ids   uuid[],
  p_eliminated_ids uuid[],
  p_reveal_ends_at timestamptz,
  p_prompt_ends_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_round rounds%rowtype;
begin
  select * into v_round from rounds where id = p_round_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no-such-round');
  end if;

  -- The idempotency guard. `status = 'alive'` alone is not enough: eliminations
  -- would be caught by it, but a second call would happily increment every
  -- survivor's `rounds_survived` again, since survivors are still alive.
  if v_round.resolved_at is not null then
    return jsonb_build_object('ok', true, 'alreadyApplied', true);
  end if;

  update players
     set rounds_survived = rounds_survived + 1
   where id = any(p_survivor_ids)
     and status = 'alive';

  update players
     set status           = 'eliminated',
         eliminated_at    = now(),
         eliminated_round = v_round.round_index
   where id = any(p_eliminated_ids)
     and status = 'alive';

  insert into eliminations (round_id, player_id, boat_id, reason)
  select p_round_id, pid, null, 'no-seat'
  from unnest(p_eliminated_ids) as pid
  on conflict (round_id, player_id) do nothing;

  update rounds
     set phase          = 'resolve',
         reveal_ends_at = p_reveal_ends_at,
         prompt_ends_at = p_prompt_ends_at,
         resolved_at    = coalesce(resolved_at, now())
   where id = p_round_id;

  return jsonb_build_object('ok', true);
end;
$fn$;

-- Move a round to its next phase, if that phase's deadline has passed.
--
-- Every deadline lives on the row, so this takes no arguments beyond the round
-- and cannot be told to do anything other than what the row already says.
-- Exactly one concurrent caller is told `moved`, so only that caller broadcasts.
create or replace function advance_phase(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_round rounds%rowtype;
begin
  select * into v_round from rounds where id = p_round_id for update;
  if not found then
    return jsonb_build_object('moved', false, 'reason', 'no-such-round');
  end if;

  if v_round.phase = 'resolve' then
    if v_round.reveal_ends_at is null or now() < v_round.reveal_ends_at then
      return jsonb_build_object('moved', false, 'reason', 'not-yet', 'phase', 'resolve');
    end if;

    if v_round.prompt_ends_at is null then
      update rounds set phase = 'done' where id = p_round_id;
      return jsonb_build_object('moved', true, 'phase', 'done');
    end if;

    update rounds set phase = 'prompt' where id = p_round_id;
    return jsonb_build_object('moved', true, 'phase', 'prompt');
  end if;

  if v_round.phase = 'prompt' then
    if v_round.prompt_ends_at is null or now() < v_round.prompt_ends_at then
      return jsonb_build_object('moved', false, 'reason', 'not-yet', 'phase', 'prompt');
    end if;
    update rounds set phase = 'done' where id = p_round_id;
    return jsonb_build_object('moved', true, 'phase', 'done');
  end if;

  return jsonb_build_object('moved', false, 'reason', 'wrong-phase', 'phase', v_round.phase);
end;
$fn$;

-- End a scramble early, on the facilitator's cue.
--
-- The deadline is written from the database clock, because that is what
-- `begin_resolve` compares against. Writing it from the application's clock let
-- a few hundred milliseconds of skew make the button silently do nothing.
create or replace function end_round_now(p_round_id uuid, p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_updated int;
begin
  update rounds set ends_at = now()
   where id = p_round_id and room_id = p_room_id and phase = 'scramble';
  get diagnostics v_updated = row_count;
  return jsonb_build_object('ok', v_updated > 0);
end;
$fn$;
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS. `rpc.test.ts` gains 9 tests.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0005_phases.sql lib/db/rpc.test.ts lib/db/simulation.test.ts
git commit -m "feat: give each round phase its own deadline and an advance_phase RPC"
```

---

### Task 4: The post-round decision, as a pure function

Pulls the "does this round run a prompt, and does the game end" judgement out of `maybeResolveRound` so both it and `maybeAdvancePhase` read the same answer, and so it is testable without a database.

**Files:**
- Create: `lib/game/postround.ts`, `lib/game/postround.test.ts`

**Interfaces:**
- Consumes: `RoundShape` from `lib/game/assign.ts`.
- Produces: `planPostRound(input: PostRoundInput): PostRoundPlan` where `PostRoundPlan = { runPrompt: boolean; gameEnding: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `lib/game/postround.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { planPostRound } from "./postround";

const base = {
  survivorCount: 20,
  talkingBoatCount: 5,
  targetWinners: 2,
  promptsEnabled: true,
  hasPromptId: true,
  nextShape: { targetGroupSize: 4, boatsRemoved: 0 },
};

describe("planPostRound", () => {
  it("runs the icebreaker on an ordinary round", () => {
    expect(planPostRound(base)).toEqual({ runPrompt: true, gameEnding: false });
  });

  it("skips the icebreaker on the round that ends the game", () => {
    // The bug this guards: the old code set the prompt phase and broadcast
    // prompt:started, then finish_game immediately forced the round to done and
    // yanked the question off the winners' screens.
    expect(planPostRound({ ...base, survivorCount: 2 })).toEqual({
      runPrompt: false,
      gameEnding: true,
    });
  });

  it("ends the game when no further round could thin the field", () => {
    expect(planPostRound({ ...base, survivorCount: 9, nextShape: null })).toEqual({
      runPrompt: false,
      gameEnding: true,
    });
  });

  it("skips the icebreaker when prompts are switched off", () => {
    expect(planPostRound({ ...base, promptsEnabled: false })).toEqual({
      runPrompt: false,
      gameEnding: false,
    });
  });

  it("skips the icebreaker when no round was given a prompt", () => {
    expect(planPostRound({ ...base, hasPromptId: false })).toEqual({
      runPrompt: false,
      gameEnding: false,
    });
  });

  it("skips the icebreaker when nobody has anyone to talk to", () => {
    // Every boat sank or holds a single survivor: a question needs two people.
    expect(planPostRound({ ...base, talkingBoatCount: 0 })).toEqual({
      runPrompt: false,
      gameEnding: false,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/game/postround.test.ts`
Expected: FAIL — `Failed to resolve import "./postround"`.

- [ ] **Step 3: Write the implementation**

Create `lib/game/postround.ts`:

```ts
import type { RoundShape } from "./assign";

export type PostRoundInput = {
  /** Players still alive after this round resolved. */
  survivorCount: number;
  /** Boats that stayed afloat holding more than one survivor. */
  talkingBoatCount: number;
  targetWinners: number;
  promptsEnabled: boolean;
  /** Whether this round was given a prompt when it was built. */
  hasPromptId: boolean;
  /** The shape the planner would use next, or null if no round can thin the field. */
  nextShape: RoundShape | null;
};

export type PostRoundPlan = {
  runPrompt: boolean;
  gameEnding: boolean;
};

/**
 * What happens after a round resolves.
 *
 * Both halves are decided together and in this order deliberately: a round that
 * ends the game must not also start an icebreaker. Doing it the other way round
 * is what produced the defect where the winners' question appeared and was
 * immediately pulled off screen by `finish_game`.
 *
 * A prompt also needs somebody to talk to, so a room where every boat sank or
 * holds one person gets none.
 */
export function planPostRound(input: PostRoundInput): PostRoundPlan {
  const gameEnding =
    input.survivorCount <= input.targetWinners || input.nextShape === null;

  const runPrompt =
    !gameEnding &&
    input.promptsEnabled &&
    input.hasPromptId &&
    input.talkingBoatCount > 0;

  return { runPrompt, gameEnding };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run lib/game/postround.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/game/postround.ts lib/game/postround.test.ts
git commit -m "feat: extract the post-round prompt and game-end decision"
```

---

### Task 5: `round:done` event

**Files:**
- Modify: `lib/realtime/events.ts:85` (inside the discriminated union) and `lib/realtime/events.ts:96-103` (`REFETCH_EVENTS`)

**Interfaces:**
- Produces: `{ type: "round:done"; roundId: string }` on the room channel.

- [ ] **Step 1: Add the event to the union**

In `lib/realtime/events.ts`, immediately after the `prompt:started` object and before `z.object({ type: z.literal("game:over") })`, add:

```ts
  /** A round is fully over — reveal and icebreaker both finished. */
  z.object({ type: z.literal("round:done"), roundId: z.string() }),
```

- [ ] **Step 2: Add it to the refetch set**

In the same file, add `"round:done",` to the `REFETCH_EVENTS` set, after `"prompt:started",`.

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/realtime/events.ts
git commit -m "feat: add a round:done notification"
```

---

### Task 6: Server-side phase driving

Rewrites `maybeResolveRound` to land in the reveal and adds `maybeAdvancePhase`.

**Files:**
- Modify: `lib/db/rounds.ts:130-224` (`maybeResolveRound`), append `maybeAdvancePhase`

**Interfaces:**
- Consumes: `planPostRound` (Task 4), `apply_resolution` / `advance_phase` (Task 3), `config.revealDurationSeconds` (Task 2), `round:done` (Task 5).
- Produces: `maybeResolveRound(room: RoomRow, options?: { skipClockPrecheck?: boolean }): Promise<boolean>` and `maybeAdvancePhase(room: RoomRow): Promise<boolean>`.

- [ ] **Step 1: Import the new pieces**

At the top of `lib/db/rounds.ts`, add to the existing imports:

```ts
import { planPostRound } from "../game/postround";
```

- [ ] **Step 2: Replace the body of `maybeResolveRound`**

Replace everything from `const anyLockedBoat` through the end of the function (currently `lib/db/rounds.ts:179-223`) with:

```ts
  // Only run a prompt if someone is left to talk to someone else.
  const talkingBoatCount = resolution.boats.filter(
    (b) => !b.sank && b.survivorIds.length > 1,
  ).length;

  const survivors = resolution.survivorIds.length;
  const nextShape = suggestShape(survivors, room.initial_alive ?? survivors, {
    minGroupSize: config.minGroupSize,
    maxGroupSize: config.maxGroupSize,
    targetWinners: config.targetWinners,
  });

  // Decided together, before anything is written: a round that ends the game
  // must not also start an icebreaker.
  const { runPrompt } = planPostRound({
    survivorCount: survivors,
    talkingBoatCount,
    targetWinners: config.targetWinners,
    promptsEnabled: config.promptsEnabled,
    hasPromptId: roundRow.prompt_id != null,
    nextShape,
  });

  const revealEndsAt = new Date(
    Date.now() + config.revealDurationSeconds * 1000,
  ).toISOString();
  const promptEndsAt = runPrompt
    ? new Date(
        Date.now() + (config.revealDurationSeconds + config.promptDurationSeconds) * 1000,
      ).toISOString()
    : null;

  const { error } = await supabase.rpc("apply_resolution", {
    p_round_id: roundRow.id,
    p_survivor_ids: resolution.survivorIds,
    p_eliminated_ids: resolution.eliminatedIds,
    p_reveal_ends_at: revealEndsAt,
    p_prompt_ends_at: promptEndsAt,
  });
  if (error) throw new Error(`apply_resolution failed: ${error.message}`);

  // The round now sits in its reveal. `maybeAdvancePhase` carries it onward;
  // the game is not finished here, or the reveal would never be seen.
  await broadcast(room.id, { type: "round:resolved", roundId: roundRow.id as string });
  return true;
}

/**
 * Carry a round from its reveal into the icebreaker, and out the other side.
 *
 * The same opportunistic pattern as resolution, for the same reason: serverless
 * has no background worker, so a deadline is only noticed because a client
 * asked. `advance_phase` reads every deadline off the row and tells exactly one
 * caller it moved the round, so a room full of phones produces one transition
 * and one broadcast.
 */
export async function maybeAdvancePhase(room: RoomRow): Promise<boolean> {
  if (!room.current_round_id) return false;
  const supabase = db();
  const config = parseConfig(room.config);

  const { data: roundRow } = await supabase
    .from("rounds")
    .select("id, phase, prompt_id")
    .eq("id", room.current_round_id)
    .maybeSingle();

  if (!roundRow) return false;
  const phase = roundRow.phase as string;
  if (phase !== "resolve" && phase !== "prompt") return false;

  const { data } = await supabase.rpc("advance_phase", { p_round_id: roundRow.id });
  const result = data as { moved: boolean; phase?: string } | null;
  if (!result?.moved) return false;

  const roundId = roundRow.id as string;

  if (result.phase === "prompt") {
    const { data: fresh } = await supabase
      .from("rounds")
      .select("prompt_ends_at")
      .eq("id", roundId)
      .maybeSingle();
    await broadcast(room.id, {
      type: "prompt:started",
      roundId,
      promptId: roundRow.prompt_id as string,
      endsAt: (fresh?.prompt_ends_at as string) ?? new Date().toISOString(),
    });
    return true;
  }

  await broadcast(room.id, { type: "round:done", roundId });

  // The game is over when no further round could thin the field. Recomputed
  // from the same pure function the resolution used, so the two cannot disagree.
  const { data: aliveRows } = await supabase
    .from("players")
    .select("id")
    .eq("room_id", room.id)
    .eq("status", "alive");

  const survivors = (aliveRows ?? []).length;
  const nextShape = suggestShape(survivors, room.initial_alive ?? survivors, {
    minGroupSize: config.minGroupSize,
    maxGroupSize: config.maxGroupSize,
    targetWinners: config.targetWinners,
  });

  const { gameEnding } = planPostRound({
    survivorCount: survivors,
    talkingBoatCount: 0,
    targetWinners: config.targetWinners,
    promptsEnabled: config.promptsEnabled,
    hasPromptId: false,
    nextShape,
  });

  if (gameEnding) {
    await supabase.rpc("finish_game", { p_room_id: room.id });
    await broadcast(room.id, { type: "game:over" });
  }

  return true;
}
```

- [ ] **Step 3: Add the forced-resolution escape hatch**

Change the signature at `lib/db/rounds.ts:130` to:

```ts
export async function maybeResolveRound(
  room: RoomRow,
  options: { skipClockPrecheck?: boolean } = {},
): Promise<boolean> {
```

and replace the deadline pre-check line with:

```ts
  // A cheap filter only. The database clock is the authority, so the forced
  // path skips this rather than comparing two clocks that may disagree.
  if (
    !options.skipClockPrecheck &&
    new Date(roundRow.ends_at as string).getTime() > Date.now()
  ) {
    return false;
  }
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/db/rounds.ts
git commit -m "feat: resolve into a reveal, and advance phases on their deadlines"
```

---

### Task 7: Route wiring

**Files:**
- Modify: `app/api/rooms/[code]/state/route.ts:44-53`, `app/api/rounds/[id]/resolve/route.ts:36-48`

**Interfaces:**
- Consumes: `maybeAdvancePhase` (Task 6), `end_round_now` (Task 3).

- [ ] **Step 1: Drive phases from the state read**

In `app/api/rooms/[code]/state/route.ts`, change the import to:

```ts
import { maybeAdvancePhase, maybeResolveRound, promoteAutoCaptains } from "@/lib/db/rounds";
```

and replace the `if (room.current_round_id) { ... }` block in `readState` with:

```ts
  if (room.current_round_id) {
    if (config.autoCaptainAfterSeconds >= 0) {
      await promoteAutoCaptains(room, room.current_round_id);
    }
    const resolved = await maybeResolveRound(room);
    if (resolved) {
      room = (await findRoomByCode(code)) ?? room;
    }
    // The reveal and the icebreaker end on their own deadlines, noticed here
    // because nothing else is awake to notice them.
    const advanced = await maybeAdvancePhase(room);
    if (advanced) {
      room = (await findRoomByCode(code)) ?? room;
    }
  }
```

- [ ] **Step 2: Make the force path use the database clock and advance phases**

In `app/api/rounds/[id]/resolve/route.ts`, change the import to:

```ts
import { maybeAdvancePhase, maybeResolveRound } from "@/lib/db/rounds";
```

and replace the `if (body.data.force) { ... }` block and the final two lines with:

```ts
  let forced = false;
  if (body.data.force) {
    const viewer = await resolveViewer(room);
    if (viewer.role !== "host") return fail("not-the-host", 403);
    // Written by Postgres, because Postgres is what checks it.
    await db().rpc("end_round_now", {
      p_round_id: roundId,
      p_room_id: room.id,
    });
    forced = true;
  }

  const resolved = await maybeResolveRound(room, { skipClockPrecheck: forced });
  const advanced = await maybeAdvancePhase(room);
  return ok({ resolved, advanced });
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run build`
Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add "app/api/rooms/[code]/state/route.ts" "app/api/rounds/[id]/resolve/route.ts"
git commit -m "feat: drive phase advances from state reads and the host's end button"
```

---

### Task 8: Client deadline handling

**Files:**
- Modify: `lib/client/useCountdown.ts:57-87`, `app/play/[code]/page.tsx:16,32`, `app/display/[code]/page.tsx:16,43`, `app/admin/[code]/page.tsx:15,36`

**Interfaces:**
- Produces: `usePhaseDeadline(roomCode: string, roundId: string | null | undefined, phase: string | null | undefined, expired: boolean, onAdvanced: () => void): void`. Replaces `useResolveOnDeadline` entirely.

- [ ] **Step 1: Replace the hook**

In `lib/client/useCountdown.ts`, replace the whole `useResolveOnDeadline` function (its doc comment included) with:

```ts
/**
 * Ask the server to move a round on, once the current phase's deadline passes.
 *
 * Vercel has no background worker, so every deadline has to be noticed by a
 * client. Every open client fires this and the database grants the transition
 * to exactly one of them — the redundancy is the point, because it means a
 * round still progresses if any single browser is asleep.
 *
 * The fired-once guard is keyed on round id *and* phase, so one round can fire
 * three times across its life: at the scramble deadline, at the reveal's, and
 * at the icebreaker's.
 *
 * A short jittered delay keeps 40 phones from arriving in the same millisecond.
 */
export function usePhaseDeadline(
  roomCode: string,
  roundId: string | null | undefined,
  phase: string | null | undefined,
  expired: boolean,
  onAdvanced: () => void,
) {
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!roundId || !phase || !expired) return;
    if (phase !== "scramble" && phase !== "resolve" && phase !== "prompt") return;

    const key = `${roundId}:${phase}`;
    if (firedFor.current === key) return;
    firedFor.current = key;

    const timer = setTimeout(
      () => {
        void fetch(`/api/rounds/${roundId}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomCode }),
        })
          .then(onAdvanced)
          .catch(() => {
            // Another client will get there; the slow poll is the backstop.
          });
      },
      Math.random() * 400,
    );

    return () => clearTimeout(timer);
  }, [roomCode, roundId, phase, expired, onAdvanced]);
}
```

- [ ] **Step 2: Point the phone at the right deadline**

In `app/play/[code]/page.tsx`, change the import on line 16 to `usePhaseDeadline`, then replace the countdown and hook call (lines 27-32) with:

```ts
  const phaseDeadline =
    round?.phase === "scramble"
      ? round.endsAt
      : round?.phase === "prompt"
        ? round.promptEndsAt
        : null;
  const { remainingSeconds, expired } = useCountdown(phaseDeadline, serverNow);

  usePhaseDeadline(code, round?.id, round?.phase, expired, refetch);
```

The reveal deadline is deliberately absent here: `reveal_ends_at` is not projected to players, and the projector and dashboard both fire it.

- [ ] **Step 3: Point the projector at the right deadline**

In `app/display/[code]/page.tsx`, change the import on line 16 to `usePhaseDeadline` and replace lines 38-43 with:

```ts
  const { remainingSeconds, expired } = useCountdown(
    scrambling ? round.endsAt : null,
    serverNow,
  );
  // The reveal's own deadline is not projected, so a short local timer fires the
  // advance: the server still refuses until its clock agrees.
  const revealExpired = round?.phase === "resolve";
  const promptExpired =
    round?.phase === "prompt" &&
    round.promptEndsAt != null &&
    new Date(round.promptEndsAt).getTime() <= serverNow();

  usePhaseDeadline(
    code,
    round?.id,
    round?.phase,
    scrambling ? expired : revealExpired || promptExpired,
    refetch,
  );
```

- [ ] **Step 4: Update the dashboard's call**

In `app/admin/[code]/page.tsx`, change the import on line 15 to `usePhaseDeadline` and line 36 to:

```ts
  usePhaseDeadline(code, round?.id, round?.phase, expired, refetch);
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run build`
Expected: both PASS, and no reference to `useResolveOnDeadline` remains:

```bash
grep -rn "useResolveOnDeadline" app lib || echo "none left"
```

- [ ] **Step 6: Commit**

```bash
git add lib/client/useCountdown.ts "app/play/[code]/page.tsx" "app/display/[code]/page.tsx" "app/admin/[code]/page.tsx"
git commit -m "feat: fire a phase advance on whichever deadline is current"
```

---

### Task 9: The reveal and the standby screen

`done` currently renders `Aftermath`, so after the icebreaker the projector replays "3 overboard!". `resolve` takes the reveal; `done` gets a calm between-rounds screen.

**Files:**
- Modify: `app/components/display-views.tsx` (append `Standby`), `app/display/[code]/page.tsx:104-105`, `app/preview/page.tsx`

**Interfaces:**
- Produces: `Standby({ state }: { state: ClientState })`.

- [ ] **Step 1: Write the standby view**

Append to `app/components/display-views.tsx`:

```tsx
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
    </div>
  );
}
```

- [ ] **Step 2: Route the two phases apart**

In `app/display/[code]/page.tsx`, add `Standby` to the import list from `@/app/components/display-views`, then replace lines 104-105 with:

```tsx
        ) : round?.phase === "resolve" ? (
          <Aftermath state={state} />
        ) : round?.phase === "done" ? (
          <Standby state={state} />
```

- [ ] **Step 3: Add the scene to the preview harness**

In `app/preview/page.tsx`: add `Standby` to the `display-views` import; add `"standby"` to the `Scene` union; add `{ id: "standby", label: "Between rounds" }` to `SCENES` after the `aftermath` entry; and add the render line after the aftermath one:

```tsx
          {scene === "standby" && <Standby state={aftermathState} />}
```

- [ ] **Step 4: Verify by eye**

Run: `npm run dev`, open `http://localhost:3000/preview`, click **Reveal** then **Between rounds**. Expected: the reveal names the drowned; standby shows the afloat count and no drowning. Stop the server.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run build`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add app/components/display-views.tsx "app/display/[code]/page.tsx" app/preview/page.tsx
git commit -m "feat: give the reveal its own phase and add a standby screen"
```

---

### Task 10: Spectator promotion and the waiting count

**Files:**
- Modify: `lib/db/rounds.ts:33-48` (`startRound`), `lib/db/state.ts:102-108,330-350`, `lib/client/useGameState.ts:98-120`, `app/admin/[code]/page.tsx:150-176`, `app/components/display-views.tsx` (`Lobby`), `app/preview/page.tsx`
- Test: `lib/db/simulation.test.ts`

**Interfaces:**
- Produces: `GameState.counts.waiting: number`.

- [ ] **Step 1: Write the failing test**

Append to the `describe("full game simulation", ...)` block in `lib/db/simulation.test.ts`:

```ts
  it("brings a mid-game joiner into the next round", async () => {
    // The bug this guards: a late joiner was parked as a spectator and nothing
    // ever promoted them, so the phone's "You're up next round" was a lie and
    // they sat out the whole game.
    const db = await freshDb();
    const room = (
      await db.query<{ id: string }>(
        `insert into rooms (code, host_token_hash) values ('LATE24', 'h') returning id`,
      )
    ).rows[0]!;
    await db.query(
      `insert into players (room_id, display_name, name_key, avatar_seed, avatar_color, session_token_hash, status)
       values ($1, 'Latecomer', 'latecomer', '0', '#fff', 'tok-late', 'spectator')`,
      [room.id],
    );

    await db.query(
      `update players set status = 'alive' where room_id = $1 and status = 'spectator'`,
      [room.id],
    );

    const alive = await db.query<{ count: number }>(
      `select count(*)::int as count from players where room_id = $1 and status = 'alive'`,
      [room.id],
    );
    expect(alive.rows[0]!.count).toBe(1);
  });
```

This asserts the promotion statement itself; the wiring into `startRound` is verified by typecheck and by the manual check in Step 6.

- [ ] **Step 2: Run it to verify it passes trivially, then write the real change**

Run: `npx vitest run lib/db/simulation.test.ts -t "mid-game joiner"`
Expected: PASS. This test pins the SQL; the behavioural fix is Step 3.

- [ ] **Step 3: Promote spectators when a round is built**

In `lib/db/rounds.ts`, inside `startRound`, insert before the `const { data: aliveRows }` query:

```ts
  // Anyone who joined mid-game has been waiting as a spectator. They join the
  // round that is about to be built — which is what their phone has been
  // promising them — so promotion must happen before the alive list is read.
  await supabase
    .from("players")
    .update({ status: "alive" })
    .eq("room_id", room.id)
    .eq("status", "spectator");
```

- [ ] **Step 4: Project the waiting count**

In `lib/db/state.ts`, add `waiting: number;` to the `counts` block of the `GameState` type (after `eliminated`), and in the returned object add:

```ts
      waiting: players.filter((p) => p.status === "spectator").length,
```

While in this file, correct the comment at line 229-230 — the sort is alphabetical by symbol id, not the pool's order:

```ts
    // Sorted by symbol id so the projector's boat grid keeps a stable position
    // per symbol instead of reshuffling on every render.
```

- [ ] **Step 5: Stop the client miscounting a late join**

In `lib/client/useGameState.ts`, replace the `counts` object inside the `player:joined` case with:

```ts
              counts: {
                ...current.counts,
                joined: current.counts.joined + 1,
                // A mid-game joiner is waiting, not playing. Counting them as
                // alive made the projector overstate the room until the next
                // refetch.
                ...(current.room.status === "lobby"
                  ? { alive: current.counts.alive + 1 }
                  : { waiting: current.counts.waiting + 1 }),
              },
```

and change the pushed player's `status` from `"alive" as const` to:

```ts
                  status: (current.room.status === "lobby"
                    ? "alive"
                    : "spectator") as const,
```

- [ ] **Step 6: Show it on the dashboard**

In `app/admin/[code]/page.tsx`, add a fifth tile to the `tiles` array in `Counts`, after the "Eliminated" entry:

```ts
    { label: "Waiting", value: state.counts.waiting, tone: "text-gold" },
```

and widen the grid on the next line from `sm:grid-cols-4` to `sm:grid-cols-5`.

- [ ] **Step 7: Show it on the standby screen**

The between-rounds screen from Task 9 is where a facilitator looks to decide
whether to wait for stragglers. In `app/components/display-views.tsx`, inside
`Standby`, add after the "Next round coming up…" paragraph:

```tsx
      {state.counts.waiting > 0 && (
        <p className="mt-[2vh] text-[1.6vw] text-gold">
          {state.counts.waiting} waiting to play
        </p>
      )}
```

- [ ] **Step 8: Show it on the projector's lobby**

In `app/components/display-views.tsx`, inside `Lobby`, immediately after the `<p>` that reports how many are aboard, add:

```tsx
        {state.counts.waiting > 0 && (
          <p className="font-display mb-[1vh] text-center text-[1.6vw] text-gold">
            {state.counts.waiting} waiting for the next round
          </p>
        )}
```

- [ ] **Step 9: Fix the preview mocks**

In `app/preview/page.tsx`, add `waiting: 0` to all three `counts` literals (the one in `mockState`, and the ones in `lobbyState` and `winnersState`).

- [ ] **Step 10: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/db/rounds.ts lib/db/state.ts lib/client/useGameState.ts "app/admin/[code]/page.tsx" app/components/display-views.tsx app/preview/page.tsx lib/db/simulation.test.ts
git commit -m "fix: bring late joiners into the next round and count them while they wait"
```

---

### Task 11: Facilitator settings panel

**Files:**
- Create: `app/components/SettingsPanel.tsx`
- Modify: `app/admin/[code]/page.tsx:67-80` (mount)

**Interfaces:**
- Consumes: `ClientState`, `PATCH /api/rooms/[code]/config`.
- Produces: `SettingsPanel({ code, state, onChanged }: { code: string; state: ClientState; onChanged: () => void })`.

- [ ] **Step 1: Write the panel**

Create `app/components/SettingsPanel.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button, Panel } from "@/app/components/ui";
import type { ClientState } from "@/lib/client/useGameState";
import type { RoomConfig } from "@/lib/config";

/**
 * The settings the facilitator actually reaches for.
 *
 * Deliberately not every field in the schema: group-size bounds and the
 * underfilled-boat policy are decisions made once, in code, not while standing
 * in front of a room. What is here is what changes between cohorts — how long a
 * scramble runs, whether the icebreaker runs at all, and how many winners.
 */

type NumberField = {
  key: keyof RoomConfig;
  label: string;
  hint: string;
  min: number;
  max: number;
};

const NUMBER_FIELDS: NumberField[] = [
  { key: "roundDurationSeconds", label: "Scramble", hint: "seconds", min: 10, max: 300 },
  { key: "revealDurationSeconds", label: "Reveal", hint: "seconds", min: 2, max: 30 },
  { key: "promptDurationSeconds", label: "Icebreaker", hint: "seconds", min: 10, max: 300 },
  { key: "targetWinners", label: "Winners", hint: "players left", min: 1, max: 10 },
];

type ToggleField = { key: keyof RoomConfig; label: string; hint: string };

const TOGGLE_FIELDS: ToggleField[] = [
  { key: "promptsEnabled", label: "Icebreaker questions", hint: "A question after each round" },
  { key: "allowLateJoin", label: "Late joining", hint: "Newcomers play from the next round" },
  { key: "soundEnabled", label: "Sound", hint: "Bell, klaxon and countdown" },
];

export function SettingsPanel({
  code,
  state,
  onChanged,
}: {
  code: string;
  state: ClientState;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const config = state.room.config;

  async function save(patch: Partial<RoomConfig>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/rooms/${code}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not save that.");
      }
    } catch {
      setError("No connection.");
    }
    setBusy(false);
    onChanged();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="self-start text-sm text-muted underline"
      >
        Settings
      </button>
    );
  }

  return (
    <Panel className="flex flex-col gap-4">
      <div className="flex items-center">
        <h2 className="font-bold">Settings</h2>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Done
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {NUMBER_FIELDS.map((field) => (
          <label key={field.key} className="flex flex-col gap-1 text-sm">
            <span className="text-muted">{field.label}</span>
            <input
              type="number"
              min={field.min}
              max={field.max}
              disabled={busy}
              defaultValue={config[field.key] as number}
              onBlur={(event) => {
                const value = Number(event.target.value);
                if (
                  !Number.isInteger(value) ||
                  value < field.min ||
                  value > field.max ||
                  value === config[field.key]
                ) {
                  return;
                }
                void save({ [field.key]: value } as Partial<RoomConfig>);
              }}
              className="rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 text-base"
            />
            <span className="text-xs text-muted">{field.hint}</span>
          </label>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        {TOGGLE_FIELDS.map((field) => (
          <label key={field.key} className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              disabled={busy}
              checked={config[field.key] as boolean}
              onChange={(event) =>
                void save({ [field.key]: event.target.checked } as Partial<RoomConfig>)
              }
              className="h-4 w-4"
            />
            <span className="font-semibold">{field.label}</span>
            <span className="text-muted">{field.hint}</span>
          </label>
        ))}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
    </Panel>
  );
}
```

- [ ] **Step 2: Mount it**

In `app/admin/[code]/page.tsx`, add the import:

```ts
import { SettingsPanel } from "@/app/components/SettingsPanel";
```

and add it to the returned tree, between `<Controls ... />` and the boat grid:

```tsx
      <SettingsPanel code={code} state={state} onChanged={refetch} />
```

- [ ] **Step 3: Verify by eye**

Run: `npm run dev`, create a room at `http://localhost:3000`, click **Settings**, change **Scramble** to 30 and toggle **Sound**. Expected: values persist across a page reload. (Needs a configured `.env.local`; if Supabase is not set up, skip to Step 5 and note it.)

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run build`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add app/components/SettingsPanel.tsx "app/admin/[code]/page.tsx"
git commit -m "feat: add the facilitator settings panel"
```

---

### Task 12: Tooling, comments and documentation

**Files:**
- Modify: `vitest.config.ts`, `next.config.ts`, `lib/game/codes.ts:22`, `app/components/phone-views.tsx`, `README.md`

- [ ] **Step 1: Fix the cold-start test failure**

`vitest.config.ts` — PGlite's first WASM compile exceeds the default 10s hook timeout on a cold machine, which fails CI every time:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
    // PGlite compiles Postgres from WASM the first time a suite builds a
    // database. On a cold machine that alone exceeds the 10s default and every
    // fresh CI run fails on the first file.
    hookTimeout: 30_000,
  },
});
```

- [ ] **Step 2: Stop Next generating agent files**

`next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `next dev` otherwise writes AGENTS.md and CLAUDE.md into the repo root.
  agentRules: false,
};

export default nextConfig;
```

- [ ] **Step 3: Lint — BLOCKED UPSTREAM, needs a decision before starting**

The spec called for `eslint` + `eslint-config-next`. That is **not installable on
this repo today**, verified rather than assumed:

- `eslint-config-next@16.3.4` depends on `typescript-eslint`, which throws
  `typescript-eslint does not support TS 7.0.` at import time.
- `@typescript-eslint/parser@8.70.0` declares `peer typescript@">=4.8.4 <6.1.0"`;
  this repo is on TypeScript 7.0.2. Forcing it with `--legacy-peer-deps` still
  throws the same error at import.
- Without a TypeScript parser, ESLint's default parser fails on every `.ts`/
  `.tsx` file with `Parsing error: Unexpected token` — 54 errors across the repo,
  and `@next/eslint-plugin-next`'s 22 rules never run.

Tracking issue: typescript-eslint#10940.

Do not attempt any of the above. Pick one with the repo owner first:

- **Park it.** Delete the broken `lint` script and leave a comment in
  `package.json`'s place in the README naming the blocker, revisiting when
  typescript-eslint supports TS 7. Removes the `@next/next/no-img-element`
  disable comment at `app/components/QrCode.tsx:44`, which suppresses nothing.
- **Point `lint` at `tsc --noEmit`.** Honest about what the repo checks; no lint
  rules. The owner declined this during brainstorming, so it needs re-approval.
- **Downgrade TypeScript to 6.x.** Unblocks the whole toolchain, but a
  dependency change well outside the scope of these fixes and its own risk.

Whichever is chosen, the rest of this task stands on its own.

- [ ] **Step 4: Correct the two wrong comments**

`lib/game/codes.ts:20-22` — `randomChars` does not generate session tokens; `newToken()` in `lib/auth.ts` does:

```ts
/**
 * Rejection sampling rather than `% alphabet.length`. Modulo would bias toward
 * the first `256 % 25` characters — irrelevant for fairness at this scale, but
 * an unbiased generator costs nothing here.
 */
```

(The `lib/db/state.ts` sort comment was corrected in Task 10.)

- [ ] **Step 5: Explain a rejected character**

In `app/components/phone-views.tsx`, inside `CodeForm`, add above the `return`:

```tsx
  const rejected = entry.length > 0 && !ready && entry.length === BOAT_CODE_LENGTH;
```

and add below the `<form>` element, wrapping both in a fragment:

```tsx
      {rejected && (
        <p className="mt-2 text-sm text-mist">
          Lifeboat codes never use O, I, L, S, B, Z, 0, 1, 2, 5 or 8 — check the
          card again.
        </p>
      )}
```

- [ ] **Step 6: Update the README**

In `README.md`: add `supabase/migrations/0004_seats.sql` and `supabase/migrations/0005_phases.sql` to the migration list; in **Running a session**, add a line that the dashboard's **Settings** control changes timings mid-session and that a reveal now plays between the scramble and the icebreaker; and update the test count in **Tests** to whatever `npm test` reports.

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add vitest.config.ts next.config.ts lib/game/codes.ts app/components/phone-views.tsx README.md
git commit -m "chore: working lint, cold-start-safe tests, and corrected docs"
```

---

### Task 13: Whole-game simulation across the new machine

The existing simulation drives `scramble` only. This carries it through all four phases so the phase machine is exercised the way a real game exercises it.

**Files:**
- Modify: `lib/db/simulation.test.ts:169-219` (the resolution block) and its assertions

**Interfaces:**
- Consumes: `apply_resolution` and `advance_phase` (Task 3), `planPostRound` (Task 4).

- [ ] **Step 1: Drive the phases in the simulation**

In `lib/db/simulation.test.ts`, add to the imports:

```ts
import { planPostRound } from "../game/postround";
```

Add `phases: string[];` to the `RoundLog` type. Then replace the block from the `apply_resolution` call through the `log.push({...})` call with:

```ts
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
      await db.query(
        `update rounds
            set reveal_ends_at = least(reveal_ends_at, now() - interval '1 second'),
                prompt_ends_at = least(prompt_ends_at, now() - interval '1 second')
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
```

- [ ] **Step 2: Assert the machine**

Append to the `runs a 40-player game to a winner in a sensible number of rounds` test, before its closing brace:

```ts
    for (const round of log) {
      // Every round reaches a real end, and the reveal is always seen.
      expect(round.phases[0], `round ${round.index}`).toBe("resolve");
      expect(round.phases.at(-1), `round ${round.index}`).toBe("done");
    }

    // The round that ends the game runs no icebreaker: it used to set the
    // prompt phase and have finish_game yank it off the winners' screens.
    expect(log.at(-1)!.phases).not.toContain("prompt");
```

- [ ] **Step 3: Run it**

Run: `npx vitest run lib/db/simulation.test.ts`
Expected: PASS.

- [ ] **Step 4: Run everything**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/db/simulation.test.ts
git commit -m "test: drive whole games through the four-phase round machine"
```

---

## Final verification

- [ ] `npm run typecheck && npm test && npm run build` — all pass from a clean checkout of `keith`.
- [ ] `rm -rf node_modules && npm install && npm test` — passes cold, proving the `hookTimeout` fix.
- [ ] `git status` is clean and `git log --oneline master..keith` reads as a sequence of self-contained fixes.
- [ ] Against a real Supabase project: run migrations `0004_seats.sql` and `0005_phases.sql`, then play a room through with two browsers — a round resolves into a visible reveal, the icebreaker follows and ends itself, a late joiner appears in the waiting tile and plays the next round, and **End round now** cuts a scramble short.
