import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSenseEnvFromToml } from "./cli.js";
import { listConsentReceipts } from "./consent.js";
import { loadSensePolicy, type PolicySnapshot } from "./policy.js";
import { readPanelRuntimes } from "./panelRuntime.js";
import { runCapture } from "./sensors/exec.js";

const DEFAULT_CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");
/** Last-resort macOS PATH: what launchd hands a GUI app that never had one set. Never assumed while a real one can be measured. */
const POSIX_HOST_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/**
 * Last-resort PATH anywhere else. launchd's stripped set is a macOS fact, not a portable one —
 * every other platform puts local installs on /usr/local/bin, and asserting the darwin constant
 * off-darwin would make doctor report helpers missing that are plainly present.
 */
const DEFAULT_HOST_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin";
const MAX_ANCESTRY_DEPTH = 12;

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  generated_at: string;
  checks: DoctorCheck[];
}

/** Where the PATH the MCP server will really run with was measured from, weakest last. */
export type HostPathSource =
  | "client_config"
  | "inherited"
  | "host_process"
  | "launchd"
  | "posix_default";

export interface HostAppPath {
  name: string;
  /** PATH read out of the running .app process, not assumed for it. */
  path: string;
}

export interface HostSearchPath {
  path: string;
  source: HostPathSource;
  /** Measured .app PATH, carried along when it is not the effective one. */
  app?: HostAppPath;
}

export interface CommandLookup {
  command: string;
  /** Resolvable on the PATH the MCP server itself will run with. */
  available: boolean;
  host_path?: string;
  host_path_source?: HostPathSource;
  resolved?: string;
  /** Only reachable through the PATH of the shell running doctor. */
  shell_only?: string;
  /** Resolves on the effective PATH but not inside the responsible .app's own measured PATH. */
  host_app_gap?: HostAppPath;
}

export type MacAuthorization =
  | "authorized"
  | "denied"
  | "restricted"
  | "not_determined"
  | "unknown";

export interface MacGrantSnapshot {
  screen_recording: "granted" | "not_granted" | "unknown";
  camera: MacAuthorization;
  microphone: MacAuthorization;
}

export interface ProcessAncestor {
  pid: number;
  command: string;
}

export interface ResponsibleApp {
  pid: number;
  name: string;
  path: string;
}

function line(status: DoctorStatus, name: string, detail: string, fix?: string): string {
  const base = `${status.toUpperCase()} ${name}: ${detail}`;
  return fix ? `${base}\n  Fix: ${fix}` : base;
}

export function renderDoctorReport(report: DoctorReport): string {
  return [
    "Sense Doctor",
    `generated_at: ${report.generated_at}`,
    "",
    ...report.checks.map((check) => line(check.status, check.name, check.detail, check.fix)),
  ].join("\n");
}

/**
 * Resolve `command` the way `which` does. The execute bit alone is not enough: every directory on
 * the PATH carries it, so `access(X_OK)` by itself hands back `/opt/homebrew/bin/ffmpeg` when that
 * is a *folder* and reports a helper that cannot be run. Require a regular file — stat follows
 * symlinks, so a Homebrew symlink into ../Cellar still resolves.
 */
async function executableOnPath(command: string, searchPath: string): Promise<string | undefined> {
  for (const entry of searchPath.split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, command);
    const isFile = await stat(candidate).then(
      (entryStat) => entryStat.isFile(),
      () => false,
    );
    if (!isFile) continue;
    const usable = await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (usable) return candidate;
  }
  return undefined;
}

function usablePath(value: string | undefined): value is string {
  return typeof value === "string" && value.includes("/");
}

/**
 * Pick the PATH the Sense server will really be started with. Every candidate is measured, never
 * assumed: the configured env PATH is what the client hands the server, and failing that doctor's
 * own environment is the one an MCP client started from this session passes on.
 */
export function resolveHostSearchPath(options: {
  /** env PATH of the sense entry in the MCP client configuration. */
  configuredPath?: string;
  /** PATH doctor itself inherited. */
  sessionPath?: string;
  /** PATH measured from the responsible .app process. */
  appPath?: HostAppPath;
  /** PATH launchd hands GUI processes, when it has one. */
  launchdPath?: string;
  /** Host platform, which decides the last-resort default. Defaults to the running one. */
  platform?: NodeJS.Platform;
}): HostSearchPath {
  const app = usablePath(options.appPath?.path) ? options.appPath : undefined;
  // A configured env PATH reaches the server whoever launches it, so the .app's own PATH stops mattering.
  if (usablePath(options.configuredPath)) {
    return { path: options.configuredPath, source: "client_config" };
  }
  if (usablePath(options.sessionPath)) {
    return { path: options.sessionPath, source: "inherited", ...(app ? { app } : {}) };
  }
  if (app) return { path: app.path, source: "host_process" };
  if (usablePath(options.launchdPath)) return { path: options.launchdPath, source: "launchd" };
  // Nothing measurable left, so the only honest guess is the platform's own default set.
  const platform = options.platform ?? process.platform;
  return {
    path: platform === "darwin" ? POSIX_HOST_PATH : DEFAULT_HOST_PATH,
    source: "posix_default",
  };
}

/** Pull PATH out of a `ps -E` environment dump; values may contain spaces, keys never do. */
export function pathFromProcessEnvironment(dump: string): string | undefined {
  const start = dump.search(/(?:^|\s)PATH=\//);
  if (start === -1) return undefined;
  const rest = dump.slice(dump.indexOf("PATH=", start) + "PATH=".length);
  const end = rest.search(/\s[A-Za-z_][A-Za-z0-9_]*=/);
  const value = (end === -1 ? rest : rest.slice(0, end)).trim();
  return usablePath(value) ? value : undefined;
}

/** macOS lets us read our own processes' environments, so the host app's PATH is a measurement. */
async function measureProcessPath(pid: number): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const result = await runCapture("/bin/ps", ["-wwEp", String(pid)], 2000);
  if (!result || result.exitCode !== 0 || !result.stdout) return undefined;
  return pathFromProcessEnvironment(result.stdout);
}

async function launchdSearchPath(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const result = await runCapture("/bin/launchctl", ["getenv", "PATH"], 2000);
  const value = result && result.exitCode === 0 ? result.stdout.trim() : "";
  return usablePath(value) ? value : undefined;
}

async function hostSearchPath(options: {
  configuredPath?: string;
  app?: ResponsibleApp;
}): Promise<HostSearchPath> {
  const measured = options.app ? await measureProcessPath(options.app.pid) : undefined;
  const appPath = options.app && measured ? { name: options.app.name, path: measured } : undefined;
  const sessionPath = process.env.PATH;
  // Only pay for launchctl when nothing better was measured.
  const launchdPath =
    usablePath(options.configuredPath) || usablePath(sessionPath) || appPath
      ? undefined
      : await launchdSearchPath();
  return resolveHostSearchPath({
    configuredPath: options.configuredPath,
    sessionPath,
    appPath,
    launchdPath,
  });
}

async function lookupCommand(command: string, host: HostSearchPath): Promise<CommandLookup> {
  const base: CommandLookup = {
    command,
    available: false,
    host_path: host.path,
    host_path_source: host.source,
  };
  const resolved = await executableOnPath(command, host.path);
  if (resolved) {
    const inApp = host.app ? await executableOnPath(command, host.app.path) : undefined;
    return {
      ...base,
      available: true,
      resolved,
      ...(host.app && !inApp ? { host_app_gap: host.app } : {}),
    };
  }
  const shellOnly = await executableOnPath(command, process.env.PATH ?? "");
  return shellOnly ? { ...base, shell_only: shellOnly } : base;
}

function asLookup(command: string, value: CommandLookup | boolean): CommandLookup {
  return typeof value === "boolean" ? { command, available: value } : value;
}

const HOST_PATH_SOURCE_LABEL: Record<HostPathSource, string> = {
  client_config: "sense entry env PATH",
  inherited: "PATH inherited by this session",
  host_process: "host app process PATH",
  launchd: "launchd user PATH",
  posix_default: "POSIX default PATH",
};

const MAX_RENDERED_PATH = 200;

/** An inherited PATH can run to thousands of characters; keep one report line readable. */
function summarizeSearchPath(value: string): string {
  if (value.length <= MAX_RENDERED_PATH) return value;
  const entries = value.split(path.delimiter).filter(Boolean);
  const head: string[] = [];
  for (const entry of entries) {
    if (head.join(path.delimiter).length + entry.length > MAX_RENDERED_PATH) break;
    head.push(entry);
  }
  return `${head.join(path.delimiter)}:... (${entries.length} entries)`;
}

function hostPathNote(lookup: CommandLookup): string {
  if (!lookup.host_path) return "";
  const source = HOST_PATH_SOURCE_LABEL[lookup.host_path_source ?? "posix_default"];
  return ` (MCP host PATH, ${source}: ${summarizeSearchPath(lookup.host_path)})`;
}

/**
 * A GUI .app is started by launchd with a stripped PATH — /usr/bin:/bin:/usr/sbin:/sbin on a stock
 * Mac — while doctor itself usually runs from a shell whose PATH carries /opt/homebrew/bin. When
 * both are true the helper resolves for doctor and is invisible to the server that .app spawns.
 * Reporting that as a pass with a parenthetical note was a regression: the gap is real, the user
 * cannot see it from the outside, and it is exactly what these checks exist to catch. It warns.
 */
function hostAppGapDetail(lookup: CommandLookup, gap: HostAppPath, consequence: string): string {
  const source = HOST_PATH_SOURCE_LABEL[lookup.host_path_source ?? "posix_default"];
  return (
    `found at ${lookup.resolved ?? lookup.command} on the ${source}, but ${gap.name} — the app that ` +
    `launches the Sense server — runs with PATH ${summarizeSearchPath(gap.path)}, which cannot ` +
    `resolve ${lookup.command}, so ${consequence}`
  );
}

/** Only an explicit env PATH closes a launchd gap; reinstalling the helper never does. */
function hostAppGapFix(lookup: CommandLookup, gap: HostAppPath): string {
  const directory = path.dirname(lookup.resolved ?? "");
  return (
    `Add ${directory} to the env PATH of the sense entry in your MCP client configuration ` +
    `(for example PATH=${directory}${path.delimiter}${POSIX_HOST_PATH}), then restart ${gap.name}. ` +
    `${gap.name} inherits its PATH from launchd, so reinstalling ${lookup.command} will not change this.`
  );
}

function shellOnlyFix(lookup: CommandLookup): string {
  return (
    `${lookup.command} is only on this shell's PATH. Add ${path.dirname(lookup.shell_only ?? "")} to the ` +
    "env PATH of the sense entry in your MCP client configuration, then restart the client."
  );
}

export function nodeVersionDoctorCheck(version = process.versions.node): DoctorCheck {
  const normalized = version.replace(/^v/, "");
  const major = Number(normalized.split(".", 1)[0]);
  const supported = Number.isInteger(major) && major >= 22;
  return {
    name: "Node.js",
    status: supported ? "pass" : "fail",
    detail: `v${normalized}`,
    fix: supported ? undefined : "Install Node.js 22 or newer, then restart the MCP client.",
  };
}

export function ffmpegDoctorCheck(
  ffmpeg: CommandLookup | boolean,
  policy: PolicySnapshot,
): DoctorCheck {
  const lookup = asLookup("ffmpeg", ffmpeg);
  const required = policy.valid && (policy.values.camera_snapshot || policy.values.mic_level);
  const enabledUses = [
    policy.values.camera_snapshot ? "camera snapshots" : undefined,
    policy.values.mic_level ? "mic-level sampling" : undefined,
  ].filter(Boolean).join(" and ");
  if (lookup.available) {
    const gap = required ? lookup.host_app_gap : undefined;
    if (gap) {
      return {
        name: "ffmpeg",
        status: "warn",
        detail: hostAppGapDetail(lookup, gap, `enabled ${enabledUses} will fail there`),
        fix: hostAppGapFix(lookup, gap),
      };
    }
    return {
      name: "ffmpeg",
      status: "pass",
      detail:
        `${lookup.resolved ? `available at ${lookup.resolved}` : "available"}${hostPathNote(lookup)}`,
    };
  }
  if (lookup.shell_only) {
    return {
      name: "ffmpeg",
      status: required ? "warn" : "pass",
      detail: required
        ? `found at ${lookup.shell_only} on this shell's PATH only, so enabled ${enabledUses} will fail under the MCP host${hostPathNote(lookup)}`
        : `found at ${lookup.shell_only} on this shell's PATH only; not required while camera snapshots and mic-level sampling are disabled`,
      fix: required ? shellOnlyFix(lookup) : undefined,
    };
  }
  return {
    name: "ffmpeg",
    status: required ? "fail" : "pass",
    detail: required
      ? `not found but required by enabled ${enabledUses}${hostPathNote(lookup)}`
      : "not found; not required while camera snapshots and mic-level sampling are disabled",
    fix: required ? "Install ffmpeg with Homebrew: brew install ffmpeg" : undefined,
  };
}

export function calendarProviderDoctorCheck(
  icalBuddy: CommandLookup | boolean,
  policy: PolicySnapshot,
): DoctorCheck {
  const lookup = asLookup("icalBuddy", icalBuddy);
  const required = policy.valid && policy.values.calendar;
  if (lookup.available) {
    const gap = required ? lookup.host_app_gap : undefined;
    if (gap) {
      return {
        name: "icalBuddy",
        status: "warn",
        detail: hostAppGapDetail(lookup, gap, "enabled Calendar context will fail there"),
        fix: hostAppGapFix(lookup, gap),
      };
    }
    return {
      name: "icalBuddy",
      status: "pass",
      detail:
        `${lookup.resolved ? `available at ${lookup.resolved}` : "available"} for coarse date-time-only calendar queries` +
        `${hostPathNote(lookup)}`,
    };
  }
  if (lookup.shell_only) {
    return {
      name: "icalBuddy",
      status: required ? "warn" : "pass",
      detail: required
        ? `found at ${lookup.shell_only} on this shell's PATH only, so enabled Calendar context will fail under the MCP host${hostPathNote(lookup)}`
        : `found at ${lookup.shell_only} on this shell's PATH only; optional while Calendar context is disabled`,
      fix: required ? shellOnlyFix(lookup) : undefined,
    };
  }
  return {
    name: "icalBuddy",
    status: required ? "fail" : "pass",
    detail: required
      ? `not found but required by enabled Calendar context${hostPathNote(lookup)}`
      : "not found; optional while Calendar context is disabled",
    fix: required
      ? "Install icalBuddy or disable Calendar context and use a direct calendar connector."
      : undefined,
  };
}

/**
 * macOS attributes a TCC grant to the outermost .app, which is the only one the user can grant in
 * System Settings. Helper bundles nested inside it (Claude Helper.app, a claude-code sidecar under
 * Application Support) are not grantable, so walk past them in both directions: take the leftmost
 * .app component of a path, and the farthest .app ancestor of the process tree.
 */
export function responsibleHostApp(
  ancestry: readonly ProcessAncestor[],
): ResponsibleApp | undefined {
  let outermost: ResponsibleApp | undefined;
  for (const ancestor of ancestry) {
    const match = ancestor.command.match(/^(.*?\/([^/]+)\.app)(?:\/|$)/);
    if (!match) continue;
    outermost = { pid: ancestor.pid, name: match[2], path: ancestor.command };
  }
  return outermost;
}

export function hostProcessDoctorCheck(app: ResponsibleApp | undefined): DoctorCheck {
  return {
    name: "Responsible host app",
    status: app ? "pass" : "warn",
    detail: app
      ? `${app.name} (pid ${app.pid}) at ${app.path}; macOS privacy grants are recorded against this app`
      : "no .app ancestor; macOS grants will be recorded against the terminal or launch agent that started this process",
    fix: app
      ? undefined
      : "Run sense-mcp doctor from the same app that launches the MCP server so the reported grants match it.",
  };
}

function grantDoctorCheck(
  name: string,
  required: boolean,
  disabledNote: string,
  state: string | undefined,
  granted: boolean,
  app: ResponsibleApp | undefined,
  settingsPane: string,
): DoctorCheck {
  const owner = app ? app.name : "the app that launches the MCP server";
  if (state === undefined || state === "unknown") {
    return {
      name,
      status: "warn",
      detail: `could not be read without prompting; assume it is ungranted for ${owner}`,
    };
  }
  if (!required) {
    return { name, status: "pass", detail: `${state} for ${owner}; ${disabledNote}` };
  }
  if (granted) return { name, status: "pass", detail: `${state} for ${owner}` };
  const pending = state === "not_determined";
  return {
    name,
    status: pending ? "warn" : "fail",
    detail: `${state} for ${owner}`,
    fix: pending
      ? `macOS will ask ${owner} the first time Sense captures. Approve that prompt, or pre-approve it under System Settings > Privacy & Security > ${settingsPane}.`
      : `Enable ${owner} under System Settings > Privacy & Security > ${settingsPane}, then restart it.`,
  };
}

/** Sense policy says what Sense will try; these say whether macOS will let it. */
export function macGrantDoctorChecks(
  policy: PolicySnapshot,
  grants: MacGrantSnapshot | undefined,
  app: ResponsibleApp | undefined,
): DoctorCheck[] {
  const enabled = (key: "camera_snapshot" | "mic_level" | "window_snapshot" | "full_screen_snapshot") =>
    policy.valid && policy.values[key];
  const screenRequired = enabled("window_snapshot") || enabled("full_screen_snapshot");
  return [
    grantDoctorCheck(
      "Screen recording grant (macOS)",
      screenRequired,
      "not required while window and full-screen snapshots are disabled",
      grants?.screen_recording,
      grants?.screen_recording === "granted",
      app,
      "Screen & System Audio Recording",
    ),
    grantDoctorCheck(
      "Camera grant (macOS)",
      enabled("camera_snapshot"),
      "not required while camera snapshots are disabled",
      grants?.camera,
      grants?.camera === "authorized",
      app,
      "Camera",
    ),
    grantDoctorCheck(
      "Microphone grant (macOS)",
      enabled("mic_level"),
      "not required while mic-level sampling is disabled",
      grants?.microphone,
      grants?.microphone === "authorized",
      app,
      "Microphone",
    ),
  ];
}

export function policyDoctorChecks(
  policy: PolicySnapshot,
  activeConsentReceipts: number | undefined,
  brokerReachable: boolean,
): DoctorCheck[] {
  const policyState = (enabled: boolean) => (enabled ? "enabled" : "disabled");
  // Sense policy alone never means macOS will allow the capture; the grant checks say that.
  const grantedState = (enabled: boolean) =>
    `${policyState(enabled)} in Sense policy; the macOS grant is a separate check`;
  return [
    {
      name: "Central policy",
      status: policy.valid ? "pass" : "fail",
      detail: policy.valid ? `loaded from ${policy.path}` : policy.error || "invalid; protected capabilities fail closed",
      fix: policy.valid
        ? undefined
        : "Repair or remove the unsafe policy file, then run sense-mcp doctor again.",
    },
    {
      name: "Shared broker",
      status: brokerReachable ? "pass" : "warn",
      detail: brokerReachable
        ? "reachable through private per-user IPC"
        : "not running or not reachable; it starts on demand with an MCP client",
    },
    {
      name: "Capture consent",
      status: activeConsentReceipts === undefined ? "warn" : "pass",
      detail:
        activeConsentReceipts === undefined
          ? "receipt store could not be inspected; capture authorization remains fail closed"
          : `local allow-once confirmation required; ${activeConsentReceipts} active short-lived receipt(s)`,
    },
    {
      name: "Calendar policy",
      status: "pass",
      detail: policyState(policy.valid && policy.values.calendar),
    },
    {
      name: "Location policy",
      status: "pass",
      detail: policyState(policy.valid && policy.values.location),
    },
    {
      name: "Mic level policy",
      status: "pass",
      detail: grantedState(policy.valid && policy.values.mic_level),
    },
    {
      name: "Camera snapshot policy",
      status: "pass",
      detail: grantedState(policy.valid && policy.values.camera_snapshot),
    },
    {
      name: "Window snapshot policy",
      status: "pass",
      detail: grantedState(policy.valid && policy.values.window_snapshot),
    },
    {
      name: "Full-screen snapshot policy",
      status: "pass",
      detail: grantedState(policy.valid && policy.values.full_screen_snapshot),
    },
    {
      name: "Raw title policy",
      status: "pass",
      detail: policyState(policy.valid && policy.values.raw_titles),
    },
    {
      name: "Model egress boundary",
      status: "pass",
      detail: "Sense controls local acquisition; the MCP client and model provider control onward transmission and retention.",
    },
  ];
}

async function readProcessAncestry(startPid = process.ppid): Promise<ProcessAncestor[]> {
  const ancestry: ProcessAncestor[] = [];
  let pid = startPid;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && pid > 1; depth += 1) {
    const result = await runCapture("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)], 2000);
    if (!result || result.exitCode !== 0 || !result.stdout) break;
    const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) break;
    ancestry.push({ pid, command: match[2].trim() });
    const parent = Number(match[1]);
    if (!Number.isSafeInteger(parent) || parent <= 1 || parent === pid) break;
    pid = parent;
  }
  return ancestry;
}

const MAC_GRANT_SCRIPT = `ObjC.import('Foundation');
function run() {
  var result = { screen_recording: 'unknown', camera: 'unknown', microphone: 'unknown' };
  try {
    ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
    result.screen_recording = $.CGPreflightScreenCaptureAccess() ? 'granted' : 'not_granted';
  } catch (error) { /* leave unknown */ }
  var names = ['not_determined', 'restricted', 'denied', 'authorized'];
  function status(mediaType) {
    try {
      var device = $.NSClassFromString($('AVCaptureDevice'));
      return names[device.authorizationStatusForMediaType($(mediaType))] || 'unknown';
    } catch (error) { return 'unknown'; }
  }
  result.camera = status('vide');
  result.microphone = status('soun');
  return JSON.stringify(result);
}`;

/**
 * Read the TCC state without prompting and without capturing anything:
 * CGPreflightScreenCaptureAccess and -authorizationStatusForMediaType: are both pure queries.
 * CGRequestScreenCaptureAccess is deliberately never called here.
 */
async function readMacGrants(): Promise<MacGrantSnapshot | undefined> {
  if (process.platform !== "darwin") return undefined;
  const result = await runCapture(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", MAC_GRANT_SCRIPT],
    4000,
  );
  if (!result || result.exitCode !== 0 || !result.stdout) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as Partial<MacGrantSnapshot>;
    const authorization = (value: unknown): MacAuthorization =>
      value === "authorized" || value === "denied" || value === "restricted" || value === "not_determined"
        ? value
        : "unknown";
    return {
      screen_recording:
        parsed.screen_recording === "granted" || parsed.screen_recording === "not_granted"
          ? parsed.screen_recording
          : "unknown",
      camera: authorization(parsed.camera),
      microphone: authorization(parsed.microphone),
    };
  } catch {
    return undefined;
  }
}

async function existingBrokerReachable(): Promise<boolean> {
  try {
    const { BrokerClient, defaultBrokerSocketPath } = await import("./broker.js");
    const client = await BrokerClient.connect(defaultBrokerSocketPath(), { requestTimeoutMs: 500 });
    await client.close();
    return true;
  } catch {
    return false;
  }
}

async function readable(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

async function runningPanelUrl(): Promise<string | undefined> {
  for (const runtime of await readPanelRuntimes()) {
    if (!processAlive(runtime.pid)) continue;
    const url = `http://127.0.0.1:${runtime.port}/`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (
        response.status === 403 &&
        response.headers.get("x-frame-options") === "DENY" &&
        response.headers.get("content-security-policy")?.includes("default-src 'none'")
      ) {
        return url;
      }
    } catch {
      // Try another live runtime receipt.
    } finally {
      clearTimeout(timeout);
    }
  }
  return undefined;
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function probeSensor(
  name: string,
  sensor: {
    sample: () => Promise<unknown[]>;
    diagnose?: () => { detail: string; fixHint?: string } | null;
  },
): Promise<DoctorCheck> {
  const observations = await sensor.sample();
  const diagnostic = sensor.diagnose?.();
  if (diagnostic || observations.length === 0) {
    return {
      name,
      status: "warn",
      detail: diagnostic?.detail ?? "not yielding observations",
      fix: diagnostic?.fixHint,
    };
  }

  return {
    name,
    status: "pass",
    detail: "yielding observations",
  };
}

export async function createDoctorReport(configPath = process.env.SENSE_CODEX_CONFIG || DEFAULT_CODEX_CONFIG): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  checks.push(nodeVersionDoctorCheck());

  checks.push({
    name: "Platform",
    status: process.platform === "darwin" ? "pass" : "warn",
    detail: process.platform,
    fix: process.platform === "darwin" ? undefined : "Most built-in sensors are macOS-first today.",
  });

  const hasConfig = await readable(configPath);
  checks.push({
    name: "Codex config",
    status: hasConfig ? "pass" : "warn",
    detail: hasConfig ? configPath : "not found",
    fix: hasConfig ? undefined : "Create a sense MCP block in ~/.codex/config.toml or set SENSE_CODEX_CONFIG.",
  });

  const configEnv: Record<string, string | undefined> = hasConfig
    ? await readFile(configPath, "utf8").then(parseSenseEnvFromToml).catch(() => ({}))
    : {};
  const env = { ...process.env, ...configEnv };
  const policy = await loadSensePolicy(env);
  const [activeConsentReceipts, brokerReachable] = await Promise.all([
    listConsentReceipts().then((receipts) => receipts.length).catch(() => undefined),
    existingBrokerReachable(),
  ]);
  checks.push(...policyDoctorChecks(policy, activeConsentReceipts, brokerReachable));

  const responsible = responsibleHostApp(await readProcessAncestry());
  checks.push(hostProcessDoctorCheck(responsible));
  if (process.platform === "darwin") {
    checks.push(...macGrantDoctorChecks(policy, await readMacGrants(), responsible));
  }

  // Resolve helpers on the PATH that will really be in effect: the configured env PATH first, so the
  // fix these checks print is one the user can actually follow.
  const hostPath = await hostSearchPath({ configuredPath: configEnv.PATH, app: responsible });
  const [ffmpeg, icalBuddy] = await Promise.all([
    lookupCommand("ffmpeg", hostPath),
    lookupCommand("icalBuddy", hostPath),
  ]);

  checks.push(ffmpegDoctorCheck(ffmpeg, policy));
  checks.push(calendarProviderDoctorCheck(icalBuddy, policy));
  checks.push({
    name: "Workspace roots",
    status: env.SENSE_WORKSPACE_ROOTS ? "pass" : "warn",
    detail: env.SENSE_WORKSPACE_ROOTS || "not configured",
    fix: env.SENSE_WORKSPACE_ROOTS ? undefined : "Run sense-mcp enable workspace /absolute/path/to/repo.",
  });

  const panel = await runningPanelUrl();
  checks.push({
    name: "Settings panel",
    status: panel ? "pass" : "warn",
    detail: panel ? `reachable at ${panel} via private runtime receipt` : "not running",
    fix: panel ? undefined : "Run sense-mcp settings --open to open the local settings panel.",
  });

  if (process.platform === "darwin") {
    await withEnv(env, async () => {
      const { audioLevelSensor } = await import("./sensors/audioLevel.js");
      const { focusModeSensor } = await import("./sensors/focusMode.js");
      const { ambientLightSensor } = await import("./sensors/ambientLight.js");
      const { calendarSensor } = await import("./sensors/calendar.js");

      if (policy.valid && policy.values.mic_level) {
        checks.push(await probeSensor("Mic level sensor", audioLevelSensor));
      }

      if (policy.valid && policy.values.calendar) {
        checks.push(await probeSensor("Calendar sensor", calendarSensor));
      }

      checks.push(await probeSensor("Focus mode sensor", focusModeSensor));
      checks.push(await probeSensor("Ambient light sensor", ambientLightSensor));
    });
  }

  return {
    generated_at: new Date().toISOString(),
    checks,
  };
}
