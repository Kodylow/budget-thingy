import { defineConfig } from "vitest/config";

// Only .test.ts files run under Vitest. The package scripts report this lane
// independently from the pure and shared-database node:test lanes.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
