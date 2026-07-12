import { lstat, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BrokerClient,
  BrokerServer,
  brokerOwnerPath,
  brokerProcessEnv,
  connectSenseBroker,
  type BrokerServerOptions,
} from "../src/broker.js";
import type { Observation, Sensor } from "../src/types.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

function reading(sensor: string, domain: "screen" | "user" = "screen"): Observation {
  return {
    sensor,
    domain,
    fields: domain === "screen" ? { active_app: "Code" } : { presence: "active" },
    observedAt: Date.now(),
    ttlMs: 60_000,
  };
}

async function brokerFixture(
  sensors: Sensor[],
  overrides: Partial<BrokerServerOptions> = {},
): Promise<{ socketPath: string; server: BrokerServer }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-test-"));
  const socketPath = path.join(dir, "broker.sock");
  const server = new BrokerServer({
    socketPath,
    sensors,
    privacyConfig: {
      isMac: false,
      rawTitles: false,
      cameraSnapshot: false,
      screenSnapshot: false,
    },
    daemonOptions: { startupTimeoutMs: 100, jitterRatio: 0 },
    ...overrides,
  });
  await server.start();
  cleanups.push(() => server.close());
  return { socketPath, server };
}

describe("Sense broker", () => {
  test("reloads privacy configuration for each context request", async () => {
    let windowEnabled = false;
    const privacyConfig = vi.fn(async () => ({
      isMac: true,
      rawTitles: false,
      cameraSnapshot: false,
      screenSnapshot: windowEnabled,
      windowSnapshot: windowEnabled,
      fullScreenSnapshot: false,
    }));
    const { socketPath } = await brokerFixture([], { privacyConfig });
    const client = await BrokerClient.connect(socketPath);
    cleanups.push(() => client.close());

    const disabled = await client.getContext({ refresh: "cached" });
    windowEnabled = true;
    const enabled = await client.getContext({ refresh: "cached" });

    expect(disabled.frame.privacy.capability_states?.window_snapshot).toBe("disabled");
    expect(enabled.frame.privacy.capability_states?.window_snapshot).toBe("no_signal");
    expect(privacyConfig).toHaveBeenCalledTimes(2);
  });

  test("immediately purges cached semantic fields when policy is revoked", async () => {
    let locationEnabled = true;
    const privacyConfig = async () => ({
      isMac: true,
      location: locationEnabled,
      rawTitles: false,
      cameraSnapshot: false,
      screenSnapshot: false,
    });
    const location: Sensor = {
      name: "location",
      intervalMs: 60_000,
      tier: 2,
      capability: "location_class",
      domains: ["environment"],
      sample: async () => [{
        sensor: "location",
        domain: "environment",
        fields: { location_class: "home_office" },
        observedAt: Date.now(),
        ttlMs: 120_000,
      }],
    };
    const { socketPath } = await brokerFixture([location], { privacyConfig });
    const client = await BrokerClient.connect(socketPath);
    cleanups.push(() => client.close());

    const before = await client.getContext({ refresh: "cached" });
    locationEnabled = false;
    const after = await client.getContext({ refresh: "cached" });

    expect(before.frame.environment?.location_class).toBe("home_office");
    expect(after.frame.environment?.location_class).toBeUndefined();
    expect(after.frame.privacy.capability_states?.location_class).toBe("disabled");
  });

  test("serves multiple clients from one authoritative sensor cadence", async () => {
    const sample = vi.fn(async () => [reading("shared")]);
    const { socketPath, server } = await brokerFixture([
      { name: "shared", intervalMs: 60_000, tier: 1, domains: ["screen"], sample },
    ]);
    const first = await BrokerClient.connect(socketPath);
    const second = await BrokerClient.connect(socketPath);
    cleanups.push(() => first.close(), () => second.close());

    const [a, b] = await Promise.all([
      first.getContext({ refresh: "cached" }),
      second.getContext({ refresh: "cached" }),
    ]);

    expect(a.frame.screen?.active_app).toBe("Code");
    expect(b.frame.screen?.active_app).toBe("Code");
    expect(a.health.source).toBe("broker");
    expect(a.health.diagnostics).toEqual([]);
    expect(sample).toHaveBeenCalledTimes(1);
    expect(server.metrics().connected_clients).toBe(2);
    expect(server.metrics().context_requests).toBe(2);
  });

  test("supports authoritative on-demand domain refresh", async () => {
    let generation = 0;
    const sample = vi.fn(async () => {
      generation += 1;
      return [
        {
          ...reading("screen"),
          fields: { active_app: generation === 1 ? "Code" : "Xcode" },
        },
      ];
    });
    const { socketPath } = await brokerFixture([
      { name: "screen", intervalMs: 60_000, tier: 1, domains: ["screen"], sample },
    ]);
    const client = await BrokerClient.connect(socketPath);
    cleanups.push(() => client.close());

    const result = await client.getContext({ domains: ["screen"], refresh: "force" });

    expect(result.frame.screen?.active_app).toBe("Xcode");
    expect(result.refreshed_domains).toEqual(["screen"]);
    expect(sample).toHaveBeenCalledTimes(2);
  });

  test("coalesces concurrent force refreshes from separate clients", async () => {
    const sample = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [reading("coalesced")];
    });
    const { socketPath } = await brokerFixture([
      { name: "coalesced", intervalMs: 60_000, tier: 1, domains: ["screen"], sample },
    ]);
    const first = await BrokerClient.connect(socketPath);
    const second = await BrokerClient.connect(socketPath);
    cleanups.push(() => first.close(), () => second.close());

    await Promise.all([
      first.getContext({ domains: ["screen"], refresh: "force" }),
      second.getContext({ domains: ["screen"], refresh: "force" }),
    ]);

    expect(sample).toHaveBeenCalledTimes(2);
  });

  test("creates a user-private socket directory and socket", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-mode-"));
    const privateDir = path.join(dir, "private");
    const socketPath = path.join(privateDir, "broker.sock");
    const server = new BrokerServer({
      socketPath,
      sensors: [],
      privacyConfig: {
        isMac: false,
        rawTitles: false,
        cameraSnapshot: false,
        screenSnapshot: false,
      },
    });
    await server.start();
    cleanups.push(() => server.close());

    expect((await stat(privateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  test("recovers one leader from a stale socket under concurrent startup", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-election-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    const identity = await lstat(socketPath);
    await writeFile(
      brokerOwnerPath(socketPath),
      JSON.stringify({
        protocol_version: 1,
        pid: 2_147_483_647,
        started_at: "2000-01-01T00:00:00.000Z",
        token: "dead-owner",
        socket_dev: identity.dev,
        socket_ino: identity.ino,
      }),
    );
    let starts = 0;
    let server: BrokerServer | undefined;
    const startBroker = async () => {
      starts += 1;
      server = new BrokerServer({
        socketPath,
        sensors: [],
        privacyConfig: {
          isMac: false,
          rawTitles: false,
          cameraSnapshot: false,
          screenSnapshot: false,
        },
      });
      await server.start();
    };

    const clients = await Promise.all(
      Array.from({ length: 6 }, () =>
        connectSenseBroker({ socketPath, startBroker, startupTimeoutMs: 1_000 }),
      ),
    );
    cleanups.push(...clients.map((client) => () => client.close()));
    if (server) cleanups.push(() => server!.close());

    expect(starts).toBe(1);
    await expect(clients[0].getContext()).resolves.toMatchObject({
      health: { source: "broker" },
    });
  });

  test("reconnects and promotes a replacement after leader loss", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-recovery-"));
    const socketPath = path.join(dir, "broker.sock");
    const servers: BrokerServer[] = [];
    const startBroker = async () => {
      const server = new BrokerServer({
        socketPath,
        sensors: [],
        privacyConfig: {
          isMac: false,
          rawTitles: false,
          cameraSnapshot: false,
          screenSnapshot: false,
        },
      });
      servers.push(server);
      await server.start();
    };
    const client = await connectSenseBroker({
      socketPath,
      startBroker,
      startupTimeoutMs: 1_000,
    });
    cleanups.push(() => client.close());

    await client.getContext();
    await servers[0].close();
    await expect(client.getContext()).resolves.toMatchObject({
      health: { source: "broker" },
    });
    expect(servers).toHaveLength(2);
    cleanups.push(() => servers[1].close());
  });

  test("never unlinks an unresponsive socket owned by a live process", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-live-owner-"));
    const socketPath = path.join(dir, "broker.sock");
    const foreignSockets = new Set<import("node:net").Socket>();
    const foreign = createNetServer((socket) => {
      foreignSockets.add(socket);
      socket.on("close", () => foreignSockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      foreign.once("error", reject);
      foreign.listen(socketPath, resolve);
    });
    const identity = await lstat(socketPath);
    await writeFile(
      brokerOwnerPath(socketPath),
      JSON.stringify({
        protocol_version: 1,
        pid: process.pid,
        started_at: new Date().toISOString(),
        token: "live-owner",
        socket_dev: identity.dev,
        socket_ino: identity.ino,
      }),
    );
    const candidate = new BrokerServer({
      socketPath,
      sensors: [],
      privacyConfig: {
        isMac: false,
        rawTitles: false,
        cameraSnapshot: false,
        screenSnapshot: false,
      },
    });

    await expect(candidate.start()).rejects.toThrow(/owned by a live process/);
    expect((await lstat(socketPath)).ino).toBe(identity.ino);

    for (const socket of foreignSockets) socket.destroy();
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
    await unlink(brokerOwnerPath(socketPath)).catch(() => undefined);
  });

  test("shuts the detached-style broker down after the last client is idle", async () => {
    const sample = vi.fn(async () => [reading("idle-shutdown")]);
    const { socketPath, server } = await brokerFixture(
      [{ name: "idle-shutdown", intervalMs: 5, tier: 1, domains: ["screen"], sample }],
      { idleShutdownMs: 20 },
    );
    const client = await BrokerClient.connect(socketPath);
    await client.close();

    await server.waitUntilClosed();

    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    const samplesAtClose = sample.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sample).toHaveBeenCalledTimes(samplesAtClose);
  });

  test("does not remove a replacement path when closing its bound socket", async () => {
    const { socketPath, server } = await brokerFixture([]);
    await unlink(socketPath);
    await writeFile(socketPath, "replacement-owned-elsewhere");

    await server.close();

    await expect(readFile(socketPath, "utf8")).resolves.toBe("replacement-owned-elsewhere");
  });

  test("passes only operational and Sense variables to a detached broker", () => {
    const env = brokerProcessEnv({
      PATH: "/usr/bin",
      HOME: "/Users/test",
      SENSE_MIC_LEVEL: "1",
      OPENAI_API_KEY: "must-not-cross",
      RANDOM_SECRET: "must-not-cross",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/test");
    expect(env.SENSE_MIC_LEVEL).toBe("1");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.RANDOM_SECRET).toBeUndefined();
  });
});
