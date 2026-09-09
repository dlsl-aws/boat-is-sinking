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
