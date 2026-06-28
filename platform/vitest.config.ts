import { defineConfig } from "vitest/config";

// Dedicated vitest config so the test runner is independent of the board's
// vite.config.ts (React plugin etc.). Vitest prefers this file, keeping CI test
// discovery stable. Tests are pure TS (helper + fixtures) — no DOM needed.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
