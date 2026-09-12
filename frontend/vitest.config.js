import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/api/**", "src/lib/**"],
      thresholds: { lines: 80, branches: 80 },
    },
  },
});
