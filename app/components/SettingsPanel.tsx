"use client";

import { useEffect, useRef, useState } from "react";
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

type SaveState = "idle" | "saving" | "saved";

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
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const config = state.room.config;

  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of NUMBER_FIELDS) {
      initial[field.key] = String(config[field.key] as number);
    }
    return initial;
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const focusedField = useRef<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-sync a field's draft from config when config changes, but only while
  // that field isn't being actively edited — a background refetch should
  // never yank text out from under someone mid-type.
  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const field of NUMBER_FIELDS) {
        if (focusedField.current === field.key) continue;
        next[field.key] = String(config[field.key] as number);
      }
      return next;
    });
  }, [config]);

  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  async function save(patch: Partial<RoomConfig>) {
    setBusy(true);
    setSaveState("saving");
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
        setSaveState("idle");
      } else {
        setSaveState("saved");
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaveState("idle"), 1500);
      }
    } catch {
      setError("No connection.");
      setSaveState("idle");
    }
    setBusy(false);
    onChanged();
  }

  function commitNumberField(field: NumberField, rawValue: string) {
    const value = Number(rawValue);
    if (rawValue.trim() === "" || !Number.isInteger(value) || value < field.min || value > field.max) {
      setFieldErrors((prev) => ({
        ...prev,
        [field.key]: `Between ${field.min} and ${field.max} ${field.hint}`,
      }));
      return;
    }
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[field.key];
      return next;
    });
    if (value === config[field.key]) return;
    void save({ [field.key]: value } as Partial<RoomConfig>);
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
      <div className="flex items-center gap-3">
        <h2 className="font-bold">Settings</h2>
        {saveState === "saving" && <span className="text-sm text-muted">Saving…</span>}
        {saveState === "saved" && <span className="text-sm text-muted">Saved</span>}
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
              value={drafts[field.key] ?? ""}
              onFocus={() => {
                focusedField.current = field.key;
              }}
              onChange={(event) => {
                const raw = event.target.value;
                setDrafts((prev) => ({ ...prev, [field.key]: raw }));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              onBlur={(event) => {
                focusedField.current = null;
                commitNumberField(field, event.target.value);
              }}
              className="rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 text-base"
            />
            <span className="text-xs text-muted">{field.hint}</span>
            {fieldErrors[field.key] && (
              <span className="text-xs text-danger">{fieldErrors[field.key]}</span>
            )}
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
