import { randomUUID } from "node:crypto";
import { chmod, lstat, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  ContextDiagnostic,
  ContextProvider,
  ContextProviderHealth,
  ContextRequest,
  ContextResult,
} from "./contextProvider.js";
import {
  brokerProcessEnv,
  INTERNAL_BROKER_FLAG,
  spawnDetachedBroker,
} from "./brokerEnvironment.js";
import { Daemon, type DaemonOptions } from "./daemon.js";
import { buildFrame } from "./frame.js";
import { computePrivacy, enforcePrivacyRevocations, type PrivacyConfig } from "./privacy.js";
import { StateStore } from "./state.js";
import type { Domain, Sensor, SensorHealth } from "./types.js";
import {
  atomicWritePrivateFile,
  ensurePrivateDirectory,
  readPrivateText,
} from "./privateFiles.js";

export const BROKER_PROTOCOL_VERSION = 1;
export { brokerProcessEnv, INTERNAL_BROKER_FLAG };
const ALL_DOMAINS: Domain[] = ["screen", "user", "environment", "schedule"];
const MAX_MESSAGE_BYTES = 128 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_SOCKET_STALE_MS = 10_000;
const DEFAULT_IDLE_SHUTDOWN_MS = 30_000;

interface BrokerRequest {
  id: string;
  method: "ping" | "context";
  params?: unknown;
}

interface BrokerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

class BrokerRequestError extends Error {}
class BrokerRequestTimeoutError extends Error {}

export interface BrokerMetrics {
  connected_clients: number;
  total_connections: number;
  context_requests: number;
  sensor_health: Record<string, SensorHealth>;
}

export interface BrokerServerOptions {
  socketPath: string;
  sensors: Sensor[];
  privacyConfig: PrivacyConfig | (() => PrivacyConfig | Promise<PrivacyConfig>);
  daemonOptions?: DaemonOptions;
  idleShutdownMs?: number;
  staleSocketMs?: number;
}

export interface BrokerClientOptions {
  requestTimeoutMs?: number;
  recover?: () => Promise<void>;
}

export interface ConnectSenseBrokerOptions {
  socketPath?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  lockStaleMs?: number;
  startBroker?: (socketPath: string) => Promise<void>;
}

interface BrokerOwnerMetadata {
  protocol_version: number;
  pid: number;
  started_at: string;
  token: string;
  socket_dev: number;
  socket_ino: number;
}

export function brokerOwnerPath(socketPath: string): string {
  return `${socketPath}.owner.json`;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function readOwner(socketPath: string): Promise<BrokerOwnerMetadata | undefined> {
  try {
    const value = JSON.parse(
      await readPrivateText(brokerOwnerPath(socketPath), 4_096),
    ) as BrokerOwnerMetadata;
    if (
      value.protocol_version !== BROKER_PROTOCOL_VERSION ||
      typeof value.pid !== "number" ||
      typeof value.token !== "string" ||
      typeof value.socket_dev !== "number" ||
      typeof value.socket_ino !== "number"
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function uniqueDomains(value: unknown): Domain[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set<Domain>(ALL_DOMAINS);
  const domains = value.filter((item): item is Domain => allowed.has(item as Domain));
  if (domains.length !== value.length) throw new Error("invalid context domains");
  return [...new Set(domains)];
}

function contextRequest(value: unknown): ContextRequest {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid context request");
  }
  const body = value as Record<string, unknown>;
  const domains = uniqueDomains(body.domains);
  const refresh = body.refresh ?? "cached";
  if (refresh !== "cached" && refresh !== "if_stale" && refresh !== "force") {
    throw new Error("invalid refresh mode");
  }
  const maxStaleness = body.max_staleness_ms;
  if (
    maxStaleness !== undefined &&
    (typeof maxStaleness !== "number" || !Number.isFinite(maxStaleness) || maxStaleness < 0)
  ) {
    throw new Error("invalid max_staleness_ms");
  }
  return {
    ...(domains ? { domains } : {}),
    refresh,
    ...(typeof maxStaleness === "number"
      ? { max_staleness_ms: Math.min(maxStaleness, 10 * 60_000) }
      : {}),
  };
}

function diagnosticStatus(state: SensorHealth["state"]): ContextDiagnostic["status"] {
  if (state === "healthy" || state === "idle") return "healthy";
  if (state === "unavailable" || state === "stopped") return "unavailable";
  return "degraded";
}

function brokerHealth(health: Map<string, SensorHealth>): ContextProviderHealth {
  const values = [...health.values()];
  const diagnostics: ContextDiagnostic[] = values
    .filter((sensor) => sensor.state !== "healthy" && sensor.state !== "idle")
    .map((sensor) => ({
      component: sensor.name,
      status: diagnosticStatus(sensor.state),
      message:
        sensor.diagnostic?.detail ??
        `${sensor.state}; samples=${sensor.sample_count}; availability_checks=${sensor.availability_checks}`,
      last_success_at: sensor.last_success_at,
      latency_ms: sensor.latency_ms,
    }));
  const status: ContextProviderHealth["status"] = values.some(
    (sensor) => sensor.state === "initializing",
  )
    ? "initializing"
    : values.some((sensor) => sensor.state === "degraded" || sensor.state === "backing_off")
      ? "degraded"
      : values.length > 0 && values.every((sensor) => sensor.state === "unavailable" || sensor.state === "stopped")
        ? "unavailable"
        : "healthy";

  return {
    status,
    source: "broker",
    checked_at: new Date().toISOString(),
    diagnostics,
  };
}

/** The authoritative local sensor process. MCP adapters never instantiate this unless elected. */
export class BrokerServer {
  private readonly store = new StateStore();
  private readonly daemon: Daemon;
  private server?: Server;
  private sockets = new Set<Socket>();
  private started = false;
  private closing = false;
  private totalConnections = 0;
  private contextRequests = 0;
  private socketIdentity?: { dev: number; ino: number };
  private readonly ownerToken = randomUUID();
  private idleTimer?: NodeJS.Timeout;
  private closePromise?: Promise<void>;
  private closedPromise: Promise<void>;
  private resolveClosed!: () => void;

  constructor(private readonly options: BrokerServerOptions) {
    this.daemon = new Daemon(this.store, options.sensors, options.daemonOptions);
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.closing = false;
    this.closePromise = undefined;
    await this.bindPrivateSocket();
    this.started = true;
    try {
      await this.daemon.start();
    } catch (error) {
      await this.close();
      throw error;
    }
    this.scheduleIdleShutdown();
  }

  metrics(): BrokerMetrics {
    return {
      connected_clients: this.sockets.size,
      total_connections: this.totalConnections,
      context_requests: this.contextRequests,
      sensor_health: Object.fromEntries(this.daemon.health()),
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  waitUntilClosed(): Promise<void> {
    return this.closedPromise;
  }

  private async performClose(): Promise<void> {
    this.closing = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    await this.daemon.stop();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    const preservedPath = await this.preserveForeignSocketPath();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (preservedPath) {
      const current = await lstat(this.options.socketPath).catch(() => undefined);
      if (!current) {
        await rename(preservedPath, this.options.socketPath);
      }
    }
    await this.unlinkOwnedSocket();
    this.started = false;
    this.resolveClosed();
  }

  private async bindPrivateSocket(): Promise<void> {
    const directory = path.dirname(this.options.socketPath);
    await ensurePrivateDirectory(directory);

    const bind = async (): Promise<Server> => {
      const server = createServer((socket) => this.accept(socket));
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(this.options.socketPath, () => {
          server.off("error", onError);
          resolve();
        });
      });
      return server;
    };

    try {
      this.server = await bind();
    } catch (error) {
      if (errorCode(error) !== "EADDRINUSE") throw error;
      if (await probeBroker(this.options.socketPath, 250)) {
        throw new Error("Sense broker is already running");
      }
      await this.removeProvenStaleSocket();
      this.server = await bind();
    }
    await chmod(this.options.socketPath, 0o600);
    const identity = await lstat(this.options.socketPath);
    this.socketIdentity = { dev: identity.dev, ino: identity.ino };
    await this.writeOwnerMetadata(identity.dev, identity.ino);
  }

  private accept(socket: Socket): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.sockets.add(socket);
    this.totalConnections += 1;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        socket.destroy(new Error("broker request too large"));
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) void this.handleLine(socket, line);
      }
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.scheduleIdleShutdown();
    });
    socket.on("error", () => undefined);
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let id = "unknown";
    try {
      const request = JSON.parse(line) as Partial<BrokerRequest>;
      if (typeof request.id !== "string" || typeof request.method !== "string") {
        throw new Error("invalid broker request");
      }
      id = request.id;
      if (request.method === "ping") {
        this.send(socket, {
          id,
          ok: true,
          result: { protocol_version: BROKER_PROTOCOL_VERSION },
        });
        return;
      }
      if (request.method !== "context") throw new Error("unknown broker method");
      this.contextRequests += 1;
      const result = await this.getContext(contextRequest(request.params));
      this.send(socket, { id, ok: true, result });
    } catch (error) {
      this.send(socket, {
        id,
        ok: false,
        error: error instanceof Error ? error.message : "broker request failed",
      });
    }
  }

  private send(socket: Socket, response: BrokerResponse): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
  }

  private async getContext(request: ContextRequest): Promise<ContextResult> {
    const domains = request.domains ?? ALL_DOMAINS;
    const refresh = request.refresh ?? "cached";
    let refreshedDomains: Domain[] = [];
    if (refresh !== "cached") {
      refreshedDomains = await this.daemon.refreshDomains(
        domains,
        refresh,
        request.max_staleness_ms,
      );
    }
    const configuredPrivacy =
      typeof this.options.privacyConfig === "function"
        ? await this.options.privacyConfig()
        : this.options.privacyConfig;
    const privacy = computePrivacy(
      this.options.sensors,
      this.daemon.status(),
      configuredPrivacy,
    );
    enforcePrivacyRevocations(this.store, privacy);
    return {
      frame: buildFrame(this.store, request.domains, Date.now(), privacy),
      health: brokerHealth(this.daemon.health()),
      refreshed_domains: refreshedDomains,
    };
  }

  private scheduleIdleShutdown(): void {
    if (this.closing || this.sockets.size > 0) return;
    const delay = this.options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    if (delay <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), delay);
    this.idleTimer.unref?.();
  }

  private async writeOwnerMetadata(dev: number, ino: number): Promise<void> {
    const ownerPath = brokerOwnerPath(this.options.socketPath);
    const metadata: BrokerOwnerMetadata = {
      protocol_version: BROKER_PROTOCOL_VERSION,
      pid: process.pid,
      started_at: new Date().toISOString(),
      token: this.ownerToken,
      socket_dev: dev,
      socket_ino: ino,
    };
    await atomicWritePrivateFile(ownerPath, `${JSON.stringify(metadata)}\n`, {
      maxBytes: 4_096,
    });
  }

  private async removeProvenStaleSocket(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await probeBroker(this.options.socketPath, 250)) {
        throw new Error("Sense broker became reachable during stale-socket verification");
      }
      if (attempt < 2) await sleep(25);
    }

    const identity = await lstat(this.options.socketPath).catch(() => undefined);
    if (!identity) return;
    const owner = await readOwner(this.options.socketPath);
    if (owner) {
      if (processIsAlive(owner.pid)) {
        throw new Error(`Sense broker socket is owned by a live process (${owner.pid})`);
      }
      if (owner.socket_dev !== identity.dev || owner.socket_ino !== identity.ino) {
        throw new Error("Sense broker socket identity does not match stale owner metadata");
      }
    } else {
      const staleAfter = this.options.staleSocketMs ?? DEFAULT_SOCKET_STALE_MS;
      if (Date.now() - identity.mtimeMs < staleAfter) {
        throw new Error("Sense broker socket is unresponsive but not old enough to prove stale");
      }
    }

    await unlink(this.options.socketPath);
    await unlink(brokerOwnerPath(this.options.socketPath)).catch(() => undefined);
  }

  private async unlinkOwnedSocket(): Promise<void> {
    const owner = await readOwner(this.options.socketPath);
    const identity = await lstat(this.options.socketPath).catch(() => undefined);
    if (
      owner?.token === this.ownerToken &&
      identity &&
      this.socketIdentity &&
      identity.dev === this.socketIdentity.dev &&
      identity.ino === this.socketIdentity.ino
    ) {
      await unlink(this.options.socketPath).catch(() => undefined);
    }
    if (owner?.token === this.ownerToken) {
      await unlink(brokerOwnerPath(this.options.socketPath)).catch(() => undefined);
    }
  }

  /** Node unlinks a Unix socket path on close; move a replaced inode aside first. */
  private async preserveForeignSocketPath(): Promise<string | undefined> {
    const identity = await lstat(this.options.socketPath).catch(() => undefined);
    if (
      !identity ||
      !this.socketIdentity ||
      (identity.dev === this.socketIdentity.dev && identity.ino === this.socketIdentity.ino)
    ) {
      return undefined;
    }
    const preserved = `${this.options.socketPath}.preserved-${this.ownerToken}`;
    await rename(this.options.socketPath, preserved);
    return preserved;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Async ContextProvider backed by the authoritative per-user broker. */
export class BrokerClient implements ContextProvider {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private buffer = "";
  private pending = new Map<string, PendingRequest>();
  private explicitlyClosed = false;
  private readonly requestTimeoutMs: number;

  private constructor(
    private readonly socketPath: string,
    private readonly recover?: () => Promise<void>,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.requestTimeoutMs = requestTimeoutMs;
  }

  static async connect(
    socketPath: string,
    options: BrokerClientOptions = {},
  ): Promise<BrokerClient> {
    const client = new BrokerClient(socketPath, options.recover, options.requestTimeoutMs);
    await client.ensureConnected();
    const ping = (await client.request("ping", undefined, false)) as {
      protocol_version?: number;
    };
    if (ping.protocol_version !== BROKER_PROTOCOL_VERSION) {
      await client.close();
      throw new Error("incompatible Sense broker protocol");
    }
    return client;
  }

  async getContext(request: ContextRequest = {}): Promise<ContextResult> {
    return (await this.request("context", request, true)) as ContextResult;
  }

  async close(): Promise<void> {
    this.explicitlyClosed = true;
    const socket = this.socket;
    this.socket = undefined;
    if (!socket || socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.once("close", resolve);
      socket.end();
    });
  }

  private async request(method: BrokerRequest["method"], params: unknown, retry: boolean): Promise<unknown> {
    try {
      return await this.requestOnce(method, params);
    } catch (error) {
      if (
        !retry ||
        this.explicitlyClosed ||
        !this.recover ||
        error instanceof BrokerRequestError ||
        error instanceof BrokerRequestTimeoutError
      ) {
        throw error;
      }
      this.socket?.destroy();
      this.socket = undefined;
      await this.recover();
      return this.requestOnce(method, params);
    }
  }

  private async requestOnce(method: BrokerRequest["method"], params: unknown): Promise<unknown> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Sense broker is disconnected");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrokerRequestTimeoutError(`Sense broker request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ id, method, params } satisfies BrokerRequest)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private ensureConnected(): Promise<void> {
    if (this.explicitlyClosed) return Promise.reject(new Error("Sense broker client is closed"));
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        this.attach(socket);
        resolve();
      });
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (this.socket === socket) this.receive(chunk);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.rejectPending(new Error("Sense broker connection closed"));
      }
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES) {
      this.socket?.destroy(new Error("broker response too large"));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let response: BrokerResponse;
      try {
        response = JSON.parse(line) as BrokerResponse;
      } catch {
        this.socket?.destroy(new Error("invalid broker response"));
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new BrokerRequestError(response.error || "broker request failed"));
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function defaultBrokerSocketPath(): string {
  const uid = process.getuid?.() ?? "user";
  return process.env.SENSE_BROKER_SOCKET || path.join(os.tmpdir(), `sense-mcp-${uid}`, "broker-v1.sock");
}

async function probeBroker(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const id = randomUUID();
    let buffer = "";
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.once("error", () => finish(false));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, method: "ping" })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        finish(false);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as BrokerResponse;
        const result = response.result as { protocol_version?: number } | undefined;
        finish(
          response.id === id &&
            response.ok === true &&
            result?.protocol_version === BROKER_PROTOCOL_VERSION,
        );
      } catch {
        finish(false);
      }
    });
  });
}

async function staleLock(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

async function ensureBroker(options: Required<Pick<ConnectSenseBrokerOptions, "socketPath" | "startupTimeoutMs" | "lockStaleMs">> & {
  startBroker: (socketPath: string) => Promise<void>;
}): Promise<void> {
  if (await probeBroker(options.socketPath, 250)) return;
  const directory = path.dirname(options.socketPath);
  await ensurePrivateDirectory(directory);
  const lockPath = `${options.socketPath}.lock`;
  const deadline = Date.now() + options.startupTimeoutMs;

  while (Date.now() < deadline) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await writeFile(
        handle,
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
      );
      if (await probeBroker(options.socketPath, 250)) return;
      await options.startBroker(options.socketPath);
      while (Date.now() < deadline) {
        if (await probeBroker(options.socketPath, 250)) return;
        await sleep(20);
      }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (await staleLock(lockPath, options.lockStaleMs)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
    } finally {
      await handle?.close().catch(() => undefined);
      if (handle) await unlink(lockPath).catch(() => undefined);
    }
    await sleep(20);
    if (await probeBroker(options.socketPath, 250)) return;
  }
  throw new Error(`Sense broker did not become ready within ${options.startupTimeoutMs}ms`);
}

/** Connect to the shared broker, safely electing/spawning one leader when needed. */
export async function connectSenseBroker(
  input: ConnectSenseBrokerOptions = {},
): Promise<BrokerClient> {
  const options = {
    socketPath: input.socketPath ?? defaultBrokerSocketPath(),
    startupTimeoutMs: input.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    requestTimeoutMs: input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    lockStaleMs: input.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
    startBroker: input.startBroker ?? spawnDetachedBroker,
  };
  let recovery: Promise<void> | undefined;
  const recover = () => {
    recovery ??= ensureBroker(options).finally(() => {
      recovery = undefined;
    });
    return recovery;
  };
  await recover();
  return BrokerClient.connect(options.socketPath, {
    requestTimeoutMs: options.requestTimeoutMs,
    recover,
  });
}

/** Run the elected broker process until terminated. Intended only for index.ts. */
export async function runBrokerProcess(options: BrokerServerOptions): Promise<void> {
  const server = new BrokerServer(options);
  await server.start();
  const signal = new Promise<"signal">((resolve) => {
    process.once("SIGINT", () => resolve("signal"));
    process.once("SIGTERM", () => resolve("signal"));
  });
  const reason = await Promise.race([
    signal,
    server.waitUntilClosed().then(() => "idle" as const),
  ]);
  if (reason === "signal") await server.close();
}
