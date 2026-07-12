import { describe, expect, test } from "vitest";
import { StateStore } from "../src/state.js";
import type { Observation } from "../src/types.js";

const obs = (over: Partial<Observation> = {}): Observation => ({
  sensor: "s1",
  domain: "screen",
  fields: { active_app: "Figma" },
  observedAt: 1000,
  ttlMs: 10_000,
  ...over,
});

describe("StateStore", () => {
  test("ingests and returns live observations", () => {
    const store = new StateStore();
    store.ingest([obs()], 1000);
    expect(store.live(undefined, 2000)).toHaveLength(1);
  });

  test("drops expired observations on read", () => {
    const store = new StateStore();
    store.ingest([obs()], 1000);
    expect(store.live(undefined, 11_001)).toHaveLength(0);
  });

  test("rejects observations dead on arrival", () => {
    const store = new StateStore();
    store.ingest([obs({ observedAt: 0, ttlMs: 100 })], 1000);
    expect(store.live(undefined, 1000)).toHaveLength(0);
  });

  test("later observation from same sensor replaces earlier", () => {
    const store = new StateStore();
    store.ingest([obs()], 1000);
    store.ingest([obs({ observedAt: 2000, fields: { active_app: "Slack" } })], 2000);
    const live = store.live("screen", 3000);
    expect(live).toHaveLength(1);
    expect(live[0].fields.active_app).toBe("Slack");
  });

  test("preserves observations from one sensor across multiple domains", () => {
    const store = new StateStore();
    store.ingest(
      [
        obs({ sensor: "multi", domain: "screen", fields: { active_app: "Code" } }),
        obs({ sensor: "multi", domain: "user", fields: { presence: "active" } }),
      ],
      1000,
    );

    expect(store.live(undefined, 2000)).toHaveLength(2);
    expect(store.live("screen", 2000)[0].fields.active_app).toBe("Code");
    expect(store.live("user", 2000)[0].fields.presence).toBe("active");
  });

  test("merges partial fields from the same sensor and domain", () => {
    const store = new StateStore();
    store.ingest([obs({ fields: { active_app: "Code" } })], 1000);
    store.ingest(
      [obs({ observedAt: 2000, fields: { activity_class: "coding" } })],
      2000,
    );

    expect(store.live("screen", 3000)[0].fields).toEqual({
      active_app: "Code",
      activity_class: "coding",
    });
  });

  test("filters by domain", () => {
    const store = new StateStore();
    store.ingest([obs(), obs({ sensor: "s2", domain: "user", fields: { presence: "active" } })], 1000);
    expect(store.live("user", 2000)).toHaveLength(1);
    expect(store.live("screen", 2000)).toHaveLength(1);
  });

  test("keeps a privacy-safe semantic timeline without raw titles", () => {
    const store = new StateStore();
    store.ingest(
      [
        obs({
          sensor: "active-window",
          fields: {
            active_window_title: "Secret Project - Chris@example.com",
            activity_class: "coding",
            workspace_name: "sense-mcp",
          },
        }),
      ],
      1000,
    );

    const timeline = store.timeline(2000);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].label).toBe("Working in sense-mcp (coding)");
    expect(timeline[0].label).not.toContain("Secret Project");
    expect(timeline[0].label).not.toContain("@");
  });

  test("purges a revoked sensor from live, history, and timeline state", () => {
    const store = new StateStore();
    store.ingest([
      obs({ sensor: "calendar", domain: "schedule", fields: { time_pressure: "high" } }),
    ], 1000);

    store.removeSensor("calendar");

    expect(store.live(undefined, 2000)).toEqual([]);
    expect(store.history(undefined, 2000)).toEqual([]);
    expect(store.timeline(2000)).toEqual([]);
  });

  test("purges one revoked field without dropping safe fields from the same sensor", () => {
    const store = new StateStore();
    store.ingest([
      obs({
        sensor: "active-window",
        fields: { active_app: "Code", active_window_title: "Secret project" },
      }),
    ], 1000);

    store.removeSensorField("active-window", "active_window_title");

    expect(store.live("screen", 2000)[0].fields).toEqual({ active_app: "Code" });
    expect(store.history("screen", 2000)[0].fields).toEqual({ active_app: "Code" });
  });
});
