import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  ContextProvider,
  ContextProviderHealth,
  ContextResult,
} from "../src/contextProvider.js";
import { MAX_CONTEXT_MAX_TOKENS, MIN_CONTEXT_MAX_TOKENS } from "../src/contextOutput.js";
import { SENSE_SERVER_INSTRUCTIONS } from "../src/instructions.js";
import { createServer, type ServerDependencies } from "../src/server.js";
import type { ContextFrame, FieldQuality } from "../src/types.js";

const connected: Array<{ client: Client; server: ReturnType<typeof createServer> }> = [];

function contextResult(): ContextResult {
  return {
    frame: {
      spec: "context-frame/0.2",
      generated_at: "2026-07-11T12:00:00.000Z",
      staleness_ms: 200,
      privacy: { tier: 1, capabilities: { screen_activity: "granted" } },
      assistive_posture: "do_not_interrupt",
      screen: {
        active_app: "Code",
        activity_class: "coding",
        workspace_name: "sense-mcp",
      },
      situation: {
        summary: "User appears active working in sense-mcp.",
        confidence: "medium",
        evidence: ["workspace sense-mcp", "activity coding"],
        unknowns: [],
        risks: [],
        recommendations: [],
        recent_changes: ["Working in sense-mcp (coding)"],
      },
      quality: {
        overall_freshness: "fresh",
        domains: {},
        fields: {},
        stability: { screen_activity: "stable" },
      },
    },
    health: {
      status: "healthy",
      source: "broker",
      checked_at: "2026-07-11T12:00:00.000Z",
      diagnostics: [],
    },
    refreshed_domains: [],
  };
}

/**
 * The same realistically full frame protocol-output.test.ts measures the
 * projection defaults against, transcribed from live `npm run smoke` output.
 * The defects this file pins are invisible against a hand-written minimal
 * frame: a minimal frame's whole router payload fits any budget, so the ladder
 * never has to choose and the collapse never shows.
 */
const SMOKE_AT = "2026-09-18T19:51:49.795Z";

function fieldQuality(
  source: string,
  fields: Record<string, unknown>,
): Record<string, FieldQuality> {
  return Object.fromEntries(
    Object.keys(fields).map((field) => [
      field,
      {
        source,
        classification: "observed" as const,
        observed_at: SMOKE_AT,
        staleness_ms: 2_500,
      },
    ]),
  );
}

/**
 * A realistically full frame, transcribed from live `npm run smoke` /
 * get_context_frame debug output on a fully enabled macOS install, with the
 * `user` and `schedule` domains filled in from exactly the fields idle.ts,
 * focusMode.ts and calendar.ts emit. The shipped defaults are derived against
 * this shape, so it is what keeps them honest.
 */
function smokeFrame(): ContextFrame {
  const screen = {
    workspace_name: "jarvis",
    git_branch: "private-main",
    git_dirty_count: 728,
    git_has_uncommitted_changes: true,
    git_dirty_severity: "heavy",
    project_type: "unknown",
    has_test_script: false,
    has_build_script: false,
    has_dev_script: false,
    work_mode: "implementation",
    active_app: "WhatsApp",
    activity_class: "unknown",
    active_window_label: "unknown",
    sensitivity_level: "normal",
    active_window_title: "WhatsApp",
  };
  const user = {
    idle_seconds: 3,
    presence: "active",
    input_cadence: "steady",
    focus_mode: "deep_work",
    do_not_disturb: false,
  };
  const environment = {
    local_time: "15:51",
    day_segment: "afternoon",
    daylight_class: "daylight",
    is_workday: true,
    camera_capture_enabled: true,
    camera_requires_local_consent: true,
    battery_percent: 100,
    power_source: "ac_power",
    low_power: false,
    media_app: "Spotify",
    media_playback: "paused",
    media_type: "music",
    external_display_count: 2,
    multi_display: true,
    airpods_connected: false,
    bluetooth_input_connected: false,
    noise_class: "quiet",
    microphone_level_db: -53.1,
    microphone_level_sample_ms: 1_000,
  };
  const schedule = {
    in_meeting: false,
    next_event_minutes: 15,
    time_pressure: "high",
    usable_work_minutes: 12,
    work_window: "short",
    meeting_state: "upcoming",
    prep_window: "now",
  };

  return {
    spec: "context-frame/0.2",
    generated_at: SMOKE_AT,
    staleness_ms: 2_596,
    privacy: {
      tier: 3,
      capabilities: {
        screen_activity: "granted",
        presence: "granted",
        power: "granted",
        device_context: "granted",
        workspace_state: "granted",
        calendar: "denied",
        location_class: "denied",
        now_playing: "granted",
        ambient_light: "granted",
        microphone_level: "granted",
        focus_mode: "granted",
        camera_snapshot: "granted",
        health_context: "unavailable",
        weather: "unavailable",
        iphone_context: "unavailable",
        raw_window_titles: "granted",
        screen_snapshot: "granted",
        window_snapshot: "granted",
        full_screen_snapshot: "denied",
        camera_attention: "unavailable",
      },
      capability_details: {
        ambient_light: {
          sensor: "ambient-light",
          reason: "ambient_light_not_exposed",
          detail: "macOS did not expose an AppleLMUController ambient light value.",
          fix_hint:
            "Use daylight_class as the fallback; some Macs or display setups do not expose room brightness.",
        },
        location_class: {
          sensor: "location",
          reason: "disabled_by_policy",
          detail: "Wi-Fi location classification is disabled in the Sense policy.",
          fix_hint: "Run sense-mcp enable location to allow coarse local classification.",
        },
      },
    },
    assistive_posture: "focused_work",
    situation: {
      summary:
        "User appears active working in jarvis, with 728 changed items, plugged in, " +
        "schedule pressure high with the next event in 15 minutes.",
      confidence: "medium",
      evidence: [
        "workspace jarvis",
        "branch private-main",
        "728 changed items",
        "presence active",
        "power ac_power",
        "battery 100%",
        "2 external displays",
        "noise quiet",
        "media paused",
        "schedule pressure high",
      ],
      unknowns: ["location_class: disabled_by_policy", "ambient_light: ambient_light_not_exposed"],
      risks: ["workspace has a large amount of uncommitted local state", "schedule pressure is high"],
      recommendations: [
        "Use a direct calendar connector for account schedule timing when needed.",
        "Treat ambient light as unknown on this display setup.",
      ],
      recent_changes: [
        "Noise quiet",
        "2 external displays",
        "Media paused",
        "Workspace jarvis active",
        "Power ac_power",
      ],
    },
    quality: {
      overall_freshness: "fresh",
      domains: {
        screen: {
          source_sensors: ["workspace", "active-window"],
          observation_count: 2,
          staleness_ms: 2_497,
          freshness: "fresh",
        },
        user: {
          source_sensors: ["idle", "focus-mode"],
          observation_count: 2,
          staleness_ms: 2_400,
          freshness: "fresh",
        },
        environment: {
          source_sensors: ["time-context", "camera", "battery", "media", "devices", "audio-level"],
          observation_count: 6,
          staleness_ms: 2_582,
          freshness: "fresh",
        },
        schedule: {
          source_sensors: ["calendar"],
          observation_count: 1,
          staleness_ms: 2_500,
          freshness: "fresh",
        },
      },
      fields: {
        screen: fieldQuality("workspace", screen),
        user: fieldQuality("idle", user),
        environment: fieldQuality("time-context", environment),
        schedule: fieldQuality("calendar", schedule),
      },
      stability: { screen_activity: "stable" },
    },
    screen,
    user,
    environment,
    schedule,
  };
}

/** The diagnostics list a real degraded local install attaches to every response. */
function smokeHealth(): ContextProviderHealth {
  return {
    status: "degraded",
    source: "broker",
    checked_at: SMOKE_AT,
    diagnostics: [
      {
        component: "calendar",
        status: "unavailable",
        message: "Calendar timing is disabled in the Sense policy.",
        latency_ms: 51,
      },
      {
        component: "location",
        status: "unavailable",
        message: "Wi-Fi location classification is disabled in the Sense policy.",
        latency_ms: 51,
      },
      {
        component: "ambient-light",
        status: "degraded",
        message: "macOS did not expose an AppleLMUController ambient light value.",
        last_success_at: "2026-09-18T19:51:47.276Z",
        latency_ms: 77,
      },
      {
        component: "focus-mode",
        status: "unavailable",
        message: "unavailable; samples=0; availability_checks=3306",
        latency_ms: 50,
      },
      {
        component: "health-bridge",
        status: "unavailable",
        message: "unavailable; samples=0; availability_checks=1655",
        latency_ms: 50,
      },
      {
        component: "weather-bridge",
        status: "unavailable",
        message: "unavailable; samples=0; availability_checks=1653",
        latency_ms: 50,
      },
      {
        component: "iphone-context-bridge",
        status: "unavailable",
        message: "unavailable; samples=0; availability_checks=1659",
        latency_ms: 50,
      },
      {
        component: "mock",
        status: "unavailable",
        message: "unavailable; samples=0; availability_checks=19810",
        latency_ms: 50,
      },
    ],
  };
}

function smokeResult(): ContextResult {
  return { frame: smokeFrame(), health: smokeHealth(), refreshed_domains: ["screen"] };
}

async function connect(provider: ContextProvider, dependencies: ServerDependencies = {}) {
  const server = createServer(provider, {
    writeAccess: async () => undefined,
    ...dependencies,
  });
  const client = new Client({ name: "sense-protocol-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  connected.push({ client, server });
  return { client, server };
}

function expectWithinOutputBudget(structured: Record<string, unknown>, truncated = false): void {
  const budget = structured.output_budget as {
    max_bytes: number;
    serialized_bytes: number;
    truncated: boolean;
  };
  const actualBytes = Buffer.byteLength(JSON.stringify(structured), "utf8");
  expect(actualBytes).toBeLessThanOrEqual(budget.max_bytes);
  expect(budget.serialized_bytes).toBe(actualBytes);
  expect(budget.truncated).toBe(truncated);
}

afterEach(async () => {
  await Promise.all(connected.splice(0).map(({ client, server }) => Promise.all([client.close(), server.close()])));
});

describe("Sense MCP protocol surface", () => {
  test("SDK discovery exposes titled, schema-first, annotated tools and resources", async () => {
    const provider: ContextProvider = { getContext: vi.fn(async () => contextResult()) };
    const { client } = await connect(provider);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      [
        "get_context_frame",
        "get_domains",
        "get_environment_context",
        "get_relevant_context",
        "get_schedule_context",
        "get_screen_context",
        "get_user_state",
        "take_camera_snapshot",
        "take_full_screen_snapshot",
        "take_screen_snapshot",
        "take_window_snapshot",
      ].sort(),
    );
    for (const tool of listed.tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.annotations).toMatchObject({
        destructiveHint: false,
        openWorldHint: false,
      });
    }
    expect(listed.tools.find((tool) => tool.name === "get_context_frame")?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(listed.tools.find((tool) => tool.name === "take_window_snapshot")?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
    });
    expect(
      listed.tools.find((tool) => tool.name === "take_window_snapshot")?.inputSchema.required ?? [],
    ).not.toContain("window_id");
    expect(
      listed.tools.find((tool) => tool.name === "take_full_screen_snapshot")?.inputSchema.required,
    ).toContain("confirm_full_screen");

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri).sort()).toEqual(
      ["sense://context/current", "sense://health", "sense://privacy"].sort(),
    );
  });

  test("every tool advertises the JSON Schema dialect modern clients validate", async () => {
    const { client } = await connect({ getContext: async () => contextResult() });

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(11);
    for (const tool of listed.tools) {
      expect(tool.inputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(tool.outputSchema?.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    }
  });

  test("the router is the first tool a client sees and the routing rules ship with it", async () => {
    const { client } = await connect({ getContext: async () => contextResult() });

    const listed = await client.listTools();
    expect(listed.tools[0]?.name).toBe("get_relevant_context");
    expect(client.getInstructions()).toBe(SENSE_SERVER_INSTRUCTIONS);
  });

  test("the prompting guide quotes the wire instructions verbatim", () => {
    const guide = readFileSync(new URL("../docs/PROMPTING.md", import.meta.url), "utf8");
    expect(guide).toContain(SENSE_SERVER_INSTRUCTIONS);
  });

  test("a context body emptied by the budget comes back partial, not as an error", async () => {
    const { client } = await connect({
      getContext: async () => {
        const result = contextResult();
        // The health bridge emits readiness_class, which compact and brief
        // withhold by design, so a budget that forces the compact shape drops
        // this domain while its sibling survives. The caller asked for focused,
        // where the field is returned, so the loss is the budget's.
        result.frame.user = { readiness_class: "ready" };
        return result;
      },
    });

    const response = await client.callTool({
      name: "get_domains",
      arguments: {
        domains: ["screen", "user"],
        projection: "focused",
        max_tokens: MIN_CONTEXT_MAX_TOKENS,
      },
    });

    // This used to be a hard tool error. A context-enrichment tool that errors
    // is worse than one that answers partially: the caller loses the context it
    // could have had, and the four single-domain tools cannot "request fewer
    // domains" at all. The shortfall is reported in the response instead.
    expect(response.isError).not.toBe(true);
    const structured = response.structuredContent as {
      ok: boolean;
      context_satisfied: boolean;
      context: Record<string, unknown>;
      context_omitted: { domains: string[]; reason: string; suggested_max_tokens?: number };
    };
    expect(structured.ok).toBe(true);
    expect(structured.context_satisfied).toBe(false);
    expect(structured.context_omitted.domains).toContain("user");
    expect(structured.context_omitted.reason).toContain("max_tokens");
    expect(structured.context_omitted.suggested_max_tokens).toBeGreaterThan(
      MIN_CONTEXT_MAX_TOKENS,
    );
    // And the text a client reads instead of the structured content says so too.
    expect((response.content[0] as { text: string }).text).toContain("partial");
  });

  test("the max_tokens the omission suggests actually returns every requested domain", async () => {
    const { client } = await connect({
      getContext: async () => {
        const result = contextResult();
        result.frame.user = { readiness_class: "ready" };
        return result;
      },
    });

    const partial = await client.callTool({
      name: "get_domains",
      arguments: {
        domains: ["screen", "user"],
        projection: "focused",
        max_tokens: MIN_CONTEXT_MAX_TOKENS,
      },
    });
    const suggested = (
      partial.structuredContent as { context_omitted: { suggested_max_tokens?: number } }
    ).context_omitted.suggested_max_tokens;

    const retried = await client.callTool({
      name: "get_domains",
      arguments: { domains: ["screen", "user"], projection: "focused", max_tokens: suggested },
    });
    const structured = retried.structuredContent as {
      context_satisfied: boolean;
      context: Record<string, unknown>;
      context_omitted?: unknown;
    };

    // This used to assert the constant DEFAULT_CONTEXT_BUDGETS.focused. The
    // suggestion is now measured by building the response at candidate budgets
    // and checking coverage, so the only things worth pinning are the two
    // properties a caller can act on: it is larger than what they sent, and it
    // works.
    expect(suggested).toBeGreaterThan(MIN_CONTEXT_MAX_TOKENS);
    expect(retried.isError).not.toBe(true);
    expect(structured.context_satisfied).toBe(true);
    expect(structured.context_omitted).toBeUndefined();
    expect(structured.context.screen).toBeDefined();
    expect(structured.context.user).toBeDefined();
  });

  test("deprecated screen alias can only use safe window-scoped capture", async () => {
    const captureWindow = vi.fn(async (windowId?: number) => ({
      ok: true as const,
      generated_at: "2026-07-11T12:00:00.000Z",
      mode: "screen_debug" as const,
      window_id: windowId ?? 42,
      mimeType: "image/png" as const,
      data: "cG5n",
      path: "/tmp/window.png",
      markdown_image: "![window](/tmp/window.png)",
      size_bytes: 3,
    }));
    const captureFullScreen = vi.fn();
    const { client } = await connect(
      { getContext: async () => contextResult() },
      { captureWindow, captureFullScreen },
    );

    const response = await client.callTool({
      name: "take_screen_snapshot",
      arguments: { reason: "Review the current app window" },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ ok: true, context_satisfied: true });
    expect(captureWindow).toHaveBeenCalledWith(
      undefined,
      undefined,
      "Review the current app window",
    );
    expect(captureFullScreen).not.toHaveBeenCalled();
  });

  test("context calls return structured content and concise text through the SDK", async () => {
    const getContext = vi.fn(async () => contextResult());
    const { client } = await connect({ getContext });

    const response = await client.callTool({
      name: "get_screen_context",
      arguments: { projection: "compact", refresh: "cached" },
    });
    const structured = response.structuredContent as Record<string, unknown>;

    expect(response.isError).not.toBe(true);
    expect(structured.ok).toBe(true);
    expect(structured.context_satisfied).toBe(true);
    expect(structured.projection).toBe("compact");
    expect((structured.context as Record<string, unknown>).screen).toMatchObject({
      active_app: "Code",
      activity_class: "coding",
    });
    expect(response.content[0]).toMatchObject({ type: "text" });
    expect((response.content[0] as { text: string }).text.startsWith("{")).toBe(false);
    expect(getContext).toHaveBeenCalledWith({
      domains: ["screen"],
      refresh: "cached",
      max_staleness_ms: undefined,
    });
  });

  test("router embeds useful context once and marks the request satisfied", async () => {
    const getContext = vi.fn(async () => contextResult());
    const { client } = await connect({ getContext });

    const response = await client.callTool({
      name: "get_relevant_context",
      arguments: { user_request: "what am I working on right now?" },
    });
    const structured = response.structuredContent as Record<string, unknown> & {
      context_satisfied: boolean;
      follow_up_tools: string[];
      context?: Record<string, unknown>;
    };

    expect(response.isError).not.toBe(true);
    expect(structured.context_satisfied).toBe(true);
    expect(structured.follow_up_tools).toEqual([]);
    expect(structured.context?.screen).toBeDefined();
    // The fields docs/PROMPTING.md tells clients to read must survive the default budget.
    expect(structured.context_plan).toBeDefined();
    expect(structured.guidance).toBeDefined();
    expect(structured.privacy_notes).toBeDefined();
    expectWithinOutputBudget(structured);
    expect(getContext).toHaveBeenCalledTimes(1);

    const planOnly = await client.callTool({
      name: "get_relevant_context",
      arguments: {
        user_request: "write a friendly launch email",
        max_tokens: MIN_CONTEXT_MAX_TOKENS,
      },
    });
    expect(planOnly.structuredContent).toMatchObject({
      context_satisfied: true,
      follow_up_tools: [],
    });
    expectWithinOutputBudget(planOnly.structuredContent as Record<string, unknown>, true);
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  test("the stock router call returns the plan, the guidance and the planned domains", async () => {
    // get_relevant_context with no max_tokens, over the frame a real install
    // produces. Against the shipped 1000-token default this returned
    // {generated_at, assistive_posture} at 123 estimated tokens with
    // context_satisfied true -- and src/instructions.ts tells every client that
    // context_satisfied true means stop calling Sense for this request, so the
    // model concluded there was no context.
    const { client } = await connect({ getContext: async () => smokeResult() });

    const response = await client.callTool({
      name: "get_relevant_context",
      arguments: { user_request: "what am I working on right now?" },
    });
    const structured = response.structuredContent as Record<string, unknown> & {
      context_satisfied: boolean;
      context?: Record<string, unknown>;
      guidance?: string[];
      context_plan?: Record<string, unknown>;
      relevant_domains?: string[];
    };

    expect(response.isError).not.toBe(true);
    expect(structured.context_satisfied).toBe(true);
    expect(structured.context_plan).toBeDefined();
    expect(structured.guidance?.length).toBeGreaterThan(0);
    expect(structured.relevant_domains).toContain("screen");
    // Every domain the plan asked for is in the payload the client receives,
    // not merely in the intermediate the server checked.
    for (const domain of structured.relevant_domains ?? []) {
      expect(structured.context?.[domain]).toBeDefined();
    }
    expect(structured.context?.screen).toMatchObject({ workspace_name: "jarvis" });
    expectWithinOutputBudget(structured);
  });

  test("the router reports a collapse instead of an empty satisfied answer", async () => {
    // A budget too small for the whole payload must never come back as a
    // success with the plan or the domains missing, whatever the ladder picked.
    // It must not come back as a hard error either: the caller keeps whatever
    // fitted, plus the budget that returns the rest.
    const { client } = await connect({ getContext: async () => smokeResult() });

    const response = await client.callTool({
      name: "get_relevant_context",
      arguments: { user_request: "what am I working on right now?", max_tokens: 1_000 },
    });
    const structured = response.structuredContent as {
      ok: boolean;
      context_satisfied: boolean;
      context_omitted: { domains: string[]; reason: string; suggested_max_tokens?: number };
      context?: Record<string, unknown>;
    };

    expect(response.isError).not.toBe(true);
    expect(structured.ok).toBe(true);
    expect(structured.context_satisfied).toBe(false);
    expect(structured.context_omitted.reason).toMatch(/max_tokens/);

    const suggested = structured.context_omitted.suggested_max_tokens;
    expect(suggested).toBeGreaterThan(1_000);

    const retried = await client.callTool({
      name: "get_relevant_context",
      arguments: { user_request: "what am I working on right now?", max_tokens: suggested },
    });
    const ok = retried.structuredContent as Record<string, unknown> & {
      context?: Record<string, unknown>;
      guidance?: string[];
      relevant_domains?: string[];
    };

    expect(retried.isError).not.toBe(true);
    expect(ok.context_satisfied).toBe(true);
    expect(ok.context_omitted).toBeUndefined();
    expect(ok.context_plan).toBeDefined();
    expect(ok.guidance?.length).toBeGreaterThan(0);
    for (const domain of ok.relevant_domains ?? []) {
      expect(ok.context?.[domain]).toBeDefined();
    }
  });

  test("the router sheds diagnostics before it sheds the answer", async () => {
    // Gradual degradation: a budget under the full payload costs the caller the
    // cheapest item, not the plan and the domains at once.
    const { client } = await connect({ getContext: async () => smokeResult() });

    const full = await client.callTool({
      name: "get_relevant_context",
      arguments: { user_request: "what am I working on right now?", max_tokens: 2_800 },
    });
    const tight = await client.callTool({
      name: "get_relevant_context",
      arguments: { user_request: "what am I working on right now?", max_tokens: 2_200 },
    });
    const wide = full.structuredContent as Record<string, unknown> & {
      health?: { diagnostics: unknown[] };
      output_budget: { estimated_tokens: number };
      relevant_domains?: string[];
    };
    const lean = tight.structuredContent as typeof wide & { context?: Record<string, unknown> };

    expect(wide.health?.diagnostics.length).toBeGreaterThan(0);
    expect(tight.isError).not.toBe(true);
    expect(lean.health?.diagnostics).toEqual([]);
    expect(lean.output_budget.estimated_tokens).toBeLessThan(wide.output_budget.estimated_tokens);
    // The parts that answer the question survived the rung the budget forced.
    expect(lean.context_plan).toBeDefined();
    expect((lean.guidance as string[]).length).toBeGreaterThan(0);
    for (const domain of lean.relevant_domains ?? []) {
      expect(lean.context?.[domain]).toBeDefined();
    }
  });

  test("the suggested max_tokens exceeds a request that was already above the default", async () => {
    // The hint used to be the constant DEFAULT_CONTEXT_BUDGETS[projection]. A
    // caller who sent more than that constant was told to retry with less,
    // which cannot succeed. A frame whose situation block has grown past what
    // the shipped default anticipates is exactly that case: focused costs 3661
    // tokens here, and the request below is already above the 2800 default.
    // situation.evidence grows with session length rather than sensor count, so
    // this is what an ordinary long session looks like.
    const { client } = await connect({
      getContext: async () => {
        const result = smokeResult();
        result.frame.situation?.evidence.push(
          ...Array.from(
            { length: 80 },
            (_, index) => `additional local evidence line number ${index} from a long session`,
          ),
        );
        return result;
      },
    });

    const requested = 2_900;
    const partial = await client.callTool({
      name: "get_context_frame",
      arguments: { projection: "focused", max_tokens: requested },
    });
    const omitted = (
      partial.structuredContent as {
        context_satisfied: boolean;
        context_omitted: { suggested_max_tokens?: number };
      }
    ).context_omitted;
    const suggested = omitted.suggested_max_tokens;

    expect(partial.isError).not.toBe(true);
    expect((partial.structuredContent as { context_satisfied: boolean }).context_satisfied).toBe(
      false,
    );
    expect(suggested).toBeGreaterThan(requested);

    const retried = await client.callTool({
      name: "get_context_frame",
      arguments: { projection: "focused", max_tokens: suggested },
    });
    const structured = retried.structuredContent as {
      context_satisfied: boolean;
      context: Record<string, unknown>;
    };

    // This used to assert budget.truncated === false as well. What the
    // suggestion promises is the requested DOMAIN DATA, and the smallest budget
    // that delivers it may still drop health diagnostics, which are not context.
    // Asserting the domains is asserting the contract.
    expect(retried.isError).not.toBe(true);
    expect(structured.context_satisfied).toBe(true);
    for (const domain of ["screen", "user", "environment", "schedule"]) {
      expect(structured.context[domain]).toBeDefined();
    }
  });

  test("no number is asserted when no accepted max_tokens could work", async () => {
    // The health bridge's opt-in telemetry is the whole user domain here, and
    // compact withholds every field of it, so no budget returns it. The response
    // must not name one -- a suggestion that cannot work is worse than none --
    // and must point at the projection that does carry it.
    const { client } = await connect({
      getContext: async () => {
        const result = smokeResult();
        result.frame.user = { readiness_class: "ready" };
        return result;
      },
    });

    const response = await client.callTool({
      name: "get_user_state",
      arguments: { projection: "compact", max_tokens: MAX_CONTEXT_MAX_TOKENS },
    });
    const structured = response.structuredContent as {
      ok: boolean;
      context_satisfied: boolean;
      context_omitted: { domains: string[]; reason: string; suggested_max_tokens?: number };
    };

    expect(response.isError).not.toBe(true);
    expect(structured.ok).toBe(true);
    expect(structured.context_satisfied).toBe(false);
    expect(structured.context_omitted.domains).toEqual(["user"]);
    expect(structured.context_omitted.suggested_max_tokens).toBeUndefined();
    expect(structured.context_omitted.reason).toContain("focused");

    // And the projection it names really does return the data.
    const richer = await client.callTool({
      name: "get_user_state",
      arguments: { projection: "focused", max_tokens: MAX_CONTEXT_MAX_TOKENS },
    });
    const rich = richer.structuredContent as {
      context_satisfied: boolean;
      context: Record<string, unknown>;
    };
    expect(rich.context_satisfied).toBe(true);
    expect(rich.context.user).toEqual({ readiness_class: "ready" });
  });

  test("provider failures return stable machine-readable tool errors", async () => {
    const { client } = await connect({
      getContext: async () => {
        throw new Error("socket disappeared with secret details");
      },
    });

    const response = await client.callTool({ name: "get_context_frame", arguments: {} });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      ok: false,
      context_satisfied: false,
      error: {
        code: "context_provider_failed",
        retryable: true,
      },
    });
    expect(JSON.stringify(response.structuredContent)).not.toContain("secret details");
  });

  test("privacy, health, and current-context resources are readable without refresh", async () => {
    const getContext = vi.fn(async () => contextResult());
    const { client } = await connect({ getContext });

    const privacy = await client.readResource({ uri: "sense://privacy" });
    const health = await client.readResource({ uri: "sense://health" });
    const current = await client.readResource({ uri: "sense://context/current" });

    expect(JSON.parse(privacy.contents[0].text ?? "{}").privacy.tier).toBe(1);
    expect(JSON.parse(health.contents[0].text ?? "{}").health.status).toBe("healthy");
    expect(JSON.parse(current.contents[0].text ?? "{}").context_satisfied).toBe(true);
    expect(getContext).toHaveBeenCalledTimes(3);
    expect(getContext).toHaveBeenCalledWith({ refresh: "cached" });
  });
});

/**
 * The frame in docs/evals/real-frame-fixture.json, captured from a live
 * get_context_frame on macOS and sanitized. It is 10-20x larger than a
 * hand-written frame, and every defect this block pins is invisible against a
 * small one: a minimal frame fits any budget, so nothing ever has to be left
 * out and no report of a shortfall is ever produced.
 *
 * The variants matter as much as the fixture. `situation.evidence` grows with
 * session length rather than with sensor count, so a frame that fitted this
 * morning does not fit this evening; and a broker one sensor ahead of this
 * server -- the user's brokers run from a different checkout, and the version
 * probe compares protocol versions, never field names -- sends a field this
 * build has never classified.
 */
const REAL_FIXTURE = JSON.parse(
  readFileSync(new URL("../docs/evals/real-frame-fixture.json", import.meta.url), "utf8"),
) as { frame: ContextFrame; health: ContextProviderHealth };

interface RealFrameOptions {
  /** Extra situation.evidence lines, as a long session accumulates. */
  evidence?: number;
  /** A field from a newer broker that neither field list decided on. */
  unclassifiedField?: boolean;
}

function realResult(options: RealFrameOptions = {}): ContextResult {
  const frame = structuredClone(REAL_FIXTURE.frame);
  if (options.evidence) {
    frame.situation?.evidence.push(
      ...Array.from(
        { length: options.evidence },
        (_, index) => `additional local evidence line number ${index} from a long session`,
      ),
    );
  }
  if (options.unclassifiedField && frame.screen) {
    frame.screen.editor_language = "typescript";
  }
  return {
    frame,
    health: structuredClone(REAL_FIXTURE.health),
    refreshed_domains: ["screen"],
  };
}

const REAL_VARIANTS: [string, RealFrameOptions][] = [
  ["as captured", {}],
  ["evidence +20", { evidence: 20 }],
  ["evidence +80", { evidence: 80 }],
  ["one unclassified sensor field", { unclassifiedField: true }],
];

const CONTEXT_TOOLS = [
  "get_context_frame",
  "get_screen_context",
  "get_user_state",
  "get_environment_context",
  "get_schedule_context",
] as const;

const DOMAINS: Domain[] = ["screen", "user", "environment", "schedule"];

/** The domains a response owes, from the frame rather than from the response. */
function populatedDomains(frame: ContextFrame, requested: Domain[]): Domain[] {
  return requested.filter((domain) =>
    Object.values(frame[domain] ?? {}).some((value) => value !== undefined),
  );
}

describe("Sense over a real captured frame", () => {
  test.each(REAL_VARIANTS)(
    "no stock call is a hard error with the frame %s",
    async (_label, options) => {
      const { client } = await connect({ getContext: async () => realResult(options) });

      for (const name of CONTEXT_TOOLS) {
        // Both the stock call and the one at the published ceiling: the defect
        // this replaces failed at every budget, not only at small ones.
        for (const args of [{}, { max_tokens: MAX_CONTEXT_MAX_TOKENS }]) {
          const response = await client.callTool({ name, arguments: args });
          expect(`${name}:${JSON.stringify(args)}:${response.isError === true}`).toBe(
            `${name}:${JSON.stringify(args)}:false`,
          );
          expect((response.structuredContent as { ok: boolean }).ok).toBe(true);
        }
      }
      const routed = await client.callTool({
        name: "get_relevant_context",
        arguments: { user_request: "what am I working on right now?" },
      });
      expect(routed.isError).not.toBe(true);
      expect((routed.structuredContent as { ok: boolean }).ok).toBe(true);
    },
  );

  test("an unclassified field from a newer broker cannot take a tool out", async () => {
    // Adding one plausible field to the screen domain used to return
    // context_budget_too_small from get_screen_context at every budget up to the
    // published ceiling, with a fix_hint telling a single-domain tool to request
    // fewer domains. The field is simply not carried by the leaner projections;
    // everything the projection does carry still comes back.
    const { client } = await connect({
      getContext: async () => realResult({ unclassifiedField: true }),
    });

    const response = await client.callTool({ name: "get_screen_context", arguments: {} });
    const structured = response.structuredContent as {
      ok: boolean;
      context_satisfied: boolean;
      context: { screen?: Record<string, unknown> };
      context_omitted?: unknown;
    };

    expect(response.isError).not.toBe(true);
    expect(structured.ok).toBe(true);
    expect(structured.context_satisfied).toBe(true);
    expect(structured.context_omitted).toBeUndefined();
    expect(structured.context.screen).toMatchObject({
      active_app: REAL_FIXTURE.frame.screen?.active_app,
    });

    // And a projection that carries the domain verbatim passes it through.
    const verbatim = await client.callTool({
      name: "get_screen_context",
      arguments: { projection: "focused" },
    });
    expect(
      (verbatim.structuredContent as { context: { screen: Record<string, unknown> } }).context
        .screen.editor_language,
    ).toBe("typescript");
  });

  test("context_satisfied is accurate and every suggested max_tokens works", async () => {
    // The fuzz this block exists for. Two failures are counted explicitly
    // because they are the two ways this surface has actually broken: a response
    // that claims satisfaction while carrying nothing, and a hard error thrown
    // where a partial answer was available. Both must be zero.
    let silentlyEmptyButSatisfied = 0;
    let erroredWherePartialWasPossible = 0;
    let inaccurateSatisfaction = 0;
    let suggestionsChecked = 0;
    let badSuggestions = 0;

    for (const [, options] of REAL_VARIANTS) {
      const frame = realResult(options).frame;
      const { client } = await connect({ getContext: async () => realResult(options) });

      for (const name of CONTEXT_TOOLS) {
        const requested: Domain[] =
          name === "get_context_frame"
            ? DOMAINS
            : [name.replace("get_", "").replace("_context", "").replace("_state", "") as Domain];
        const owed = populatedDomains(frame, requested);

        for (const projection of [undefined, "compact", "brief", "focused", "debug"] as const) {
        for (let maxTokens = MIN_CONTEXT_MAX_TOKENS; maxTokens <= 4_000; maxTokens += 53) {
          const response = await client.callTool({
            name,
            arguments: { max_tokens: maxTokens, ...(projection ? { projection } : {}) },
          });
          if (response.isError) {
            erroredWherePartialWasPossible += 1;
            continue;
          }
          const structured = response.structuredContent as {
            context_satisfied: boolean;
            context: Record<string, unknown>;
            context_omitted?: { domains: string[]; suggested_max_tokens?: number };
          };
          const carried = owed.filter((domain) => structured.context[domain] !== undefined);

          if (structured.context_satisfied) {
            if (owed.length > 0 && carried.length === 0) silentlyEmptyButSatisfied += 1;
            if (carried.length !== owed.length) inaccurateSatisfaction += 1;
            if (structured.context_omitted !== undefined) inaccurateSatisfaction += 1;
            continue;
          }

          // Unsatisfied must always say what is missing.
          if (structured.context_omitted === undefined) inaccurateSatisfaction += 1;
          const suggested = structured.context_omitted?.suggested_max_tokens;
          if (suggested === undefined) continue;
          if (suggested <= maxTokens) badSuggestions += 1;
          suggestionsChecked += 1;
          const retried = await client.callTool({
            name,
            arguments: { max_tokens: suggested, ...(projection ? { projection } : {}) },
          });
          const retriedStructured = retried.structuredContent as { context_satisfied: boolean };
          if (retried.isError || !retriedStructured.context_satisfied) badSuggestions += 1;
        }
        }
      }
    }

    // The router runs the same gauntlet: it is the tool the instructions tell
    // every client to call first, and the one whose stock call started
    // hard-erroring once situation.evidence grew.
    for (const [, options] of REAL_VARIANTS) {
      const { client } = await connect({ getContext: async () => realResult(options) });
      for (const userRequest of ["what am I working on right now?", "where did I leave off"]) {
        for (let maxTokens = MIN_CONTEXT_MAX_TOKENS; maxTokens <= 3_000; maxTokens += 53) {
          const response = await client.callTool({
            name: "get_relevant_context",
            arguments: { user_request: userRequest, max_tokens: maxTokens },
          });
          if (response.isError) {
            erroredWherePartialWasPossible += 1;
            continue;
          }
          const structured = response.structuredContent as {
            context_satisfied: boolean;
            context?: Record<string, unknown>;
            relevant_domains?: string[];
            context_omitted?: { suggested_max_tokens?: number };
          };
          if (structured.context_satisfied) {
            const planned = structured.relevant_domains ?? [];
            const carried = planned.filter((d) => structured.context?.[d] !== undefined);
            if (planned.length > 0 && carried.length === 0) silentlyEmptyButSatisfied += 1;
            continue;
          }
          if (structured.context_omitted === undefined) inaccurateSatisfaction += 1;
          const suggested = structured.context_omitted?.suggested_max_tokens;
          if (suggested === undefined) continue;
          if (suggested <= maxTokens) badSuggestions += 1;
          suggestionsChecked += 1;
          const retried = await client.callTool({
            name: "get_relevant_context",
            arguments: { user_request: userRequest, max_tokens: suggested },
          });
          if (
            retried.isError ||
            !(retried.structuredContent as { context_satisfied: boolean }).context_satisfied
          ) {
            badSuggestions += 1;
          }
        }
      }
    }

    expect(silentlyEmptyButSatisfied).toBe(0);
    expect(erroredWherePartialWasPossible).toBe(0);
    expect(inaccurateSatisfaction).toBe(0);
    expect(badSuggestions).toBe(0);
    // The two counts the redesign is judged on, named so a failure prints them:
    // responses that claimed satisfaction while carrying nothing, and hard
    // errors raised where a partial answer was available.
    expect(
      `silently-empty-but-satisfied=${silentlyEmptyButSatisfied} ` +
        `hard-errored-when-partial-was-possible=${erroredWherePartialWasPossible}`,
    ).toBe("silently-empty-but-satisfied=0 hard-errored-when-partial-was-possible=0");
    // The fuzz has to have actually exercised the partial path, or it proves
    // nothing: a sweep that never left the satisfied case would report zero too.
    expect(suggestionsChecked).toBeGreaterThan(0);
  });

  test("the router degrades one rung at a time instead of collapsing", async () => {
    // Each rung of routerCandidates, pinned by searching the accepted budget
    // range for a budget that selects it. Deleting a rung removes its band
    // entirely, so this fails rather than quietly covering unreachable code.
    const header = new Set(["generated_at", "assistive_posture", "summary", "freshness"]);
    const seen = { full: 0, lean: 0, planned: 0, core: 0 };
    const { client } = await connect({ getContext: async () => realResult() });

    for (const userRequest of ["where did I leave off", "why is this button greyed out?"]) {
      for (let maxTokens = MIN_CONTEXT_MAX_TOKENS; maxTokens <= 1_200; maxTokens += 1) {
        const response = await client.callTool({
          name: "get_relevant_context",
          arguments: { user_request: userRequest, max_tokens: maxTokens },
        });
        if (response.isError) continue;
        const structured = response.structuredContent as {
          context_plan?: unknown;
          guidance?: string[];
          fallbacks?: string[];
          privacy_notes?: string[];
          relevant_domains?: string[];
          context?: Record<string, unknown>;
        };
        const context = structured.context ?? {};
        const planned = structured.relevant_domains ?? [];
        const beyondPlan = Object.keys(context).filter(
          (key) => !header.has(key) && !planned.includes(key),
        );

        if (structured.context_plan === undefined || (structured.guidance?.length ?? 0) === 0) {
          seen.core += 1;
        } else if (beyondPlan.length === 0 && planned.some((d) => context[d] !== undefined)) {
          seen.planned += 1;
        } else if (
          (structured.fallbacks?.length ?? 0) === 0 &&
          (structured.privacy_notes?.length ?? 0) === 0
        ) {
          seen.lean += 1;
        } else {
          seen.full += 1;
        }
      }
    }

    // Every rung is reachable at some accepted budget.
    expect(seen.full).toBeGreaterThan(0);
    expect(seen.lean).toBeGreaterThan(0);
    expect(seen.planned).toBeGreaterThan(0);
    expect(seen.core).toBeGreaterThan(0);
  });

  test("the one remaining hard error is the unusable case, and it is honest about it", async () => {
    // The only shortfall that is still an error: not even the empty envelope
    // fits, so there is no response to return at all. A frame carrying an absurd
    // generated_at is the cheapest way to reach it. Two cases, because the
    // retryable flag has to track the hint rather than being hard-coded true --
    // an error that says "retry" beside a hint saying no retry can work is the
    // defect this replaces.
    const withGeneratedAt = (length: number) => async () => {
      const result = realResult();
      result.frame.generated_at = "x".repeat(length);
      return result;
    };

    const { client } = await connect({ getContext: withGeneratedAt(1_200) });
    const retryable = await client.callTool({
      name: "get_context_frame",
      arguments: { projection: "compact", max_tokens: MIN_CONTEXT_MAX_TOKENS },
    });
    const retryableError = (retryable.structuredContent as {
      error: { code: string; message: string; retryable: boolean; fix_hint: string };
    }).error;

    expect(retryable.isError).toBe(true);
    expect(retryableError.code).toBe("context_budget_too_small");
    expect(retryableError.message).toContain(String(MIN_CONTEXT_MAX_TOKENS));
    expect(retryableError.retryable).toBe(true);
    const suggested = Number(retryableError.fix_hint.match(/(\d+) fits/)?.[1]);
    expect(suggested).toBeGreaterThan(MIN_CONTEXT_MAX_TOKENS);

    const retried = await client.callTool({
      name: "get_context_frame",
      arguments: { projection: "compact", max_tokens: suggested },
    });
    expect(retried.isError).not.toBe(true);

    const { client: hopeless } = await connect({ getContext: withGeneratedAt(30_000) });
    const unusable = await hopeless.callTool({
      name: "get_context_frame",
      arguments: { projection: "compact", max_tokens: MAX_CONTEXT_MAX_TOKENS },
    });
    const unusableError = (unusable.structuredContent as {
      error: { retryable: boolean; fix_hint: string };
    }).error;

    expect(unusable.isError).toBe(true);
    // No budget works here, so the response does not claim one does.
    expect(unusableError.retryable).toBe(false);
    expect(unusableError.fix_hint).not.toMatch(/\d+ fits/);
    expect(unusableError.fix_hint).toContain(String(MAX_CONTEXT_MAX_TOKENS));
  });

  test("the accepted max_tokens range is what both context and router tools publish", async () => {
    // A deliberate public shape: every Sense tool that takes max_tokens accepts
    // the same closed range, and the numbers a fix_hint or a suggested
    // max_tokens names are inside it by construction.
    const { client } = await connect({ getContext: async () => realResult() });
    const listed = await client.listTools();

    for (const tool of listed.tools) {
      const property = (
        tool.inputSchema.properties as Record<string, { minimum?: number; maximum?: number }>
      )?.max_tokens;
      if (!property) continue;
      expect(`${tool.name}:${property.minimum}-${property.maximum}`).toBe(
        `${tool.name}:${MIN_CONTEXT_MAX_TOKENS}-${MAX_CONTEXT_MAX_TOKENS}`,
      );
    }
    // And it is not a range nobody publishes: the tools that take it are the
    // context getters, get_domains and the router.
    expect(
      listed.tools.filter((tool) => (tool.inputSchema.properties as Record<string, unknown>)?.max_tokens)
        .length,
    ).toBe(7);
  });
});
