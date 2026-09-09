import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
    // PGlite compiles Postgres from WASM the first time a suite builds a
    // database. On a cold machine that alone exceeds the 10s default and every
    // fresh CI run fails on the first file.
    hookTimeout: 30_000,
  },
});
