import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each worker owns a migrated schema; some also boot a WASM database.
    // Bound concurrent startup so completion review does not starve test timers.
    maxWorkers: 2,
    globalSetup: ["./src/test/global-setup.ts"],
    setupFiles: ["./src/test/worker-setup.ts"],
    include: ["src/**/*.test.{ts,mjs}"],
  },
});
