import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      /**
       * Set just under the measured actuals (statements 79.6, branches 71.9,
       * functions 80.1, lines 84.0) so an ordinary change stays green and a
       * real drop fails. Only `lines` was enforced before, which let branch and
       * function coverage fall without anything noticing -- the paths these
       * sensors take on a machine where a permission is denied are branches,
       * not lines.
       */
      thresholds: {
        statements: 78,
        branches: 70,
        functions: 78,
        lines: 82,
      },
    },
  },
});
