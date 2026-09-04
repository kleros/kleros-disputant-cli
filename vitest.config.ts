import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Fork and acceptance suites live under `src/**` too and self-skip at module
    // scope rather than being excluded here, so a missing prerequisite is visible.
    include: ["src/**/*.test.ts"],

    // Load-bearing. That self-skip idiom announces itself with `console.warn`,
    // and vitest 4 intercepts console output and prints it only for *failing*
    // files — so a skipped suite's warning is swallowed and the run is silently
    // green, which is the exact failure the idiom exists to prevent. Verified
    // against vitest 4.1.11: without this, neither module-scope nor in-test
    // `console.warn` reaches the terminal.
    disableConsoleIntercept: true,
  },
});
