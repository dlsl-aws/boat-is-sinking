import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests.
 *
 * These exist for the things that only break in a real browser: cookie scoping
 * across windows, and the multi-surface flows (projector, phone, dashboard)
 * that no unit test can stand up. Everything else stays in vitest, which runs
 * in seconds against PGlite and needs no server.
 *
 * They hit a real Supabase project via `.env.local`, so they create real rooms.
 * That is deliberate — the bug these were written for lives in the interaction
 * between a browser's cookie jar and the server's identity projection, and a
 * mock of either would have hidden it.
 */
export default defineConfig({
  testDir: "./e2e",
  // A room is a live thing with timers; a stuck test should fail, not hang.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Rooms are shared server state, so parallel files would race for the same
  // game. Correctness over speed.
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    // Reuse a server you already have running; start one in CI.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
