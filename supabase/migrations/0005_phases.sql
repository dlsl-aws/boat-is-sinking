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
