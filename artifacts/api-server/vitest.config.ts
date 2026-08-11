import { defineConfig } from "vitest/config";

// Only .test.ts files run under vitest; .test.mjs files use node:test
// (see the "test" script in package.json, which runs both).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
