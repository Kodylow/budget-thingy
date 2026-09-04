import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./src/test/global-setup.ts"],
    include: ["src/**/*.test.{ts,mjs}"],
    // API suites share one PostgreSQL schema; checker tests intentionally
    // recreate tables, so test files must not mutate that schema concurrently.
    fileParallelism: false,
  },
});
