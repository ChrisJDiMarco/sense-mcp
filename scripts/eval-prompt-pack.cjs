#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const CAPTURE_TOOLS = [
  "take_camera_snapshot",
  "take_window_snapshot",
  "take_full_screen_snapshot",
  "take_screen_snapshot",
];

/** macOS substitutes these while typing; the router must fold them to U+0027. */
const APOSTROPHE_VARIANTS = ["‘", "’", "ʼ", "‛"];

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

function assertContextPlan(actual, expected = {}) {
  if (!expected) return;
  if (expected.expected_value && actual.context_plan.expected_value !== expected.expected_value) {
    throw new Error(
      `context_plan.expected_value expected ${expected.expected_value}, got ${actual.context_plan.expected_value}`,
    );
  }
  if (
    typeof expected.plan_only === "boolean" &&
    actual.context_plan.plan_only !== expected.plan_only
  ) {
    throw new Error(
      `context_plan.plan_only expected ${expected.plan_only}, got ${actual.context_plan.plan_only}`,
    );
  }
  if (
    typeof expected.include_frame === "boolean" &&
    actual.context_plan.include_frame !== expected.include_frame
  ) {
    throw new Error(
      `context_plan.include_frame expected ${expected.include_frame}, got ${actual.context_plan.include_frame}`,
    );
  }
  if (expected.budget_mode && actual.context_plan.budget.mode !== expected.budget_mode) {
    throw new Error(
      `context_plan.budget.mode expected ${expected.budget_mode}, got ${actual.context_plan.budget.mode}`,
    );
  }
  assertIncludes(
    actual.context_plan.external_context_needed,
    expected.external_context_needed,
    "context_plan.external_context_needed",
  );
  assertIncludes(
    actual.context_plan.included_context,
    expected.included_context,
    "context_plan.included_context",
  );
  assertExcludes(
    actual.context_plan.included_context,
    expected.forbidden_included_context,
    "context_plan.included_context",
  );
}

function usesCapture(plan) {
  return (
    CAPTURE_TOOLS.includes(plan.minimum_tool) ||
    plan.recommended_tools.some((tool) => CAPTURE_TOOLS.includes(tool))
  );
}

/**
 * The absolute failures, reported separately from the ordinary expectation
 * misses below and before them: capturing the camera or screen for a prompt that
 * did not ask, or walking a privacy-boundary prompt into a Sense tool. Both
 * classes fail the build; these are called out first because they are the ones
 * that cannot be traded against anything.
 */
function privacyBreach(expectation, plan) {
  const expectsCapture = CAPTURE_TOOLS.includes(expectation.minimum_tool);
  if (!expectsCapture && usesCapture(plan)) {
    return `routed to a capture tool (${plan.minimum_tool}) for a prompt that does not ask for one`;
  }
  if (expectation.intent === "privacy_boundary" && plan.intent !== "privacy_boundary") {
    return `privacy-boundary prompt routed to ${plan.intent}`;
  }
  for (const tool of expectation.forbidden_recommended_tools ?? []) {
    if (CAPTURE_TOOLS.includes(tool) && plan.recommended_tools.includes(tool)) {
      return `recommended forbidden capture tool ${tool}`;
    }
  }
  if (expectation.requires_explicit_media === false && plan.requires_explicit_media === true) {
    return "claimed explicit media is required for a non-media prompt";
  }
  return null;
}

function record(scores, expected, actual) {
  for (const intent of [expected, actual]) {
    if (!scores.has(intent)) scores.set(intent, { tp: 0, fp: 0, fn: 0, support: 0 });
  }
  scores.get(expected).support += 1;
  if (expected === actual) {
    scores.get(expected).tp += 1;
    return;
  }
  scores.get(actual).fp += 1;
  scores.get(expected).fn += 1;
}

function ratio(numerator, denominator) {
  if (denominator === 0) return "     n/a";
  return `${((numerator / denominator) * 100).toFixed(1).padStart(7)}%`;
}

function printScores(scores) {
  console.log("  intent                     support    TP    FP    FN   precision      recall");
  for (const intent of [...scores.keys()].sort()) {
    const { tp, fp, fn, support } = scores.get(intent);
    console.log(
      `  ${intent.padEnd(26)}${String(support).padStart(6)}${String(tp).padStart(6)}` +
        `${String(fp).padStart(6)}${String(fn).padStart(6)}   ${ratio(tp, tp + fp)}    ${ratio(tp, tp + fn)}`,
    );
  }
}

/** Re-runs every prompt with each curly apostrophe substituted for U+0027. */
function unicodeVariantPass(planRelevantContext, prompts) {
  const differences = [];
  let checked = 0;
  for (const prompt of prompts) {
    if (!prompt.includes("'")) continue;
    const base = planRelevantContext(prompt);
    for (const variant of APOSTROPHE_VARIANTS) {
      checked += 1;
      const plan = planRelevantContext(prompt.split("'").join(variant));
      if (plan.intent !== base.intent || plan.minimum_tool !== base.minimum_tool) {
        differences.push(
          `U+${variant.codePointAt(0).toString(16).toUpperCase()} "${prompt}": ` +
            `${base.intent}/${base.minimum_tool} -> ${plan.intent}/${plan.minimum_tool}`,
        );
      }
    }
  }
  return { checked, differences };
}


/**
 * The prompt pack is a curated specification, not a sample: every entry is a
 * routing decision the product has committed to, so the gate is simply that all
 * of them hold. There is deliberately no waiver list here. A committed baseline
 * of "known misses" was tried and removed: it turned eight genuine routing
 * regressions into a green build, which is strictly less coverage than failing
 * on the first miss. Honest measurement belongs on the held-out corpora, where a
 * low score means the corpus is telling us something; the per-intent table below
 * reports the pack's shape, and gates nothing.
 *
 * The two sampled held-out corpora in scripts/eval-routing.cjs keep a baseline,
 * because there a number below 100% is a measurement rather than a defect. The
 * curated fixtures and the two privacy corpora in that script do not, for the
 * same reason the pack does not.
 */

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

  const scores = new Map();
  const hardFailures = [];
  const softFailures = [];
  let intentHits = 0;
  let toolHits = 0;
  let fullMatches = 0;
  const missedIds = [];

  for (const expectation of expectations) {
    const prompt = byId.get(expectation.id);
    if (!prompt) {
      hardFailures.push(`${expectation.id}: prompt id not found`);
      continue;
    }

    const plan = planRelevantContext(prompt.prompt);
    record(scores, expectation.intent, plan.intent);
    if (plan.intent === expectation.intent) intentHits += 1;
    if (plan.minimum_tool === expectation.minimum_tool) toolHits += 1;

    const breach = privacyBreach(expectation, plan);
    if (breach) hardFailures.push(`${expectation.id}: ${breach}\n  ${prompt.prompt}`);

    try {
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
      assertContextPlan(plan, expectation.context_plan);
      fullMatches += 1;
    } catch (err) {
      missedIds.push(expectation.id);
      softFailures.push(
        `${expectation.id}: ${err instanceof Error ? err.message : err}\n  ${prompt.prompt}`,
      );
    }
  }

  const unicode = unicodeVariantPass(
    planRelevantContext,
    prompts.map((prompt) => prompt.prompt),
  );
  for (const difference of unicode.differences) {
    hardFailures.push(`unicode apostrophe variant changed routing: ${difference}`);
  }

  const line = (label, current) =>
    console.log(
      `  ${label.padEnd(20)} ${String(current).padStart(3)}/${expectations.length} ` +
        `(${ratio(current, expectations.length).trim().padStart(6)})   required ` +
        `${String(expectations.length).padStart(3)}`,
    );

  console.log("Sense prompt-pack routing eval");
  line("intent", intentHits);
  line("minimum_tool", toolHits);
  line("every assertion", fullMatches);
  console.log(
    `  unicode apostrophes  ${unicode.checked} variant runs, ${unicode.differences.length} routing differences`,
  );
  console.log("");
  printScores(scores);

  console.log("");
  if (hardFailures.length > 0) {
    console.error(`Privacy/robustness gate FAILED — ${hardFailures.length}:`);
    for (const failure of hardFailures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("Privacy/robustness gate passed: no unrequested capture, no privacy-boundary leak,");
  console.log("no apostrophe-variant routing drift.");

  if (softFailures.length > 0) {
    console.error("");
    console.error(`Prompt-pack gate FAILED — ${softFailures.length} expectation(s) missed:`);
    for (const failure of softFailures) console.error(`  - ${failure}`);
    console.error(
      `Missed ids: ${missedIds.join(", ")}. Fix the routing, or change the expectation on ` +
        "purpose and say why — there is no waiver list.",
    );
    process.exit(1);
  }
  console.log(
    `Prompt-pack gate passed: all ${expectations.length} expectations hold, every assertion checked.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
