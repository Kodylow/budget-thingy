import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./src/test/global-setup.ts"],
    setupFiles: ["./src/test/worker-setup.ts"],
    include: ["src/**/*.test.{ts,mjs}"],
  },
});
