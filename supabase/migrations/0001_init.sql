-- "The Boat Is Sinking" — core schema.
--
-- Every table is server-authoritative. RLS is enabled with no anon policies, so
-- the browser can never read or write these directly; all access goes through
-- Next.js route handlers using the service-role key. That is deliberate: a
-- player who could SELECT `assignments` or `boats` would see everyone's symbol
-- and every boat code, and could board without ever leaving their chair, which
-- is precisely the behaviour the game exists to prevent.

-- `gen_random_uuid()` is core Postgres since 13, so no pgcrypto extension
-- is required.
create type room_status  as enum ('lobby', 'in_progress', 'finished');
create type player_status as enum ('alive', 'eliminated', 'spectator');
create type round_phase   as enum ('briefing', 'scramble', 'resolve', 'prompt', 'done');

create table rooms (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  status            room_status not null default 'lobby',
  host_token_hash   text not null,
  config            jsonb not null default '{}'::jsonb,
  current_round_id  uuid,
  -- Captured when the first round starts. The planner ramps difficulty against
  -- the room's original size, so it must not drift as players are eliminated.
  initial_alive     int,
  -- Rotates the symbol pool between rounds so consecutive rounds look different.
  symbol_offset     int not null default 0,
  created_at        timestamptz not null default now()
);

create table players (
  id                 uuid primary key default gen_random_uuid(),
  room_id            uuid not null references rooms(id) on delete cascade,
  display_name       text not null,
  -- Case- and accent-folded form. The unique index below is what actually stops
  -- two people called "Sam" existing in one room.
  name_key           text not null,
  avatar_seed        text not null,
  avatar_color       text not null,
  session_token_hash text not null,
  status             player_status not null default 'alive',
  joined_at          timestamptz not null default now(),
  eliminated_at      timestamptz,
  eliminated_round   int,
  rounds_survived    int not null default 0,
  last_seen_at       timestamptz not null default now()
);

create unique index players_room_name_key_idx on players (room_id, name_key);
create unique index players_session_idx       on players (session_token_hash);
create index        players_room_idx          on players (room_id);

create table rounds (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references rooms(id) on delete cascade,
  round_index       int not null,
  target_group_size int not null check (target_group_size >= 2),
  boats_removed     int not null default 0 check (boats_removed >= 0),
  phase             round_phase not null default 'briefing',
  prompt_id         text,
  starts_at         timestamptz not null default now(),
  -- The single source of truth for the countdown. Clients render against this
  -- rather than receiving ticks, which is what keeps realtime traffic near zero.
  ends_at           timestamptz not null,
  prompt_ends_at    timestamptz,
  resolved_at       timestamptz,
  -- After this instant a boat with no captain gets one assigned. Without it a
  -- whole cohort can drown because nobody volunteered.
  auto_captain_at   timestamptz,
  unique (room_id, round_index)
);

alter table rooms
  add constraint rooms_current_round_fk
  foreign key (current_round_id) references rounds(id) on delete set null;

create table boats (
  id                uuid primary key default gen_random_uuid(),
  round_id          uuid not null references rounds(id) on delete cascade,
  symbol_id         text not null,
  capacity          int not null check (capacity >= 2),
  code              text not null,
  captain_player_id uuid references players(id) on delete set null,
  locked_at         timestamptz,
  -- One cohort per symbol, and codes distinct within a round: a duplicate would
  -- let a player board the wrong boat with a correct-looking code.
  unique (round_id, symbol_id),
  unique (round_id, code)
);

create index boats_round_idx on boats (round_id);

create table assignments (
  round_id   uuid not null references rounds(id) on delete cascade,
  player_id  uuid not null references players(id) on delete cascade,
  boat_id    uuid not null references boats(id) on delete cascade,
  symbol_id  text not null,
  primary key (round_id, player_id)
);

create index assignments_boat_idx on assignments (boat_id);

create table seats (
  id         uuid primary key default gen_random_uuid(),
  round_id   uuid not null references rounds(id) on delete cascade,
  boat_id    uuid not null references boats(id) on delete cascade,
  player_id  uuid not null references players(id) on delete cascade,
  seat_index int not null check (seat_index >= 0),
  claimed_at timestamptz not null default now(),
  -- These two constraints are what make the N+1 race correct under concurrency.
  -- The first caps a boat at its capacity; the second stops one player holding
  -- seats on two boats in the same round.
  unique (boat_id, seat_index),
  unique (round_id, player_id)
);

create index seats_boat_idx on seats (boat_id);

-- Per-round record of who drowned, so the admin dashboard can show an
-- elimination feed and a post-game debrief without recomputing history.
create table eliminations (
  round_id   uuid not null references rounds(id) on delete cascade,
  player_id  uuid not null references players(id) on delete cascade,
  boat_id    uuid references boats(id) on delete set null,
  reason     text not null,
  created_at timestamptz not null default now(),
  primary key (round_id, player_id)
);

alter table rooms        enable row level security;
alter table players      enable row level security;
alter table rounds       enable row level security;
alter table boats        enable row level security;
alter table assignments  enable row level security;
alter table seats        enable row level security;
alter table eliminations enable row level security;
