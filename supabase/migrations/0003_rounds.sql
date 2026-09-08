-- Round creation, as one atomic operation.
--
-- A round is only meaningful together with its boats and its assignments. If the
-- round row committed but the assignments did not, every phone would show a
-- countdown with no symbol on it, mid-event, with no way to recover. Doing the
-- whole thing in one function makes that state unreachable.
--
-- It also sets `ends_at` from the database clock rather than the caller's.
-- `claim_seat` and `begin_resolve` both compare against Postgres `now()`, so the
-- deadline has to come from the same clock or a skew between the serverless
-- function and the database would silently shorten or extend the round.
create or replace function create_round(
  p_room_id             uuid,
  p_target_group_size   int,
  p_boats_removed       int,
  p_duration_seconds    int,
  p_auto_captain_seconds int,
  p_prompt_id           text,
  p_boats               jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_index    int;
  v_round_id uuid;
  v_boat     jsonb;
  v_boat_id  uuid;
  v_player   jsonb;
  v_alive    int;
begin
  select coalesce(max(round_index) + 1, 0) into v_index
  from rounds where room_id = p_room_id;

  insert into rounds (
    room_id, round_index, target_group_size, boats_removed,
    phase, prompt_id, starts_at, ends_at, auto_captain_at
  )
  values (
    p_room_id, v_index, p_target_group_size, p_boats_removed,
    'scramble', p_prompt_id, now(),
    now() + make_interval(secs => p_duration_seconds),
    now() + make_interval(secs => p_auto_captain_seconds)
  )
  returning id into v_round_id;

  for v_boat in select * from jsonb_array_elements(p_boats)
  loop
    insert into boats (round_id, symbol_id, capacity, code)
    values (
      v_round_id,
      v_boat ->> 'symbolId',
      (v_boat ->> 'capacity')::int,
      upper(v_boat ->> 'code')
    )
    returning id into v_boat_id;

    for v_player in select * from jsonb_array_elements(v_boat -> 'playerIds')
    loop
      insert into assignments (round_id, player_id, boat_id, symbol_id)
      values (
        v_round_id,
        (v_player #>> '{}')::uuid,
        v_boat_id,
        v_boat ->> 'symbolId'
      );
    end loop;
  end loop;

  select count(*) into v_alive from players
  where room_id = p_room_id and status = 'alive';

  update rooms
     set current_round_id = v_round_id,
         status           = 'in_progress',
         -- Captured once. The planner ramps difficulty against the room's
         -- original size, so it must not drift as players are eliminated.
         initial_alive    = coalesce(initial_alive, v_alive),
         symbol_offset    = symbol_offset + jsonb_array_length(p_boats)
   where id = p_room_id;

  return jsonb_build_object(
    'ok', true,
    'roundId', v_round_id,
    'roundIndex', v_index,
    'endsAt', (select ends_at from rounds where id = v_round_id)
  );
end;
$fn$;

-- Finish a game: everyone still alive is a winner.
create or replace function finish_game(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update rooms set status = 'finished' where id = p_room_id;
  update rounds set phase = 'done'
   where room_id = p_room_id and phase <> 'done';
  return jsonb_build_object('ok', true);
end;
$fn$;
