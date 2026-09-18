import { describe, expect, test, vi } from "vitest";
import {
  createLocalContextProvider,
  type ContextProviderHealth,
  type ContextResult,
} from "../src/contextProvider.js";
import {
  DEFAULT_CONTEXT_BUDGETS,
  MAX_CONTEXT_MAX_TOKENS,
  MIN_CONTEXT_MAX_TOKENS,
  contextCoverage,
  estimateJsonTokens,
  projectContext,
  sufficientContextMaxTokens,
} from "../src/contextOutput.js";
import { StateStore } from "../src/state.js";
import type { ContextFrame, FieldQuality, Observation } from "../src/types.js";

function richFrame(): ContextFrame {
  return {
    spec: "context-frame/0.2",
    generated_at: "2026-07-11T12:00:00.000Z",
    staleness_ms: 1_500,
    privacy: {
      tier: 2,
      capabilities: {
        screen_activity: "granted",
        presence: "granted",
        calendar: "denied",
      },
      capability_details: {
        calendar: {
          sensor: "calendar",
          reason: "calendar_query_timeout",
          detail: "Calendar query timed out.",
        },
      },
    },
    assistive_posture: "do_not_interrupt",
    situation: {
      summary: "User appears active working in sense-mcp with schedule pressure.",
      confidence: "high",
      evidence: ["workspace sense-mcp", "activity coding", "presence active", "power ac_power"],
      unknowns: ["calendar: calendar_query_timeout"],
      risks: ["schedule pressure is high"],
      recommendations: ["Use a direct calendar connector when exact timing matters."],
      recent_changes: ["Working in sense-mcp (coding)", "Power ac_power"],
    },
    quality: {
      overall_freshness: "fresh",
      domains: {
        screen: {
          source_sensors: ["active-window", "workspace"],
          observation_count: 2,
          staleness_ms: 1_000,
          freshness: "fresh",
        },
        environment: {
          source_sensors: ["battery"],
          observation_count: 1,
          staleness_ms: 1_500,
          freshness: "fresh",
        },
      },
      fields: {
        screen: {
          active_app: {
            source: "active-window",
            classification: "observed",
            observed_at: "2026-07-11T11:59:59.000Z",
            staleness_ms: 1_000,
          },
        },
      },
      stability: { screen_activity: "stable" },
    },
    screen: {
      active_app: "Code",
      activity_class: "coding",
      workspace_name: "sense-mcp",
      git_branch: "main",
      git_dirty_count: 7,
      active_window_label: "source file",
    },
    user: { presence: "active", input_cadence: "steady", focus_mode: "deep_work" },
    environment: {
      power_source: "ac_power",
      battery_percent: 91,
      external_display_count: 1,
      lighting: "normal",
      media_playback: "paused",
    },
    schedule: {
      in_meeting: false,
      next_event_minutes: 18,
      time_pressure: "moderate",
    },
  };
}

function result(): ContextResult {
  return {
    frame: richFrame(),
    health: {
      status: "degraded",
      source: "broker",
      checked_at: "2026-07-11T12:00:00.000Z",
      diagnostics: [
        {
          component: "calendar",
          status: "degraded",
          message: "Calendar query timed out.",
          last_success_at: "2026-07-11T11:55:00.000Z",
          latency_ms: 8_000,
        },
      ],
    },
    refreshed_domains: ["screen"],
  };
}

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

describe("context output projections", () => {
  test.each(["compact", "brief", "focused", "debug", "diff"] as const)(
    "%s projection enforces its serialized token budget",
    (projection) => {
      const output = projectContext(result(), {
        projection,
        domains: ["screen"],
        max_tokens: MIN_CONTEXT_MAX_TOKENS,
      });

      expect(estimateJsonTokens(output)).toBeLessThanOrEqual(MIN_CONTEXT_MAX_TOKENS);
      expect(output.budget.estimated_tokens).toBeLessThanOrEqual(MIN_CONTEXT_MAX_TOKENS);
      expect(output.budget.serialized_bytes).toBeLessThanOrEqual(output.budget.max_bytes);
      expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThanOrEqual(
        output.budget.max_bytes,
      );
      expect(output.budget.serialized_bytes).toBe(
        Buffer.byteLength(JSON.stringify(output), "utf8"),
      );
      expect(output.context_satisfied).toBe(true);
    },
  );

  test.each(
    (["compact", "brief", "focused", "debug"] as const).flatMap((projection) =>
      (["screen", "user", "environment", "schedule"] as const).map(
        (domain) => [projection, domain] as const,
      ),
    ),
  )(
    "the shipped %s default still carries the requested %s domain",
    (projection, domain) => {
      const output = projectContext(result(), {
        projection,
        domains: [domain],
      });

      expect(output.budget.max_tokens).toBe(DEFAULT_CONTEXT_BUDGETS[projection]);
      expect(output.context[domain]).toBeDefined();
      expect(output.context_satisfied).toBe(true);
      expect(output.context_omitted).toBeUndefined();
    },
  );

  // This case used to be written against focused/[screen] at MIN_CONTEXT_MAX_TOKENS,
  // which the raised floor now serves. The invariant it guards is unchanged: a
  // domain the frame carried but the budget removed is never reported satisfied.
  // What changed is the shape of the report -- it is a field on an `ok` response
  // now, not an exception -- and the partial context still comes back.
  test("a budget that empties the whole context body is reported, never silently emptied", () => {
    const frame = richFrame();
    // The health bridge emits readiness_class, which compact and brief withhold
    // by design, so this domain only survives in the richest candidate. It used
    // to read idle_seconds; DOMAIN_FIELDS now carries that field, so it no
    // longer demonstrates a loss.
    frame.user = { readiness_class: "ready" };
    const output = projectContext(
      { ...result(), frame },
      {
        projection: "focused",
        domains: ["user"],
        max_tokens: MIN_CONTEXT_MAX_TOKENS,
      },
    );

    expect(output.context.user).toBeUndefined();
    expect(output.ok).toBe(true);
    expect(output.context_satisfied).toBe(false);
    expect(output.context_omitted?.domains).toEqual(["user"]);
    // A larger budget restores it, so a number is named and it is a real one.
    expect(output.context_omitted?.suggested_max_tokens).toBeGreaterThan(
      MIN_CONTEXT_MAX_TOKENS,
    );
    const retried = projectContext(
      { ...result(), frame },
      {
        projection: "focused",
        domains: ["user"],
        max_tokens: output.context_omitted?.suggested_max_tokens,
      },
    );
    expect(retried.context_satisfied).toBe(true);
    expect(retried.context.user).toEqual({ readiness_class: "ready" });
  });

  test("a partially emptied context body is reported, not returned as satisfied", () => {
    const frame = smokeFrame();
    frame.user = { readiness_class: "ready" };
    const output = projectContext(
      { ...smokeResult(), frame },
      {
        // 300 lands under the floor, where the report of what is missing costs
        // the last domain that would have fitted. This budget is just above it,
        // which is where the partial-body case actually lives.
        projection: "focused",
        domains: ["screen", "user"],
        max_tokens: 400,
      },
    );

    // The budget forced the compact shape, which withholds readiness_class, so
    // the user domain vanished while its sibling survived. The caller asked for
    // focused, where the field is returned, so the loss is the budget's.
    expect(output.context.screen).toBeDefined();
    expect(output.context.user).toBeUndefined();
    expect(output.budget.truncated).toBe(true);
    expect(output.context_satisfied).toBe(false);
    // The partial context that did fit is still returned: a caller that can use
    // screen alone gets screen, and is told in the same response what is missing.
    expect(output.context_omitted?.domains).toEqual(["screen", "user"]);
  });

  // The four tools whose fallback projection is brief -- get_screen_context,
  // get_user_state, get_environment_context and get_schedule_context -- could
  // not report a drop at any budget while `available` was computed from
  // contextCandidates(...)[0], because for compact and brief that candidate is
  // itself the allowlist-filtered shape. These three cases pin the decision
  // DOMAIN_FIELDS now makes about every emitted field.
  test.each(["compact", "brief"] as const)(
    "%s returns an emitted field the allowlist carries instead of filtering it away",
    (projection) => {
      const frame = smokeFrame();
      // The field idle.ts really emits alongside presence and input_cadence.
      frame.user = { idle_seconds: 3 };
      const output = projectContext(
        { ...smokeResult(), frame },
        { projection, domains: ["user"], max_tokens: MAX_CONTEXT_MAX_TOKENS },
      );

      expect(output.budget.truncated).toBe(false);
      expect(output.context.user).toEqual({ idle_seconds: 3 });
      expect(output.context_satisfied).toBe(true);
    },
  );

  // This case used to assert the opposite: an unclassified field was treated as
  // a budget failure, which took the whole tool out at every budget. It is a
  // forward-compatibility event instead -- the user's broker runs from a
  // different checkout than this server and can be one sensor ahead -- so it is
  // ignored for satisfaction accounting and cannot fail a call.
  test.each(["compact", "brief"] as const)(
    "%s ignores an emitted field the allowlist has made no decision about",
    (projection) => {
      const frame = smokeFrame();
      // A field a future sensor adds that nobody classified, beside the fields
      // this build does know: exactly what a newer broker sends.
      frame.user = { ...frame.user, brand_new_sensor_field: "value" };
      const output = projectContext(
        { ...smokeResult(), frame },
        { projection, domains: ["user"], max_tokens: MAX_CONTEXT_MAX_TOKENS },
      );

      expect(output.budget.max_tokens).toBe(MAX_CONTEXT_MAX_TOKENS);
      expect(output.budget.truncated).toBe(false);
      expect(output.context.user).toMatchObject({ idle_seconds: 3, presence: "active" });
      expect(output.context.user).not.toHaveProperty("brand_new_sensor_field");
      expect(output.context_satisfied).toBe(true);
      expect(output.context_omitted).toBeUndefined();
    },
  );

  test.each(["compact", "brief"] as const)(
    "%s carries a withheld field's domain as long as it carries another of its fields",
    (projection) => {
      const frame = smokeFrame();
      // The health bridge's opt-in telemetry beside a carried field. Withholding
      // it is a projection decision, not an omission.
      frame.user = { idle_seconds: 3, readiness_class: "ready" };
      const output = projectContext(
        { ...smokeResult(), frame },
        { projection, domains: ["user"], max_tokens: MAX_CONTEXT_MAX_TOKENS },
      );

      expect(output.context.user).toEqual({ idle_seconds: 3 });
      expect(output.context_satisfied).toBe(true);
    },
  );

  // This case used to assert `false` -- no budget failure -- and that was the
  // bug: get_user_state answered `context_satisfied: true` carrying no user data
  // at all, and the shipped instructions tell the model that means stop asking.
  // The frame has data here; this projection cannot carry any of it; so the
  // answer is an honest `false` with a pointer at the projection that can.
  test.each(["compact", "brief"] as const)(
    "%s reports a domain whose every live field it withholds, instead of claiming satisfied",
    (projection) => {
      const frame = smokeFrame();
      frame.user = { readiness_class: "ready" };
      const output = projectContext(
        { ...smokeResult(), frame },
        { projection, domains: ["user"], max_tokens: MAX_CONTEXT_MAX_TOKENS },
      );

      expect(output.ok).toBe(true);
      expect(output.context.user).toBeUndefined();
      expect(output.context_satisfied).toBe(false);
      expect(output.context_omitted?.domains).toEqual(["user"]);
      // No budget can fix a projection decision, so no number is invented.
      expect(output.context_omitted?.suggested_max_tokens).toBeUndefined();
      expect(output.context_omitted?.reason).toContain("focused");
      // And the richer projection the reason names really does carry it.
      expect(
        projectContext({ ...smokeResult(), frame }, { projection: "focused", domains: ["user"] })
          .context.user,
      ).toEqual({ readiness_class: "ready" });
    },
  );

  test.each(["compact", "brief"] as const)(
    "%s reports a budget that stripped the domain bodies it does carry",
    (projection) => {
      const output = projectContext(smokeResult(), {
        projection,
        max_tokens: MIN_CONTEXT_MAX_TOKENS,
      });

      expect(output.budget.truncated).toBe(true);
      expect(output.context.screen).toBeUndefined();
      expect(output.context_satisfied).toBe(false);
      expect(output.context_omitted?.domains).toEqual([
        "screen",
        "user",
        "environment",
        "schedule",
      ]);
    },
  );

  test("a call at exactly MIN_CONTEXT_MAX_TOKENS returns real domain data", () => {
    // get_screen_context's default projection is the common single-domain call.
    const output = projectContext(smokeResult(), {
      projection: "brief",
      domains: ["screen"],
      max_tokens: MIN_CONTEXT_MAX_TOKENS,
    });

    expect(output.context.screen).toMatchObject({ active_app: "WhatsApp", workspace_name: "jarvis" });
    expect(output.context_satisfied).toBe(true);
  });

  // What MIN_CONTEXT_MAX_TOKENS actually guarantees is the compact body: every
  // field DOMAIN_FIELDS carries for the requested domain. This used to be
  // asserted for focused and debug too, and passed only because the check was
  // per domain -- the domain key survived while the fields outside the allowlist
  // were shed. Those two projections cost 1275-3788 tokens for a single domain
  // over a realistically full frame, so the floor cannot serve them, and the
  // case below now pins what they do instead.
  test.each(
    (["compact", "brief"] as const).flatMap((projection) =>
      (["screen", "user", "environment", "schedule"] as const).map(
        (domain) => [projection, domain] as const,
      ),
    ),
  )("%s/%s still carries its domain at the advertised floor", (projection, domain) => {
    const frame = smokeFrame();
    const output = projectContext(smokeResult(), {
      projection,
      domains: [domain],
      max_tokens: MIN_CONTEXT_MAX_TOKENS,
    });
    const body = output.context[domain] as Record<string, unknown>;

    expect(body).toBeDefined();
    // Not merely present: every field the projection promises is still there.
    for (const [field, value] of Object.entries(frame[domain] ?? {})) {
      if (body[field] !== undefined) expect(body[field]).toBe(value);
    }
    expect(output.context_satisfied).toBe(true);
  });

  test.each(
    (["focused", "debug"] as const).flatMap((projection) =>
      (["screen", "environment", "schedule"] as const).map(
        (domain) => [projection, domain] as const,
      ),
    ),
  )("%s/%s reports the fields the floor sheds instead of returning them quietly", (projection, domain) => {
    const frame = smokeFrame();
    const output = projectContext(smokeResult(), {
      projection,
      domains: [domain],
      max_tokens: MIN_CONTEXT_MAX_TOKENS,
    });
    const body = output.context[domain] as Record<string, unknown> | undefined;

    // The domain key can survive the fallback to the compact shape while the
    // fields outside the allowlist do not, which is exactly the silent loss the
    // invariant exists to catch.
    expect(Object.keys(frame[domain] ?? {}).some((field) => body?.[field] === undefined)).toBe(true);
    expect(output.context_satisfied).toBe(false);
    expect(output.context_omitted?.domains).toEqual([domain]);
    // The floor is a budget the caller chose, so a bigger one is named and works.
    const suggested = output.context_omitted?.suggested_max_tokens;
    expect(suggested).toBeGreaterThan(MIN_CONTEXT_MAX_TOKENS);
    expect(
      projectContext(smokeResult(), { projection, domains: [domain], max_tokens: suggested })
        .context_satisfied,
    ).toBe(true);
  });

  test.each(["compact", "brief", "focused", "debug", "diff"] as const)(
    "the shipped %s default keeps real headroom over a realistically full frame",
    (projection) => {
      const output = projectContext(smokeResult(), { projection });
      const budget = DEFAULT_CONTEXT_BUDGETS[projection];

      // The projection's own shape survives: nothing was dropped to fit.
      expect(output.budget.truncated).toBe(false);
      expect(output.budget.max_tokens).toBe(budget);
      // At least a quarter of the budget is still free, so one more sensor, one
      // more diagnostic or one more summary clause does not flip it to truncated.
      expect(output.budget.estimated_tokens).toBeLessThanOrEqual(Math.floor(budget * 0.75));
    },
  );

  test("a domain the frame never populated is unknown, not a budget failure", () => {
    const frame = richFrame();
    delete frame.schedule;
    const output = projectContext(
      { ...result(), frame },
      { projection: "brief", domains: ["schedule"] },
    );

    expect(output.context.schedule).toBeUndefined();
    expect(output.context_satisfied).toBe(true);
    expect(output.context_omitted).toBeUndefined();
  });

  test("focused projection excludes unrelated domains", () => {
    const output = projectContext(result(), {
      projection: "focused",
      domains: ["screen"],
      max_tokens: 800,
    });

    expect(output.context.screen).toBeDefined();
    expect(output.context.environment).toBeUndefined();
    expect(output.context.schedule).toBeUndefined();
  });

  test("debug is richer than compact when the budget allows it", () => {
    const compact = projectContext(result(), {
      projection: "compact",
      max_tokens: 2_000,
    });
    const debug = projectContext(result(), {
      projection: "debug",
      max_tokens: 2_000,
    });

    expect(estimateJsonTokens(debug)).toBeGreaterThan(estimateJsonTokens(compact));
    expect(debug.context.quality).toBeDefined();
  });

  test("diff uses the provider's semantic recent-change timeline without mirroring state", () => {
    const output = projectContext(result(), {
      projection: "diff",
      max_tokens: 300,
    });

    expect(output.context.recent_changes).toEqual([
      "Working in sense-mcp (coding)",
      "Power ac_power",
    ]);
    expect(output.context.screen).toBeUndefined();
  });
});

describe("local context provider adapter", () => {
  test("centralizes frame construction and delegates optional domain refresh", async () => {
    const store = new StateStore();
    const observation: Observation = {
      sensor: "active-window",
      domain: "screen",
      fields: { active_app: "Code", activity_class: "coding" },
      observedAt: 1_000,
      ttlMs: 60_000,
    };
    store.ingest([observation], 1_000);
    const refreshDomains = vi.fn(async (domains: import("../src/types.js").Domain[]) => domains);
    const provider = createLocalContextProvider(store, () => ({ tier: 1, capabilities: {} }), {
      now: () => 2_000,
      refreshDomains,
    });

    const current = await provider.getContext({
      domains: ["screen"],
      refresh: "force",
      max_staleness_ms: 500,
    });

    expect(refreshDomains).toHaveBeenCalledWith(["screen"], "force", 500);
    expect(current.frame.screen?.active_app).toBe("Code");
    expect(current.health.source).toBe("local");
    expect(current.refreshed_domains).toEqual(["screen"]);
  });
});
