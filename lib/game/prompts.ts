/**
 * Icebreaker prompts shown to a boat once it locks.
 *
 * This is the part that actually breaks ice. The elimination mechanic exists to
 * keep forcing fresh group compositions; the prompt is what turns thirty seconds
 * of standing together into a conversation.
 *
 * They are deliberately answerable in one sentence by anyone, with no
 * prerequisite of knowing the company, the course, or each other.
 */
export type Prompt = { id: string; text: string };

export const PROMPTS: readonly Prompt[] = [
  { id: "lifeboat-item", text: "Names first — then: one thing you'd grab before the ship went down." },
  { id: "breakfast", text: "Names first — then: what did you eat for breakfast today?" },
  { id: "getting-here", text: "Names first — then: how did you get here this morning?" },
  { id: "useless-talent", text: "Names first — then: a completely useless talent you have." },
  { id: "last-photo", text: "Names first — then: describe the last photo you took." },
  { id: "wrong-opinion", text: "Names first — then: a food opinion that gets you in trouble." },
  { id: "desert-song", text: "Names first — then: one song you'd survive on forever." },
  { id: "first-job", text: "Names first — then: your very first job." },
  { id: "three-words", text: "Names first — then: describe your week in three words." },
  { id: "sea-creature", text: "Names first — then: which sea creature are you today, and why?" },
  { id: "open-tabs", text: "Names first — then: how many browser tabs do you have open?" },
  { id: "learn-tomorrow", text: "Names first — then: something you'd learn if tomorrow were free." },
  { id: "hometown", text: "Names first — then: where did you grow up?" },
  { id: "small-win", text: "Names first — then: one small win from this week." },
  { id: "overrated", text: "Names first — then: something everyone loves that you find overrated." },
  { id: "captain-or-crew", text: "Names first — then: captain or crew, and be honest about why." },
];

/**
 * Prompts are picked without repeating within a game, since hearing the same
 * question twice in ten minutes is the fastest way to flatten the energy.
 * Falls back to cycling only if a game somehow outlasts the list.
 */
export function nextPrompt(usedIds: readonly string[]): Prompt {
  const used = new Set(usedIds);
  const unused = PROMPTS.filter((p) => !used.has(p.id));
  const pool = unused.length > 0 ? unused : PROMPTS;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

export function getPrompt(id: string): Prompt | undefined {
  return PROMPTS.find((p) => p.id === id);
}
