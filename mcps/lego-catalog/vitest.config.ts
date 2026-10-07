import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    // Builds a fixture snapshot (real builder, fixture CSVs) when no real snapshot is configured.
    globalSetup: ["tests/helpers/global-setup.ts"],
  },
});
