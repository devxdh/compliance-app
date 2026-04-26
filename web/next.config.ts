import type { NextConfig } from "next";

const monorepoRoot = new URL("..", import.meta.url).pathname;

const nextConfig: NextConfig = {
  outputFileTracingRoot: monorepoRoot,
  reactStrictMode: true,
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
