import { defineConfig } from "vitest/config";

// Unit tests target pure utility modules only, so no DOM environment is needed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
