import { describe, expect, test } from "vitest";
import { Daemon } from "../src/daemon.js";
import { StateStore } from "../src/state.js";
import type { Observation, Sensor } from "../src/types.js";

const tick = () => new Promise((r) => setTimeout(r, 10));

const sensor = (over: Partial<Sensor>): Sensor => ({
  name: "x",
  intervalMs: 10_000, // large, so only the priming poll runs during the test
  tier: 1,
  sample: async () => [],
  ...over,
});

const reading = (name: string): Observation => ({
  sensor: name,
  domain: "user",
  fields: { presence: "active" },
  observedAt: Date.now(),
  ttlMs: 10_000,
});

describe("Daemon", () => {
  test("skips sensors that report unavailable", async () => {
    const d = new Daemon(new StateStore(), [
      sensor({ name: "off", available: async () => false }),
    ]);
    expect(await d.start()).toEqual([]);
    d.stop();
  });

  test("a throwing sensor never kills the daemon and is marked not yielding", async () => {
    const d = new Daemon(new StateStore(), [
      sensor({
        name: "boom",
        sample: async () => {
          throw new Error("nope");
        },
      }),
      sensor({ name: "ok", capability: "presence", sample: async () => [reading("ok")] }),
    ]);

    const active = await d.start();
    await tick(); // let the priming polls resolve

    expect(active.sort()).toEqual(["boom", "ok"]);
    const status = d.status();
    expect(status.active.has("boom")).toBe(true);
    expect(status.yielding.has("boom")).toBe(false);
    expect(status.yielding.has("ok")).toBe(true);
    d.stop();
  });

  test("records diagnostics from active sensors that are not yielding", async () => {
    const d = new Daemon(new StateStore(), [
      sensor({
        name: "diagnostic",
        capability: "focus_mode",
        sample: async () => [],
        diagnose: () => ({
          reason: "missing_bridge",
          detail: "No bridge configured.",
          fixHint: "Set an env var.",
        }),
      }),
    ]);

    await d.start();
    await tick();

    const status = d.status();
    expect(status.yielding.has("diagnostic")).toBe(false);
    expect(status.diagnostics?.get("diagnostic")).toEqual({
      reason: "missing_bridge",
      detail: "No bridge configured.",
      fixHint: "Set an env var.",
    });
    d.stop();
  });
});
