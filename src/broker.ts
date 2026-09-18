import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
const DEFAULT_PROBE_TIMEOUT_MS = 250;
const PROCESS_LOOKUP_TIMEOUT_MS = 2_000;
/** `ps` reports whole seconds, and the owner record is written after the fork. */
const PROCESS_START_TOLERANCE_MS = 2_000;
/**
 * A forward step of the wall clock moves the derived boot time without moving
 * any recorded start time, which would make a live owner look pre-boot. Only
 * the `ps`-unavailable fallback depends on that estimate, so a generous margin
 * costs nothing but the delay before a post-reboot record is proven stale.
 */
const CLOCK_STEP_TOLERANCE_MS = 5 * 60_000;
/**
 * How long an owner record that cannot be interpreted at all keeps protecting
 * its socket. The record is the only evidence that identifies a live owner, so
 * losing it has to make the socket *more* protected — but not forever, because
 * a corrupt record would otherwise wedge every future election until a human
 * deleted a file they do not know about.
 */
const DEFAULT_OWNER_QUARANTINE_MS = 60_000;
/**
 * Every refusal to remove a socket is a refusal to start, so each one has to
 * name the command that clears the state it is refusing over. `sense-mcp broker
 * reset` removes the socket, owner record, lock, and preserved copies, but only
 * once nothing answers the socket — so it is safe to suggest unconditionally.
 */
const BROKER_WEDGE_ESCAPE_HATCH =
  "Quit the MCP clients using Sense, then run `sense-mcp broker reset` to clear the stale runtime files.";
/** One recover-and-retry, exactly like the warm request path. */
const CONNECT_ATTEMPTS = 2;
/**
 * Bounds establishing the socket itself, on every connection this client makes
 * — the session's first one and every reconnect a later request triggers. A
 * listener with a saturated backlog neither completes the connection nor
 * reports an error, and no request timer is running yet.
 */
export const BROKER_CONNECT_TIMEOUT_MS = 2_000;
/**
 * Bounds only the `ping` reply that opens a session. A broker answers `ping`
 * without touching a sensor, so a peer that accepts the connection and stays
 * quiet past this is wedged, not slow. Bounding the handshake keeps a wedged
 * broker from holding every adapter for the full request timeout before the
 * recover/elect path runs.
 *
 * The two are separate on purpose: establishment applies to every request that
 * has to reconnect, the handshake only to `connect`. Worst case for `connect`
 * is therefore BROKER_CONNECT_TIMEOUT_MS + BROKER_HANDSHAKE_TIMEOUT_MS per
 * attempt, and CONNECT_ATTEMPTS of those.
 */
export const BROKER_HANDSHAKE_TIMEOUT_MS = 2_000;
/**
 * `end()` waits for the peer's FIN. A half-open peer never sends one, so the
 * graceful drain is bounded and then the socket is destroyed outright.
 */
const CLOSE_DRAIN_TIMEOUT_MS = 250;

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
  ownerQuarantineMs?: number;
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

const runProcessLookup = promisify(execFile);

/**
 * Derived from the wall clock, because `os.uptime()` is monotonic but
 * `started_at` is a wall-clock stamp: the two can only be compared in wall-clock
 * terms. A forward step of the clock therefore moves this estimate forward
 * without moving any recorded start time, which is why callers must tolerate
 * CLOCK_STEP_TOLERANCE_MS of drift before treating a record as pre-boot.
 */
function bootTimeMs(): number {
  return Date.now() - os.uptime() * 1_000;
}

/**
 * Start time of a live pid, or undefined when it cannot be read. The command is
 * matched only to confirm a well-formed `ps` line: Sense runs under whatever
 * binary the host launched — a version manager's shim, a wrapper script, an
 * embedded runtime — so the executable's *name* is never evidence about a pid.
 */
async function currentProcess(pid: number): Promise<{ startedAtMs: number } | undefined> {
  try {
    const { stdout } = await runProcessLookup("/bin/ps", ["-o", "lstart=,comm=", "-p", String(pid)], {
      timeout: PROCESS_LOOKUP_TIMEOUT_MS,
    });
    const match = stdout
      .trim()
      .match(/^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+\S.*$/);
    if (!match) return undefined;
    const startedAtMs = Date.parse(match[1].replace(/\s+/g, " "));
    if (!Number.isFinite(startedAtMs)) return undefined;
    return { startedAtMs };
  } catch {
    return undefined;
  }
}

/**
 * What can be proven about a recorded broker owner.
 *
 * - `stale`: the recorded process is provably gone, so its socket is removable.
 * - `live`: the pid is alive and its start time is consistent with the record,
 *   which is as close to "this is still the broker" as a pid can get.
 * - `unknown`: neither could be established. Nothing is removed on an unknown,
 *   but an unknown that never resolves is a permanent wedge, so the caller
 *   bounds how long it protects the socket.
 */
type OwnerLiveness = "live" | "stale" | "unknown";

/**
 * Prove — or refuse to prove — that a recorded broker owner is gone.
 * `process.kill(pid, 0)` alone is not enough: it reports a recycled pid and an
 * EPERM pid owned by somebody else as live forever. The only identity evidence
 * that holds is time: a broker starts before it writes its record, so a pid
 * that started after the record was written is not the process that wrote it.
 */
async function pidLiveness(
  pid: number,
  startedAt: string | undefined,
  recordWrittenAtMs?: number,
): Promise<OwnerLiveness> {
  if (!processIsAlive(pid)) return "stale";
  const recordedAtMs = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  // `ps` is the only source that does not go through the wall clock twice, so
  // it decides whenever it answers.
  const current = await currentProcess(pid);
  if (!Number.isFinite(recordedAtMs)) {
    // The record names no start time it can be checked against. The mtime of
    // the record itself is a weaker but real substitute: it cannot prove the
    // pid *is* the owner, only that a younger pid cannot be.
    if (
      current &&
      recordWrittenAtMs !== undefined &&
      current.startedAtMs > recordWrittenAtMs + PROCESS_START_TOLERANCE_MS
    ) {
      return "stale";
    }
    return "unknown";
  }
  if (current) {
    return current.startedAtMs > recordedAtMs + PROCESS_START_TOLERANCE_MS ? "stale" : "live";
  }
  // `ps` could not answer, so fall back to boot time: a record written before
  // this boot cannot describe any process running now. The estimate moves with
  // the wall clock, so a record only counts as pre-boot once it predates the
  // estimate by more than a tolerated clock step.
  return recordedAtMs < bootTimeMs() - CLOCK_STEP_TOLERANCE_MS ? "stale" : "live";
}

function ownerLiveness(
  owner: BrokerOwnerMetadata,
  recordWrittenAtMs?: number,
): Promise<OwnerLiveness> {
  return pidLiveness(owner.pid, owner.started_at, recordWrittenAtMs);
}

/** Every variant carries `writtenAtMs`: it starts the quarantine clock, and it
 * is the only start-time reference available when a record names none. */
type BrokerOwnerRecord =
  | { state: "absent" }
  /** Readable, but written by a broker speaking another protocol version. */
  | { state: "foreign"; pid: number; started_at?: string; writtenAtMs?: number }
  /** No interpretable owner at all. */
  | { state: "unusable"; writtenAtMs?: number }
  | { state: "present"; owner: BrokerOwnerMetadata; writtenAtMs?: number };

function ownerRecordWrittenAtMs(socketPath: string): Promise<number | undefined> {
  return lstat(brokerOwnerPath(socketPath)).then(
    (entry) => entry.mtimeMs,
    () => undefined,
  );
}

/**
 * A record that exists but cannot be trusted has to make its owner *more*
 * protected, never less: collapsing it to "no owner" would hand the socket to
 * the mtime rule, which cannot tell a live broker from an abandoned path. How
 * much more depends on how much of the record survived:
 *
 * - a record from another protocol version still names a pid, so its owner is
 *   protected for exactly as long as that pid is alive — no time bound needed;
 * - a record that cannot be parsed at all names nothing, so its socket is
 *   quarantined rather than protected forever (see DEFAULT_OWNER_QUARANTINE_MS).
 */
async function readOwnerRecord(socketPath: string): Promise<BrokerOwnerRecord> {
  let text: string;
  try {
    text = await readPrivateText(brokerOwnerPath(socketPath), 4_096);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "absent" };
    return { state: "unusable", writtenAtMs: await ownerRecordWrittenAtMs(socketPath) };
  }
  const writtenAtMs = await ownerRecordWrittenAtMs(socketPath);
  let value: BrokerOwnerMetadata;
  try {
    value = JSON.parse(text) as BrokerOwnerMetadata;
  } catch {
    return { state: "unusable", writtenAtMs };
  }
  if (typeof value !== "object" || value === null || typeof value.pid !== "number") {
    return { state: "unusable", writtenAtMs };
  }
  if (value.protocol_version !== BROKER_PROTOCOL_VERSION) {
    // The pid is the one field whose meaning cannot change between versions.
    // Nothing else in a foreign record — least of all the socket identity — is
    // safe to interpret, so liveness alone decides.
    return {
      state: "foreign",
      pid: value.pid,
      ...(typeof value.started_at === "string" ? { started_at: value.started_at } : {}),
      writtenAtMs,
    };
  }
  if (
    typeof value.token !== "string" ||
    typeof value.socket_dev !== "number" ||
    typeof value.socket_ino !== "number"
  ) {
    return { state: "unusable", writtenAtMs };
  }
  // `started_at` is deliberately not required here: a record without one still
  // names a pid, and `ownerLiveness` reports that as unknown rather than stale.
  // Rejecting the record instead would lose the pid entirely.
  return { state: "present", owner: value, writtenAtMs };
}

async function readOwner(socketPath: string): Promise<BrokerOwnerMetadata | undefined> {
  const record = await readOwnerRecord(socketPath);
  return record.state === "present" ? record.owner : undefined;
}

/**
 * Split a newline-delimited read into whole messages.
 *
 * The wire limit bounds a *message*, which is what the broker's own response
 * guard enforces. A reader that bounds its buffer instead rejects a read that
 * happens to carry several legal messages — the peer sees a bare disconnect,
 * which is indistinguishable from a broker that died, so it elects a
 * replacement and walks back into the same read. Both directions therefore
 * measure the same unit: each complete line, and whatever incomplete line is
 * still accumulating.
 */
function readFramedMessages(buffer: string): { lines: string[]; rest: string; oversized: boolean } {
  const lines: string[] = [];
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf("\n");
    if (newline < 0) break;
    const line = rest.slice(0, newline);
    rest = rest.slice(newline + 1);
    if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) return { lines, rest, oversized: true };
    if (line.trim()) lines.push(line);
  }
  return { lines, rest, oversized: Buffer.byteLength(rest) > MAX_MESSAGE_BYTES };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Every timer on the election and stale-socket paths is unref'd, so without one
 * ref'd handle the event loop can empty and the process exit 0 with no output
 * before the failure is ever reported to the caller.
 */
async function withEventLoopKeepAlive<T>(run: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    return await run();
  } finally {
    clearInterval(keepAlive);
  }
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
    // The elected broker child reaches this before it owns any ref'd handle;
    // a bind failure must surface as an error, not as a silent exit 0.
    await withEventLoopKeepAlive(() => this.bindPrivateSocket());
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
      // `link` is atomic and fails with EEXIST, so a successor that claimed the
      // path while this broker was closing is never clobbered.
      const restored = await link(preservedPath, this.options.socketPath).then(
        () => true,
        (error) => errorCode(error) === "EEXIST",
      );
      // Any other failure leaves this copy as the only surviving reference to
      // somebody else's socket; leaking a file is cheaper than destroying it,
      // and `sense-mcp broker reset` removes preserved copies.
      if (restored) await unlink(preservedPath).catch(() => undefined);
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
      if (await probeBrokerSocket(this.options.socketPath, 250)) {
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
    // The listener stays bound for the filesystem work in performClose; a client
    // adopted here would lose its broker seconds later without electing one.
    if (this.closing) {
      socket.destroy();
      return;
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.sockets.add(socket);
    this.totalConnections += 1;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      const framed = readFramedMessages(buffer + chunk);
      buffer = framed.rest;
      if (framed.oversized) {
        socket.destroy(new Error("broker request too large"));
        return;
      }
      for (const line of framed.lines) void this.handleLine(socket, line);
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
        if (this.closing) {
          this.send(socket, { id, ok: false, error: "Sense broker is shutting down" });
          return;
        }
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
    if (socket.destroyed) return;
    const line = `${JSON.stringify(response)}\n`;
    const bytes = Buffer.byteLength(line);
    // A response past the wire limit trips the client's own guard, which
    // destroys the connection and reports a plain disconnect — indistinguishable
    // from a broker that died, so every adapter elects a replacement and walks
    // straight back into the same oversized frame. Refusing the request by name
    // keeps the connection and tells the caller what actually went wrong.
    if (bytes > MAX_MESSAGE_BYTES && response.ok) {
      socket.write(
        `${JSON.stringify({
          id: response.id,
          ok: false,
          error: `Sense broker response is ${bytes} bytes, past the ${MAX_MESSAGE_BYTES}-byte broker wire limit`,
        } satisfies BrokerResponse)}\n`,
      );
      return;
    }
    socket.write(line);
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
      if (await probeBrokerSocket(this.options.socketPath, 250)) {
        throw new Error("Sense broker became reachable during stale-socket verification");
      }
      if (attempt < 2) await sleep(25);
    }

    const identity = await lstat(this.options.socketPath).catch(() => undefined);
    if (!identity) return;
    const record = await readOwnerRecord(this.options.socketPath);
    if (record.state === "present") {
      const owner = record.owner;
      const liveness = await ownerLiveness(owner, record.writtenAtMs);
      if (liveness === "live") {
        throw new Error(
          `Sense broker socket is owned by a live process (${owner.pid}). ${BROKER_WEDGE_ESCAPE_HATCH}`,
        );
      }
      const identityMatches =
        owner.socket_dev === identity.dev && owner.socket_ino === identity.ino;
      if (liveness === "unknown" || !identityMatches) {
        // Either the record cannot be reconciled with its own pid, or it
        // describes a different socket than the one on disk. Neither proves a
        // live owner and neither proves a dead one, so the socket is protected
        // for the quarantine window and then falls back to the age rule.
        this.assertOwnerQuarantineElapsed(
          record.writtenAtMs,
          identity.mtimeMs,
          liveness === "unknown"
            ? `Sense broker owner (${owner.pid}) could not be proven live or gone`
            : "Sense broker socket identity does not match its owner record",
        );
        this.assertSocketOldEnough(identity.mtimeMs);
      }
    } else if (record.state === "foreign") {
      const liveness = await pidLiveness(record.pid, record.started_at, record.writtenAtMs);
      if (liveness === "live") {
        throw new Error(
          `Sense broker socket is owned by a live process (${record.pid}) speaking another protocol version. ${BROKER_WEDGE_ESCAPE_HATCH}`,
        );
      }
      if (liveness === "unknown") {
        this.assertOwnerQuarantineElapsed(
          record.writtenAtMs,
          identity.mtimeMs,
          `Sense broker owner (${record.pid}) speaking another protocol version could not be proven live or gone`,
        );
        this.assertSocketOldEnough(identity.mtimeMs);
      }
    } else if (record.state === "unusable") {
      this.assertOwnerQuarantineElapsed(
        record.writtenAtMs,
        identity.mtimeMs,
        "Sense broker owner record could not be read",
      );
      // The quarantine has run out: nothing identifies an owner, and the socket
      // has failed every probe above, so it falls back to the age rule.
      this.assertSocketOldEnough(identity.mtimeMs);
    } else {
      this.assertSocketOldEnough(identity.mtimeMs);
    }

    await unlink(this.options.socketPath);
    await unlink(brokerOwnerPath(this.options.socketPath)).catch(() => undefined);
  }

  private assertSocketOldEnough(mtimeMs: number): void {
    const staleAfter = this.options.staleSocketMs ?? DEFAULT_SOCKET_STALE_MS;
    if (Date.now() - mtimeMs < staleAfter) {
      throw new Error(
        `Sense broker socket is unresponsive but not old enough to prove stale. ${BROKER_WEDGE_ESCAPE_HATCH}`,
      );
    }
  }

  /**
   * An owner record that cannot prove its owner is gone protects the socket,
   * because removing a live broker's socket kills it out from under connected
   * clients. But protection with no bound is its own failure: it wedges every
   * future election on a file nobody knows about. So the socket is refused only
   * until both the record and the socket have been untouched for the quarantine
   * window, after which the wedge breaks on its own.
   */
  private assertOwnerQuarantineElapsed(
    writtenAtMs: number | undefined,
    socketMtimeMs: number,
    reason: string,
  ): void {
    const quarantineMs = this.options.ownerQuarantineMs ?? DEFAULT_OWNER_QUARANTINE_MS;
    const touchedAtMs = Math.max(writtenAtMs ?? 0, socketMtimeMs);
    const remainingMs = touchedAtMs + quarantineMs - Date.now();
    if (remainingMs > 0) {
      throw new Error(
        `${reason}; refusing to remove the socket for another ${Math.ceil(remainingMs / 1_000)}s. ${BROKER_WEDGE_ESCAPE_HATCH}`,
      );
    }
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
    // A broker that is shutting down still answers its listener for a few
    // milliseconds, so the first connection of a session gets the same bounded
    // recover-and-retry the warm request path already has.
    const attempts = options.recover ? CONNECT_ATTEMPTS : 1;
    let lastError: Error = new Error("Sense broker is unreachable");
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        client.socket?.destroy();
        client.socket = undefined;
        await options.recover?.();
      }
      let ping: { protocol_version?: number };
      try {
        ping = (await client.requestOnce(
          "ping",
          undefined,
          Math.min(client.requestTimeoutMs, BROKER_HANDSHAKE_TIMEOUT_MS),
        )) as { protocol_version?: number };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      if (ping.protocol_version !== BROKER_PROTOCOL_VERSION) {
        await client.close();
        throw new Error("incompatible Sense broker protocol");
      }
      return client;
    }
    await client.close();
    throw lastError;
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
      // A peer that accepted the connection and then stopped answering never
      // sends the FIN `end()` waits for; without this bound, closing a wedged
      // broker's socket would wedge the adapter too.
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, CLOSE_DRAIN_TIMEOUT_MS);
      timer.unref?.();
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
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

  private async requestOnce(
    method: BrokerRequest["method"],
    params: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Sense broker is disconnected");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrokerRequestTimeoutError(`Sense broker request timed out: ${method}`));
      }, timeoutMs);
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
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Sense broker connection timed out"));
      }, BROKER_CONNECT_TIMEOUT_MS);
      timer.unref?.();
      const onError = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        clearTimeout(timer);
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
    const framed = readFramedMessages(this.buffer + chunk);
    this.buffer = framed.rest;
    if (framed.oversized) {
      this.socket?.destroy(new Error("broker response too large"));
      return;
    }
    for (const line of framed.lines) {
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

/** True only when a broker on this protocol answered a ping and stayed healthy. */
export async function probeBrokerSocket(
  socketPath: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
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
    // A broker that drops the connection instead of answering is not healthy,
    // and waiting out the full timeout for it delays every election.
    socket.once("close", () => finish(false));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, method: "ping" })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      // The limit bounds one message, so only what is still accumulating
      // towards the first reply is measured against it.
      if (newline < 0) {
        if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) finish(false);
        return;
      }
      if (Buffer.byteLength(buffer.slice(0, newline)) > MAX_MESSAGE_BYTES) {
        finish(false);
        return;
      }
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

export interface BrokerResetResult {
  socketPath: string;
  reachable: boolean;
  removed: string[];
  failed: Array<{ path: string; reason: string }>;
}

async function preservedSocketPaths(socketPath: string): Promise<string[]> {
  const prefix = `${path.basename(socketPath)}.preserved-`;
  const names = await readdir(path.dirname(socketPath)).catch(() => []);
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(path.dirname(socketPath), name));
}

/**
 * Clear the runtime files of a broker that no longer answers, so an election
 * wedged by a stale record can be recovered without guessing at filenames.
 */
export async function resetBrokerRuntime(
  socketPath = defaultBrokerSocketPath(),
): Promise<BrokerResetResult> {
  const result: BrokerResetResult = { socketPath, reachable: false, removed: [], failed: [] };
  if (await probeBrokerSocket(socketPath, 500)) {
    result.reachable = true;
    return result;
  }
  const targets = [
    socketPath,
    brokerOwnerPath(socketPath),
    `${socketPath}.lock`,
    ...(await preservedSocketPaths(socketPath)),
  ];
  for (const target of targets) {
    try {
      await unlink(target);
      result.removed.push(target);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      result.failed.push({
        path: target,
        reason: error instanceof Error ? error.message : "could not be removed",
      });
    }
  }
  return result;
}

async function staleLock(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

type ElectBrokerOptions = Required<
  Pick<ConnectSenseBrokerOptions, "socketPath" | "startupTimeoutMs" | "lockStaleMs">
> & {
  startBroker: (socketPath: string) => Promise<void>;
};

async function ensureBroker(options: ElectBrokerOptions): Promise<void> {
  return withEventLoopKeepAlive(() => electBroker(options));
}

async function electBroker(options: ElectBrokerOptions): Promise<void> {
  if (await probeBrokerSocket(options.socketPath, 250)) return;
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
      if (await probeBrokerSocket(options.socketPath, 250)) return;
      await options.startBroker(options.socketPath);
      while (Date.now() < deadline) {
        if (await probeBrokerSocket(options.socketPath, 250)) return;
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
    if (await probeBrokerSocket(options.socketPath, 250)) return;
  }
  // The elected broker runs detached with no stdio, so whatever it refused to
  // do is invisible here; this is the only message a user sees.
  throw new Error(
    `Sense broker did not become ready within ${options.startupTimeoutMs}ms. ${BROKER_WEDGE_ESCAPE_HATCH}`,
  );
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
