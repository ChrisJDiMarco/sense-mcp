import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_CONTEXT_BUDGETS,
  MIN_CONTEXT_MAX_TOKENS,
  estimateJsonTokens,
  projectContext,
} from "../src/contextOutput.js";
import type { ContextResult } from "../src/contextProvider.js";
import { relevantContextInputSchema } from "../src/mcpSchemas.js";
import { planRelevantContext } from "../src/relevance.js";

/**
 * A real frame captured from a live `get_context_frame` and sanitized. Budget
 * assertions have to use it: a hand-written frame is an order of magnitude
 * smaller and every truncation defect hides behind it.
 */
const REAL_FRAME_PATH = new URL("../docs/evals/real-frame-fixture.json", import.meta.url);
const REAL_FRAME = JSON.parse(
  readFileSync(fileURLToPath(REAL_FRAME_PATH), "utf8"),
) as {
  description: string;
  captured_from: string;
  frame: ContextResult["frame"];
  health: ContextResult["health"];
};
const REAL_RESULT: ContextResult = {
  frame: REAL_FRAME.frame,
  health: REAL_FRAME.health,
  refreshed_domains: [],
};

describe("planRelevantContext", () => {
  test("routes appearance checks to camera snapshot with appearance mode", () => {
    const plan = planRelevantContext("how do I look right now?");
    expect(plan.intent).toBe("visual_appearance_check");
    expect(plan.minimum_tool).toBe("take_camera_snapshot");
    expect(plan.recommended_tools).toContain("take_camera_snapshot");
    expect(plan.snapshot_mode).toBe("appearance_check");
    expect(plan.relevant_domains).toContain("environment");
    expect(plan.requires_explicit_media).toBe(true);
    expect(plan.privacy_notes.join(" ")).toContain("explicit");
    expect(plan.context_plan.expected_value).toBe("high");
    expect(plan.context_plan.budget.mode).toBe("visual");
    expect(plan.context_plan.include_frame).toBe(false);
    expect(plan.context_plan.included_context).toEqual(["camera_snapshot"]);
    expect(plan.context_satisfied).toBe(false);
    expect(plan.follow_up_tools).toEqual(["take_camera_snapshot"]);
  });

  test("routes hair checks to camera snapshot with hair mode", () => {
    const plan = planRelevantContext("how's my hair?");
    expect(plan.intent).toBe("visual_appearance_check");
    expect(plan.snapshot_mode).toBe("hair_check");
  });

  test("routes screen/UI questions to screen snapshot", () => {
    const plan = planRelevantContext("what is this error on my screen?");
    expect(plan.intent).toBe("screen_debug");
    expect(plan.minimum_tool).toBe("take_window_snapshot");
    expect(plan.recommended_tools).toContain("take_window_snapshot");
    expect(plan.recommended_tools).not.toContain("take_full_screen_snapshot");
    expect(plan.snapshot_mode).toBe("screen_debug");
    expect(plan.relevant_domains).toContain("screen");
    expect(plan.guidance.join(" ")).toContain("window-id capture");
    expect(plan.context_plan.include_frame).toBe(false);
    expect(plan.context_plan.included_context).toEqual(["window_snapshot"]);
  });

  test("routes only an explicit whole-screen request to full-screen capture", () => {
    const plan = planRelevantContext("review my entire screen right now");

    expect(plan.minimum_tool).toBe("take_full_screen_snapshot");
    expect(plan.recommended_tools).toEqual(["take_full_screen_snapshot"]);
    expect(plan.avoided_tools).toContain("take_window_snapshot");
    expect(plan.context_plan.included_context).toEqual(["full_screen_snapshot"]);
  });

  test("does not claim the main-display tool can capture all displays", () => {
    const plan = planRelevantContext("review all my displays right now");

    expect(plan.minimum_tool).toBe("none");
    expect(plan.recommended_tools).toEqual([]);
    expect(plan.guidance.join(" ")).toContain("only the main display");
    expect(plan.avoided_tools).toContain("take_full_screen_snapshot");
  });

  test("does not screenshot non-deictic writing that mentions screen as a topic", () => {
    const plan = planRelevantContext("write an email about the screen redesign");
    expect(plan.intent).toBe("writing_or_general_help");
    expect(plan.minimum_tool).toBe("none");
    expect(plan.recommended_tools).toEqual([]);
    expect(plan.avoided_tools).toEqual([
      "take_camera_snapshot",
      "take_window_snapshot",
      "take_full_screen_snapshot",
      "take_screen_snapshot",
    ]);
  });

  test("routes urgency/time prompts to schedule and user state", () => {
    const plan = planRelevantContext("help me knock this out fast before my meeting");
    expect(plan.intent).toBe("time_pressure");
    expect(plan.minimum_tool).toBe("get_schedule_context");
    expect(plan.recommended_tools).toEqual(["get_schedule_context", "get_user_state"]);
    expect(plan.relevant_domains).toEqual(["schedule", "user"]);
    expect(plan.avoided_tools).toContain("take_camera_snapshot");
    expect(plan.context_plan.expected_value).toBe("high");
    expect(plan.context_plan.external_context_needed).toContain("calendar_connector");
  });

  test("does not treat a bare quick question as time pressure", () => {
    const plan = planRelevantContext("quick question about my code");
    expect(plan.intent).toBe("no_local_context_needed");
    expect(plan.minimum_tool).toBe("none");
    expect(plan.recommended_tools).toEqual([]);
    expect(plan.context_plan.plan_only).toBe(true);
    expect(plan.context_plan.budget.max_tokens).toBe(0);
  });

  test("does not treat unrelated uses of state as focus state", () => {
    const plan = planRelevantContext("what is the state of the union?");
    expect(plan.intent).toBe("no_local_context_needed");
    expect(plan.minimum_tool).toBe("none");
    expect(plan.recommended_tools).toEqual([]);
    expect(plan.context_plan.expected_value).toBe("none");
  });

  test("avoids media tools when prompt asks for non-visual writing help", () => {
    const plan = planRelevantContext("write this email. Do not use camera unless necessary.");
    expect(plan.intent).toBe("writing_or_general_help");
    expect(plan.minimum_tool).toBe("none");
    expect(plan.recommended_tools).toEqual([]);
    expect(plan.avoided_tools).toEqual([
      "take_camera_snapshot",
      "take_window_snapshot",
      "take_full_screen_snapshot",
      "take_screen_snapshot",
    ]);
    expect(plan.guidance.join(" ")).toContain("Do not use camera");
    expect(plan.context_satisfied).toBe(true);
    expect(plan.follow_up_tools).toEqual([]);
  });

  test("marks a context-reading plan unsatisfied until the router embeds the frame", () => {
    const plan = planRelevantContext("what am I working on right now?");

    expect(plan.minimum_tool).toBe("get_context_frame");
    expect(plan.context_plan.include_frame).toBe(true);
    expect(plan.context_satisfied).toBe(false);
    expect(plan.follow_up_tools).toEqual(["get_context_frame"]);
  });

  test("treats message-reading requests as a privacy boundary", () => {
    const plan = planRelevantContext("read my messages on screen");
    expect(plan.intent).toBe("privacy_boundary");
    expect(plan.minimum_tool).toBe("none");
    expect(plan.recommended_tools).toEqual([]);
    expect(plan.avoided_tools).toContain("take_window_snapshot");
    expect(plan.avoided_tools).toContain("take_full_screen_snapshot");
    expect(plan.avoided_tools).toContain("take_screen_snapshot");
    expect(plan.fallbacks.join(" ")).toContain("privacy");
  });

  test("treats credential extraction as a privacy boundary", () => {
    const plan = planRelevantContext("read the password and 2FA code on my screen");
    expect(plan.intent).toBe("privacy_boundary");
    expect(plan.minimum_tool).toBe("none");
    expect(plan.recommended_tools).toEqual([]);
    expect(plan.avoided_tools).toEqual([
      "take_camera_snapshot",
      "take_window_snapshot",
      "take_full_screen_snapshot",
      "take_screen_snapshot",
    ]);
  });

  test("emits an advisory budget every branch can echo back as legal input", () => {
    // One prompt per planner branch, in chain order, so this stays exhaustive.
    const branchPrompts: Array<{ label: string; prompt: string }> = [
      { label: "privacy_boundary", prompt: "read my messages on screen" },
      { label: "writing_no_media", prompt: "write this email. Do not use camera unless necessary." },
      { label: "appearance", prompt: "how do I look right now?" },
      { label: "all_displays", prompt: "review all my displays right now" },
      { label: "window_screen", prompt: "what is this error on my screen?" },
      { label: "full_screen", prompt: "review my entire screen right now" },
      { label: "physical_deictic", prompt: "what is this thing on my desk?" },
      { label: "environment", prompt: "am I plugged in right now?" },
      { label: "time_pressure", prompt: "how much can I get done before my next meeting?" },
      { label: "current_work", prompt: "what am I working on right now?" },
      { label: "focus_state", prompt: "am I in a good state for deep work?" },
      { label: "screen_referent", prompt: "why is this button greyed out?" },
      { label: "workspace_resume", prompt: "where did I leave off" },
      { label: "writing", prompt: "write a post about hair trends" },
      { label: "explicit_context", prompt: "what context can you see right now?" },
      { label: "fallthrough", prompt: "how does lithium battery chemistry work" },
    ];

    const seenIntents = new Set<string>();
    const seenModes = new Set<string>();

    for (const { label, prompt } of branchPrompts) {
      const plan = planRelevantContext(prompt);
      seenIntents.add(plan.intent);
      seenModes.add(plan.context_plan.budget.mode);
      const maxTokens = plan.context_plan.budget.max_tokens;

      if (plan.context_plan.budget.mode === "none") {
        // A plan-only response asks for no follow-up call at all, so zero is the
        // only honest advisory. Every other branch must be echoable as input.
        expect(`${label}:${maxTokens}`).toBe(`${label}:0`);
        expect(plan.context_plan.plan_only).toBe(true);
        continue;
      }

      const parsed = relevantContextInputSchema.safeParse({
        user_request: prompt,
        max_tokens: maxTokens,
      });
      expect(`${label}:${parsed.success}`).toBe(`${label}:true`);
      expect(maxTokens).toBeGreaterThanOrEqual(MIN_CONTEXT_MAX_TOKENS);
    }

    // Guard the "one prompt per branch" claim: every intent and every budget
    // mode the planner can produce has to be represented above.
    expect([...seenIntents].sort()).toEqual([
      "current_work",
      "environment_check",
      "focus_state",
      "general_context",
      "no_local_context_needed",
      "privacy_boundary",
      "screen_debug",
      "time_pressure",
      "visual_appearance_check",
      "writing_or_general_help",
    ]);
    expect([...seenModes].sort()).toEqual(["brief", "focused", "none", "visual"]);
  });

  test("normalizes curly apostrophes before matching", () => {
    for (const apostrophe of ["'", "‘", "’", "ʼ", "‛"]) {
      const plan = planRelevantContext(`how${apostrophe}s my hair?`);
      expect(`${apostrophe.codePointAt(0)}:${plan.intent}`).toBe(
        `${apostrophe.codePointAt(0)}:visual_appearance_check`,
      );
      expect(plan.minimum_tool).toBe("take_camera_snapshot");
      expect(plan.snapshot_mode).toBe("hair_check");
    }
  });

  test("does not read a bare topic noun as a local sensor question", () => {
    const bareTopics = [
      "write a blog post about the best lighting for a home office",
      "how does lithium battery chemistry work",
      "what is the deadline for filing taxes in california",
    ];

    for (const prompt of bareTopics) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.minimum_tool}`).toBe(`${prompt} -> none`);
      expect(plan.context_plan.plan_only).toBe(true);
      expect(plan.intent).not.toBe("environment_check");
      expect(plan.intent).not.toBe("time_pressure");
    }
  });

  test("routes deictic on-screen referents to pixel-free screen context", () => {
    const plan = planRelevantContext("why is this button greyed out?");

    expect(plan.intent).toBe("screen_debug");
    expect(plan.minimum_tool).toBe("get_screen_context");
    expect(plan.confidence).toBe("medium");
    expect(plan.recommended_tools).toEqual(["get_screen_context"]);
    expect(plan.requires_explicit_media).toBe(false);
    expect(plan.avoided_tools).toEqual([
      "take_camera_snapshot",
      "take_window_snapshot",
      "take_full_screen_snapshot",
      "take_screen_snapshot",
    ]);
  });

  test("routes a resume-where-I-left-off question to pixel-free screen context", () => {
    const plan = planRelevantContext("where did I leave off");

    expect(plan.intent).toBe("current_work");
    expect(plan.minimum_tool).toBe("get_screen_context");
    expect(plan.confidence).toBe("medium");
    expect(plan.recommended_tools).toEqual(["get_screen_context"]);
    expect(plan.requires_explicit_media).toBe(false);
    expect(plan.avoided_tools).toContain("take_window_snapshot");
  });

  test("does not read a writing task about an on-screen control as a screen question", () => {
    // The deixis gate was added so "write a post about the best lighting"
    // stopped reaching a sensor. The deictic on-screen branch added later
    // reintroduced exactly that miss for "my sidebar" / "my button", and the
    // physical-referent branch reintroduced it on a camera capture.
    const writingTasks = [
      "write a blog post about my sidebar design",
      "write documentation for my button component",
      "edit this paragraph about my toolbar redesign",
      "draft a post about my desk setup",
      "write an email about my workspace reorganization",
      "draft an article about my focus routine",
      "write a post about my deadline anxiety",
    ];

    for (const prompt of writingTasks) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.intent}`).toBe(`${prompt} -> writing_or_general_help`);
      expect(`${prompt} -> ${plan.minimum_tool}`).toBe(`${prompt} -> none`);
      expect(plan.recommended_tools).toEqual([]);
      expect(plan.requires_explicit_media).toBe(false);
    }
  });

  test("still routes the same nouns to a sensor when the request is not a writing task", () => {
    // The writing gate must not cost the branches it guards.
    const situationRequests: Array<[string, string]> = [
      ["why is this button greyed out?", "get_screen_context"],
      ["what is this thing on my desk?", "take_camera_snapshot"],
      ["what is my current workspace?", "get_context_frame"],
      ["am I in a good state for deep work?", "get_context_frame"],
      ["is my battery going to last another hour?", "get_environment_context"],
    ];

    for (const [prompt, minimumTool] of situationRequests) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.minimum_tool}`).toBe(`${prompt} -> ${minimumTool}`);
    }
  });

  test("routes embedded resume phrasings, not only the inverted question form", () => {
    // "remind me what I was working on" is the commoner English order; the
    // branch only matched the inverted "what was I working on".
    const resumeRequests = [
      "remind me what I was working on",
      "remind me where I left off",
      "what am I in the middle of",
      // Not "...before the call": an explicit meeting reference is time
      // pressure first, and that precedence is deliberate.
      "what was I in the middle of",
      "where did I leave off",
      "can you pick up where I left off?",
    ];

    for (const prompt of resumeRequests) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.intent}`).toBe(`${prompt} -> current_work`);
      expect(`${prompt} -> ${plan.minimum_tool}`).toBe(`${prompt} -> get_screen_context`);
      expect(plan.requires_explicit_media).toBe(false);
    }
  });

  test("keeps the page-readable trigger, but only under deixis", () => {
    // Removed once as a duplicate of "this page" / "current page", which it is
    // not: a readability question names no deictic page.
    const screenPlan = planRelevantContext("is the page readable at this size");
    expect(screenPlan.intent).toBe("screen_debug");
    expect(screenPlan.minimum_tool).toBe("take_window_snapshot");

    // ...and the general-knowledge form must still reach no capture at all.
    const generalPlan = planRelevantContext("what makes a page readable for dyslexic readers");
    expect(generalPlan.intent).toBe("no_local_context_needed");
    expect(generalPlan.minimum_tool).toBe("none");
    expect(generalPlan.recommended_tools).toEqual([]);
  });

  test("advisory budgets carry a real frame plus the real router envelope", () => {
    // Measured against the sanitized live frame, not a hand-written one: a
    // minimal frame costs a tenth of this and would pass any budget.
    const branches: Array<{ prompt: string; projection: "brief" | "focused" }> = [
      { prompt: "what am I working on right now?", projection: "focused" },
      { prompt: "what context can you see right now?", projection: "focused" },
      { prompt: "how much can I get done before my next meeting?", projection: "focused" },
      { prompt: "am I in a good state for deep work?", projection: "focused" },
      { prompt: "am I plugged in right now?", projection: "brief" },
      { prompt: "why is this button greyed out?", projection: "brief" },
      { prompt: "where did I leave off", projection: "brief" },
    ];

    for (const { prompt, projection } of branches) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt}:${plan.context_plan.include_frame}`).toBe(`${prompt}:true`);

      // What the server embeds: the frame at the projection this branch's
      // minimum tool defaults to, over the domains the plan asked for.
      const context = projectContext(REAL_RESULT, {
        projection,
        domains: plan.relevant_domains,
        max_tokens: DEFAULT_CONTEXT_BUDGETS[projection],
        context_satisfied: true,
      });
      expect(`${prompt}:truncated=${context.budget.truncated}`).toBe(`${prompt}:truncated=false`);

      // What the client actually gets back from get_relevant_context, which is
      // what max_tokens is a ceiling on.
      const wholeResponse = estimateJsonTokens({
        ok: true,
        ...plan,
        context_satisfied: true,
        context: context.context,
        context_budget: context.budget,
        health: context.health,
        refreshed_domains: context.refreshed_domains,
      });
      const advisory = plan.context_plan.budget.max_tokens;
      expect(wholeResponse).toBeLessThanOrEqual(advisory);

      // This machine's frame is not the worst case: the context tool will fill
      // a frame right up to the projection default. An advisory equal to that
      // default leaves nothing for the plan around it, and the router answers
      // by silently swapping in its degraded candidate — no error, just missing
      // guidance and privacy notes. So the advisory has to cover both.
      const envelope = estimateJsonTokens({ ok: true, ...plan });
      expect(`${prompt}: advisory ${advisory}`).toBe(
        `${prompt}: advisory ${Math.max(advisory, DEFAULT_CONTEXT_BUDGETS[projection] + envelope)}`,
      );

      // And the advisory has to remain a legal input, not just a large number.
      const parsed = relevantContextInputSchema.safeParse({
        user_request: prompt,
        max_tokens: advisory,
      });
      expect(`${prompt}:${parsed.success}`).toBe(`${prompt}:true`);
    }
  });

  test("a visual branch advises enough for the context a capture is answered with", () => {
    // Snapshot tools take no max_tokens, so the visual advisory describes the
    // most context a client should pull alongside the capture: a compact frame.
    const plan = planRelevantContext("how do I look right now?");
    expect(plan.context_plan.budget.mode).toBe("visual");

    const compact = projectContext(REAL_RESULT, {
      projection: "compact",
      domains: ["screen", "user", "environment", "schedule"],
      max_tokens: DEFAULT_CONTEXT_BUDGETS.compact,
      context_satisfied: true,
    });
    const alongside = estimateJsonTokens({ ok: true, ...plan, context: compact.context });
    expect(alongside).toBeLessThanOrEqual(plan.context_plan.budget.max_tokens);
    expect(plan.context_plan.budget.max_tokens).toBeGreaterThanOrEqual(MIN_CONTEXT_MAX_TOKENS);
  });

  test("routes the pack's urgency and next-action prompts to a sensor branch", () => {
    // These eight prompt-pack expectations were matched by literal prompt
    // strings ("knock this out fast", "safest next engineering step"), which
    // were removed as corpus-fitting. Removing them was right; removing the
    // behavior with them was not. They are back as rules about the shape of the
    // request, and each one is paired below with the general-knowledge form of
    // the same words, which must still reach no sensor at all.
    const situationRequests: Array<[string, string, string]> = [
      ["help me knock this out fast.", "time_pressure", "get_schedule_context"],
      ["can you help me wrap this up quickly", "time_pressure", "get_schedule_context"],
      ["should I start a big refactor right now?", "time_pressure", "get_schedule_context"],
      ["is it worth taking on something large this afternoon?", "time_pressure", "get_schedule_context"],
      ["do I need to prep for anything coming up?", "time_pressure", "get_schedule_context"],
      ["should I send this now or wait?", "time_pressure", "get_schedule_context"],
      ["help me choose between debugging, writing, or admin work.", "current_work", "get_context_frame"],
      ["what is the safest next engineering step?", "current_work", "get_context_frame"],
      ["should I run tests now?", "current_work", "get_context_frame"],
      ["should I commit before moving on?", "current_work", "get_context_frame"],
      ["should I open a pull request yet?", "current_work", "get_context_frame"],
    ];

    for (const [prompt, intent, minimumTool] of situationRequests) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.intent}`).toBe(`${prompt} -> ${intent}`);
      expect(`${prompt} -> ${plan.minimum_tool}`).toBe(`${prompt} -> ${minimumTool}`);
      expect(plan.requires_explicit_media).toBe(false);
    }
  });

  test("keeps the general-knowledge form of those same words out of every sensor", () => {
    // The paired half of the test above: a rule that fires on "next step" or
    // "choose between" regardless of who the sentence is about would pass the
    // prompt pack and be worse than what it replaced.
    const generalKnowledge = [
      "how do I learn this quickly",
      "what are good ways to start a big open source project",
      "what is coming up in the next javascript release",
      "how do commit hooks work in git",
      "how do people choose between meetings and deep work in general",
      "what is the next step in the scientific method",
      "what is the usual next move for a startup after a seed round",
    ];

    for (const prompt of generalKnowledge) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.intent}`).toBe(`${prompt} -> no_local_context_needed`);
      expect(`${prompt} -> ${plan.minimum_tool}`).toBe(`${prompt} -> none`);
      expect(plan.recommended_tools).toEqual([]);
    }
  });

  test("does not capture the camera for talk about recording, lighting or a desk", () => {
    // Every one of these reached take_camera_snapshot: "start recording" and
    // "before recording" fired the appearance branch with no first person in
    // the sentence at all, bare "lighting ... video call" fired it without
    // deixis, and bare "my desk" / "behind me" fired the physical-referent
    // branch for any sentence that merely mentioned the place.
    const noCapture = [
      "how do I start recording in zoom",
      "what is the shortcut to start recording a screencast",
      "what should I check before recording a screencast",
      "tips for lighting a video call in general",
      "how should I organize my desk",
      "what is a good height for my desk",
      "how do I keep my desk tidy in general",
      "how do I declutter the cables behind me for good",
    ];

    for (const prompt of noCapture) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.minimum_tool}`).toBe(`${prompt} -> none`);
      expect(plan.recommended_tools).toEqual([]);
      expect(plan.requires_explicit_media).toBe(false);
    }
  });

  test("still captures when the request really is about what is in front of the camera", () => {
    // The narrowing above must not cost the branch: these are the requests the
    // camera exists for, including the prompt-pack phrasings.
    const capture: Array<[string, string]> = [
      ["what is this thing on my desk?", "take_camera_snapshot"],
      ["is there anything visibly distracting behind me?", "take_camera_snapshot"],
      ["give me one quick improvement before I start recording.", "take_camera_snapshot"],
      ["is my lighting okay for a video call?", "take_camera_snapshot"],
      ["can you tell me what is on my desk", "take_camera_snapshot"],
    ];

    for (const [prompt, minimumTool] of capture) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.minimum_tool}`).toBe(`${prompt} -> ${minimumTool}`);
      expect(plan.requires_explicit_media).toBe(true);
    }
  });

  test("treats a writing task about where I left off as writing, not as resuming", () => {
    // The resume branch was added in the same change that introduced the
    // writing gate for deictic branches, and was the one branch that did not
    // get it: these routed to get_screen_context.
    const writingTasks = ["write up a summary of where I left off", "draft a note about what I was working on"];

    for (const prompt of writingTasks) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.intent}`).toBe(`${prompt} -> writing_or_general_help`);
      expect(`${prompt} -> ${plan.minimum_tool}`).toBe(`${prompt} -> none`);
      expect(plan.recommended_tools).toEqual([]);
    }

    // ...and the request to actually go and look is untouched.
    const resume = planRelevantContext("remind me where I left off");
    expect(resume.intent).toBe("current_work");
    expect(resume.minimum_tool).toBe("get_screen_context");
  });

  test("advisory budgets still hold when the frame grows past the captured one", () => {
    // A frame grows during a session: more evidence, more recent changes, a
    // longer window title. The captured fixture is one moment, so it is a floor
    // and not a worst case. Grown well past it, the projection must truncate
    // into its own default rather than overrun it, and the advisory must still
    // cover the whole response.
    const grown: ContextResult = {
      ...REAL_RESULT,
      frame: {
        ...REAL_RESULT.frame,
        screen: {
          ...REAL_RESULT.frame.screen,
          active_window_title: `${"parser refactor — very long window title segment ".repeat(8)}`,
        },
        situation: {
          ...REAL_RESULT.frame.situation,
          evidence: Array.from({ length: 150 }, (_, index) => `evidence line ${index}: dirty worktree on feature-parser`),
          unknowns: Array.from({ length: 50 }, (_, index) => `unknown ${index}`),
          risks: Array.from({ length: 50 }, (_, index) => `risk ${index}: heavy uncommitted change`),
          recommendations: Array.from({ length: 50 }, (_, index) => `recommendation ${index}`),
          recent_changes: Array.from({ length: 100 }, (_, index) => `change ${index}: branch or app switch`),
        },
      },
    } as ContextResult;

    // Sanity: the grown frame really is bigger than the captured one.
    expect(estimateJsonTokens(grown.frame)).toBeGreaterThan(
      estimateJsonTokens(REAL_RESULT.frame) * 2,
    );

    const branches: Array<{ prompt: string; projection: "brief" | "focused" }> = [
      { prompt: "what am I working on right now?", projection: "focused" },
      { prompt: "am I plugged in right now?", projection: "brief" },
      { prompt: "should I commit before moving on?", projection: "focused" },
    ];

    for (const { prompt, projection } of branches) {
      const plan = planRelevantContext(prompt);
      const context = projectContext(grown, {
        projection,
        domains: plan.relevant_domains,
        max_tokens: DEFAULT_CONTEXT_BUDGETS[projection],
        context_satisfied: true,
      });

      // Truncation is allowed here; overrunning the budget is not.
      expect(`${prompt}:${context.budget.estimated_tokens <= DEFAULT_CONTEXT_BUDGETS[projection]}`).toBe(
        `${prompt}:true`,
      );

      const wholeResponse = estimateJsonTokens({
        ok: true,
        ...plan,
        context_satisfied: true,
        context: context.context,
        context_budget: context.budget,
        health: context.health,
        refreshed_domains: context.refreshed_domains,
      });
      expect(`${prompt}:${wholeResponse <= plan.context_plan.budget.max_tokens}`).toBe(`${prompt}:true`);
    }
  });

  test("the budget fixture is a real captured frame, not a hand-written one", () => {
    // Provenance, checked rather than described: docs/evals/README.md says how
    // this file was captured and how to regenerate it, and every budget
    // assertion in this file is only meaningful if the fixture is really of
    // live size. A minimal frame swapped in for convenience would make those
    // assertions pass vacuously, so it fails here first.
    expect(REAL_FRAME.captured_from).toContain("get_context_frame");
    expect(REAL_FRAME.captured_from).toContain("projection=debug");
    expect(REAL_FRAME.description).toContain("sanitized");

    for (const domain of ["screen", "environment", "user", "schedule"] as const) {
      expect(`${domain}:${Object.keys(REAL_FRAME.frame[domain] ?? {}).length > 4}`).toBe(
        `${domain}:true`,
      );
    }
    expect(Object.keys(REAL_FRAME.frame.privacy?.capabilities ?? {}).length).toBeGreaterThan(15);

    // A hand-written frame in this repo's tests runs a few hundred tokens; the
    // captured one is an order of magnitude past that, and past what a focused
    // projection is allowed to spend, which is what makes truncation testable.
    expect(estimateJsonTokens(REAL_FRAME.frame)).toBeGreaterThan(3000);
    expect(estimateJsonTokens(REAL_FRAME.frame)).toBeGreaterThan(DEFAULT_CONTEXT_BUDGETS.focused);
  });

  test("SPEC.md publishes the advisory budgets the router actually emits", () => {
    // The advisories are derived from DEFAULT_CONTEXT_BUDGETS, which another
    // module owns and has already moved once. Reading SPEC back keeps the
    // documented contract from going stale behind a constant change.
    const spec = readFileSync(fileURLToPath(new URL("../SPEC.md", import.meta.url)), "utf8");
    const documented = new Map<string, number>();
    for (const [, mode, advisory] of spec.matchAll(
      /^\| `(visual|brief|focused)`\s*\|[^|]*\|[^|]*\|\s*`(\d+)`\s*\|$/gm,
    )) {
      documented.set(mode, Number(advisory));
    }
    expect([...documented.keys()].sort()).toEqual(["brief", "focused", "visual"]);

    const emitted = new Map(
      [
        "how do I look right now?",
        "am I plugged in right now?",
        "what am I working on right now?",
      ].map((prompt) => {
        const plan = planRelevantContext(prompt);
        return [plan.context_plan.budget.mode, plan.context_plan.budget.max_tokens];
      }),
    );
    expect(Object.fromEntries(documented)).toEqual(Object.fromEntries(emitted));

    // ...and the worked example in the same section.
    expect(spec).toContain(`"budget": { "mode": "focused", "max_tokens": ${emitted.get("focused")} }`);
  });
});

const CAPTURE_TOOLS = [
  "take_camera_snapshot",
  "take_window_snapshot",
  "take_full_screen_snapshot",
  "take_screen_snapshot",
];

function usesCapture(plan: ReturnType<typeof planRelevantContext>): boolean {
  return (
    CAPTURE_TOOLS.includes(plan.minimum_tool) ||
    plan.recommended_tools.some((tool) => CAPTURE_TOOLS.includes(tool))
  );
}

/**
 * The property this project cannot get wrong: Sense must never recommend a
 * capture the user did not ask for. Every case below reached one before the
 * change that added the test beside it.
 */
describe("unrequested capture", () => {
  test("naming a place is not asking for the room to be looked at", () => {
    // The inspection gate keyed on a bare "what is", which opens most questions
    // in English, so every one of these reached take_camera_snapshot.
    for (const prompt of [
      "what is a good way to organize the cables on my desk",
      "what's the best lamp to put on my desk",
      "what is a normal temperature in my room",
      "what is the average humidity in my room in winter",
      "what is a good webcam angle for someone behind me",
      "what would be the cheapest way to soundproof the wall behind me",
      "could you please tell me what a good way to organize the cables on my desk is",
      "can you see a way to make my desk setup cheaper",
    ]) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.minimum_tool}`).toBe(`${prompt} -> none`);
      expect(plan.requires_explicit_media).toBe(false);
    }
  });

  test("a body-part noun used as a topic is not an appearance check", () => {
    for (const prompt of [
      "does my hair grow faster in summer",
      "is my hair type suited to sulfate free shampoo",
      "what sunscreen should I use on my face",
      "how do I moisturize my face in winter",
      "does my beard need different oil in winter",
    ]) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.intent}`).toBe(`${prompt} -> no_local_context_needed`);
      expect(usesCapture(plan)).toBe(false);
    }
  });

  test("'look' as a phrasal verb is not a question about the user's face", () => {
    for (const prompt of [
      "how do I look up a word in the dictionary",
      "how do I look up a DNS record",
      "how do I look into a memory leak",
      "how do I look at this problem differently",
      "do I look for the file first or the folder",
    ]) {
      expect(`${prompt} -> ${planRelevantContext(prompt).minimum_tool}`).toBe(`${prompt} -> none`);
    }
    // ...and the appearance question itself still is one.
    for (const prompt of ["how do I look right now?", "do I look presentable enough for a client?"]) {
      expect(`${prompt} -> ${planRelevantContext(prompt).minimum_tool}`).toBe(
        `${prompt} -> take_camera_snapshot`,
      );
    }
  });

  test("a bare demonstrative is not an object on the desk", () => {
    for (const prompt of [
      "how do I clone this object in JavaScript",
      "how do I serialize this object to JSON",
      "how does this thing work under the hood",
      "what is this thing called in linguistics",
    ]) {
      expect(`${prompt} -> ${planRelevantContext(prompt).minimum_tool}`).toBe(`${prompt} -> none`);
    }
    // The same demonstrative in the room still reaches the camera.
    expect(planRelevantContext("what is this thing on my desk?").minimum_tool).toBe(
      "take_camera_snapshot",
    );
  });

  test("talk about recording is not a pre-recording appearance check", () => {
    for (const prompt of [
      "what should I read before I hop on a plane",
      "what podcasts should I queue before I go live on twitch someday",
      "how long should I warm up my voice before I record a podcast",
    ]) {
      expect(`${prompt} -> ${planRelevantContext(prompt).minimum_tool}`).toBe(`${prompt} -> none`);
    }
    expect(
      planRelevantContext("give me one quick improvement before I start recording.").minimum_tool,
    ).toBe("take_camera_snapshot");
  });

  test("the display as a physical panel or a document is not a screenshot request", () => {
    for (const prompt of [
      "how do I clean my screen without scratching it",
      "what size is my screen in inches",
      "my screen is cracked, is it worth repairing",
      "how do I cite this page in APA format",
      "how do I print this page as a PDF",
      "what does this error mean: TypeError undefined is not a function",
      "is this UI pattern common in banking apps",
      "what is the current app store review time",
      "what current window functions exist in postgres",
    ]) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.minimum_tool}`).toBe(`${prompt} -> none`);
    }
    // The same referents under a request to read the screen back still capture.
    for (const prompt of [
      "review this screen and tell me the biggest UI issue",
      "what is this error on my screen?",
      "is this page readable?",
    ]) {
      expect(`${prompt} -> ${planRelevantContext(prompt).minimum_tool}`).toBe(
        `${prompt} -> take_window_snapshot`,
      );
    }
  });

  test("a procedure question about the capture apparatus is not a capture request", () => {
    for (const prompt of [
      "how do I record my entire screen in quicktime",
      "how do I screenshot my whole screen on a mac",
      "can you check the camera settings in obs for me",
      "what is a fit check on tiktok",
      "take a photo of me in front of the eiffel tower someday",
    ]) {
      expect(`${prompt} -> ${planRelevantContext(prompt).minimum_tool}`).toBe(`${prompt} -> none`);
    }
    // The request to use the camera, and the whole-screen request, still hold.
    expect(planRelevantContext("check the camera before the call starts").minimum_tool).toBe(
      "take_camera_snapshot",
    );
    expect(planRelevantContext("fit check").minimum_tool).toBe("take_camera_snapshot");
    expect(planRelevantContext("review my entire screen right now").minimum_tool).toBe(
      "take_full_screen_snapshot",
    );
  });

  test("every generated capture-corpus paraphrase stays away from a capture", () => {
    // The corpus the routing eval hard-gates on, checked here too so `npm test`
    // alone cannot go green while an unrequested capture is reachable.
    const corpus = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../docs/evals/privacy-capture-corpus.json", import.meta.url)),
        "utf8",
      ),
    ) as {
      never_capture: Array<{
        family: string;
        prompts?: string[];
        openers?: string[];
        tails?: string[];
      }>;
      always_capture: Array<{ prompt: string; minimum_tool: string }>;
    };

    let checked = 0;
    for (const family of corpus.never_capture) {
      const prompts =
        family.prompts ??
        (family.openers ?? []).flatMap((opener) =>
          (family.tails ?? []).map((tail) => `${opener} ${tail}`),
        );
      expect(`${family.family} expands to prompts`).toBe(
        prompts.length > 0 ? `${family.family} expands to prompts` : "",
      );
      for (const prompt of prompts) {
        checked += 1;
        const plan = planRelevantContext(prompt);
        expect(`${family.family}: ${prompt} -> capture=${usesCapture(plan)}`).toBe(
          `${family.family}: ${prompt} -> capture=false`,
        );
      }
    }
    // Two-sided on purpose: a router that never captures fails this test.
    for (const { prompt, minimum_tool } of corpus.always_capture) {
      checked += 1;
      expect(`${prompt} -> ${planRelevantContext(prompt).minimum_tool}`).toBe(
        `${prompt} -> ${minimum_tool}`,
      );
    }
    expect(checked).toBeGreaterThan(150);
  });

  test("no baseline file can waive a hard-gated corpus", () => {
    // `--update-baseline` used to be able to record a miss for the curated
    // fixtures and the negatives corpus, which made it a one-command waiver for
    // the whole eval. The baseline now covers the statistical corpora only.
    const baseline = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../docs/evals/routing-baseline.json", import.meta.url)),
        "utf8",
      ),
    ) as { counts: Record<string, unknown>; known_misses: Record<string, string[]> };
    const statistical = [
      "held_out_paraphrases",
      "held_out_situation_positives",
      "held_out_situation_negatives",
    ];
    expect(Object.keys(baseline.counts).sort()).toEqual([...statistical].sort());
    expect(Object.keys(baseline.known_misses).sort()).toEqual([...statistical].sort());
  });
});

/**
 * Routing rules added for the situation prompts read ordinary decisions as work
 * decisions and sent them to a full local context frame. Each case below did.
 */
describe("local context over-triggering", () => {
  test("an action verb in a non-work sense is not a workspace action", () => {
    for (const prompt of [
      "should I push myself harder at the gym",
      "should I commit to a two year lease",
      "should I ship a product that is not fully polished to early customers",
      "should I merge these two paragraphs into one",
      "should I deploy on fridays",
      "is it time to refactor a codebase that nobody owns",
      "should I run tests before or after code review as a rule",
    ]) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.intent}/${plan.minimum_tool}`).toBe(
        `${prompt} -> no_local_context_needed/none`,
      );
    }
    // The same frame around the work in progress still reaches the frame.
    for (const prompt of [
      "should I run tests now?",
      "should I commit before moving on?",
      "should I merge these branches?",
    ]) {
      expect(`${prompt} -> ${planRelevantContext(prompt).minimum_tool}`).toBe(
        `${prompt} -> get_context_frame`,
      );
    }
  });

  test("a next step belonging to another subject is not local work", () => {
    for (const prompt of [
      "what is the next step after boiling the pasta",
      "what is the next thing to do when a fuse blows",
      "what should I do next in the legend of zelda",
      "what is the next move for a startup after a seed round",
    ]) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.minimum_tool}`).toBe(`${prompt} -> none`);
    }
    expect(planRelevantContext("what is the safest next engineering step?").minimum_tool).toBe(
      "get_context_frame",
    );
    expect(planRelevantContext("what should I do next in this repo?").minimum_tool).toBe(
      "get_context_frame",
    );
  });

  test("a procedure or generalization about a topic noun reaches no sensor", () => {
    for (const prompt of [
      "how do I improve my focus while studying",
      "how do I stay focused during a long drive",
      "how do I keep my repo clean over time",
      "how should I structure a deep work schedule in general",
      "what is the current thinking on open plan office noise",
      "what is the best lighting for my kitchen",
      "should I buy a laptop with better battery life",
    ]) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.intent}`).toBe(`${prompt} -> no_local_context_needed`);
    }
    // The same nouns, asked about right now, still reach their sensor.
    expect(planRelevantContext("is my focus holding up today?").minimum_tool).toBe(
      "get_context_frame",
    );
    expect(planRelevantContext("is my battery going to last another hour?").minimum_tool).toBe(
      "get_environment_context",
    );
  });

  test("a demonstrative determiner is not local deixis", () => {
    // `hasLocalDeixis` matched a bare "this", so the deixis gate was satisfied
    // by any sentence containing the word — including the tax-deadline example
    // its own comment names as the thing it excludes.
    for (const prompt of [
      "what is the deadline for filing taxes this year",
      "is there a deadline coming up in this legislative session",
      "how does a battery work in this kind of device",
      "how much noise does this kind of fan make",
      "what does workspace mean in this context",
      "what repo layout do people use for this sort of project",
      "is deep work possible in this kind of open office",
    ]) {
      const plan = planRelevantContext(prompt);
      expect(`${prompt} -> ${plan.intent}/${plan.minimum_tool}`).toBe(
        `${prompt} -> no_local_context_needed/none`,
      );
    }
    // A demonstrative pointing at something present still counts.
    expect(planRelevantContext("why is this button greyed out?").minimum_tool).toBe(
      "get_screen_context",
    );
    expect(planRelevantContext("what does this disabled menu item mean?").minimum_tool).toBe(
      "get_screen_context",
    );
    expect(planRelevantContext("is it worth taking on something large this afternoon?").intent).toBe(
      "time_pressure",
    );
  });
});
