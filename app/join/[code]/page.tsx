"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar, Button, Panel } from "@/app/components/ui";
import { Ocean } from "@/app/components/Ocean";
import {
  AVATAR_COLORS,
  AVATAR_FACES,
  randomAvatarColor,
  randomAvatarSeed,
} from "@/lib/game/avatar";
import { NAME_MAX_LENGTH } from "@/lib/game/names";
import { buzz } from "@/lib/client/haptics";

/**
 * Boarding.
 *
 * Names are load-bearing rather than decorative here — the projector announces
 * survivors and casualties by name, and a captain shouts for their group — so
 * this screen does real validation and shows a live preview of exactly how the
 * player will appear on the big screen.
 */
export default function JoinPage() {
  const router = useRouter();
  const params = useParams<{ code: string }>();
  const code = (params.code ?? "").toUpperCase();

  const [name, setName] = useState("");
  const [seed, setSeed] = useState("0");
  const [color, setColor] = useState(AVATAR_COLORS[0] as string);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Randomised after mount so server and client render identical markup.
  useEffect(() => {
    setSeed(randomAvatarSeed());
    setColor(randomAvatarColor());
  }, []);

  async function join(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/rooms/${code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name, avatarSeed: seed, avatarColor: color }),
      });
      const data = (await response.json()) as { message?: string; error?: string };

      if (!response.ok) {
        buzz("fail");
        setError(
          data.message ??
            {
              "no-such-room": "That room doesn't exist. Check the code on the screen.",
              "game-already-started": "That game has already set sail.",
            }[data.error ?? ""] ??
            "Couldn't board. Try again.",
        );
        setBusy(false);
        return;
      }
      buzz("success");
      router.push(`/play/${code}`);
    } catch {
      setError("No connection. Check the venue WiFi and try again.");
      setBusy(false);
    }
  }

  return (
    <>
      <Ocean level={0.05} />

      <main className="relative z-10 mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
        <header className="text-center">
          <p className="font-display text-sm tracking-[0.35em] text-mist">
            ROOM {code}
          </p>
          <h1 className="font-display mt-2 text-4xl font-bold">Who&apos;s boarding?</h1>
        </header>

        <Panel>
          <form onSubmit={join} className="flex flex-col gap-6">
            {/* A live preview of the name badge that will appear on the wall. */}
            <div className="flex flex-col items-center gap-3">
              <span className="flex items-center gap-3 rounded-full border border-white/10 bg-white/[0.07] py-2 pr-6 pl-2">
                <Avatar seed={seed} color={color} size={56} />
                <span className="font-display text-xl font-bold">
                  {name.trim() || <span className="text-muted">Your name</span>}
                </span>
              </span>
              <p className="text-xs text-muted">
                This is how you&apos;ll appear on the big screen
              </p>
            </div>

            <div>
              <label htmlFor="name" className="mb-2 block text-sm text-mist">
                Your name
              </label>
              <input
                id="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={NAME_MAX_LENGTH}
                autoComplete="given-name"
                placeholder="e.g. Sam K"
                className="font-display w-full rounded-2xl border-2 border-white/15 bg-black/40 px-4 py-4 text-center text-2xl font-semibold focus:border-beacon focus:outline-none"
              />
            </div>

            <div>
              <p className="mb-2 text-sm text-mist">Pick a face</p>
              <div className="flex flex-wrap justify-center gap-2">
                {AVATAR_FACES.map((_, index) => (
                  <button
                    key={index}
                    type="button"
                    aria-label={`Avatar ${index + 1}`}
                    aria-pressed={seed === String(index)}
                    onClick={() => setSeed(String(index))}
                    className={`rounded-full p-0.5 transition-transform active:scale-90 ${
                      seed === String(index) ? "ring-2 ring-white" : "opacity-60"
                    }`}
                  >
                    <Avatar seed={String(index)} color={color} size={40} />
                  </button>
                ))}
              </div>

              <p className="mt-4 mb-2 text-sm text-mist">…and a colour</p>
              <div className="flex flex-wrap justify-center gap-2">
                {AVATAR_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Colour ${c}`}
                    aria-pressed={color === c}
                    onClick={() => setColor(c)}
                    style={{ background: c }}
                    className={`h-8 w-8 rounded-full transition-transform active:scale-90 ${
                      color === c
                        ? "ring-2 ring-white ring-offset-2 ring-offset-[#0a2439]"
                        : "opacity-70"
                    }`}
                  />
                ))}
              </div>
            </div>

            {error && (
              <p role="alert" className="animate-shake text-center font-semibold text-danger">
                {error}
              </p>
            )}

            <Button
              type="submit"
              variant="safe"
              size="lg"
              disabled={busy || name.trim().length < 2}
              className="w-full"
            >
              {busy ? "Boarding…" : "🛟 Board the ship"}
            </Button>
          </form>
        </Panel>
      </main>
    </>
  );
}
