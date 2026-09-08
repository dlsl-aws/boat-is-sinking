"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Panel } from "./components/ui";
import { Ocean } from "./components/Ocean";
import { ROOM_CODE_LENGTH, normalizeCode } from "@/lib/game/codes";

export default function LandingPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const joinable = code.length === ROOM_CODE_LENGTH;

  async function createRoom() {
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error(await response.text());
      const room = (await response.json()) as { code: string };
      router.push(`/admin/${room.code}`);
    } catch {
      setError("Couldn't create a room. Check the Supabase environment variables.");
      setCreating(false);
    }
  }

  return (
    <>
      <Ocean level={0.06} />

      <main className="relative z-10 mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-7 p-6">
        <header className="text-center">
          <div className="animate-bob text-8xl" aria-hidden>
            🚢
          </div>
          <h1 className="font-display mt-4 text-5xl leading-none font-bold">
            The Boat
            <br />
            Is Sinking
          </h1>
          <p className="mt-4 text-mist">
            Find your symbol. Claim a seat.
            <br />
            <span className="text-danger">Don&apos;t be the one still swimming.</span>
          </p>
        </header>

        <Panel>
          <h2 className="font-display mb-3 font-semibold">Join a game</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (joinable) router.push(`/join/${code}`);
            }}
            className="flex gap-2"
          >
            <input
              value={code}
              onChange={(event) =>
                setCode(normalizeCode(event.target.value).slice(0, ROOM_CODE_LENGTH))
              }
              placeholder="ROOM CODE"
              aria-label="Room code"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="font-display min-w-0 flex-1 rounded-2xl border-2 border-white/15 bg-black/40 px-4 py-3 text-center text-2xl font-bold tracking-[0.25em] uppercase placeholder:text-sm placeholder:font-normal placeholder:tracking-normal placeholder:text-muted focus:border-beacon focus:outline-none"
            />
            <Button type="submit" variant={joinable ? "safe" : "ghost"} disabled={!joinable}>
              Go
            </Button>
          </form>
        </Panel>

        <Panel tone="warn">
          <h2 className="font-display mb-1 font-semibold">Running the session?</h2>
          <p className="mb-4 text-sm text-mist">
            Creates a room and opens the facilitator dashboard.
          </p>
          <Button
            variant="gold"
            size="lg"
            onClick={createRoom}
            disabled={creating}
            className="w-full"
          >
            {creating ? "Casting off…" : "⚓ Create a room"}
          </Button>
          {error && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
        </Panel>
      </main>
    </>
  );
}
