import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSenseEnvFromToml } from "./cli.js";
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
  const result = await runCapture("sh", ["-lc", `command -v ${command}`], 2000);
  return Boolean(result && result.exitCode === 0 && result.stdout);
}

async function readable(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function panelReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch("http://127.0.0.1:3777/api/status", {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
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

  checks.push({
    name: "Node.js",
    status: "pass",
    detail: process.version,
  });

  checks.push({
    name: "Platform",
    status: process.platform === "darwin" ? "pass" : "warn",
    detail: process.platform,
    fix: process.platform === "darwin" ? undefined : "Most built-in sensors are macOS-first today.",
  });

  const hasFfmpeg = await commandAvailable("ffmpeg");
  checks.push({
    name: "ffmpeg",
    status: hasFfmpeg ? "pass" : "fail",
    detail: hasFfmpeg ? "available" : "not found",
    fix: hasFfmpeg ? undefined : "Install ffmpeg with Homebrew: brew install ffmpeg",
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

  checks.push({
    name: "Camera snapshot",
    status: env.SENSE_CAMERA_SNAPSHOT === "1" ? "pass" : "warn",
    detail: env.SENSE_CAMERA_SNAPSHOT === "1" ? "enabled" : "disabled",
    fix: env.SENSE_CAMERA_SNAPSHOT === "1" ? undefined : "Run sense-mcp settings --open and enable Camera Snapshot.",
  });
  checks.push({
    name: "Screen snapshot",
    status: env.SENSE_SCREEN_SNAPSHOT === "1" ? "pass" : "warn",
    detail: env.SENSE_SCREEN_SNAPSHOT === "1" ? "enabled" : "disabled",
    fix: env.SENSE_SCREEN_SNAPSHOT === "1" ? undefined : "Run sense-mcp settings --open and enable Screen Snapshot.",
  });
  checks.push({
    name: "Mic level",
    status: env.SENSE_MIC_LEVEL === "1" ? "pass" : "warn",
    detail: env.SENSE_MIC_LEVEL === "1" ? "enabled" : "disabled",
    fix: env.SENSE_MIC_LEVEL === "1" ? undefined : "Run sense-mcp settings --open and enable Mic Level, then restart the MCP client.",
  });
  checks.push({
    name: "Workspace roots",
    status: env.SENSE_WORKSPACE_ROOTS ? "pass" : "warn",
    detail: env.SENSE_WORKSPACE_ROOTS || "not configured",
    fix: env.SENSE_WORKSPACE_ROOTS ? undefined : "Run sense-mcp enable workspace /absolute/path/to/repo.",
  });

  const panel = await panelReachable();
  checks.push({
    name: "Settings panel",
    status: panel ? "pass" : "warn",
    detail: panel ? "reachable at http://127.0.0.1:3777/" : "not running",
    fix: panel ? undefined : "Run sense-mcp settings --open to open the local settings panel.",
  });

  if (process.platform === "darwin") {
    await withEnv(env, async () => {
      const { calendarSensor } = await import("./sensors/calendar.js");
      const { audioLevelSensor } = await import("./sensors/audioLevel.js");
      const { focusModeSensor } = await import("./sensors/focusMode.js");
      const { ambientLightSensor } = await import("./sensors/ambientLight.js");

      checks.push(await probeSensor("Calendar sensor", calendarSensor));

      if (env.SENSE_MIC_LEVEL === "1") {
        checks.push(await probeSensor("Mic level sensor", audioLevelSensor));
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
