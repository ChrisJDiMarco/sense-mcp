import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSenseEnvFromToml } from "./cli.js";
import { listConsentReceipts } from "./consent.js";
import { loadSensePolicy, type PolicySnapshot } from "./policy.js";
import { readPanelRuntimes } from "./panelRuntime.js";
import { runCapture } from "./sensors/exec.js";

const DEFAULT_CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");

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

async function commandAvailable(command: string): Promise<boolean> {
  const result = await runCapture("which", [command], 2000);
  return Boolean(result && result.exitCode === 0 && result.stdout);
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

export function ffmpegDoctorCheck(hasFfmpeg: boolean, policy: PolicySnapshot): DoctorCheck {
  const required = policy.valid && (policy.values.camera_snapshot || policy.values.mic_level);
  const enabledUses = [
    policy.values.camera_snapshot ? "camera snapshots" : undefined,
    policy.values.mic_level ? "mic-level sampling" : undefined,
  ].filter(Boolean).join(" and ");
  return {
    name: "ffmpeg",
    status: hasFfmpeg || !required ? "pass" : "fail",
    detail: hasFfmpeg
      ? "available"
      : required
        ? `not found but required by enabled ${enabledUses}`
        : "not found; not required while camera snapshots and mic-level sampling are disabled",
    fix: !hasFfmpeg && required ? "Install ffmpeg with Homebrew: brew install ffmpeg" : undefined,
  };
}

export function calendarProviderDoctorCheck(
  hasIcalBuddy: boolean,
  policy: PolicySnapshot,
): DoctorCheck {
  const required = policy.valid && policy.values.calendar;
  return {
    name: "icalBuddy",
    status: hasIcalBuddy || !required ? "pass" : "fail",
    detail: hasIcalBuddy
      ? "available for coarse date-time-only calendar queries"
      : required
        ? "not found but required by enabled Calendar context"
        : "not found; optional while Calendar context is disabled",
    fix: !hasIcalBuddy && required
      ? "Install icalBuddy or disable Calendar context and use a direct calendar connector."
      : undefined,
  };
}

export function policyDoctorChecks(
  policy: PolicySnapshot,
  activeConsentReceipts: number | undefined,
  brokerReachable: boolean,
): DoctorCheck[] {
  const policyState = (enabled: boolean) => (enabled ? "enabled" : "disabled");
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
      detail: policyState(policy.valid && policy.values.mic_level),
    },
    {
      name: "Camera snapshot policy",
      status: "pass",
      detail: policyState(policy.valid && policy.values.camera_snapshot),
    },
    {
      name: "Window snapshot policy",
      status: "pass",
      detail: policyState(policy.valid && policy.values.window_snapshot),
    },
    {
      name: "Full-screen snapshot policy",
      status: "pass",
      detail: policyState(policy.valid && policy.values.full_screen_snapshot),
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

  const [hasFfmpeg, hasIcalBuddy] = await Promise.all([
    commandAvailable("ffmpeg"),
    commandAvailable("icalBuddy"),
  ]);

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

  checks.push(ffmpegDoctorCheck(hasFfmpeg, policy));
  checks.push(calendarProviderDoctorCheck(hasIcalBuddy, policy));
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
