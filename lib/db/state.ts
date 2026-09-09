import "server-only";
import { db } from "../supabase/server";
import { parseConfig, type RoomConfig } from "../config";
import { getPrompt } from "../game/prompts";
import { getSymbol } from "../game/symbols";
import type { Viewer } from "../auth";

/**
 * The single authoritative read for every surface.
 *
 * The projection is the security boundary of the game. Realtime carries no
 * secrets, so this is the only place a boat code or a symbol assignment can
 * escape — and it hands each viewer strictly what their role needs:
 *
 *   player  - their own symbol, their own boat's fill count, and the code ONLY
 *             if they are its captain. Never another player's symbol, because
 *             that would let them find their group without leaving their chair.
 *   display - names, counts, and per-symbol fill. No codes, no assignments.
 *   host    - everything, including codes, so the dashboard can tell a stuck
 *             room what to do.
 */

export type PlayerStatus = "alive" | "eliminated" | "spectator";
export type RoundPhase = "briefing" | "scramble" | "resolve" | "prompt" | "done";

export type PublicPlayer = {
  id: string;
  displayName: string;
  avatarSeed: string;
  avatarColor: string;
  status: PlayerStatus;
  roundsSurvived: number;
  eliminatedRound: number | null;
};

export type PublicBoat = {
  id: string;
  symbolId: string;
  capacity: number;
  filled: number;
  locked: boolean;
  captainName: string | null;
  hasCaptain: boolean;
};

export type RoundView = {
  id: string;
  roundIndex: number;
  targetGroupSize: number;
  phase: RoundPhase;
  startsAt: string;
  endsAt: string;
  promptEndsAt: string | null;
  promptText: string | null;
};

export type SelfView = {
  playerId: string;
  displayName: string;
  avatarSeed: string;
  avatarColor: string;
  status: PlayerStatus;
  roundsSurvived: number;
  /** Null outside a round, or if the player joined after it started. */
  symbolId: string | null;
  boatId: string | null;
  isCaptain: boolean;
  /** Only ever populated for the captain of this player's own boat. */
  boatCode: string | null;
  captainName: string | null;
  seatIndex: number | null;
  boatFilled: number;
  boatCapacity: number;
  boatLocked: boolean;
};

export type AdminBoat = PublicBoat & {
  /** Host only. Lets the facilitator read a code out when a captain freezes. */
  code: string;
  memberIds: string[];
  seatedPlayerIds: string[];
};

export type AdminExtras = {
  boats: AdminBoat[];
  /** Alive players with no seat yet — the list of who to shout at. */
  unseatedPlayerIds: string[];
  assignments: { playerId: string; symbolId: string; boatId: string }[];
};

export type GameState = {
  room: {
    id: string;
    code: string;
    status: "lobby" | "in_progress" | "finished";
    config: RoomConfig;
    joinUrl: string;
  };
  round: RoundView | null;
  players: PublicPlayer[];
  boats: PublicBoat[];
  counts: {
    joined: number;
    alive: number;
    eliminated: number;
    waiting: number;
    seated: number;
    seatsAvailable: number;
  };
  self: SelfView | null;
  admin: AdminExtras | null;
  /** For the client clock-offset correction that drives the countdown. */
  serverTime: string;
};

type RoomRow = {
  id: string;
  code: string;
  status: "lobby" | "in_progress" | "finished";
  config: unknown;
  current_round_id: string | null;
  initial_alive: number | null;
  symbol_offset: number;
};

export async function findRoomByCode(code: string): Promise<RoomRow | null> {
  const { data } = await db()
    .from("rooms")
    .select("id, code, status, config, current_round_id, initial_alive, symbol_offset")
    .eq("code", code.toUpperCase())
    .maybeSingle();
  return (data as RoomRow | null) ?? null;
}

export async function buildGameState(
  room: RoomRow,
  viewer: Viewer,
  joinUrl: string,
): Promise<GameState> {
  const supabase = db();

  const [{ data: playerRows }, { data: roundRows }] = await Promise.all([
    supabase
      .from("players")
      .select(
        "id, display_name, avatar_seed, avatar_color, status, rounds_survived, eliminated_round",
      )
      .eq("room_id", room.id)
      .order("joined_at", { ascending: true }),
    room.current_round_id
      ? supabase
          .from("rounds")
          .select(
            "id, round_index, target_group_size, phase, starts_at, ends_at, prompt_ends_at, prompt_id",
          )
          .eq("id", room.current_round_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const players: PublicPlayer[] = (playerRows ?? []).map((p) => ({
    id: p.id as string,
    displayName: p.display_name as string,
    avatarSeed: p.avatar_seed as string,
    avatarColor: p.avatar_color as string,
    status: p.status as PlayerStatus,
    roundsSurvived: p.rounds_survived as number,
    eliminatedRound: (p.eliminated_round as number | null) ?? null,
  }));

  const nameById = new Map(players.map((p) => [p.id, p.displayName]));

  const roundRow = roundRows as Record<string, unknown> | null;
  const round: RoundView | null = roundRow
    ? {
        id: roundRow.id as string,
        roundIndex: roundRow.round_index as number,
        targetGroupSize: roundRow.target_group_size as number,
        phase: roundRow.phase as RoundPhase,
        startsAt: roundRow.starts_at as string,
        endsAt: roundRow.ends_at as string,
        promptEndsAt: (roundRow.prompt_ends_at as string | null) ?? null,
        promptText: roundRow.prompt_id
          ? (getPrompt(roundRow.prompt_id as string)?.text ?? null)
          : null,
      }
    : null;

  let boats: PublicBoat[] = [];
  let admin: AdminExtras | null = null;
  let self: SelfView | null = null;

  // Identity, not role. A host who also joined has both, and must get their own
  // symbol as well as the dashboard.
  const selfPlayerId = viewer.role === "display" ? null : viewer.playerId;

  if (round) {
    const [{ data: boatRows }, { data: seatRows }, { data: assignmentRows }] =
      await Promise.all([
        supabase
          .from("boats")
          .select("id, symbol_id, capacity, code, captain_player_id, locked_at")
          .eq("round_id", round.id),
        supabase
          .from("seats")
          .select("boat_id, player_id, seat_index")
          .eq("round_id", round.id)
          .order("seat_index", { ascending: true }),
        supabase
          .from("assignments")
          .select("player_id, boat_id, symbol_id")
          .eq("round_id", round.id),
      ]);

    const seatsByBoat = new Map<string, { playerId: string; seatIndex: number }[]>();
    for (const seat of seatRows ?? []) {
      const list = seatsByBoat.get(seat.boat_id as string) ?? [];
      list.push({
        playerId: seat.player_id as string,
        seatIndex: seat.seat_index as number,
      });
      seatsByBoat.set(seat.boat_id as string, list);
    }

    const membersByBoat = new Map<string, string[]>();
    for (const a of assignmentRows ?? []) {
      const list = membersByBoat.get(a.boat_id as string) ?? [];
      list.push(a.player_id as string);
      membersByBoat.set(a.boat_id as string, list);
    }

    const rows = (boatRows ?? []) as Record<string, unknown>[];

    // Sorted by symbol id so the projector's boat grid keeps a stable position
    // per symbol instead of reshuffling on every render.
    rows.sort((a, b) => (a.symbol_id as string).localeCompare(b.symbol_id as string));

    boats = rows.map((b) => {
      const id = b.id as string;
      const captainId = (b.captain_player_id as string | null) ?? null;
      return {
        id,
        symbolId: b.symbol_id as string,
        capacity: b.capacity as number,
        filled: seatsByBoat.get(id)?.length ?? 0,
        locked: b.locked_at != null,
        captainName: captainId ? (nameById.get(captainId) ?? null) : null,
        hasCaptain: captainId != null,
      };
    });

    if (viewer.role === "host") {
      const seatedIds = new Set((seatRows ?? []).map((s) => s.player_id as string));
      admin = {
        boats: rows.map((b, i) => ({
          ...boats[i]!,
          code: b.code as string,
          memberIds: membersByBoat.get(b.id as string) ?? [],
          seatedPlayerIds: (seatsByBoat.get(b.id as string) ?? []).map((s) => s.playerId),
        })),
        unseatedPlayerIds: players
          .filter((p) => p.status === "alive" && !seatedIds.has(p.id))
          .map((p) => p.id),
        assignments: (assignmentRows ?? []).map((a) => ({
          playerId: a.player_id as string,
          symbolId: a.symbol_id as string,
          boatId: a.boat_id as string,
        })),
      };
    }

    if (selfPlayerId) {
      const me = players.find((p) => p.id === selfPlayerId);
      const assignment = (assignmentRows ?? []).find(
        (a) => a.player_id === selfPlayerId,
      );
      const boatRow = assignment
        ? rows.find((b) => b.id === assignment.boat_id)
        : undefined;
      const boatId = (boatRow?.id as string | undefined) ?? null;
      const seat = boatId
        ? seatsByBoat.get(boatId)?.find((s) => s.playerId === selfPlayerId)
        : undefined;
      const captainId = (boatRow?.captain_player_id as string | null) ?? null;
      const isCaptain = captainId != null && captainId === selfPlayerId;

      if (me) {
        self = {
          playerId: me.id,
          displayName: me.displayName,
          avatarSeed: me.avatarSeed,
          avatarColor: me.avatarColor,
          status: me.status,
          roundsSurvived: me.roundsSurvived,
          symbolId: (assignment?.symbol_id as string | undefined) ?? null,
          boatId,
          isCaptain,
          // The one place a code is ever revealed, and only to its captain.
          boatCode: isCaptain ? ((boatRow?.code as string) ?? null) : null,
          captainName: captainId ? (nameById.get(captainId) ?? null) : null,
          seatIndex: seat?.seatIndex ?? null,
          boatFilled: boatId ? (seatsByBoat.get(boatId)?.length ?? 0) : 0,
          boatCapacity: (boatRow?.capacity as number | undefined) ?? 0,
          boatLocked: boatRow?.locked_at != null,
        };
      }
    }
  }

  if (selfPlayerId && !self) {
    // In the lobby, or between rounds: still return identity so the phone can
    // show who it thinks you are.
    const me = players.find((p) => p.id === selfPlayerId);
    if (me) {
      self = {
        playerId: me.id,
        displayName: me.displayName,
        avatarSeed: me.avatarSeed,
        avatarColor: me.avatarColor,
        status: me.status,
        roundsSurvived: me.roundsSurvived,
        symbolId: null,
        boatId: null,
        isCaptain: false,
        boatCode: null,
        captainName: null,
        seatIndex: null,
        boatFilled: 0,
        boatCapacity: 0,
        boatLocked: false,
      };
    }
  }

  const alive = players.filter((p) => p.status === "alive").length;
  const seated = boats.reduce((sum, b) => sum + b.filled, 0);

  return {
    room: {
      id: room.id,
      code: room.code,
      status: room.status,
      config: parseConfig(room.config),
      joinUrl,
    },
    round,
    players,
    boats,
    counts: {
      joined: players.length,
      alive,
      eliminated: players.filter((p) => p.status === "eliminated").length,
      waiting: players.filter((p) => p.status === "spectator").length,
      seated,
      seatsAvailable: boats.reduce((sum, b) => sum + b.capacity, 0),
    },
    self,
    admin,
    serverTime: new Date().toISOString(),
  };
}

/** Resolve a stored symbol id for rendering, tolerating unknown ids. */
export function symbolView(symbolId: string | null) {
  return symbolId ? (getSymbol(symbolId) ?? null) : null;
}
