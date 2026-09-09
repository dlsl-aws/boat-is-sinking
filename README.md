# The Boat Is Sinking

A live icebreaker for a room full of people. The projector shows a QR code,
everyone joins on their phone, and each round the system hands every player a
**symbol** — they have to physically find the others holding it and claim a seat
on the lifeboat before the timer runs out.

Three surfaces, one room:

| Route | Who | What it shows |
| --- | --- | --- |
| `/display/[code]` | The projector | QR, countdown, live boat grid, the reveal |
| `/play/[code]` | Every phone | One symbol, one number, one action |
| `/admin/[code]` | The facilitator | Status, roster, boat grid, controls |

---

## How a round works

1. **Briefing.** The system splits the alive players across `floor(alive / N)`
   lifeboats, each with exactly `N` seats, and gives everyone a symbol.
2. **Scramble.** One player per cohort taps **I'm the Captain** and gets a
   4-character code. They shout it; everyone else has to *physically find them*
   and type it in. The boat locks when it fills.
3. **Resolve.** Anyone without a seat is in the water.
4. **Icebreaker.** Each surviving boat gets a question with its own short timer.
   This is the part that actually breaks ice — the elimination just keeps
   forcing fresh groups together.

### Why anyone drowns

Survivors are always `boats × N`, so the *count* is fixed before anyone moves —
but the *identity* is not. Cohorts are sized `N` or `N+1`, and an overflow
player's screen is identical to a safe player's. Nobody can tell whether they're
contested, so everybody scrambles. It's musical chairs.

### The divisibility trap

If the alive count divides evenly by `N`, there are exactly enough seats and
**nobody is eliminated**. At 40 players, `N` of 2, 4, 5 or 8 all eliminate
nobody — and even the best natural round only removes `N-1` people, because
that's all the remainder can be.

So withholding boats is the primary pace control, not an edge case:
dropping `k` boats eliminates `(alive mod N) + k × N`. The planner
(`lib/game/plan.ts`) handles this automatically and the dashboard warns loudly
if a hand-picked `N` would eliminate nobody.

---

## Setup

### 1. Create a Supabase project

Free tier is plenty — this needs ~42 concurrent realtime connections against a
limit of 200. From **Project Settings → API**, copy the project URL, the `anon`
key, and the `service_role` key.

### 2. Run the migrations

In the Supabase SQL editor, run these in order:

```
supabase/migrations/0001_init.sql
supabase/migrations/0002_rpc.sql
supabase/migrations/0003_rounds.sql
supabase/migrations/0004_seats.sql
supabase/migrations/0005_phases.sql
```

### 3. Configure the environment

```bash
cp .env.example .env.local
```

Fill in the three Supabase values. `SUPABASE_SERVICE_ROLE_KEY` is server-only —
it bypasses RLS and must never reach a browser.

### 4. Run it

```bash
npm install && npm run dev
```

> **Testing on real phones locally?** Set `NEXT_PUBLIC_SITE_URL` to your
> laptop's LAN address (`http://192.168.1.x:3000`). A QR code pointing at
> `localhost` resolves to the *phone*, which is the single most common way this
> fails at an event.

### 5. Deploy

Push to Vercel and set the same three environment variables. `NEXT_PUBLIC_SITE_URL`
can be left unset — it falls back to the Vercel deployment URL.

---

## Architecture

Vercel functions can't hold the WebSockets this needs. Native support exists but
connections die at the function's max duration, and there's no cross-instance
broadcast — a room's 40 players would land on different instances with no way to
reach each other. So no long-lived connections run on Vercel at all:

| Concern | Handled by |
| --- | --- |
| Game logic and writes | Next.js route handlers (service-role key) |
| Durable state | Supabase Postgres |
| Realtime fan-out | Supabase Realtime Broadcast |
| The countdown | **Nothing** — clients count down to a server-issued deadline |

Three properties make this hold up in front of a real room:

**Realtime is never the source of truth.** Broadcasts are notifications. Every
client refetches the authoritative snapshot on mount, on reconnect, and on tab
focus. A dropped message costs latency, never correctness.

**The timer is never streamed.** The server sets `ends_at` once; each client
measures its own clock offset and ticks locally at 60fps. A 45-second round with
40 phones generates almost no realtime traffic.

**Nothing runs on a schedule.** Serverless has no background worker, so the two
things that must happen on a timer — appointing a captain nobody volunteered
for, and resolving a round at its deadline — are driven opportunistically by
whichever client notices first. Both are idempotent, both check the *database*
clock, and `begin_resolve` grants ownership to exactly one caller. A round
therefore can't get stuck because a browser was backgrounded, and can't be ended
early by a phone with a fast clock.

### Game integrity

The mechanic only works if you can't find your group without talking to anyone,
so two things are **never broadcast and never in a shared view**:

- **Boat codes** — returned only in the captain's own HTTP response.
- **Symbol assignments** — returned only by the per-player state projection.

RLS is on with no anon policies, so the browser can't read these tables even
with the anon key in hand. `lib/db/state.ts` is the single projection boundary.

---

## Design

Three surfaces with genuinely different jobs, one visual world.

| Surface | Job | Consequence |
| --- | --- | --- |
| Projector | A **stage** | Nothing small, nothing colour-only, one idea at a time |
| Phone | A **tool held at arm's length while moving** | One glance, one action, nothing else |
| Dashboard | An **instrument panel** | Dense, calm, scannable under pressure |

### The ideas that carry it

**The phone becomes a beacon.** During a scramble the whole screen glows in the
player's symbol colour, so a room of forty people visibly sorts itself into
colour-coded clusters. It can't be used to cheat — the code is still the only
way aboard — it just moves the bottleneck off *searching* and onto the talking,
which is the part worth spending forty-five seconds on.

**The water level is the countdown.** The sea rises as the round drains, and
turns red in the last ten seconds. Someone at the back who can't read the digits
can still see how much time is left, so the room keeps its head up and keeps
moving instead of staring at a clock. It's capped at 42% of screen height —
past that the crest starts slicing the boat grid, and a hard band across the
content reads as a rendering glitch rather than as a sea.

**The captain's code is a physical artifact, not a UI element.** It gets held
above a head and read from three metres by people who are moving: enormous,
near-black on gold, widely letterspaced, and shimmering to catch the eye in a
room where thirty other phones are already lit.

**Sound is synthesised, not loaded.** `lib/client/sound.ts` builds every cue
from oscillators and filtered noise — a struck ship's bell with real inharmonic
partials, a klaxon, a splash, an arpeggio when a boat locks. No audio assets to
host, nothing to fail on venue wifi, and the whole palette stays tunable by
changing a number. The countdown tick climbs in pitch and volume over the final
fifteen seconds, which moves a room more than anything on screen does.

**Cues are edge-triggered, in one place.** `useGameFeedback` maps state
*transitions* to sound and haptics. Nothing is level-triggered, so the
five-second state refetch can't machine-gun a cue, and no cue can fire twice
from two render paths.

### Accessibility

- Every symbol carries **emoji + name + colour**. "I'm the purple one" fails the
  moment two colours look alike on a washed-out projector, so colour is only ever
  decoration on top of two channels that already work without it.
- Boat state is carried by border, fill, icon **and** a word — never colour alone.
- `prefers-reduced-motion` disables every animation and the confetti. Nothing is
  communicated by motion alone, so nothing is lost.
- Haptics are additive; `navigator.vibrate` is absent on iOS Safari and no state
  depends on it.
- 16px minimum input font, so iOS doesn't zoom the page when a player taps the
  code field with ten seconds left.

### `/preview` — the design harness

```
/preview
```

Every projector phase and every phone state, on demand, against mock data — so
the display can be tuned without standing up a room of forty people first. It
mounts the *same* components the real surfaces use (`app/components/display-views.tsx`
and `phone-views.tsx`), which is the point: there's no parallel "design version"
that can drift out of sync with what a room actually sees.

Not linked from anywhere in the game; it costs one static route.

---

## Tests

```bash
npm test
```

75 tests. The interesting ones:

- **`lib/db/rpc.test.ts`** runs the migrations against real Postgres (PGlite,
  compiled to WASM) and exercises the N+1 race: six players holding one symbol,
  five seats, exactly five succeed. Also covers idempotent replays, wrong-boat
  rejection, and the auto-captain safety valve.
- **`lib/db/simulation.test.ts`** plays whole games end to end — 40 players,
  randomised boarding order, players who never reach their boat, and a run where
  *nobody ever volunteers as captain* — asserting every round thins the field and
  the game converges in 4–10 rounds.
- **`lib/game/plan.test.ts`** proves the planner converges from every room size
  from 4 to 60 and never proposes a round that eliminates nobody.
- **`lib/game/names.test.ts`** includes the Scunthorpe cases, because rejecting
  someone's real name in front of a room is worse than the word it blocked.

The one thing the SQL tests can't cover is genuine lock contention — PGlite is a
single embedded instance, so `for update` waiters never queue. What's verified is
that the *sequence* is correct; the row lock is what preserves it under real
concurrency.

---

## Lint

There is currently no `npm run lint` script. TypeScript-ESLint does not yet support
TypeScript 7 (tracking issue [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)),
so ESLint cannot run on this codebase until it does. The `npm run typecheck` command
covers type correctness.

---

## Running a session

1. Open `/admin`, hit **Create a room**, open the projector view on the big screen.
2. Let people join. Watch the count.
3. **Start the game.** Leave group size on **Auto** unless you want a specific one.
4. Between rounds, glance at the boat grid. A boat outlined in amber has no
   captain yet — that's your cue to shout.
5. Mid-scramble, the **still swimming** filter is the list of who to chase.

Facilitator notes:

- The dashboard is the only place boat codes appear on a shared screen. If a
  captain's phone dies, read their code out.
- **End round now** cuts a scramble short when the room has clearly finished.
- **Reset** keeps everyone and starts a fresh game — useful between cohorts.
- The **If you start now** panel projects the remaining rounds and rough
  duration, so you can see before starting whether it fits your slot.
- The **Settings** panel on the dashboard adjusts round timings and other
  parameters mid-session, and a short reveal animation plays between the
  scramble and the icebreaker.

---

## Not built (deliberately)

Scoped out, with room left in the schema:

- **Sharks mode** — something for eliminated players to do. In a 40-person room
  half the players are out by round four, and a dead phone screen is where the
  energy goes. Highest-value addition.
- **Anti-clique assignment** — track who has shared a boat with whom and bias
  against repeats, ending with "you met 14 new people".
- **CSV export** — freeze a round's boats as the workshop's breakout groups.
- **Round modifiers** — silent rounds, mixed-colour requirements, reverse rounds.
- **Tap-to-board** — a digital fallback for hybrid attendees.
