import { describe, expect, test, vi } from "vitest";
import { createLocalContextProvider, type ContextResult } from "../src/contextProvider.js";
import { estimateJsonTokens, projectContext } from "../src/contextOutput.js";
import { StateStore } from "../src/state.js";
import type { ContextFrame, Observation } from "../src/types.js";

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

describe("context output projections", () => {
  test.each(["compact", "brief", "focused", "debug", "diff"] as const)(
    "%s projection enforces its serialized token budget",
    (projection) => {
      const output = projectContext(result(), {
        projection,
        domains: ["screen"],
        max_tokens: 140,
        context_satisfied: true,
      });

      expect(estimateJsonTokens(output)).toBeLessThanOrEqual(140);
      expect(output.budget.estimated_tokens).toBeLessThanOrEqual(140);
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

  test("focused projection excludes unrelated domains", () => {
    const output = projectContext(result(), {
      projection: "focused",
      domains: ["screen"],
      max_tokens: 800,
      context_satisfied: true,
    });

    expect(output.context.screen).toBeDefined();
    expect(output.context.environment).toBeUndefined();
    expect(output.context.schedule).toBeUndefined();
  });

  test("debug is richer than compact when the budget allows it", () => {
    const compact = projectContext(result(), {
      projection: "compact",
      max_tokens: 2_000,
      context_satisfied: true,
    });
    const debug = projectContext(result(), {
      projection: "debug",
      max_tokens: 2_000,
      context_satisfied: true,
    });

    expect(estimateJsonTokens(debug)).toBeGreaterThan(estimateJsonTokens(compact));
    expect(debug.context.quality).toBeDefined();
  });

  test("diff uses the provider's semantic recent-change timeline without mirroring state", () => {
    const output = projectContext(result(), {
      projection: "diff",
      max_tokens: 300,
      context_satisfied: true,
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
