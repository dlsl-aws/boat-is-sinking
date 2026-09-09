import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `next dev` otherwise writes AGENTS.md and CLAUDE.md into the repo root.
  agentRules: false,
};

export default nextConfig;
