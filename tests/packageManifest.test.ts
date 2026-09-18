import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface PackageManifest {
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
  main?: string;
  os?: string[];
  scripts?: Record<string, string>;
  types?: string;
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

/**
 * Asserts a caret range whose floor is at least the one we depend on, so an
 * ordinary dependency bump stays green while a downgrade below the floor fails.
 */
function expectCaretFloor(range: string | undefined, floor: string): void {
  expect(range).toMatch(/^\^\d+\.\d+\.\d+$/);
  const actual = range!.slice(1).split(".").map(Number);
  const wanted = floor.split(".").map(Number);
  expect(actual[0]).toBe(wanted[0]);
  expect(actual[1] * 1_000_000 + actual[2]).toBeGreaterThanOrEqual(
    wanted[1] * 1_000_000 + wanted[2],
  );
}

describe("published package", () => {
  test("ships only the runtime and lightweight operator documentation", () => {
    expect(manifest.files).toEqual([
      "dist",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "ROADMAP.md",
      "SECURITY.md",
      "SPEC.md",
      "docs/**/*.md",
      "examples",
    ]);
    expect(manifest.files).not.toContain("apps/ios/SenseIOS/SenseIOS");
    expect(manifest.files).not.toContain("scripts");
  });

  test("checks the packed artifact before release", () => {
    expect(manifest.scripts?.["check:package"]).toBe("node scripts/check-package.cjs");
    expect(manifest.scripts?.["release:dry-run"]).toContain("npm run check:package");
    expect(manifest.scripts?.["audit:all"]).toBe("npm audit --audit-level=moderate");
    expect(manifest.scripts?.check).toContain("npm run audit:all");
  });

  test("requires a supported Node.js release line", () => {
    expect(manifest.engines?.node).toBe(">=22");
  });

  test("declares the MCP server SDK and its compatible Zod floor", () => {
    expectCaretFloor(manifest.dependencies?.["@modelcontextprotocol/server"], "2.0.0");
    expectCaretFloor(manifest.dependencies?.zod, "4.6.5");
  });

  test("keeps the stdio runtime free of the v1 SDK's transport dependencies", () => {
    // The v1 SDK dragged express, hono, cors, jose, ajv and friends into a
    // stdio-only binary; every production advisory we carried came from them.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@modelcontextprotocol/server",
      "zod",
    ]);
    expect(manifest.dependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined();
    expect(manifest.devDependencies?.["@modelcontextprotocol/client"]).toBeDefined();
  });

  test("is a binary, not an importable library", () => {
    // dist/index.js calls main() at module top level with no main-module guard:
    // it connects an MCP stdio transport to whatever stdout it is loaded into
    // and installs SIGINT/SIGTERM handlers that call process.exit. While `main`
    // and `types` pointed at it, `import "sense-mcp"` did all of that to the
    // consumer's process, and dist/index.d.ts is an empty 31-byte `export {}`,
    // so it was not even a usable type entry.
    expect(manifest.main).toBeUndefined();
    expect(manifest.types).toBeUndefined();
    expect(manifest.bin?.["sense-mcp"]).toBe("dist/index.js");
  });

  test("does not freeze dist/* as public API", () => {
    // An `exports` map without a root or wildcard entry makes every dist path
    // private, so the build layout stays refactorable. package.json is exported
    // because tooling reads it and doing so runs no code.
    expect(manifest.exports).toBeDefined();
    const entries = Object.keys(manifest.exports ?? {});
    expect(entries).toEqual(["./package.json"]);
    expect(manifest.exports?.["."]).toBeUndefined();
    expect(entries.some((entry) => entry.includes("*"))).toBe(false);
  });

  test("declares macOS, because the privacy guarantees are macOS-only", () => {
    // Private storage relies on 0700/0600 POSIX modes and every sensor shells
    // out to a macOS binary. Installing elsewhere yields a server whose stated
    // privacy invariants are no-ops, so npm should refuse rather than warn.
    expect(manifest.os).toEqual(["darwin"]);
  });

  test("uses the patched Vitest release line", () => {
    expectCaretFloor(manifest.devDependencies?.vitest, "5.0.1");
    expectCaretFloor(manifest.devDependencies?.["@vitest/coverage-v8"], "5.0.1");
    expectCaretFloor(manifest.devDependencies?.tsx, "4.23.13");
    expect(manifest.scripts?.["test:coverage"]).toBe("vitest run --coverage");
  });
});
