import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

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

  test("declares the MCP SDK and its compatible Zod floor", () => {
    expect(manifest.dependencies?.["@modelcontextprotocol/sdk"]).toBe("^1.29.0");
    expect(manifest.dependencies?.zod).toBe("^3.25.0");
  });

  test("uses the patched Vitest release line", () => {
    expect(manifest.devDependencies?.vitest).toBe("^4.1.10");
    expect(manifest.devDependencies?.["@vitest/coverage-v8"]).toBe("^4.1.10");
    expect(manifest.devDependencies?.tsx).toBe("^4.23.0");
    expect(manifest.scripts?.["test:coverage"]).toBe("vitest run --coverage");
  });
});
