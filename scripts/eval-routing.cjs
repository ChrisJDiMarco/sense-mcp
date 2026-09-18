#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
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
 * A fixture is privacy-critical when getting it wrong means Sense captures the
 * camera or screen without the user asking, or lets a privacy-boundary prompt
 * through. These are checked first and separately from the fixture's other
 * assertions, because they are the failures that say what went wrong rather
 * than which field mismatched. Both kinds fail the build.
 */
function privacyBreach(fixture, plan) {
  const expectsCapture = CAPTURE_TOOLS.includes(fixture.minimum_tool);
  if (!expectsCapture && usesCapture(plan)) {
    return `routed to a capture tool (${plan.minimum_tool}) for a prompt that does not ask for one`;
  }
  if (fixture.intent === "privacy_boundary" && plan.intent !== "privacy_boundary") {
    return `privacy-boundary prompt routed to ${plan.intent}`;
  }
  for (const tool of fixture.forbidden_recommended_tools ?? []) {
    if (CAPTURE_TOOLS.includes(tool) && plan.recommended_tools.includes(tool)) {
      return `recommended forbidden capture tool ${tool}`;
    }
  }
  if (fixture.requires_explicit_media === false && plan.requires_explicit_media === true) {
    return "claimed explicit media is required for a non-media prompt";
  }
  return null;
}

function scoreboard() {
  return new Map();
}

/**
 * A capture-corpus family is either a literal prompt list or an opener set
 * crossed with a tail set. The cross product is the point: a router that closes
 * "what is ... on my desk" and leaves "what's ... on my desk" open fails.
 */
function expandFamily(family) {
  if (family.prompts) return family.prompts;
  const prompts = [];
  for (const opener of family.openers) {
    for (const tail of family.tails) prompts.push(`${opener} ${tail}`);
  }
  return prompts;
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
  const intents = [...scores.keys()].sort();
  console.log("  intent                     support    TP    FP    FN   precision      recall");
  for (const intent of intents) {
    const { tp, fp, fn, support } = scores.get(intent);
    console.log(
      `  ${intent.padEnd(26)}${String(support).padStart(6)}${String(tp).padStart(6)}` +
        `${String(fp).padStart(6)}${String(fn).padStart(6)}   ${ratio(tp, tp + fp)}    ${ratio(tp, tp + fn)}`,
    );
  }
  const totals = [...scores.values()].reduce(
    (acc, row) => ({ tp: acc.tp + row.tp, support: acc.support + row.support }),
    { tp: 0, support: 0 },
  );
  console.log(`  overall accuracy: ${totals.tp}/${totals.support} (${ratio(totals.tp, totals.support).trim()})`);
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
 * The committed score, for the two statistical corpora and for nothing else.
 *
 * A baseline is a waiver, and it belongs only where a number below 100% is a
 * measurement rather than a defect. `held-out-paraphrases` and
 * `held-out-situation` are samples of how people phrase things, so they get
 * one. The curated adversarial fixtures and the two privacy corpora do not:
 * those are specifications, and a miss there is a defect, so they fail the
 * build directly and no flag can record a miss for them. `--update-baseline`
 * refuses to write anything while a hard gate is red, which is what stopped it
 * from being a one-command waiver for the whole eval.
 *
 * Within the statistical corpora the baseline is still a pass count plus the
 * exact cases known to miss, so a regression fails even when it is traded
 * one-for-one against a fix, and a case that starts passing fails too until
 * `node scripts/eval-routing.cjs --update-baseline` records the better score.
 */
const BASELINE_PATH = path.join(__dirname, "..", "docs", "evals", "routing-baseline.json");

function loadBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function delta(current, baseline) {
  const difference = current - baseline;
  if (difference === 0) return "  same as baseline";
  return difference > 0 ? `  +${difference} vs baseline` : `  ${difference} vs baseline`;
}

function compareCorpus(label, current, baseline, regressions, improvements) {
  const currentSet = new Set(current);
  const baselineSet = new Set(baseline ?? []);
  for (const miss of currentSet) {
    if (!baselineSet.has(miss)) regressions.push(`${label}: ${miss}`);
  }
  for (const miss of baselineSet) {
    if (!currentSet.has(miss)) improvements.push(`${label}: ${miss}`);
  }
}

function writeBaseline(counts, misses) {
  const baseline = {
    description:
      "Committed honest routing score for the two statistical held-out corpora, and for " +
      "nothing else. Every number here was measured, not tuned for: the router is not " +
      "adjusted until a corpus reads 100%. scripts/eval-routing.cjs fails on any regression " +
      "against these counts or against known_misses, and also fails when a known miss starts " +
      "passing, so an improvement has to be recorded here on purpose. The curated fixtures, " +
      "held-out-negatives.json and privacy-capture-corpus.json are deliberately absent: they " +
      "are hard gates, a miss in them is a defect rather than a measurement, and " +
      "--update-baseline refuses to run while any of them is failing. Update with " +
      "`node scripts/eval-routing.cjs --update-baseline` and say in the commit message what " +
      "changed.",
    recorded_at: new Date().toISOString().slice(0, 10),
    counts,
    known_misses: misses,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Baseline rewritten: ${BASELINE_PATH}`);
}

async function main() {
  const updateBaseline = process.argv.includes("--update-baseline");
  const root = path.join(__dirname, "..");
  const evals = path.join(root, "docs", "evals");
  const fixtures = JSON.parse(readFileSync(path.join(evals, "routing-fixtures.json"), "utf8"));
  const negatives = JSON.parse(readFileSync(path.join(evals, "held-out-negatives.json"), "utf8"));
  const paraphrases = JSON.parse(readFileSync(path.join(evals, "held-out-paraphrases.json"), "utf8"));
  const situation = JSON.parse(readFileSync(path.join(evals, "held-out-situation.json"), "utf8"));
  const capture = JSON.parse(readFileSync(path.join(evals, "privacy-capture-corpus.json"), "utf8"));
  const moduleUrl = pathToFileURL(path.join(root, "dist", "relevance.js")).href;
  const { planRelevantContext } = await import(moduleUrl);

  const scores = scoreboard();
  const hardFailures = [];
  const allPrompts = [];
  // Only the statistical corpora can have known misses. The curated fixtures,
  // the held-out negatives and the capture corpus fail the build instead.
  const misses = {
    held_out_paraphrases: [],
    held_out_situation_positives: [],
    held_out_situation_negatives: [],
  };

  let fixturePasses = 0;
  for (const fixture of fixtures) {
    allPrompts.push(fixture.prompt);
    const plan = planRelevantContext(fixture.prompt);
    record(scores, fixture.intent, plan.intent);

    const breach = privacyBreach(fixture, plan);
    if (breach) hardFailures.push(`fixture "${fixture.name}": ${breach}`);

    try {
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
      assertContextPlan(plan, fixture.context_plan);
      fixturePasses += 1;
    } catch (err) {
      // Curated fixtures are a specification, not a sample: every assertion
      // holds or the build fails. They had an independent hard gate, lost it to
      // a shared baseline, and have it back.
      hardFailures.push(`fixture "${fixture.name}": ${err instanceof Error ? err.message : err}`);
    }
  }

  // The unrequested-capture corpus. It runs first because it is the property
  // that matters most: every generated paraphrase must reach no capture tool,
  // and the explicit requests must still reach one, so a router that simply
  // stopped capturing would fail here too.
  let captureChecked = 0;
  let captureFailures = 0;
  for (const family of capture.never_capture) {
    for (const prompt of expandFamily(family)) {
      captureChecked += 1;
      allPrompts.push(prompt);
      const plan = planRelevantContext(prompt);
      if (usesCapture(plan)) {
        captureFailures += 1;
        hardFailures.push(
          `capture corpus [${family.family}] "${prompt}" routed to capture tool ${plan.minimum_tool}`,
        );
      } else if (plan.requires_explicit_media) {
        captureFailures += 1;
        hardFailures.push(
          `capture corpus [${family.family}] "${prompt}" claimed explicit media is required`,
        );
      }
    }
  }
  for (const testCase of capture.always_capture) {
    captureChecked += 1;
    allPrompts.push(testCase.prompt);
    const plan = planRelevantContext(testCase.prompt);
    if (plan.minimum_tool !== testCase.minimum_tool) {
      captureFailures += 1;
      hardFailures.push(
        `capture corpus explicit request "${testCase.prompt}" expected ${testCase.minimum_tool}, ` +
          `got ${plan.minimum_tool}`,
      );
    }
  }

  let negativeHits = 0;
  const negativeMisses = [];
  for (const prompt of negatives.prompts) {
    allPrompts.push(prompt);
    const plan = planRelevantContext(prompt);
    record(scores, negatives.expected_intent, plan.intent);
    if (plan.intent === negatives.expected_intent && plan.minimum_tool === "none") {
      negativeHits += 1;
    } else {
      negativeMisses.push(`"${prompt}" -> ${plan.intent}/${plan.minimum_tool}`);
      hardFailures.push(
        `held-out negative "${prompt}" routed to ${plan.intent}/${plan.minimum_tool}, ` +
          `expected ${negatives.expected_intent}/none`,
      );
    }
    if (usesCapture(plan)) {
      hardFailures.push(`held-out negative "${prompt}" routed to capture tool ${plan.minimum_tool}`);
    }
  }

  let paraphraseIntentHits = 0;
  let paraphraseToolHits = 0;
  const paraphraseMisses = [];
  for (const testCase of paraphrases.cases) {
    allPrompts.push(testCase.prompt);
    const plan = planRelevantContext(testCase.prompt);
    record(scores, testCase.intent, plan.intent);
    if (plan.intent === testCase.intent) paraphraseIntentHits += 1;
    if (plan.minimum_tool === testCase.minimum_tool) paraphraseToolHits += 1;
    if (plan.intent !== testCase.intent || plan.minimum_tool !== testCase.minimum_tool) {
      misses.held_out_paraphrases.push(testCase.prompt);
      paraphraseMisses.push(
        `"${testCase.prompt}" -> ${plan.intent}/${plan.minimum_tool} ` +
          `(want ${testCase.intent}/${testCase.minimum_tool})`,
      );
    }
    if (!testCase.capture && usesCapture(plan)) {
      hardFailures.push(
        `held-out paraphrase "${testCase.prompt}" routed to capture tool ${plan.minimum_tool}`,
      );
    }
    if (testCase.intent === "privacy_boundary" && plan.intent !== "privacy_boundary") {
      hardFailures.push(
        `held-out paraphrase "${testCase.prompt}" left the privacy boundary: ${plan.intent}`,
      );
    }
  }

  // The second held-out corpus, written from the intent definitions rather than
  // from the router's own noun list. It is the only corpus here that can see the
  // deixis gate under-firing on natural phrasing, and it scores badly on purpose:
  // the number is a measurement, not a target the router was fitted to.
  let situationIntentHits = 0;
  let situationToolHits = 0;
  const situationMisses = [];
  for (const testCase of situation.positives) {
    allPrompts.push(testCase.prompt);
    const plan = planRelevantContext(testCase.prompt);
    record(scores, testCase.intent, plan.intent);
    if (plan.intent === testCase.intent) situationIntentHits += 1;
    if (plan.minimum_tool === testCase.minimum_tool) situationToolHits += 1;
    if (plan.intent !== testCase.intent || plan.minimum_tool !== testCase.minimum_tool) {
      misses.held_out_situation_positives.push(testCase.prompt);
      situationMisses.push(
        `"${testCase.prompt}" -> ${plan.intent}/${plan.minimum_tool} ` +
          `(want ${testCase.intent}/${testCase.minimum_tool})`,
      );
    }
    if (!testCase.capture && usesCapture(plan)) {
      hardFailures.push(
        `held-out situation positive "${testCase.prompt}" routed to capture tool ${plan.minimum_tool}`,
      );
    }
  }

  let situationNegativeHits = 0;
  const situationNegativeMisses = [];
  for (const testCase of situation.negatives) {
    allPrompts.push(testCase.prompt);
    const plan = planRelevantContext(testCase.prompt);
    const answeredWithoutSensors =
      plan.intent === "no_local_context_needed" || plan.intent === "writing_or_general_help";
    record(scores, "no_local_context_needed", plan.intent);
    if (answeredWithoutSensors) {
      situationNegativeHits += 1;
    } else {
      misses.held_out_situation_negatives.push(testCase.prompt);
      situationNegativeMisses.push(`"${testCase.prompt}" -> ${plan.intent}/${plan.minimum_tool}`);
    }
    if (usesCapture(plan)) {
      hardFailures.push(
        `held-out situation negative "${testCase.prompt}" routed to capture tool ${plan.minimum_tool}`,
      );
    }
  }

  const unicode = unicodeVariantPass(planRelevantContext, allPrompts);
  for (const difference of unicode.differences) {
    hardFailures.push(`unicode apostrophe variant changed routing: ${difference}`);
  }

  const counts = {
    held_out_paraphrases: {
      intent: paraphraseIntentHits,
      minimum_tool: paraphraseToolHits,
      total: paraphrases.cases.length,
    },
    held_out_situation_positives: {
      intent: situationIntentHits,
      minimum_tool: situationToolHits,
      total: situation.positives.length,
    },
    held_out_situation_negatives: {
      passed: situationNegativeHits,
      total: situation.negatives.length,
    },
  };

  if (updateBaseline) {
    if (hardFailures.length > 0) {
      console.error(`Privacy/robustness gate FAILED — ${hardFailures.length}:`);
      for (const failure of hardFailures) console.error(`  - ${failure}`);
      console.error("");
      console.error(
        "--update-baseline refuses to write while a hard gate is failing. The curated " +
          "fixtures, the held-out negatives and the capture corpus are specifications, not " +
          "measurements: there is no waiver for them.",
      );
      process.exit(1);
    }
    writeBaseline(counts, misses);
    return;
  }

  const baseline = loadBaseline();
  const line = (label, current, total, baselineValue) =>
    console.log(
      `  ${label.padEnd(30)} ${String(current).padStart(3)}/${String(total).padEnd(4)} ` +
        `(${ratio(current, total).trim().padStart(6)})   baseline ${String(baselineValue).padStart(3)}${delta(current, baselineValue)}`,
    );

  const gateLine = (label, current, total) =>
    console.log(
      `  ${label.padEnd(30)} ${String(current).padStart(3)}/${String(total).padEnd(4)} ` +
        `(${ratio(current, total).trim().padStart(6)})   hard gate, no baseline`,
    );

  console.log("Sense routing eval");
  gateLine("capture corpus", captureChecked - captureFailures, captureChecked);
  gateLine("curated fixtures", fixturePasses, fixtures.length);
  gateLine("held-out negatives", negativeHits, negatives.prompts.length);
  line(
    "held-out paraphrases intent",
    paraphraseIntentHits,
    paraphrases.cases.length,
    baseline.counts.held_out_paraphrases.intent,
  );
  line(
    "held-out paraphrases tool",
    paraphraseToolHits,
    paraphrases.cases.length,
    baseline.counts.held_out_paraphrases.minimum_tool,
  );
  line(
    "held-out situation intent",
    situationIntentHits,
    situation.positives.length,
    baseline.counts.held_out_situation_positives.intent,
  );
  line(
    "held-out situation tool",
    situationToolHits,
    situation.positives.length,
    baseline.counts.held_out_situation_positives.minimum_tool,
  );
  line(
    "held-out situation negatives",
    situationNegativeHits,
    situation.negatives.length,
    baseline.counts.held_out_situation_negatives.passed,
  );
  console.log(
    `  unicode apostrophes            ${unicode.checked} variant runs, ${unicode.differences.length} routing differences`,
  );
  console.log("");
  printScores(scores);

  for (const [label, list] of [
    ["held-out negatives", negativeMisses],
    ["held-out paraphrases", paraphraseMisses],
    ["held-out situation positives", situationMisses],
    ["held-out situation negatives", situationNegativeMisses],
  ]) {
    if (list.length === 0) continue;
    console.log("");
    console.log(`Missed ${label} — ${list.length}:`);
    for (const miss of list) console.log(`  - ${miss}`);
  }

  const regressions = [];
  const improvements = [];
  for (const label of Object.keys(misses)) {
    compareCorpus(label, misses[label], baseline.known_misses[label], regressions, improvements);
  }

  console.log("");
  if (hardFailures.length > 0) {
    console.error(`Privacy/robustness gate FAILED — ${hardFailures.length}:`);
    for (const failure of hardFailures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("Privacy/robustness gate passed: no unrequested capture, no privacy-boundary leak,");
  console.log("no apostrophe-variant routing drift.");

  if (regressions.length > 0) {
    console.error("");
    console.error(`Baseline gate FAILED — ${regressions.length} case(s) regressed:`);
    for (const regression of regressions) console.error(`  - ${regression}`);
    if (improvements.length > 0) {
      console.error(`  (${improvements.length} other case(s) improved; a trade is still a regression)`);
    }
    process.exit(1);
  }
  if (improvements.length > 0) {
    console.error("");
    console.error(`Baseline gate FAILED — the baseline is stale: ${improvements.length} case(s) now pass:`);
    for (const improvement of improvements) console.error(`  - ${improvement}`);
    console.error("Record the better score on purpose: node scripts/eval-routing.cjs --update-baseline");
    process.exit(1);
  }
  console.log(`Baseline gate passed: every corpus matches docs/evals/routing-baseline.json (recorded ${baseline.recorded_at}).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
