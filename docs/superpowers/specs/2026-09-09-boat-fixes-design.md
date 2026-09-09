# Design: correctness fixes and facilitator controls

Date: 2026-09-09
Branch: `keith`
Status: approved in chat, pending spec review

## Why

A read of the whole codebase turned up eight defects plus a ninth found while
tracing the fourth. Two of them break a live game outright: everyone who joins
after the host presses Start is silently removed from play, and a boarding
attempt can crash with a `500` after the host kicks somebody. The rest range
from a cancelled icebreaker to a lint script that has not run since the Next 16
upgrade.

This spec covers all of them, plus the facilitator settings panel the config
endpoint has always lacked a caller for.

## Verified before designing

Three claims this design rests on, checked against real Postgres (PGlite) rather
than assumed:

1. Adding a parameter to `create or replace function` produces a **second
   overload** — `pg_proc` went from one row to two. It does not replace the
   original. With `supabase-js.rpc()` sending named arguments, a stale overload
   left behind is a live hazard.
2. `create or replace function` renaming an input parameter fails:
   `cannot change name of input parameter`.
3. Changing a function's return type in place fails: `cannot change return type
   of existing function`.

Therefore **any RPC whose signature changes gets an explicit `drop function`
before it is recreated.** Functions whose signature is unchanged may keep using
`create or replace`.

A fourth was reproduced with a throwaway PGlite test: with seats 0, 1 and 2
claimed, deleting the player holding seat 1 makes the next boarder collide on
`seats_boat_id_seat_index_key`. That test was deleted; the behaviour it proved
is fixed in section 3 and re-tested for real in section 7.

## 1. The post-round phase machine

Fixes: the cancelled final-round icebreaker (#3), the prompt phase that never
ends (#4), and the reveal nobody ever sees (#9).

### The defect

`maybeResolveRound` (`lib/db/rounds.ts:130-224`) calls `begin_resolve`, which
sets phase `resolve`, and then `apply_resolution`, which sets phase `prompt` —
both inside a single request with no beat between them. The `resolve` phase
therefore exists for one Supabase round-trip. Clients poll every five seconds
and refetch when their resolve POST returns, so in practice none of them ever
samples it.

Three things hang off that phase and are consequently dead whenever prompts are
enabled: the projector's `Aftermath` view with its "3 overboard!" headline and
sinking name badges (`app/display/[code]/page.tsx:104-105`), the player's
`Survived` screen, and the display's `splash` cue, which is edge-triggered on
`resolve` following `scramble` (`lib/client/useGameFeedback.ts:94`).

Separately, nothing moves a round out of `prompt`. `prompt_ends_at` is written
and both surfaces count down to it, but only the host's "Skip icebreaker" or
"Next round" actually ends it, so the timer reaches zero and freezes.

And when the last round leaves only the winners, `apply_resolution` sets phase
`prompt` and broadcasts `prompt:started`, after which `finish_game`
(`supabase/migrations/0003_rounds.sql:102`) runs `update rounds set phase='done'
where phase <> 'done'` and yanks it away.

### The design

Every phase gets its own server-issued deadline, advanced by the same
opportunistic mechanism `begin_resolve` already uses:

```
scramble --ends_at--> resolve --reveal_ends_at--> prompt --prompt_ends_at--> done
                          |
                          +--------------------------------------------> done   (game-ending round)
```

A game-ending round skips the prompt entirely and goes to the trophy after its
reveal. That is not a special case bolted on: `maybeResolveRound` computes
whether the game is ending **before** it decides whether a prompt follows, and
the correct behaviour falls out of the ordering.

### Migration `0004_phases.sql`

- `alter table rounds add column reveal_ends_at timestamptz`
- `drop function apply_resolution(uuid, uuid[], uuid[], round_phase, timestamptz)`,
  then recreate as `apply_resolution(p_round_id uuid, p_survivor_ids uuid[],
  p_eliminated_ids uuid[], p_reveal_ends_at timestamptz)`. It always lands the
  round in `resolve` and sets `reveal_ends_at`. The existing idempotency guard —
  return early when `resolved_at is not null` — is kept verbatim, since it is
  what stops a replay double-incrementing `rounds_survived`.
- New `advance_phase(p_round_id uuid, p_prompt_ends_at timestamptz)`. Takes
  `for update` on the round, compares the **database** clock against the current
  phase's deadline, and moves `resolve → prompt` (when `p_prompt_ends_at` is
  given), `resolve → done` (when it is null) or `prompt → done`. Returns `jsonb`
  carrying the resulting phase and whether this caller was the one that moved
  it, so only that caller broadcasts. Idempotent and safe under a room full of
  racing clients, exactly like `begin_resolve`.

  It has no "finish the game" parameter. Ending the game stays a TypeScript
  decision made by the caller, which calls `finish_game` after `advance_phase`
  reports a game-ending round reaching `done`. Both `maybeResolveRound` and
  `maybeAdvancePhase` learn whether a round is game-ending from the same pure
  function described in section 7, so the answer cannot drift between them.
- `finish_game` keeps its `update rounds set phase = 'done'`, but it is now only
  ever called on a round already in `done`, so it has nothing to stomp.

Whether a prompt follows stays a TypeScript decision, passed in as
`p_prompt_ends_at` with `null` meaning "skip to done". This preserves the
existing rule that game rules live in one tested place rather than being
duplicated in SQL.

### Application changes

- `lib/db/rounds.ts`
  - `maybeResolveRound` decides `gameEnding` before `runPrompt`, calls
    `apply_resolution` with `reveal_ends_at = now + revealDurationSeconds`, and
    no longer calls `finish_game`.
  - New `maybeAdvancePhase(room)`: reads the current round, calls
    `advance_phase` when a deadline has passed, calls `finish_game` and
    broadcasts `game:over` when a game-ending round reaches `done`.
- `app/api/rooms/[code]/state/route.ts` calls `maybeAdvancePhase` after
  `maybeResolveRound`, alongside the existing auto-captain promotion.
- `app/api/rounds/[id]/resolve/route.ts` runs both, so one client POST advances
  whatever is due. `force` keeps its host-only check.
- `lib/client/useCountdown.ts`: `useResolveOnDeadline` generalises to
  `usePhaseDeadline`, firing on whichever of `ends_at`, `reveal_ends_at` or
  `prompt_ends_at` belongs to the current phase. The existing jitter and
  fire-once-per-round guard are kept, with the guard keyed on round id **and**
  phase so all three transitions can fire across one round's life.

### Presentation

- `resolve` renders `Aftermath` on the projector — the reveal it was written for.
- `done` gets a new quiet between-rounds view. Today `done` also maps to
  `Aftermath`, so after the icebreaker the projector would replay "3 overboard!".
- New config field `revealDurationSeconds`, default 6, range 2-30.

### New events

`round:resolved` already exists and now genuinely means "the reveal is up".
`prompt:started` is unchanged. A `round:done` event is added to
`gameEventSchema` and to `REFETCH_EVENTS`, so clients leave the prompt promptly
rather than waiting for a poll. It carries only the round id: like every other
event here it is a notification, never state.

## 2. Late joiners

Fixes: spectators stranded forever (#1), and the `alive` count drifting on a
mid-game join (nit).

`app/api/rooms/[code]/join/route.ts:78` gives anyone joining a non-lobby room
`status: 'spectator'`, and the phone tells them "You're up next round"
(`app/play/[code]/page.tsx:522`). Nothing ever promotes them: `startRound`
selects `status = 'alive'` only, so the sole ways back are the host reviving each
person by hand or a full Reset. With `allowLateJoin` defaulting to true, every
late scan of the QR code is silently eliminated while being told otherwise.

**Design.** `startRound` promotes every spectator in the room to `alive` as its
first action. Promotion has to precede the alive-list read, because assignments
are computed in TypeScript from that list.

Promotion is unconditional — it does not consult `allowLateJoin`. With late join
off, `join` returns `409` and no spectator is ever created, so the only way to
hold that status is the host setting it by hand; sweeping those players back in
at the next round is the behaviour the dashboard's "waiting" tile advertises.
A host who wants somebody out has `eliminated` and `kick`.

`GameState.counts` gains `waiting`, counting spectators. The dashboard grows a
fifth tile; the projector shows a "N waiting to play" line in the lobby and
during a scramble. `useGameState`'s `player:joined` handler
(`lib/client/useGameState.ts:98-120`) stops incrementing `alive` unconditionally
and increments `waiting` when the room is not in the lobby — the same bug seen
from the client side.

The phone's existing copy becomes true and is left alone.

## 3. `claim_seat`

Fixes: the crash after a kick (#2), and a lock condition found while tracing it.

`supabase/migrations/0002_rpc.sql:138-152` derives the new seat from
`count(*)`, but seats are deletable — kicking a player cascade-deletes their seat
row. Reproduced: seats 0, 1, 2 claimed, the seat-1 holder kicked, next boarder
computes index 2 and violates `seats_boat_id_seat_index_key`. The function
raises instead of returning a reason, so `/board` answers `500` and that player
can never get aboard.

**Design.** Two changes inside `claim_seat`, whose signature is unchanged, so
`create or replace` is safe:

- `select coalesce(max(seat_index) + 1, 0) into v_seat_index from seats where boat_id = v_boat.id;`
  Capacity is still checked against `count(*)`, so a freed seat remains usable;
  `seat_index` becomes a monotonic identity rather than a position.
- The lock condition moves from the index to the count. `v_seat_index + 1 >=
  capacity` is index-based, so once indices outrun positions after a kick it
  locks a boat that is not full. It becomes `v_filled + 1 >= v_boat.capacity`.

Cosmetic follow-on: the dashboard renders `#{seat.index + 1}`, which would read
"#5" on a four-seat boat. It renders list position instead.

## 4. Ending a round early

Fixes: the two-clock race in force-resolve (#8).

`app/api/rounds/[id]/resolve/route.ts:42` writes `ends_at` from the Node clock,
while `begin_resolve` compares it against Postgres `now()`. If the database
clock trails the application's, "End round now" silently does nothing until the
drift elapses. `supabase/migrations/0003_rounds.sql` states the rule this
violates: deadlines come from the database clock, because that is what the
guards compare against.

**Design.** New `end_round_now(p_round_id uuid, p_room_id uuid)` sets `ends_at =
now()` from the database clock, scoped to the room. `maybeResolveRound` gains an
option to skip its TypeScript pre-check on the forced path, so Postgres is the
only clock involved — otherwise the identical skew simply bites in the other
direction.

## 5. Facilitator settings

Fixes: the config endpoint with no caller, and two dead fields (#7).

`PATCH /api/rooms/[code]/config` works and nothing calls it, so round duration,
prompt duration, sound and target winners are reachable only with `curl`. Two
schema fields are dead in a second sense: `profanityFilter` is never read
(`checkName` always filters) and `autoPlan` is never read (auto versus manual is
decided by whether the dashboard sends `targetGroupSize`).

**Design.** New `app/components/SettingsPanel.tsx`, host-only, wired to the
existing endpoint and refetching after a save. It exposes:

| Field | Control |
| --- | --- |
| `roundDurationSeconds` | number, 10-300 |
| `revealDurationSeconds` | number, 2-30 |
| `promptDurationSeconds` | number, 10-300 |
| `promptsEnabled` | toggle |
| `targetWinners` | number, 1-10 |
| `allowLateJoin` | toggle |
| `soundEnabled` | toggle |

`autoPlan` and `profanityFilter` are removed from `roomConfigSchema`. Zod strips
unknown keys, so rooms created before this change still parse through
`parseConfig` and no data migration is needed. `minGroupSize`, `maxGroupSize` and
`underfilledBoatPolicy` stay as code defaults — nobody adjusts them mid-session.

The panel lives in its own file rather than growing
`app/admin/[code]/page.tsx` past its current 556 lines.

## 6. Tooling and documentation

- **#5, lint.** `next lint` was removed in Next 16 and now reads `lint` as a
  directory: `Invalid project directory provided, no such directory: .../lint`.
  Add `eslint` and `eslint-config-next` as devDependencies plus a flat
  `eslint.config.mjs`, and change the script to `eslint .`. This also gives
  meaning to the `@next/next/no-img-element` disable comment at
  `app/components/QrCode.tsx:44`, which currently suppresses nothing.
- **#6, cold-start test failure.** A first `npm test` on a cold machine fails
  with `Hook timed out in 10000ms` in `lib/db/rpc.test.ts`, because PGlite's
  first WASM compile exceeds vitest's default `hookTimeout`; a warm re-run passes
  57/57. Set `hookTimeout: 30000` in `vitest.config.ts`. `beforeEach` keeps
  building a fresh database, since per-test isolation is worth more than the
  seconds.
- **Generated agent files.** `next dev` writes `AGENTS.md` and `CLAUDE.md` at the
  repo root; both are untracked and absent from the initial commit. Set
  `agentRules: false` in `next.config.ts`, which is the switch the dev server
  itself names.
- **Wrong comments.** `lib/db/state.ts:231` says boats are sorted "by the symbol
  pool's own order" when it is `localeCompare` on `symbol_id`, i.e.
  alphabetical. `lib/game/codes.ts:22` says `randomChars` "is the same helper
  that generates session tokens"; those come from `newToken()` in `lib/auth.ts`.
- **Code entry hint.** `normalizeCode` accepts characters excluded from the
  alphabet (`O`, `1`, `S`), after which the Board button simply stays disabled
  with no explanation. Add a hint naming the character, keeping the deliberate
  refusal to guess a substitution.
- **README.** The migration list gains `0004_phases.sql`; "Running a session"
  gains the settings panel and the reveal beat; the test count is updated.

## 7. Testing

No new dependencies. Coverage follows the shape the repo already uses.

**PGlite (`lib/db/rpc.test.ts`)**
- `claim_seat` after a kick: the reproduced collision, now succeeding.
- The lock fires on the count reaching capacity, not on the index.
- `advance_phase`: before the deadline, wrong phase, replayed, and two callers
  racing — exactly one reports having moved it.
- `apply_resolution` under its new signature stays idempotent, and a replay does
  not double-increment `rounds_survived`.
- `end_round_now` sets `ends_at` such that `begin_resolve` immediately grants
  ownership.

**Pure functions (`lib/game/`)**
- The prompt-versus-finish decision is extracted out of `maybeResolveRound` into
  a pure function so it is testable without a database: given survivors, config
  and the next viable shape, does this round run a prompt, and does the game end?
  The game-ending round producing no prompt is asserted here.

**Simulation (`lib/db/simulation.test.ts`)**
- Whole games are driven through all four phases rather than scramble alone,
  asserting the field thins every round, the final round carries no prompt, and a
  spectator who joins mid-game is playing by the next round.

## 8. Out of scope

Named so nobody has to wonder whether they were forgotten:

- Sharks mode, anti-clique assignment, CSV export, round modifiers and
  tap-to-board — all listed as deliberate omissions in the README and untouched.
- Client hook tests. Covering `useGameState` and the countdown hooks needs jsdom
  and `@testing-library/react`; the client half stays covered by typecheck and
  build.
- Restructuring `app/admin/[code]/page.tsx`. Only the new settings panel is
  extracted; the rest of the dashboard is left alone.

## 9. Order of work

The migration is the spine and everything in section 1 depends on it.

1. `0004_phases.sql` with its PGlite tests — sections 1 and 3 share the file.
2. `claim_seat` fixes (section 3), independently testable.
3. The phase machine in `lib/db/rounds.ts` and the state route (section 1).
4. Client deadline handling and the display views (section 1).
5. Spectator promotion and the waiting count (section 2).
6. `end_round_now` (section 4).
7. Settings panel and config cleanup (section 5).
8. Tooling, comments, README (section 6).
9. Simulation tests across the finished machine (section 7).
