"use client";

/**
 * The game's sound design, synthesised at runtime.
 *
 * Every cue below is generated with oscillators and filtered noise rather than
 * loaded from a file. That is a deliberate trade: no audio assets to host, no
 * download to block the first round, nothing to go missing on venue wifi, and
 * the whole palette stays tunable by changing a number.
 *
 * Sound matters more here than in most web apps. The projector is across a room
 * from forty people who are talking — a countdown they can *hear* accelerating
 * does more to create urgency than anything on screen.
 *
 * Browsers refuse to start audio without a user gesture, so nothing plays until
 * `unlock()` has been called from a real interaction. The facilitator clicking
 * "Start the game" is the natural moment; the display arms itself on the first
 * click anywhere.
 */

type Cue =
  | "bell"        // a round begins
  | "tick"        // countdown, pitch rises with urgency
  | "alarm"       // the last ten seconds
  | "aboard"      // you claimed a seat
  | "lock"        // your lifeboat filled
  | "captain"     // you are the captain
  | "splash"      // someone went overboard
  | "error"       // wrong boat, wrong code
  | "fanfare"     // winners
  | "join";       // a player entered the lobby

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

function ensure(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  return ctx;
}

/** Call from a real user gesture before any cue is expected to be audible. */
export function unlock(): void {
  const audio = ensure();
  if (audio && audio.state === "suspended") void audio.resume();
}

export function setMuted(value: boolean): void {
  muted = value;
  if (master) master.gain.value = value ? 0 : 0.5;
}

export function isMuted(): boolean {
  return muted;
}

/** A single enveloped oscillator — the building block for every tonal cue. */
function tone(
  audio: AudioContext,
  {
    freq,
    type = "sine",
    start = 0,
    duration = 0.2,
    gain = 0.2,
    sweepTo,
  }: {
    freq: number;
    type?: OscillatorType;
    start?: number;
    duration?: number;
    gain?: number;
    sweepTo?: number;
  },
): void {
  const at = audio.currentTime + start;
  const osc = audio.createOscillator();
  const env = audio.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (sweepTo != null) osc.frequency.exponentialRampToValueAtTime(sweepTo, at + duration);

  // A tiny attack instead of an instant one; a hard start clicks audibly.
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, at + duration);

  osc.connect(env);
  env.connect(master!);
  osc.start(at);
  osc.stop(at + duration + 0.02);
}

/** Filtered white noise — water, and anything percussive. */
function noise(
  audio: AudioContext,
  {
    start = 0,
    duration = 0.4,
    gain = 0.2,
    from = 1200,
    to = 200,
    q = 1,
  }: {
    start?: number;
    duration?: number;
    gain?: number;
    from?: number;
    to?: number;
    q?: number;
  },
): void {
  const at = audio.currentTime + start;
  const frames = Math.floor(audio.sampleRate * duration);
  const buffer = audio.createBuffer(1, frames, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  const source = audio.createBufferSource();
  source.buffer = buffer;

  const filter = audio.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = q;
  filter.frequency.setValueAtTime(from, at);
  filter.frequency.exponentialRampToValueAtTime(to, at + duration);

  const env = audio.createGain();
  env.gain.setValueAtTime(gain, at);
  env.gain.exponentialRampToValueAtTime(0.0001, at + duration);

  source.connect(filter);
  filter.connect(env);
  env.connect(master!);
  source.start(at);
  source.stop(at + duration);
}

/**
 * Play a cue.
 *
 * `intensity` is used by `tick`, which rises in pitch and volume as a round runs
 * out — the same trick a heart-rate monitor uses, and the cheapest way to make a
 * room feel time pressure without anyone looking at the screen.
 */
export function play(cue: Cue, intensity = 0): void {
  if (muted) return;
  const audio = ensure();
  if (!audio || audio.state === "suspended") return;

  switch (cue) {
    case "bell": {
      // A ship's bell: a struck fundamental plus its inharmonic partials.
      for (const [mult, gain] of [[1, 0.22], [2.76, 0.1], [5.4, 0.05]] as const) {
        tone(audio, { freq: 620 * mult, type: "sine", duration: 2.4, gain });
      }
      break;
    }

    case "tick": {
      // 0 → a soft woodblock. 1 → a hard, high, urgent click.
      const t = Math.min(1, Math.max(0, intensity));
      tone(audio, {
        freq: 780 + t * 900,
        type: "square",
        duration: 0.05,
        gain: 0.05 + t * 0.14,
      });
      break;
    }

    case "alarm": {
      // Two-tone klaxon.
      tone(audio, { freq: 480, type: "sawtooth", duration: 0.28, gain: 0.14 });
      tone(audio, { freq: 360, type: "sawtooth", start: 0.3, duration: 0.32, gain: 0.14 });
      break;
    }

    case "aboard": {
      // A short rising third — resolved, unmistakably positive.
      tone(audio, { freq: 523, duration: 0.14, gain: 0.18, type: "triangle" });
      tone(audio, { freq: 784, start: 0.1, duration: 0.22, gain: 0.18, type: "triangle" });
      break;
    }

    case "lock": {
      // The boat filled: a full major arpeggio, the biggest positive cue a
      // player gets short of winning.
      [523, 659, 784, 1046].forEach((freq, i) =>
        tone(audio, {
          freq,
          start: i * 0.07,
          duration: 0.34,
          gain: 0.17,
          type: "triangle",
        }),
      );
      break;
    }

    case "captain": {
      tone(audio, { freq: 392, duration: 0.16, gain: 0.16, type: "square" });
      tone(audio, { freq: 587, start: 0.13, duration: 0.3, gain: 0.16, type: "square" });
      break;
    }

    case "splash": {
      // Water: a broadband burst falling fast, plus a low thud underneath.
      noise(audio, { duration: 0.55, gain: 0.26, from: 2600, to: 180, q: 0.7 });
      tone(audio, { freq: 180, sweepTo: 60, duration: 0.35, gain: 0.12, type: "sine" });
      break;
    }

    case "error": {
      // A flat, downward buzz. Never harsh enough to feel punishing.
      tone(audio, { freq: 220, sweepTo: 150, type: "sawtooth", duration: 0.22, gain: 0.11 });
      break;
    }

    case "fanfare": {
      [523, 659, 784, 1046, 1318].forEach((freq, i) =>
        tone(audio, {
          freq,
          start: i * 0.11,
          duration: 0.7,
          gain: 0.17,
          type: "triangle",
        }),
      );
      for (const [mult, gain] of [[1, 0.12], [2.76, 0.05]] as const) {
        tone(audio, { freq: 620 * mult, start: 0.55, duration: 2.2, gain });
      }
      break;
    }

    case "join": {
      tone(audio, { freq: 880, duration: 0.09, gain: 0.09, type: "sine" });
      break;
    }
  }
}
