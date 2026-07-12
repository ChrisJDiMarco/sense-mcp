#!/usr/bin/env node

const { execFileSync } = require("node:child_process");

const MAX_PACKED_BYTES = 1_000_000;
const MAX_UNPACKED_BYTES = 1_500_000;
const FORBIDDEN_PREFIXES = ["apps/", "docs/assets/", "scripts/"];

function fail(message) {
  process.stderr.write(`Package check failed: ${message}\n`);
  process.exit(1);
}

let report;
try {
  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  [report] = JSON.parse(output);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (!report || !Array.isArray(report.files)) {
  fail("npm did not return a package manifest");
}

if (report.size > MAX_PACKED_BYTES) {
  fail(`packed size ${report.size} exceeds ${MAX_PACKED_BYTES} bytes`);
}

if (report.unpackedSize > MAX_UNPACKED_BYTES) {
  fail(`unpacked size ${report.unpackedSize} exceeds ${MAX_UNPACKED_BYTES} bytes`);
}

const forbidden = report.files
  .map((file) => file.path)
  .filter((path) => FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)));
if (forbidden.length > 0) {
  fail(`unexpected files: ${forbidden.join(", ")}`);
}

if (!report.files.some((file) => file.path === "dist/index.js")) {
  fail("dist/index.js is missing; run npm run build first");
}

process.stdout.write(
  `Package OK: ${report.entryCount} files, ${report.size} packed bytes, ${report.unpackedSize} unpacked bytes\n`,
);
