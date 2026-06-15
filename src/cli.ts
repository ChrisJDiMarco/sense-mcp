import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");

const CAPABILITY_ENV: Record<string, string> = {
  camera: "SENSE_CAMERA_SNAPSHOT",
  screen: "SENSE_SCREEN_SNAPSHOT",
  mic: "SENSE_MIC_LEVEL",
  "raw-titles": "SENSE_RAW_TITLES",
};

type EnvLike = Record<string, string | undefined>;

function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function envSectionRange(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === "[mcp_servers.sense.env]");
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+]\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function senseSectionInsertIndex(lines: string[]): number {
  const senseStart = lines.findIndex((line) => line.trim() === "[mcp_servers.sense]");
  if (senseStart === -1) return lines.length;

  for (let i = senseStart + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+]\s*$/.test(lines[i])) return i;
  }
  return lines.length;
}

export function setSenseEnvInToml(toml: string, key: string, value: string | null): string {
  const lines = toml.split("\n");
  let range = envSectionRange(lines);

  if (!range && value !== null) {
    const insertAt = senseSectionInsertIndex(lines);
    lines.splice(insertAt, 0, "", "[mcp_servers.sense.env]");
    range = { start: insertAt + 1, end: insertAt + 2 };
  }

  if (!range) return toml;

  const section = lines.slice(range.start + 1, range.end);
  const keyPattern = new RegExp(`^\\s*${key}\\s*=`);
  const existingIndex = section.findIndex((line) => keyPattern.test(line));

  if (value === null) {
    if (existingIndex !== -1) section.splice(existingIndex, 1);
  } else if (existingIndex === -1) {
    section.push(`${key} = ${quoteToml(value)}`);
  } else {
    section[existingIndex] = `${key} = ${quoteToml(value)}`;
  }

  lines.splice(range.start + 1, range.end - range.start - 1, ...section);
  return lines.join("\n");
}

export function parseSenseEnvFromToml(toml: string): EnvLike {
  const lines = toml.split("\n");
  const range = envSectionRange(lines);
  if (!range) return {};

  const env: EnvLike = {};
  for (const line of lines.slice(range.start + 1, range.end)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"\s*$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

export function renderPermissionStatus(env: EnvLike = process.env): string {
  const state = (name: string) => (env[CAPABILITY_ENV[name]] === "1" ? "enabled" : "disabled");
  return [
    `camera: ${state("camera")} (${CAPABILITY_ENV.camera})`,
    `screen: ${state("screen")} (${CAPABILITY_ENV.screen})`,
    `mic: ${state("mic")} (${CAPABILITY_ENV.mic})`,
    `raw-titles: ${state("raw-titles")} (${CAPABILITY_ENV["raw-titles"]})`,
    `workspace: ${env.SENSE_WORKSPACE_ROOTS ? "enabled" : "disabled"} (SENSE_WORKSPACE_ROOTS)`,
    `snapshot-dir: ${env.SENSE_SNAPSHOT_DIR ?? path.join(os.tmpdir(), "sense-mcp", "snapshots")}`,
  ].join("\n");
}

function usage(): string {
  return [
    "sense-mcp <command>",
    "",
    "Commands:",
    "  status",
    "  permissions",
    "  doctor",
    "  panel [--open] [--port <number>]",
    "  enable <camera|screen|mic|raw-titles|workspace> [value]",
    "  disable <camera|screen|mic|raw-titles|workspace>",
  ].join("\n");
}

async function updateCodexConfig(key: string, value: string | null): Promise<void> {
  const configPath = process.env.SENSE_CODEX_CONFIG || DEFAULT_CODEX_CONFIG;
  const current = await readFile(configPath, "utf8");
  await writeFile(configPath, setSenseEnvInToml(current, key, value));
}

export async function runCli(argv: string[]): Promise<number> {
  const [command, capability, value] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }

  if (command === "status" || command === "permissions") {
    const configPath = process.env.SENSE_CODEX_CONFIG || DEFAULT_CODEX_CONFIG;
    const codexEnv = await readFile(configPath, "utf8")
      .then(parseSenseEnvFromToml)
      .catch(() => process.env);
    console.log(renderPermissionStatus({ ...process.env, ...codexEnv }));
    return 0;
  }

  if (command === "doctor") {
    const { createDoctorReport, renderDoctorReport } = await import("./doctor.js");
    console.log(renderDoctorReport(await createDoctorReport()));
    return 0;
  }

  if (command === "panel" || command === "tray") {
    const open = argv.includes("--open");
    const portIndex = argv.indexOf("--port");
    const port =
      portIndex === -1 || !argv[portIndex + 1] ? undefined : Number(argv[portIndex + 1]);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      console.error("Invalid port.");
      return 1;
    }

    const { startPanel } = await import("./panel.js");
    const panel = await startPanel({ open, port });
    console.log(`Sense panel running at ${panel.url}`);
    console.log("Press Ctrl+C to stop.");
    return new Promise<number>(() => undefined);
  }

  if (command !== "enable" && command !== "disable") {
    console.error(`Unknown command: ${command}\n\n${usage()}`);
    return 1;
  }

  if (!capability) {
    console.error(`Missing capability.\n\n${usage()}`);
    return 1;
  }

  const key =
    capability === "workspace" ? "SENSE_WORKSPACE_ROOTS" : CAPABILITY_ENV[capability];
  if (!key) {
    console.error(`Unknown capability: ${capability}`);
    return 1;
  }

  if (command === "enable" && capability === "workspace" && !value) {
    console.error("Enabling workspace requires a path value.");
    return 1;
  }

  await updateCodexConfig(key, command === "enable" ? value ?? "1" : null);
  console.log(`${command === "enable" ? "Enabled" : "Disabled"} ${capability}. Restart Codex.`);
  return 0;
}
