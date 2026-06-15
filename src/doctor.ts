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
    fix: env.SENSE_CAMERA_SNAPSHOT === "1" ? undefined : "Run sense-mcp enable camera or use the Sense panel.",
  });
  checks.push({
    name: "Screen snapshot",
    status: env.SENSE_SCREEN_SNAPSHOT === "1" ? "pass" : "warn",
    detail: env.SENSE_SCREEN_SNAPSHOT === "1" ? "enabled" : "disabled",
    fix: env.SENSE_SCREEN_SNAPSHOT === "1" ? undefined : "Run sense-mcp enable screen or use the Sense panel.",
  });
  checks.push({
    name: "Mic level",
    status: env.SENSE_MIC_LEVEL === "1" ? "pass" : "warn",
    detail: env.SENSE_MIC_LEVEL === "1" ? "enabled" : "disabled",
  });
  checks.push({
    name: "Workspace roots",
    status: env.SENSE_WORKSPACE_ROOTS ? "pass" : "warn",
    detail: env.SENSE_WORKSPACE_ROOTS || "not configured",
    fix: env.SENSE_WORKSPACE_ROOTS ? undefined : "Run sense-mcp enable workspace /absolute/path/to/repo.",
  });

  const panel = await panelReachable();
  checks.push({
    name: "Control panel",
    status: panel ? "pass" : "warn",
    detail: panel ? "reachable at http://127.0.0.1:3777/" : "not running",
    fix: panel ? undefined : "Run sense-mcp panel --open.",
  });

  return {
    generated_at: new Date().toISOString(),
    checks,
  };
}
