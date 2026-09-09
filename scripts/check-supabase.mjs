/**
 * Connection checker.
 *
 * Verifies, in order, the four things that must be true before a room can be
 * created: the URL resolves, the anon key is accepted, the service-role key is
 * accepted, and all five migrations have actually been applied.
 *
 * Run it with `node scripts/check-supabase.mjs` after filling in .env.local.
 * It reads that file directly — it does not need the dev server running — and
 * never prints a key.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv(path = ".env.local") {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    fail(`No ${path}. Copy .env.example to .env.local and fill it in.`);
  }
  const env = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const ok = (m) => console.log(`  ok    ${m}`);
const info = (m) => console.log(`        ${m}`);
function fail(m, hint) {
  console.log(`  FAIL  ${m}`);
  if (hint) console.log(`        → ${hint}`);
  process.exit(1);
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const service = env.SUPABASE_SERVICE_ROLE_KEY;

console.log("\nChecking .env.local\n");

// 1. Placeholders — the single most common cause of "nothing happens".
for (const [name, value] of [
  ["NEXT_PUBLIC_SUPABASE_URL", url],
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", anon],
  ["SUPABASE_SERVICE_ROLE_KEY", service],
]) {
  if (!value) fail(`${name} is missing or empty.`);
  if (value.includes("xxxxxxxxxxxx") || value === "eyJhbGciOi...") {
    fail(`${name} is still the placeholder from .env.example.`);
  }
}
ok("all three values are filled in");

// The three wrong things people paste here, each named specifically. All three
// look plausible in the dashboard and none of them produces a clear error.
if (/^postgres(ql)?:\/\//.test(url)) {
  fail(
    "That is the DATABASE CONNECTION STRING, not the Project URL.",
    "You want the one that looks like https://<project-ref>.supabase.co — see Step 1 below.",
  );
}
if (url.includes("supabase.com/dashboard") || url.includes("supabase.green")) {
  const ref = url.match(/project\/([a-z0-9]{16,})/)?.[1];
  fail(
    "That is the DASHBOARD URL (the page you were looking at), not the Project URL.",
    ref
      ? `Your project ref is "${ref}", so use: https://${ref}.supabase.co`
      : "Use https://<project-ref>.supabase.co instead.",
  );
}
if (/^["'].*["']$/.test(url)) {
  fail("The URL is wrapped in quotes.", "Remove them — .env files take raw values.");
}
if (url.endsWith("/")) {
  info(`URL has a trailing slash. It is tolerated here, but drop it: ${url.replace(/\/$/, "")}`);
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|red)$/.test(url.replace(/\/$/, ""))) {
  info(`URL is "${url}" — expected the form https://<project-ref>.supabase.co`);
}
if (anon === service) {
  fail(
    "The anon key and the service-role key are identical.",
    "They are two different keys. The service-role key bypasses RLS and must never be the public one.",
  );
}

// 2. The URL resolves and is a Supabase project.
try {
  const res = await fetch(`${url.replace(/\/$/, "")}/auth/v1/health`, {
    headers: { apikey: anon },
  });
  if (!res.ok) fail(`URL reachable but returned HTTP ${res.status}.`);
  ok("project URL resolves");
} catch (error) {
  fail(`Cannot reach ${url} (${error.message})`, "Check the project ref for typos.");
}

// 3. Keys are accepted. RLS is on with no anon policies, so the anon key is
//    EXPECTED to be denied rows — what matters is that it is not rejected as a
//    bad key.
const anonClient = createClient(url, anon, { auth: { persistSession: false } });
const anonResult = await anonClient.from("rooms").select("id").limit(1);
if (anonResult.error && /JWT|api key|Invalid/i.test(anonResult.error.message)) {
  fail(`Anon key rejected: ${anonResult.error.message}`, "Copy the anon/publishable key again.");
}
ok("anon key accepted (row access denied by RLS, which is correct)");

const admin = createClient(url, service, { auth: { persistSession: false } });
const roomsCheck = await admin.from("rooms").select("id").limit(1);
if (roomsCheck.error) {
  if (/does not exist|schema cache/i.test(roomsCheck.error.message)) {
    fail("Table `rooms` not found — migrations have not been applied.", "Run 0001 through 0005 in the SQL editor.");
  }
  fail(`Service-role key rejected: ${roomsCheck.error.message}`, "Copy the service_role/secret key again.");
}
ok("service-role key accepted and `rooms` exists");

// 4. All five migrations. Each contributes something checkable.
const checks = [
  ["0001_init.sql", async () => !(await admin.from("players").select("id").limit(1)).error],
  ["0002_rpc.sql", async () => {
    const { error } = await admin.rpc("begin_resolve", { p_round_id: "00000000-0000-0000-0000-000000000000" });
    return !error || !/does not exist/i.test(error.message);
  }],
  ["0003_rounds.sql", async () => {
    const { error } = await admin.rpc("finish_game", { p_room_id: "00000000-0000-0000-0000-000000000000" });
    return !error || !/does not exist/i.test(error.message);
  }],
  ["0004_seats.sql + 0005_phases.sql", async () => {
    const { error } = await admin.rpc("advance_phase", { p_round_id: "00000000-0000-0000-0000-000000000000" });
    return !error || !/does not exist/i.test(error.message);
  }],
];

for (const [name, run] of checks) {
  if (await run()) ok(`${name} applied`);
  else fail(`${name} NOT applied.`, "Run the remaining migrations in order in the SQL editor.");
}

// 5. Realtime broadcast — how every phone learns a round started.
const broadcast = await fetch(`${url.replace(/\/$/, "")}/realtime/v1/api/broadcast`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    apikey: service,
    Authorization: `Bearer ${service}`,
  },
  body: JSON.stringify({
    messages: [{ topic: "room:connection-check", event: "game", payload: { type: "room:updated" } }],
  }),
});
if (broadcast.ok) ok("realtime broadcast accepted");
else info(`realtime broadcast returned HTTP ${broadcast.status} — the game still works, but phones will update on a slower poll instead of instantly.`);

console.log("\nEverything checks out. Restart `npm run dev` and create a room.\n");
