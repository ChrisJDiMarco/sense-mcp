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

  test("filters by domain", () => {
    const store = new StateStore();
    store.ingest([obs(), obs({ sensor: "s2", domain: "user", fields: { presence: "active" } })], 1000);
    expect(store.live("user", 2000)).toHaveLength(1);
    expect(store.live("screen", 2000)).toHaveLength(1);
  });
});
