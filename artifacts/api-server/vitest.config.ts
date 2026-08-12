import { defineConfig } from "vitest/config";

// Only .test.ts files run under vitest; .test.mjs files use node:test
// (see the "test" script in package.json, which runs both).
export default defineConfig({
  test: {
    // enterprise.queue.test.ts uses node:test style (not vitest); it runs via
    // `node --test` in the "test" script alongside the .test.mjs files.
    include: ["src/**/*.test.ts"],
    // enterprise.queue.test.ts is run by the node:test runner (compiled to .mjs),
    // not by Vitest — exclude it so Vitest doesn't report an empty-suite error.
    exclude: ["src/lib/enterprise.queue.test.ts"],
  },
});
