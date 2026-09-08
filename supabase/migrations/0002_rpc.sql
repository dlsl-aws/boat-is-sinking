-- Atomic game operations.
--
-- Every function here takes `for update` on the boat or round row before it
-- reads counts, so concurrent callers serialise behind that lock. This is the
-- whole reason seat contention is correct: N+1 players racing for N seats all
-- queue on the same row, and exactly N inserts succeed. A read-then-write in
-- application code could not make that guarantee.
--
-- They return a jsonb result rather than raising, so the API layer can map each
-- failure to a specific message on the player's phone.

-- Claim the captaincy of a boat, taking seat 0.
create or replace function claim_captain(p_boat_id uuid, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_boat          boats%rowtype;
  v_round         rounds%rowtype;
  v_assigned_boat uuid;
  v_status        player_status;
  v_captain_name  text;
begin
  select * into v_boat from boats where id = p_boat_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no-such-boat');
  end if;

  select * into v_round from rounds where id = v_boat.round_id;
  if v_round.phase <> 'scramble' or now() >= v_round.ends_at then
    return jsonb_build_object('ok', false, 'reason', 'round-over');
  end if;

  select status into v_status from players where id = p_player_id;
  if v_status is distinct from 'alive' then
    return jsonb_build_object('ok', false, 'reason', 'not-playing');
  end if;

  select boat_id into v_assigned_boat
  from assignments where round_id = v_round.id and player_id = p_player_id;

  if v_assigned_boat is null or v_assigned_boat <> p_boat_id then
    return jsonb_build_object('ok', false, 'reason', 'wrong-boat');
  end if;

  if v_boat.captain_player_id is not null then
    -- Idempotent for the winner: a retry or a refresh hands their code back
    -- rather than telling them they lost their own captaincy.
    if v_boat.captain_player_id = p_player_id then
      return jsonb_build_object('ok', true, 'code', v_boat.code, 'seatIndex', 0);
    end if;
    select display_name into v_captain_name
    from players where id = v_boat.captain_player_id;
    return jsonb_build_object(
      'ok', false, 'reason', 'captain-taken', 'captainName', v_captain_name
    );
  end if;

  update boats set captain_player_id = p_player_id where id = p_boat_id;

  insert into seats (round_id, boat_id, player_id, seat_index)
  values (v_round.id, p_boat_id, p_player_id, 0)
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'code', v_boat.code, 'seatIndex', 0);
end;
$fn$;

-- Board a boat using the code the captain is holding up.
--
-- Addressed by code rather than boat id on purpose: the code is the thing the
-- player had to physically cross the room to obtain, and it is never broadcast.
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

  -- A real code, but for the wrong cohort. Returning the player's own symbol
  -- lets the UI say "you are an Octopus" instead of a bare rejection.
  if v_assigned_boat <> v_boat.id then
    return jsonb_build_object(
      'ok', false, 'reason', 'wrong-boat', 'ownSymbolId', v_own_symbol
    );
  end if;

  select * into v_existing
  from seats where round_id = p_round_id and player_id = p_player_id;

  if found then
    -- Already aboard the right boat, so a double-tap is harmless.
    return jsonb_build_object(
      'ok', true, 'seatIndex', v_existing.seat_index, 'alreadyAboard', true
    );
  end if;

  select count(*) into v_filled from seats where boat_id = v_boat.id;

  if v_filled >= v_boat.capacity then
    return jsonb_build_object('ok', false, 'reason', 'boat-full');
  end if;

  v_seat_index := v_filled;

  insert into seats (round_id, boat_id, player_id, seat_index)
  values (p_round_id, v_boat.id, p_player_id, v_seat_index);

  if v_seat_index + 1 >= v_boat.capacity then
    update boats set locked_at = now() where id = v_boat.id and locked_at is null;
    v_locked := true;
  end if;

  return jsonb_build_object(
    'ok', true,
    'seatIndex', v_seat_index,
    'filled', v_seat_index + 1,
    'capacity', v_boat.capacity,
    'locked', v_locked
  );
end;
$fn$;

-- Give every captain-less boat a captain.
--
-- The safety valve that stops an entire cohort drowning because nobody
-- volunteered. Idempotent and safe to call from several clients at once.
create or replace function promote_auto_captains(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_round    rounds%rowtype;
  v_boat     boats%rowtype;
  v_player   uuid;
  v_promoted jsonb := '[]'::jsonb;
begin
  select * into v_round from rounds where id = p_round_id;
  if not found
     or v_round.phase <> 'scramble'
     or now() >= v_round.ends_at
     or v_round.auto_captain_at is null
     or now() < v_round.auto_captain_at then
    return jsonb_build_object('promoted', v_promoted);
  end if;

  for v_boat in
    select * from boats
    where round_id = p_round_id and captain_player_id is null
    order by id
    for update
  loop
    -- Random, so the same person is not volunteered every round.
    select a.player_id into v_player
    from assignments a
    join players p on p.id = a.player_id
    where a.boat_id = v_boat.id and p.status = 'alive'
    order by random()
    limit 1;

    if v_player is not null then
      update boats set captain_player_id = v_player where id = v_boat.id;

      insert into seats (round_id, boat_id, player_id, seat_index)
      values (p_round_id, v_boat.id, v_player, 0)
      on conflict do nothing;

      v_promoted := v_promoted || jsonb_build_object(
        'boatId', v_boat.id, 'playerId', v_player, 'symbolId', v_boat.symbol_id
      );
    end if;
  end loop;

  return jsonb_build_object('promoted', v_promoted);
end;
$fn$;

-- Atomically take ownership of resolving a round.
--
-- Resolution fires lazily, triggered by whichever client notices the deadline
-- first, so several may race. This flips the phase exactly once and tells only
-- the winner to compute the outcome; everyone else just refetches state.
-- Keeping the rules themselves in TypeScript (lib/game/resolve.ts) means there
-- is one tested implementation rather than two that can drift apart.
create or replace function begin_resolve(p_round_id uuid)
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
    return jsonb_build_object('owned', false, 'reason', 'no-such-round');
  end if;
  if now() < v_round.ends_at then
    return jsonb_build_object('owned', false, 'reason', 'not-yet');
  end if;
  if v_round.phase <> 'scramble' then
    return jsonb_build_object('owned', false, 'reason', 'already-resolved');
  end if;

  update rounds set phase = 'resolve' where id = p_round_id;

  return jsonb_build_object('owned', true);
end;
$fn$;

-- Write a computed resolution. Idempotent: re-running with the same lists is a
-- no-op, so a retry after a network failure cannot double-eliminate anyone.
create or replace function apply_resolution(
  p_round_id       uuid,
  p_survivor_ids   uuid[],
  p_eliminated_ids uuid[],
  p_next_phase     round_phase,
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
     set phase          = p_next_phase,
         prompt_ends_at = p_prompt_ends_at,
         resolved_at    = coalesce(resolved_at, now())
   where id = p_round_id;

  return jsonb_build_object('ok', true);
end;
$fn$;
