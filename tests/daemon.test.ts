import { afterEach, describe, expect, test, vi } from "vitest";
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

afterEach(() => {
  vi.useRealTimers();
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
    await d.stop();
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
    await d.stop();
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
    await d.stop();
  });

  test("uses completion-based scheduling so a slow sensor never overlaps itself", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let samples = 0;
    const d = new Daemon(
      new StateStore(),
      [
        sensor({
          name: "slow",
          intervalMs: 5,
          sample: async () => {
            concurrent += 1;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            samples += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            concurrent -= 1;
            return [reading("slow")];
          },
        }),
      ],
      { startupTimeoutMs: 50, jitterRatio: 0 },
    );

    await d.start();
    await new Promise((resolve) => setTimeout(resolve, 35));
    await d.stop();

    expect(samples).toBeGreaterThanOrEqual(2);
    expect(maxConcurrent).toBe(1);
  });

  test("re-probes dynamic availability and begins sampling when a sensor appears", async () => {
    vi.useFakeTimers();
    let availabilityChecks = 0;
    let samples = 0;
    const d = new Daemon(
      new StateStore(),
      [
        sensor({
          name: "hot-plug",
          intervalMs: 10,
          domains: ["user"],
          available: async () => {
            availabilityChecks += 1;
            return availabilityChecks >= 2;
          },
          sample: async () => {
            samples += 1;
            return [reading("hot-plug")];
          },
        }),
      ],
      { startupTimeoutMs: 5, jitterRatio: 0 },
    );

    await d.start();
    expect(samples).toBe(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(samples).toBe(1);
    expect(d.health().get("hot-plug")?.state).toBe("healthy");
    await d.stop();
  });

  test("backs off repeated failures with deterministic jitter injection", async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    const d = new Daemon(
      new StateStore(),
      [
        sensor({
          name: "flaky",
          intervalMs: 10,
          sample: async () => {
            attempts.push(Date.now());
            throw new Error("nope");
          },
        }),
      ],
      { startupTimeoutMs: 5, jitterRatio: 0, maxBackoffMs: 40 },
    );

    await d.start();
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(40);
    await d.stop();

    expect(attempts.length).toBeGreaterThanOrEqual(3);
    expect(attempts[1] - attempts[0]).toBe(20);
    expect(attempts[2] - attempts[1]).toBe(40);
    expect(d.health().get("flaky")?.consecutive_failures).toBeGreaterThanOrEqual(3);
  });

  test("aborts an in-flight sample and shuts down cleanly", async () => {
    let aborted = false;
    const d = new Daemon(
      new StateStore(),
      [
        sensor({
          name: "hanging",
          sample: (signal) =>
            new Promise<Observation[]>((resolve) => {
              signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  resolve([]);
                },
                { once: true },
              );
            }),
        }),
      ],
      { startupTimeoutMs: 5, jitterRatio: 0 },
    );

    const startedAt = Date.now();
    await d.start();
    expect(Date.now() - startedAt).toBeLessThan(100);
    await d.stop();

    expect(aborted).toBe(true);
    expect(d.health().get("hanging")?.state).toBe("stopped");
  });

  test("refreshes only sensors relevant to requested domains after startup", async () => {
    const screenSample = vi.fn(async () => [
      { ...reading("screen"), domain: "screen" as const, fields: { active_app: "Code" } },
    ]);
    const userSample = vi.fn(async () => [reading("user")]);
    const d = new Daemon(
      new StateStore(),
      [
        sensor({ name: "screen", domains: ["screen"], sample: screenSample }),
        sensor({ name: "user", domains: ["user"], sample: userSample }),
      ],
      { startupTimeoutMs: 50, jitterRatio: 0 },
    );

    await d.start();
    await d.refreshDomains(["screen"]);
    await d.stop();

    expect(screenSample).toHaveBeenCalledTimes(2);
    expect(userSample).toHaveBeenCalledTimes(1);
  });

  test("samples an on-demand sensor only for an explicit domain refresh", async () => {
    vi.useFakeTimers();
    const sample = vi.fn(async () => [
      {
        ...reading("calendar"),
        domain: "schedule" as const,
        fields: { time_pressure: "none" },
      },
    ]);
    const onDemand = {
      name: "calendar",
      intervalMs: 5,
      tier: 2,
      domains: ["schedule" as const],
      samplingMode: "on_demand" as const,
      available: async () => true,
      sample,
    } as Sensor & { samplingMode: "on_demand" };
    const daemon = new Daemon(new StateStore(), [onDemand], {
      startupTimeoutMs: 20,
      jitterRatio: 0,
    });

    await daemon.start();
    expect(sample).not.toHaveBeenCalled();

    await daemon.refreshDomains(["schedule"], "force");
    expect(sample).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(sample).toHaveBeenCalledTimes(1);
    await daemon.stop();
  });
});
