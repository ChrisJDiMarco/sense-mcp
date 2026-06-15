#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function assertIncludes(actual, expected, label) {
  for (const item of expected ?? []) {
    if (!actual.includes(item)) {
      throw new Error(`${label} missing ${item}`);
    }
  }
}

function assertExcludes(actual, forbidden, label) {
  for (const item of forbidden ?? []) {
    if (actual.includes(item)) {
      throw new Error(`${label} unexpectedly included ${item}`);
    }
  }
}

function assertExactArray(actual, expected, label) {
  if (actual.length !== expected.length) {
    throw new Error(`${label} expected [${expected.join(", ")}], got [${actual.join(", ")}]`);
  }
  assertIncludes(actual, expected, label);
}

async function main() {
  const root = path.join(__dirname, "..");
  const fixtures = JSON.parse(
    readFileSync(path.join(root, "docs", "evals", "routing-fixtures.json"), "utf8"),
  );
  const moduleUrl = pathToFileURL(path.join(root, "dist", "relevance.js")).href;
  const { planRelevantContext } = await import(moduleUrl);

  const failures = [];
  for (const fixture of fixtures) {
    try {
      const plan = planRelevantContext(fixture.prompt);
      if (plan.intent !== fixture.intent) {
        throw new Error(`intent expected ${fixture.intent}, got ${plan.intent}`);
      }
      if (plan.minimum_tool !== fixture.minimum_tool) {
        throw new Error(`minimum_tool expected ${fixture.minimum_tool}, got ${plan.minimum_tool}`);
      }
      assertExcludes([plan.intent], fixture.forbidden_intents, "intent");
      assertExcludes([plan.minimum_tool], fixture.forbidden_minimum_tools, "minimum_tool");
      assertIncludes(plan.recommended_tools, fixture.recommended_tools, "recommended_tools");
      assertIncludes(plan.avoided_tools, fixture.avoided_tools, "avoided_tools");
      assertExcludes(
        plan.recommended_tools,
        fixture.forbidden_recommended_tools,
        "recommended_tools",
      );
      if (fixture.recommended_tools_exact) {
        assertExactArray(plan.recommended_tools, fixture.recommended_tools, "recommended_tools");
      }
      if (
        typeof fixture.requires_explicit_media === "boolean" &&
        plan.requires_explicit_media !== fixture.requires_explicit_media
      ) {
        throw new Error(
          `requires_explicit_media expected ${fixture.requires_explicit_media}, got ${plan.requires_explicit_media}`,
        );
      }
    } catch (err) {
      failures.push({
        name: fixture.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (failures.length > 0) {
    console.error("Routing eval failed:");
    for (const failure of failures) {
      console.error(`- ${failure.name}: ${failure.error}`);
    }
    process.exit(1);
  }

  console.log(`Routing eval passed (${fixtures.length}/${fixtures.length})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
