import { describe, expect, test } from "vitest";
import { StateStore } from "../src/state.js";
import { buildFrame } from "../src/frame.js";
import type { Observation } from "../src/types.js";

const obs = (over: Partial<Observation> = {}): Observation => ({
  sensor: "s1",
  domain: "screen",
  fields: { active_app: "Figma" },
  observedAt: 1000,
  ttlMs: 60_000,
  ...over,
});

describe("buildFrame", () => {
  test("produces valid envelope with no sensors", () => {
    const frame = buildFrame(new StateStore(), undefined, 5000);
    expect(frame.spec).toBe("context-frame/0.2");
    expect(frame.staleness_ms).toBe(0);
    expect(frame.screen).toBeUndefined();
    expect(frame.privacy).toEqual({ tier: 0, capabilities: {} });
    expect(frame.assistive_posture).toBe("unknown");
    expect(frame.quality).toBeDefined();
    expect(frame.quality?.overall_freshness).toBe("empty");
    expect(frame.situation?.confidence).toBe("unknown");
  });

  test("merges fields within a domain, later wins", () => {
    const store = new StateStore();
    store.ingest(
      [
        obs({ sensor: "a", fields: { active_app: "Figma", activity_class: "designing" } }),
        obs({ sensor: "b", observedAt: 2000, fields: { active_app: "Slack" } }),
      ],
      2000,
    );
    const frame = buildFrame(store, undefined, 3000);
    expect(frame.screen).toEqual({ active_app: "Slack", activity_class: "designing" });
    expect(frame.quality?.fields.screen.active_app.source).toBe("b");
    expect(frame.quality?.fields.screen.active_app.classification).toBe("observed");
    expect(frame.quality?.fields.screen.activity_class.classification).toBe("classified");
    expect(frame.situation?.summary).toContain("using Slack");
    expect(frame.situation?.evidence).toContain("activity designing");
  });

  test("staleness reflects oldest included observation", () => {
    const store = new StateStore();
    store.ingest([obs({ observedAt: 1000 })], 1000);
    const frame = buildFrame(store, undefined, 4000);
    expect(frame.staleness_ms).toBe(3000);
    expect(frame.quality?.domains.screen.staleness_ms).toBe(3000);
    expect(frame.quality?.domains.screen.freshness).toBe("fresh");
  });

  test("respects domain filter", () => {
    const store = new StateStore();
    store.ingest(
      [obs(), obs({ sensor: "u", domain: "user", fields: { presence: "active" } })],
      1000,
    );
    const frame = buildFrame(store, ["user"], 2000);
    expect(frame.user).toEqual({ presence: "active" });
    expect(frame.screen).toBeUndefined();
  });

  test("excludes expired observations", () => {
    const store = new StateStore();
    store.ingest([obs({ ttlMs: 100 })], 1000);
    const frame = buildFrame(store, undefined, 5000);
    expect(frame.screen).toBeUndefined();
  });

  test("marks screen context as stable when recent observations agree", () => {
    const store = new StateStore();
    store.ingest(
      [
        obs({ sensor: "active-window", observedAt: 1000, fields: { active_app: "Code", activity_class: "coding" } }),
        obs({ sensor: "active-window", observedAt: 5000, fields: { active_app: "Code", activity_class: "coding" } }),
      ],
      5000,
    );
    const frame = buildFrame(store, undefined, 6000);
    expect(frame.quality?.stability.screen_activity).toBe("stable");
  });

  test("marks screen context as a recent transition when app changes", () => {
    const store = new StateStore();
    store.ingest(
      [
        obs({ sensor: "active-window", observedAt: 1000, fields: { active_app: "Slack", activity_class: "communicating" } }),
        obs({ sensor: "active-window", observedAt: 5000, fields: { active_app: "Code", activity_class: "coding" } }),
      ],
      5000,
    );
    const frame = buildFrame(store, undefined, 6000);
    expect(frame.quality?.stability.screen_activity).toBe("recent_transition");
  });

  test("includes a compact situation card with safe recent changes", () => {
    const store = new StateStore();
    store.ingest(
      [
        obs({
          sensor: "workspace",
          observedAt: 1000,
          fields: {
            workspace_name: "sense-mcp",
            activity_class: "coding",
            git_branch: "main",
            git_dirty_count: 3,
          },
        }),
        obs({
          sensor: "battery",
          domain: "environment",
          observedAt: 2000,
          fields: { power_source: "ac_power", battery_percent: 94 },
        }),
      ],
      2000,
    );

    const frame = buildFrame(store, undefined, 3000);
    expect(frame.situation?.summary).toContain("working in sense-mcp");
    expect(frame.situation?.evidence).toContain("branch main");
    expect(frame.situation?.recent_changes.join(" ")).toContain("Working in sense-mcp");
    expect(frame.situation?.recent_changes.join(" ")).not.toContain("active_window_title");
  });
});
