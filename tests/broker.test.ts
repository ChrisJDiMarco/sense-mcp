import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BROKER_CONNECT_TIMEOUT_MS,
  BROKER_HANDSHAKE_TIMEOUT_MS,
  BrokerClient,
  BrokerServer,
  brokerOwnerPath,
  brokerProcessEnv,
  connectSenseBroker,
  probeBrokerSocket,
  resetBrokerRuntime,
  type BrokerServerOptions,
} from "../src/broker.js";
import { spawnDetachedBroker } from "../src/brokerEnvironment.js";
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

function plainBrokerOptions(socketPath: string): BrokerServerOptions {
  return {
    socketPath,
    sensors: [],
    privacyConfig: {
      isMac: false,
      rawTitles: false,
      cameraSnapshot: false,
      screenSnapshot: false,
    },
  };
}

/**
 * Hold a broker inside performClose: `closing` is set and the listener is still
 * bound, which is the window a connecting adapter has to survive.
 */
function holdShutdownWindow(server: BrokerServer): {
  entered: Promise<void>;
  release: () => void;
} {
  const internal = server as unknown as { daemon: { stop: () => Promise<void> } };
  const originalStop = internal.daemon.stop.bind(internal.daemon);
  let release!: () => void;
  let signalEntered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  internal.daemon.stop = async () => {
    signalEntered();
    await held;
    await originalStop();
  };
  return { entered, release };
}

/** Resolve once `read` returns something, or fail the test after `timeoutMs`. */
async function waitFor<T>(read: () => T | undefined, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for a value");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function rawPing(socket: Socket): Promise<{ ok?: boolean; error?: string } | "closed"> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (value: { ok?: boolean; error?: string } | "closed") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) finish(JSON.parse(buffer.slice(0, newline)) as { ok?: boolean });
    });
    socket.once("error", () => finish("closed"));
    socket.once("close", () => finish("closed"));
    socket.write(`${JSON.stringify({ id: "raw-ping", method: "ping" })}\n`);
  });
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

  test("names an oversized context result instead of dropping the connection", async () => {
    // Real frames grow through a session; this one has grown past the broker's
    // 128KB wire limit, which used to surface as a bare disconnect and send
    // every adapter back through election into the same oversized frame.
    const oversized: Sensor = {
      name: "oversized",
      intervalMs: 60_000,
      tier: 1,
      domains: ["screen"],
      sample: async () => [
        {
          sensor: "oversized",
          domain: "screen",
          fields: { active_app: "A".repeat(200_000) },
          observedAt: Date.now(),
          ttlMs: 600_000,
        },
      ],
    };
    const { socketPath, server } = await brokerFixture([oversized]);
    const client = await BrokerClient.connect(socketPath);
    cleanups.push(() => client.close());

    await expect(client.getContext({ refresh: "cached" })).rejects.toThrow(
      /past the \d+-byte broker wire limit/,
    );
    // The connection survives, so the adapter reports the real problem instead
    // of electing a replacement that would hit the same wall.
    expect(server.metrics().connected_clients).toBe(1);
  });

  test("answers two legal requests that arrive in one read", async () => {
    // The wire limit bounds a message, not a read. Two requests that are each
    // well inside the limit may still land in one read, and dropping the
    // connection for that is the same bare disconnect the response-side guard
    // was added to remove.
    const { socketPath, server } = await brokerFixture([]);
    const responses: string[] = [];
    const raw = createConnection(socketPath);
    raw.setEncoding("utf8");
    let inbound = "";
    raw.on("data", (chunk: string) => {
      inbound += chunk;
      for (;;) {
        const newline = inbound.indexOf("\n");
        if (newline < 0) break;
        responses.push(inbound.slice(0, newline));
        inbound = inbound.slice(newline + 1);
      }
    });
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", resolve);
      raw.once("error", reject);
    });
    cleanups.push(async () => {
      raw.destroy();
    });
    const accepted = await waitFor(() => {
      const sockets = [...(server as unknown as { sockets: Set<Socket> }).sockets];
      return sockets.length === 1 ? sockets[0] : undefined;
    });

    const padding = "B".repeat(70 * 1024);
    const read = ["one", "two"]
      .map(
        (id) =>
          `${JSON.stringify({ id, method: "context", params: { refresh: "cached", note: padding } })}\n`,
      )
      .join("");
    expect(Buffer.byteLength(read)).toBeGreaterThan(128 * 1024);
    // One read, delivered whole: the kernel is free to coalesce this much.
    accepted.emit("data", read);

    await waitFor(() => (responses.length === 2 ? responses : undefined), 2_000);
    expect(responses.map((line) => (JSON.parse(line) as { id: string; ok: boolean }).ok)).toEqual([
      true,
      true,
    ]);
    expect(server.metrics().connected_clients).toBe(1);
  });

  test("accepts two legal responses that arrive in one read", async () => {
    // The client's guard has to bound the same unit the broker's does, or a
    // pair of legal responses looks like one oversized frame and the adapter
    // elects a replacement that walks into the same pair.
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-pipelined-"));
    const socketPath = path.join(dir, "broker.sock");
    const peers = new Set<Socket>();
    const pendingIds: string[] = [];
    const peer = createNetServer((socket) => {
      peers.add(socket);
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string };
          buffer = buffer.slice(newline + 1);
          if (request.method === "ping") {
            socket.write(
              `${JSON.stringify({ id: request.id, ok: true, result: { protocol_version: 1 } })}\n`,
            );
            continue;
          }
          pendingIds.push(request.id);
        }
      });
      socket.on("close", () => peers.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      peer.once("error", reject);
      peer.listen(socketPath, resolve);
    });
    cleanups.push(async () => {
      for (const socket of peers) socket.destroy();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
    });

    const client = await BrokerClient.connect(socketPath, { requestTimeoutMs: 5_000 });
    cleanups.push(() => client.close());
    const first = client.getContext();
    const second = client.getContext();
    const ids = await waitFor(() => (pendingIds.length === 2 ? [...pendingIds] : undefined));

    const note = "A".repeat(70 * 1024);
    const read = ids
      .map((id) => `${JSON.stringify({ id, ok: true, result: { frame: { note } } })}\n`)
      .join("");
    expect(Buffer.byteLength(read)).toBeGreaterThan(128 * 1024);
    const socket = (client as unknown as { socket?: Socket }).socket;
    expect(socket).toBeDefined();
    socket?.emit("data", read);

    const results = await Promise.all([first, second]);
    for (const result of results) {
      expect((result as unknown as { frame: { note: string } }).frame.note).toHaveLength(
        note.length,
      );
    }
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

  test("reports a detached broker spawn failure to the caller", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-spawn-"));
    const executable = process.execPath;
    process.execPath = path.join(dir, "missing-node-runtime");
    try {
      await expect(spawnDetachedBroker(path.join(dir, "broker.sock"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      process.execPath = executable;
    }
  });

  test("keeps an error listener on the detached broker child after it settles", async () => {
    const children: EventEmitter[] = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      spawn: () => {
        const child = Object.assign(new EventEmitter(), { unref: () => undefined });
        children.push(child);
        return child;
      },
    }));
    try {
      const { spawnDetachedBroker: spawnMocked } = await import("../src/brokerEnvironment.js");
      const pending = spawnMocked("/tmp/sense-unused.sock");
      // The entry point is resolved from disk before the fork, so the child
      // does not exist synchronously.
      const child = await waitFor(() => children[0]);
      child.emit("spawn");
      await expect(pending).resolves.toBeUndefined();

      expect(() => child.emit("error", Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" }))).not.toThrow();
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  test("removes a socket whose owner record predates this boot", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-reused-pid-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    const identity = await lstat(socketPath);
    await writeFile(
      brokerOwnerPath(socketPath),
      JSON.stringify({
        protocol_version: 1,
        pid: process.pid,
        started_at: "2000-01-01T00:00:00.000Z",
        token: "recycled-pid",
        socket_dev: identity.dev,
        socket_ino: identity.ino,
      }),
    );
    const server = new BrokerServer(plainBrokerOptions(socketPath));

    await expect(server.start()).resolves.toBeUndefined();
    cleanups.push(() => server.close());

    expect((await lstat(socketPath)).isSocket()).toBe(true);
  });

  test("removes a socket whose owner record predates the live pid's own start", async () => {
    const bootMs = Date.now() - os.uptime() * 1_000;
    // A Node process started right now is unambiguously younger than the
    // recorded start time, so the check does not depend on how long this test
    // runner itself has been alive.
    const recycled = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      recycled.once("spawn", resolve);
      recycled.once("error", reject);
    });
    cleanups.push(async () => {
      recycled.kill("SIGKILL");
    });

    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-pid-reuse-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    const identity = await lstat(socketPath);
    await writeFile(
      brokerOwnerPath(socketPath),
      JSON.stringify({
        protocol_version: 1,
        pid: recycled.pid,
        // After this boot, so the boot-time rule cannot decide it, and well
        // before the pid above was created.
        started_at: new Date(Math.max(bootMs + 1_000, Date.now() - 10 * 60_000)).toISOString(),
        token: "recycled-pid-same-boot",
        socket_dev: identity.dev,
        socket_ino: identity.ino,
      }),
    );
    const server = new BrokerServer(plainBrokerOptions(socketPath));

    await expect(server.start()).resolves.toBeUndefined();
    cleanups.push(() => server.close());

    expect((await lstat(socketPath)).isSocket()).toBe(true);
  });

  test("keeps a socket whose owner pid is alive but owned by another user", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-eperm-owner-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    const identity = await lstat(socketPath);
    await writeFile(
      brokerOwnerPath(socketPath),
      JSON.stringify({
        protocol_version: 1,
        // pid 1 is alive and reports EPERM to an unprivileged process. It does
        // not run the Sense runtime, but "the pid is alive and started before
        // the record" is the only evidence available, and it points at live.
        pid: 1,
        started_at: new Date().toISOString(),
        token: "eperm-owner",
        socket_dev: identity.dev,
        socket_ino: identity.ino,
      }),
    );
    // Old enough that the age rule on its own would remove it.
    const aged = new Date(Date.now() - 60 * 60_000);
    await utimes(socketPath, aged, aged);
    const server = new BrokerServer(plainBrokerOptions(socketPath));

    await expect(server.start()).rejects.toThrow(/owned by a live process/);
    await expect(readFile(socketPath, "utf8")).resolves.toBe("stale");
  });

  test("keeps a live-owned socket whose runtime binary is not named node", async () => {
    // Sense runs under whatever binary the host launched it with: a version
    // manager's shim, a wrapper script, an embedded Electron helper, bun. `ps`
    // reports that name, and no liveness decision may turn on it — deciding
    // "stale" from a basename unlinks a healthy broker's socket.
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-renamed-runtime-"));
    const runtime = path.join(dir, "runtime-shim");
    await symlink(process.execPath, runtime);
    const live = spawn(runtime, ["-e", "setInterval(() => undefined, 1_000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      live.once("spawn", resolve);
      live.once("error", reject);
    });
    cleanups.push(async () => {
      live.kill("SIGKILL");
    });

    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    const identity = await lstat(socketPath);
    await writeFile(
      brokerOwnerPath(socketPath),
      JSON.stringify({
        protocol_version: 1,
        pid: live.pid,
        started_at: new Date().toISOString(),
        token: "renamed-runtime-owner",
        socket_dev: identity.dev,
        socket_ino: identity.ino,
      }),
    );
    const aged = new Date(Date.now() - 60 * 60_000);
    await utimes(socketPath, aged, aged);
    const server = new BrokerServer(plainBrokerOptions(socketPath));

    const failure = await server.start().then(
      () => undefined,
      (error: Error) => error,
    );
    expect(failure?.message).toMatch(/owned by a live process/);
    // A refusal nobody can act on is a wedge, so it names the way out.
    expect(failure?.message).toMatch(/sense-mcp broker reset/);
    await expect(readFile(socketPath, "utf8")).resolves.toBe("stale");
  });

  test("never removes a socket that still answers, whatever its owner record says", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-answering-owner-"));
    const socketPath = path.join(dir, "broker.sock");
    const live = new BrokerServer(plainBrokerOptions(socketPath));
    await live.start();
    cleanups.push(() => live.close());
    const identity = await lstat(socketPath);
    // The record is destroyed under a running broker, and every time bound on
    // the record is set to zero: the socket-level probe is the one piece of
    // evidence that cannot misfire, and it has to be enough on its own.
    await writeFile(brokerOwnerPath(socketPath), "{ truncated-owner-record");

    const candidate = new BrokerServer({
      ...plainBrokerOptions(socketPath),
      ownerQuarantineMs: 0,
      staleSocketMs: 0,
    });
    await expect(candidate.start()).rejects.toThrow(/already running/);

    expect((await lstat(socketPath)).ino).toBe(identity.ino);
    await expect(probeBrokerSocket(socketPath, 1_000)).resolves.toBe(true);
  });

  test("keeps a socket whose owner liveness cannot be checked", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-unverifiable-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    const identity = await lstat(socketPath);
    await writeFile(
      brokerOwnerPath(socketPath),
      JSON.stringify({
        protocol_version: 1,
        pid: process.pid,
        started_at: new Date(Date.now() - os.uptime() * 1_000 + 1_000).toISOString(),
        token: "unverifiable-owner",
        socket_dev: identity.dev,
        socket_ino: identity.ino,
      }),
    );

    vi.resetModules();
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        execFile: (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error) => void,
        ) => callback(new Error("ps is unavailable")),
      };
    });
    try {
      const { BrokerServer: IsolatedBrokerServer } = await import("../src/broker.js");
      const server = new IsolatedBrokerServer(plainBrokerOptions(socketPath));

      await expect(server.start()).rejects.toThrow(/owned by a live process/);
      await expect(readFile(socketPath, "utf8")).resolves.toBe("stale");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  test("quarantines a live-pid owner record with no usable start time", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-no-start-live-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    const identity = await lstat(socketPath);
    await writeFile(
      brokerOwnerPath(socketPath),
      JSON.stringify({
        protocol_version: 1,
        pid: process.pid,
        token: "no-start-time",
        socket_dev: identity.dev,
        socket_ino: identity.ino,
      }),
    );
    // Old enough that the mtime fallback on its own would remove the socket.
    const aged = new Date(Date.now() - 60 * 60_000);
    await utimes(socketPath, aged, aged);
    const server = new BrokerServer(plainBrokerOptions(socketPath));

    const failure = await server.start().then(
      () => undefined,
      (error: Error) => error,
    );
    // Without a start time the pid proves nothing, so the socket is protected —
    // but for a bounded window, not forever, and the refusal names the way out.
    expect(failure?.message).toMatch(/refusing to remove the socket for another/);
    expect(failure?.message).toMatch(/sense-mcp broker reset/);
    await expect(readFile(socketPath, "utf8")).resolves.toBe("stale");
  });

  test("self-heals from a start-time-less owner record once its quarantine elapses", async () => {
    const live = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      live.once("spawn", resolve);
      live.once("error", reject);
    });
    cleanups.push(async () => {
      live.kill("SIGKILL");
    });

    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-no-start-heal-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    const identity = await lstat(socketPath);
    await writeFile(
      brokerOwnerPath(socketPath),
      JSON.stringify({
        protocol_version: 1,
        // Alive and started before this record was written, so nothing can
        // reconcile the pid with the record it belongs to. The wedge this used
        // to cause was permanent; it now runs out.
        pid: live.pid,
        token: "no-start-time-wedge",
        socket_dev: identity.dev,
        socket_ino: identity.ino,
      }),
    );
    const aged = new Date(Date.now() - 60 * 60_000);
    await utimes(socketPath, aged, aged);
    const server = new BrokerServer({ ...plainBrokerOptions(socketPath), ownerQuarantineMs: 0 });

    await expect(server.start()).resolves.toBeUndefined();
    cleanups.push(() => server.close());

    expect((await lstat(socketPath)).isSocket()).toBe(true);
    await expect(readFile(brokerOwnerPath(socketPath), "utf8")).resolves.toContain(
      '"protocol_version":1',
    );
  });

  test("proves a start-time-less owner record stale when its pid is younger", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-no-start-younger-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    const identity = await lstat(socketPath);
    await writeFile(
      brokerOwnerPath(socketPath),
      JSON.stringify({
        protocol_version: 1,
        pid: process.pid,
        token: "no-start-time-recycled",
        socket_dev: identity.dev,
        socket_ino: identity.ino,
      }),
    );
    // A broker writes its record after it starts, so a pid that started after
    // the record was written cannot be the process that wrote it — a recycled
    // pid, proven without reading the record's own start time.
    const aged = new Date(Date.now() - 60 * 60_000);
    await utimes(socketPath, aged, aged);
    await utimes(brokerOwnerPath(socketPath), aged, aged);
    const server = new BrokerServer(plainBrokerOptions(socketPath));

    await expect(server.start()).resolves.toBeUndefined();
    cleanups.push(() => server.close());

    expect((await lstat(socketPath)).isSocket()).toBe(true);
  });

  test("self-heals from a foreign owner record that names no start time", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-foreign-no-start-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    await writeFile(
      brokerOwnerPath(socketPath),
      JSON.stringify({ protocol_version: 99, pid: process.pid }),
    );
    const aged = new Date(Date.now() - 60 * 60_000);
    await utimes(socketPath, aged, aged);
    const server = new BrokerServer({ ...plainBrokerOptions(socketPath), ownerQuarantineMs: 0 });

    await expect(server.start()).resolves.toBeUndefined();
    cleanups.push(() => server.close());

    expect((await lstat(socketPath)).isSocket()).toBe(true);
  });

  test("keeps a socket whose owner record cannot be read", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-unreadable-owner-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    // Written now, so the quarantine on an uninterpretable record is running.
    await writeFile(brokerOwnerPath(socketPath), "{ truncated-owner-record");
    const aged = new Date(Date.now() - 60 * 60_000);
    await utimes(socketPath, aged, aged);
    const server = new BrokerServer(plainBrokerOptions(socketPath));

    await expect(server.start()).rejects.toThrow(/owner record could not be read/);
    await expect(readFile(socketPath, "utf8")).resolves.toBe("stale");
  });

  test("self-heals from an owner record nobody can parse once its quarantine elapses", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-quarantine-elapsed-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    await writeFile(brokerOwnerPath(socketPath), "{ truncated-owner-record");
    // Both the socket and the corrupt record have been untouched for far longer
    // than the quarantine, so nothing can still be starting up behind them.
    const aged = new Date(Date.now() - 60 * 60_000);
    await utimes(socketPath, aged, aged);
    await utimes(brokerOwnerPath(socketPath), aged, aged);
    const server = new BrokerServer(plainBrokerOptions(socketPath));

    await expect(server.start()).resolves.toBeUndefined();
    cleanups.push(() => server.close());

    expect((await lstat(socketPath)).isSocket()).toBe(true);
    // The corrupt record is gone too, so the wedge cannot come back.
    await expect(readFile(brokerOwnerPath(socketPath), "utf8")).resolves.toContain(
      '"protocol_version":1',
    );
  });

  test("quarantines an unparseable owner record for the configured window, then yields", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-quarantine-window-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    await writeFile(brokerOwnerPath(socketPath), "not-json-at-all");
    const aged = new Date(Date.now() - 60 * 60_000);
    await utimes(socketPath, aged, aged);

    const quarantined = new BrokerServer({
      ...plainBrokerOptions(socketPath),
      ownerQuarantineMs: 10_000,
    });
    await expect(quarantined.start()).rejects.toThrow(/refusing to remove the socket for another/);

    const released = new BrokerServer({
      ...plainBrokerOptions(socketPath),
      ownerQuarantineMs: 0,
    });
    await expect(released.start()).resolves.toBeUndefined();
    cleanups.push(() => released.close());
    expect((await lstat(socketPath)).isSocket()).toBe(true);
  });

  test("keeps a socket owned by a live broker speaking another protocol version", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-foreign-live-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    await writeFile(
      brokerOwnerPath(socketPath),
      JSON.stringify({
        protocol_version: 99,
        pid: process.pid,
        started_at: new Date().toISOString(),
        unknown_future_field: "ignored",
      }),
    );
    const aged = new Date(Date.now() - 60 * 60_000);
    await utimes(socketPath, aged, aged);
    const server = new BrokerServer(plainBrokerOptions(socketPath));

    await expect(server.start()).rejects.toThrow(/another protocol version/);
    await expect(readFile(socketPath, "utf8")).resolves.toBe("stale");
  });

  test("removes a socket owned by a dead broker speaking another protocol version", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-foreign-dead-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    await writeFile(
      brokerOwnerPath(socketPath),
      JSON.stringify({
        protocol_version: 99,
        pid: 2_147_483_647,
        started_at: new Date().toISOString(),
      }),
    );
    const server = new BrokerServer(plainBrokerOptions(socketPath));

    await expect(server.start()).resolves.toBeUndefined();
    cleanups.push(() => server.close());

    expect((await lstat(socketPath)).isSocket()).toBe(true);
  });

  test("keeps a live-owned socket across a forward wall-clock step", async () => {
    const live = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      live.once("spawn", resolve);
      live.once("error", reject);
    });
    cleanups.push(async () => {
      live.kill("SIGKILL");
    });

    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-clock-step-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    const identity = await lstat(socketPath);
    await writeFile(
      brokerOwnerPath(socketPath),
      JSON.stringify({
        protocol_version: 1,
        pid: live.pid,
        started_at: new Date().toISOString(),
        token: "live-owner-before-clock-step",
        socket_dev: identity.dev,
        socket_ino: identity.ino,
      }),
    );

    // Two minutes of uptime: a broker elected right after boot, which is when
    // the clock is most likely to be corrected forward (NTP, a dead RTC, or
    // waking from sleep).
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, default: { ...actual.default, uptime: () => 120 }, uptime: () => 120 };
    });
    // The wall clock then steps ten minutes forward, which moves the derived
    // boot time past the recorded start time without moving the owner record.
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 10 * 60_000);
    try {
      const { BrokerServer: IsolatedBrokerServer } = await import("../src/broker.js");
      const server = new IsolatedBrokerServer(plainBrokerOptions(socketPath));
      await expect(server.start()).rejects.toThrow(/owned by a live process/);
      await expect(readFile(socketPath, "utf8")).resolves.toBe("stale");
    } finally {
      clock.mockRestore();
      vi.doUnmock("node:os");
      vi.resetModules();
    }
  }, 20_000);

  test("removes a socket whose owner record has no start time and no live pid", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-no-start-dead-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    const identity = await lstat(socketPath);
    await writeFile(
      brokerOwnerPath(socketPath),
      JSON.stringify({
        protocol_version: 1,
        pid: 2_147_483_647,
        token: "no-start-time-dead",
        socket_dev: identity.dev,
        socket_ino: identity.ino,
      }),
    );
    const server = new BrokerServer(plainBrokerOptions(socketPath));

    await expect(server.start()).resolves.toBeUndefined();
    cleanups.push(() => server.close());

    expect((await lstat(socketPath)).isSocket()).toBe(true);
  });

  test("fails loudly instead of exiting silently when no broker can be elected", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-keepalive-"));
    const script = path.join(dir, "elect.ts");
    const brokerModule = fileURLToPath(new URL("../src/broker.js", import.meta.url));
    await writeFile(
      script,
      [
        `import { connectSenseBroker } from ${JSON.stringify(brokerModule)};`,
        "",
        "connectSenseBroker({",
        "  socketPath: process.argv[2],",
        "  startupTimeoutMs: 300,",
        "  startBroker: async () => undefined,",
        "})",
        '  .then(() => console.log("connected"))',
        "  .catch((error) => {",
        "    console.error(`sense-mcp fatal: ${error instanceof Error ? error.message : String(error)}`);",
        "    process.exit(1);",
        "  });",
        "",
      ].join("\n"),
    );
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(tsx, [script, path.join(dir, "broker.sock")], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("close", (code) => resolve({ code, stderr }));
    });

    expect(result.stderr).toContain("did not become ready");
    expect(result.code).toBe(1);
  }, 30_000);


  test("fails loudly instead of exiting silently when the elected broker cannot bind", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-child-keepalive-"));
    const socketPath = path.join(dir, "broker.sock");
    // A freshly written regular file makes `listen` fail with EADDRINUSE and
    // sends `start` through the unref'd probe/sleep loop of the stale-socket
    // proof, which is the window the child process can vanish in.
    await writeFile(socketPath, "occupied");
    const script = path.join(dir, "start.ts");
    const brokerModule = fileURLToPath(new URL("../src/broker.js", import.meta.url));
    await writeFile(
      script,
      [
        `import { BrokerServer } from ${JSON.stringify(brokerModule)};`,
        "",
        "const server = new BrokerServer({",
        "  socketPath: process.argv[2],",
        "  sensors: [],",
        "  privacyConfig: { isMac: false, rawTitles: false, cameraSnapshot: false, screenSnapshot: false },",
        "});",
        "server",
        "  .start()",
        '  .then(() => console.log("started"))',
        "  .catch((error) => {",
        "    console.error(`sense-mcp fatal: ${error instanceof Error ? error.message : String(error)}`);",
        "    process.exit(1);",
        "  });",
        "",
      ].join("\n"),
    );
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(tsx, [script, socketPath], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("close", (code) => resolve({ code, stderr }));
    });

    expect(result.stderr).toContain("not old enough to prove stale");
    expect(result.code).toBe(1);
  }, 30_000);

  test("refuses new connections while shutting down", async () => {
    const { socketPath, server } = await brokerFixture([]);
    const window = holdShutdownWindow(server);
    const closing = server.close();
    await window.entered;

    try {
      await expect(rawPing(createConnection(socketPath))).resolves.toBe("closed");
    } finally {
      window.release();
      await closing;
    }
  });

  test("answers ping as unhealthy while shutting down", async () => {
    const { socketPath, server } = await brokerFixture([]);
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const window = holdShutdownWindow(server);
    const closing = server.close();
    await window.entered;

    try {
      await expect(rawPing(socket)).resolves.toMatchObject({ ok: false });
    } finally {
      window.release();
      await closing;
    }
  });

  test("treats a socket that closes without answering as unreachable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-silent-"));
    const socketPath = path.join(dir, "broker.sock");
    const silentSockets = new Set<Socket>();
    const silent = createNetServer((socket) => {
      silentSockets.add(socket);
      socket.on("close", () => silentSockets.delete(socket));
      setTimeout(() => socket.end(), 25).unref();
    });
    await new Promise<void>((resolve, reject) => {
      silent.once("error", reject);
      silent.listen(socketPath, resolve);
    });
    cleanups.push(async () => {
      for (const socket of silentSockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    });

    const startedAt = Date.now();
    await expect(probeBrokerSocket(socketPath, 3_000)).resolves.toBe(false);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("elects a replacement when the first ping lands on a closing broker", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-closing-connect-"));
    const socketPath = path.join(dir, "broker.sock");
    const shuttingDown = createNetServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        const request = JSON.parse(chunk.trim()) as { id: string };
        socket.write(
          `${JSON.stringify({ id: request.id, ok: false, error: "Sense broker is shutting down" })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      shuttingDown.once("error", reject);
      shuttingDown.listen(socketPath, resolve);
    });

    let replacement: BrokerServer | undefined;
    const recover = async () => {
      if (replacement) return;
      await new Promise<void>((resolve) => shuttingDown.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
      replacement = new BrokerServer(plainBrokerOptions(socketPath));
      await replacement.start();
      cleanups.push(() => replacement!.close());
    };

    const client = await BrokerClient.connect(socketPath, { recover });
    cleanups.push(() => client.close());

    await expect(client.getContext()).resolves.toMatchObject({ health: { source: "broker" } });
    expect(replacement).toBeDefined();
  });


  test("settles instead of hanging when the broker accepts and never answers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-half-open-"));
    const socketPath = path.join(dir, "broker.sock");
    const wedgedSockets = new Set<Socket>();
    // `allowHalfOpen` keeps the peer writable after the client sends FIN, which
    // is exactly what a wedged broker looks like from the outside: it accepts,
    // it never answers, and it never closes.
    const wedged = createNetServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
      wedgedSockets.add(socket);
      socket.on("close", () => wedgedSockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      wedged.once("error", reject);
      wedged.listen(socketPath, resolve);
    });
    cleanups.push(async () => {
      for (const socket of wedgedSockets) socket.destroy();
      await new Promise<void>((resolve) => wedged.close(() => resolve()));
    });
    const recover = vi.fn(async () => undefined);

    const startedAt = Date.now();
    await expect(
      BrokerClient.connect(socketPath, { recover, requestTimeoutMs: 100 }),
    ).rejects.toThrow(/timed out/);

    expect(recover).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  }, 10_000);

  test("elects a replacement when the first broker accepts and never answers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-half-open-elect-"));
    const socketPath = path.join(dir, "broker.sock");
    const wedgedSockets = new Set<Socket>();
    const wedged = createNetServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
      wedgedSockets.add(socket);
      socket.on("close", () => wedgedSockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      wedged.once("error", reject);
      wedged.listen(socketPath, resolve);
    });
    let replacement: BrokerServer | undefined;
    const recover = async () => {
      if (replacement) return;
      for (const socket of wedgedSockets) socket.destroy();
      await new Promise<void>((resolve) => wedged.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
      replacement = new BrokerServer(plainBrokerOptions(socketPath));
      await replacement.start();
      cleanups.push(() => replacement!.close());
    };

    const startedAt = Date.now();
    const client = await BrokerClient.connect(socketPath, { recover, requestTimeoutMs: 200 });
    cleanups.push(() => client.close());

    await expect(client.getContext()).resolves.toMatchObject({ health: { source: "broker" } });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  }, 10_000);

  test("bounds the opening handshake independently of the request timeout", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-handshake-bound-"));
    const socketPath = path.join(dir, "broker.sock");
    const wedgedSockets = new Set<Socket>();
    const wedged = createNetServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
      wedgedSockets.add(socket);
      socket.on("close", () => wedgedSockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      wedged.once("error", reject);
      wedged.listen(socketPath, resolve);
    });
    cleanups.push(async () => {
      for (const socket of wedgedSockets) socket.destroy();
      await new Promise<void>((resolve) => wedged.close(() => resolve()));
    });

    // The two bounds are separate constants with separate jobs: establishment
    // applies to every reconnect, the handshake only to `connect`.
    expect(BROKER_CONNECT_TIMEOUT_MS).toBe(2_000);
    expect(BROKER_HANDSHAKE_TIMEOUT_MS).toBe(2_000);

    // A request timeout far above the handshake bound must not extend it: the
    // adapter has to give up on a wedged broker and elect, not wait a minute.
    const startedAt = Date.now();
    await expect(
      BrokerClient.connect(socketPath, { requestTimeoutMs: 60_000 }),
    ).rejects.toThrow(/timed out/);

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(BROKER_HANDSHAKE_TIMEOUT_MS - 250);
    expect(elapsed).toBeLessThan(BROKER_CONNECT_TIMEOUT_MS + BROKER_HANDSHAKE_TIMEOUT_MS + 1_000);
  }, 20_000);

  test("re-executes the Sense entry point rather than the program in argv[1]", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-entrypoint-"));
    const wrapper = path.join(dir, "some-host-wrapper.js");
    await writeFile(wrapper, "// an embedding host, not the Sense entry point\n");
    const spawned: string[][] = [];

    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      spawn: (_command: string, args: string[]) => {
        spawned.push(args);
        const child = Object.assign(new EventEmitter(), { unref: () => undefined });
        setTimeout(() => child.emit("spawn"), 0);
        return child;
      },
    }));
    const originalArgv1 = process.argv[1];
    process.argv[1] = wrapper;
    try {
      const { spawnDetachedBroker: spawnMocked, senseEntryPoint } = await import(
        "../src/brokerEnvironment.js"
      );
      await spawnMocked(path.join(dir, "broker.sock"));

      const entry = await senseEntryPoint();
      expect(path.basename(entry)).toMatch(/^index\.(js|ts)$/);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]).toContain(entry);
      expect(spawned[0]).not.toContain(wrapper);
    } finally {
      process.argv[1] = originalArgv1;
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  test("drops a preserved socket instead of clobbering a successor", async () => {
    const { socketPath, server } = await brokerFixture([]);
    await unlink(socketPath);
    await writeFile(socketPath, "foreign-inode");
    // A successor claims the path in the window between this broker releasing
    // its listener and restoring the socket it moved aside.
    const listener = (server as unknown as { server: import("node:net").Server }).server;
    const closeListener = listener.close.bind(listener);
    listener.close = ((done?: () => void) =>
      closeListener(() => {
        writeFileSync(socketPath, "successor-owned-elsewhere");
        done?.();
      })) as typeof listener.close;

    await server.close();

    await expect(readFile(socketPath, "utf8")).resolves.toBe("successor-owned-elsewhere");
    const leaked = (await readdir(path.dirname(socketPath))).filter((name) =>
      name.includes(".preserved-"),
    );
    expect(leaked).toEqual([]);
  });


  test("keeps a preserved foreign socket it cannot restore", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-preserve-fail-"));
    const socketPath = path.join(dir, "broker.sock");

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        link: async () => {
          throw Object.assign(new Error("link is not permitted"), { code: "EPERM" });
        },
      };
    });
    try {
      const { BrokerServer: IsolatedBrokerServer } = await import("../src/broker.js");
      const server = new IsolatedBrokerServer(plainBrokerOptions(socketPath));
      await server.start();
      await unlink(socketPath);
      await writeFile(socketPath, "foreign-inode");

      await server.close();

      // Restoring the foreign inode failed for a reason other than "somebody
      // else already claimed the path", so the moved-aside copy is the only
      // surviving reference to it and must not be deleted.
      const preserved = (await readdir(dir)).filter((name) => name.includes(".preserved-"));
      expect(preserved).toHaveLength(1);
      await expect(readFile(path.join(dir, preserved[0]), "utf8")).resolves.toBe("foreign-inode");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  test("never clears runtime files while a broker still answers", async () => {
    const { socketPath } = await brokerFixture([]);

    const result = await resetBrokerRuntime(socketPath);

    expect(result).toMatchObject({ reachable: true, removed: [], failed: [] });
    expect((await lstat(socketPath)).isSocket()).toBe(true);
  });

  test("clears the socket, owner record, and lock of a broker that is gone", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-broker-reset-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    await writeFile(brokerOwnerPath(socketPath), "{}");
    await writeFile(`${socketPath}.lock`, "{}");

    const result = await resetBrokerRuntime(socketPath);

    expect(result.reachable).toBe(false);
    expect(result.failed).toEqual([]);
    expect(result.removed).toEqual([socketPath, brokerOwnerPath(socketPath), `${socketPath}.lock`]);
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
