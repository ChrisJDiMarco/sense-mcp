#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function promptPackPrompts(markdown) {
  const start = markdown.indexOf("## Prompt Pack");
  const end = markdown.indexOf("## Pass Criteria");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Could not find Prompt Pack section");
  }

  return [...markdown.slice(start, end).matchAll(/^(\d+)\.\s+(.+)$/gm)].map((match) => ({
    id: Number(match[1]),
    prompt: match[2],
  }));
}

function assertIncludes(actual, expected, label) {
  for (const item of expected ?? []) {
    if (!actual.includes(item)) throw new Error(`${label} missing ${item}`);
  }
}

function assertExcludes(actual, forbidden, label) {
  for (const item of forbidden ?? []) {
    if (actual.includes(item)) throw new Error(`${label} unexpectedly included ${item}`);
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
  const prompts = promptPackPrompts(
    readFileSync(path.join(root, "docs", "evals", "sense-mcp-eval-prompts.md"), "utf8"),
  );
  const expectations = JSON.parse(
    readFileSync(path.join(root, "docs", "evals", "prompt-pack-routing-expectations.json"), "utf8"),
  );
  const byId = new Map(prompts.map((prompt) => [prompt.id, prompt]));

  if (expectations.length !== prompts.length) {
    throw new Error(`expected ${prompts.length} expectations, found ${expectations.length}`);
  }

  const moduleUrl = pathToFileURL(path.join(root, "dist", "relevance.js")).href;
  const { planRelevantContext } = await import(moduleUrl);

  const failures = [];
  for (const expectation of expectations) {
    const prompt = byId.get(expectation.id);
    if (!prompt) {
      failures.push({ id: expectation.id, error: "prompt id not found" });
      continue;
    }

    try {
      const plan = planRelevantContext(prompt.prompt);
      if (plan.intent !== expectation.intent) {
        throw new Error(`intent expected ${expectation.intent}, got ${plan.intent}`);
      }
      if (plan.minimum_tool !== expectation.minimum_tool) {
        throw new Error(
          `minimum_tool expected ${expectation.minimum_tool}, got ${plan.minimum_tool}`,
        );
      }
      assertIncludes(plan.recommended_tools, expectation.recommended_tools, "recommended_tools");
      assertExcludes(
        plan.recommended_tools,
        expectation.forbidden_recommended_tools,
        "recommended_tools",
      );
      if (expectation.recommended_tools_exact) {
        assertExactArray(plan.recommended_tools, expectation.recommended_tools, "recommended_tools");
      }
      if (
        typeof expectation.requires_explicit_media === "boolean" &&
        plan.requires_explicit_media !== expectation.requires_explicit_media
      ) {
        throw new Error(
          `requires_explicit_media expected ${expectation.requires_explicit_media}, got ${plan.requires_explicit_media}`,
        );
      }
    } catch (err) {
      failures.push({
        id: expectation.id,
        prompt: prompt.prompt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (failures.length > 0) {
    console.error("Prompt-pack routing eval failed:");
    for (const failure of failures) {
      console.error(`- ${failure.id}: ${failure.error}`);
      if (failure.prompt) console.error(`  ${failure.prompt}`);
    }
    process.exit(1);
  }

  console.log(`Prompt-pack routing eval passed (${expectations.length}/${expectations.length})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
