import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSensePolicy, updateSensePolicy, type PolicyKey, type PolicyValues } from "./policy.js";

const DEFAULT_CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");

const CAPABILITY_ENV: Record<string, string> = {
  camera: "SENSE_CAMERA_SNAPSHOT",
  screen: "SENSE_SCREEN_SNAPSHOT",
  window: "SENSE_SCREEN_SNAPSHOT",
  "full-screen": "SENSE_FULL_SCREEN_SNAPSHOT",
  mic: "SENSE_MIC_LEVEL",
  calendar: "SENSE_CALENDAR",
  location: "SENSE_LOCATION",
  "raw-titles": "SENSE_RAW_TITLES",
};

const CAPABILITY_POLICY: Record<string, PolicyKey> = {
  camera: "camera_snapshot",
  screen: "window_snapshot",
  window: "window_snapshot",
  "full-screen": "full_screen_snapshot",
  mic: "mic_level",
  calendar: "calendar",
  location: "location",
  "raw-titles": "raw_titles",
};

type EnvLike = Record<string, string | undefined>;
type InitClient = "codex" | "claude-desktop";
type InitProfile = "safe" | "developer" | "visual" | "full";

export interface InitConfig {
  client: InitClient;
  profile: InitProfile;
  write: boolean;
  configPath: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function capabilityPolicyKey(capability: string): PolicyKey | undefined {
  return CAPABILITY_POLICY[capability];
}

function quoteToml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlArray(values: string[]): string {
  return `[${values.map(quoteToml).join(", ")}]`;
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

function serverSectionRange(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === "[mcp_servers.sense]");
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

function setTomlKey(section: string[], key: string, renderedValue: string): string[] {
  const keyPattern = new RegExp(`^\\s*${key}\\s*=`);
  const existingIndex = section.findIndex((line) => keyPattern.test(line));
  const rendered = `${key} = ${renderedValue}`;
  if (existingIndex === -1) return [...section, rendered];
  return section.map((line, index) => (index === existingIndex ? rendered : line));
}

export function setSenseEnvInToml(toml: string, key: string, value: string | null): string {
  const lines = toml.split("\n");
  let range = envSectionRange(lines);

  if (!range && value !== null) {
    const insertAt = senseSectionInsertIndex(lines);
    const spacer = insertAt > 0 && lines[insertAt - 1]?.trim() === "" ? [] : [""];
    lines.splice(insertAt, 0, ...spacer, "[mcp_servers.sense.env]");
    range = {
      start: insertAt + spacer.length,
      end: insertAt + spacer.length + 1,
    };
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

function profileEnv(profile: InitProfile): Record<string, string> {
  if (profile === "developer") return { SENSE_SCREEN_SNAPSHOT: "1" };
  if (profile === "visual") {
    return { SENSE_CAMERA_SNAPSHOT: "1", SENSE_SCREEN_SNAPSHOT: "1" };
  }
  if (profile === "full") {
    return {
      SENSE_CAMERA_SNAPSHOT: "1",
      SENSE_SCREEN_SNAPSHOT: "1",
      SENSE_MIC_LEVEL: "1",
    };
  }
  return {};
}

function defaultEntryPoint(): string {
  return path.resolve(process.argv[1] || path.join(process.cwd(), "dist", "index.js"));
}

export function buildInitConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): InitConfig {
  let client: InitClient = "codex";
  let profile: InitProfile = "safe";
  let write = false;
  let configPath = env.SENSE_CODEX_CONFIG || DEFAULT_CODEX_CONFIG;
  let command = process.execPath;
  let entry: string | null = defaultEntryPoint();
  let entrySpecified = false;
  const extraArgs: string[] = [];
  const explicitEnv: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };

    if (arg === "--client") {
      const value = next();
      if (value !== "codex" && value !== "claude-desktop") {
        throw new Error("--client must be codex or claude-desktop");
      }
      client = value;
    } else if (arg === "--profile") {
      const value = next();
      if (value !== "safe" && value !== "developer" && value !== "visual" && value !== "full") {
        throw new Error("--profile must be safe, developer, visual, or full");
      }
      profile = value;
    } else if (arg === "--write") {
      write = true;
    } else if (arg === "--config") {
      configPath = path.resolve(next());
    } else if (arg === "--command") {
      command = next();
      if (!entrySpecified) entry = null;
    } else if (arg === "--entry") {
      entry = path.resolve(next());
      entrySpecified = true;
    } else if (arg === "--arg") {
      extraArgs.push(next());
    } else if (arg === "--enable-camera" || arg === "--camera") {
      explicitEnv.SENSE_CAMERA_SNAPSHOT = "1";
    } else if (arg === "--enable-screen" || arg === "--screen") {
      explicitEnv.SENSE_SCREEN_SNAPSHOT = "1";
    } else if (arg === "--enable-mic" || arg === "--mic") {
      explicitEnv.SENSE_MIC_LEVEL = "1";
    } else if (arg === "--raw-titles") {
      explicitEnv.SENSE_RAW_TITLES = "1";
    } else if (arg === "--workspace") {
      explicitEnv.SENSE_WORKSPACE_ROOTS = path.resolve(next());
    } else if (arg === "--snapshot-dir") {
      explicitEnv.SENSE_SNAPSHOT_DIR = path.resolve(next());
    } else {
      throw new Error(`Unknown init option: ${arg}`);
    }
  }

  return {
    client,
    profile,
    write,
    configPath,
    command,
    args: entry ? [entry, ...extraArgs] : extraArgs,
    env: { ...profileEnv(profile), ...explicitEnv },
  };
}

export function renderCodexInitBlock(config: InitConfig): string {
  const lines = [
    "[mcp_servers.sense]",
    `command = ${quoteToml(config.command)}`,
    `args = ${tomlArray(config.args)}`,
    "startup_timeout_sec = 20",
  ];

  const envEntries = Object.entries(config.env);
  if (envEntries.length > 0) {
    lines.push("", "[mcp_servers.sense.env]");
    for (const [key, value] of envEntries) lines.push(`${key} = ${quoteToml(value)}`);
  }

  return lines.join("\n");
}

export function renderClaudeDesktopInitConfig(config: InitConfig): string {
  const server: { command: string; args: string[]; env?: Record<string, string> } = {
    command: config.command,
    args: config.args,
  };
  if (Object.keys(config.env).length > 0) server.env = config.env;

  return JSON.stringify({ mcpServers: { sense: server } }, null, 2);
}

export function upsertCodexSenseServer(toml: string, config: InitConfig): string {
  const lines = toml ? toml.trimEnd().split("\n") : [];
  const range = serverSectionRange(lines);

  if (!range) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push("[mcp_servers.sense]");
    lines.push(`command = ${quoteToml(config.command)}`);
    lines.push(`args = ${tomlArray(config.args)}`);
    lines.push("startup_timeout_sec = 20");
  } else {
    const section = lines.slice(range.start + 1, range.end);
    const updated = setTomlKey(
      setTomlKey(setTomlKey(section, "command", quoteToml(config.command)), "args", tomlArray(config.args)),
      "startup_timeout_sec",
      "20",
    );
    lines.splice(range.start + 1, range.end - range.start - 1, ...updated);
  }

  let updatedToml = `${lines.join("\n")}\n`;
  for (const [key, value] of Object.entries(config.env)) {
    updatedToml = setSenseEnvInToml(updatedToml, key, value);
  }
  return updatedToml.endsWith("\n") ? updatedToml : `${updatedToml}\n`;
}

export function renderInitPreview(config: InitConfig): string {
  const renderedConfig =
    config.client === "codex" ? renderCodexInitBlock(config) : renderClaudeDesktopInitConfig(config);
  const target =
    config.client === "codex"
      ? config.configPath
      : "Claude Desktop settings -> claude_desktop_config.json";

  return [
    `Sense init (${config.client}, ${config.profile} profile)`,
    `target: ${target}`,
    "",
    renderedConfig,
    "",
    "Next:",
    config.client === "codex"
      ? "1. Add this block to your Codex config, or rerun with --write."
      : "1. Merge this JSON into your Claude Desktop config.",
    "2. Restart your MCP client.",
    "3. Run sense-mcp doctor.",
    "4. Open settings with sense-mcp settings --open.",
  ].join("\n");
}

export interface PermissionRuntimeStatus {
  activeConsentReceipts?: number;
  broker?: "reachable" | "not_running_or_unreachable";
  policyPath?: string;
  policyValid?: boolean;
}

export function renderPermissionStatus(
  env: EnvLike = process.env,
  policy?: PolicyValues,
  runtime: PermissionRuntimeStatus = {},
): string {
  const enabled = (name: string, policyKey: PolicyKey) =>
    policy?.[policyKey] ?? env[CAPABILITY_ENV[name]] === "1";
  const state = (name: string, policyKey: PolicyKey) =>
    enabled(name, policyKey) ? "enabled" : "disabled";
  const snapshotDir =
    env.SENSE_SNAPSHOT_DIR ??
    path.join(os.tmpdir(), `sense-mcp-${process.getuid?.() ?? "user"}`, "snapshots");
  return [
    `calendar: ${state("calendar", "calendar")}`,
    `location: ${state("location", "location")}`,
    `camera: ${state("camera", "camera_snapshot")}`,
    `window: ${state("screen", "window_snapshot")}`,
    `full-screen: ${state("full-screen", "full_screen_snapshot")}`,
    `mic: ${state("mic", "mic_level")}`,
    `raw-titles: ${state("raw-titles", "raw_titles")}`,
    `workspace: ${env.SENSE_WORKSPACE_ROOTS ? "enabled" : "disabled"} (SENSE_WORKSPACE_ROOTS)`,
    `snapshot-dir: ${snapshotDir}`,
    "capture-consent: required (local allow-once confirmation; short-lived single-use receipt)",
    `active-consent-receipts: ${runtime.activeConsentReceipts ?? "not checked"}`,
    `broker: ${runtime.broker ?? "shared per-user; live state not checked"}`,
    `policy: ${
      runtime.policyPath
        ? `${runtime.policyValid === false ? "invalid; protected capabilities fail closed at" : "loaded from"} ${runtime.policyPath}`
        : "central private policy; path not checked"
    }`,
    "model-egress: controlled by the MCP client and model provider, not guaranteed local by Sense",
  ].join("\n");
}

export type PairingLinkWriter = (value: string) => Promise<void>;

function writeClipboard(value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Clipboard handoff timed out"));
    }, 2_000);
    child.once("error", finish);
    child.stdin.once("error", finish);
    child.once("close", (code) =>
      finish(code === 0 ? undefined : new Error("Clipboard handoff failed")),
    );
    child.stdin.end(value);
  });
}

export async function handoffPairingLink(
  pairingUrl: string,
  writer: PairingLinkWriter = writeClipboard,
): Promise<string> {
  if (!pairingUrl.startsWith("sense://pair?") || pairingUrl.length > 4_096) {
    return "iPhone pairing link is unavailable; rerun the LAN settings command after checking bridge setup.";
  }
  try {
    await writer(pairingUrl);
    return "iPhone pairing link copied to clipboard.";
  } catch {
    return "iPhone pairing link could not be copied; rerun the LAN settings command after clipboard access is restored.";
  }
}

function usage(): string {
  return [
    "sense-mcp <command>",
    "",
    "Commands:",
    "  init [--write] [--client codex|claude-desktop] [--profile safe|developer|visual|full]",
    "  status",
    "  permissions",
    "  doctor",
    "  ledger",
    "  consent [list|revoke <receipt-id|all>]",
    "  settings [--open] [--port <number>] [--lan] [--lan-port <number>]",
    "  panel [--open] [--port <number>] [--lan] [--lan-port <number>]",
    "  enable <calendar|location|camera|screen|window|full-screen|mic|raw-titles|workspace> [value]",
    "  disable <calendar|location|camera|screen|window|full-screen|mic|raw-titles|workspace>",
  ].join("\n");
}

function initUsage(): string {
  return [
    "sense-mcp init [options]",
    "",
    "Options:",
    "  --client codex|claude-desktop",
    "  --profile safe|developer|visual|full",
    "  --write                         Write Codex config in place",
    "  --config <path>                  Codex config path for --write",
    "  --entry <path>                   MCP server entry file",
    "  --command <command>              Advanced: command to run instead of node",
    "  --arg <value>                    Advanced: append command argument",
    "  --camera, --enable-camera        Enable explicit camera snapshots",
    "  --screen, --enable-screen        Enable explicit app-window snapshots",
    "  --mic, --enable-mic              Enable one-second mic level sampling",
    "  --workspace <path>               Enable workspace context for a root",
    "  --snapshot-dir <path>            Use a custom private snapshot directory",
    "  --raw-titles                     Enable redacted raw window titles",
  ].join("\n");
}

async function updateCodexConfig(key: string, value: string | null): Promise<void> {
  const configPath = process.env.SENSE_CODEX_CONFIG || DEFAULT_CODEX_CONFIG;
  const current = await readFile(configPath, "utf8");
  await writeFile(configPath, setSenseEnvInToml(current, key, value));
}

async function runInit(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(initUsage());
    return 0;
  }

  let config: InitConfig;
  try {
    config = buildInitConfig(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Invalid init options");
    console.error(`\n${initUsage()}`);
    return 1;
  }

  if (config.write && config.client !== "codex") {
    console.error("--write is currently supported for Codex config only.");
    return 1;
  }

  if (!config.write) {
    console.log(renderInitPreview(config));
    return 0;
  }

  const current = await readFile(config.configPath, "utf8").catch(() => "");
  await mkdir(path.dirname(config.configPath), { recursive: true });
  await writeFile(config.configPath, upsertCodexSenseServer(current, config));
  console.log(`Wrote Sense MCP config to ${config.configPath}`);
  console.log("Restart Codex, run sense-mcp doctor, then open settings with sense-mcp settings --open.");
  return 0;
}

export async function runCli(argv: string[]): Promise<number> {
  const [command, capability, value] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }

  if (command === "init") {
    return runInit(argv.slice(1));
  }

  if (command === "status" || command === "permissions") {
    const configPath = process.env.SENSE_CODEX_CONFIG || DEFAULT_CODEX_CONFIG;
    const codexEnv = await readFile(configPath, "utf8")
      .then(parseSenseEnvFromToml)
      .catch(() => process.env);
    const mergedEnv = { ...process.env, ...codexEnv };
    const [{ listConsentReceipts }, broker, policy] = await Promise.all([
      import("./consent.js"),
      existingBrokerStatus(),
      loadSensePolicy(mergedEnv),
    ]);
    const activeConsentReceipts = await listConsentReceipts().then((items) => items.length).catch(() => 0);
    console.log(
      renderPermissionStatus(mergedEnv, policy.values, {
        activeConsentReceipts,
        broker,
        policyPath: policy.path,
        policyValid: policy.valid,
      }),
    );
    return 0;
  }

  if (command === "doctor") {
    const { createDoctorReport, renderDoctorReport } = await import("./doctor.js");
    console.log(renderDoctorReport(await createDoctorReport()));
    return 0;
  }

  if (command === "ledger") {
    const { readAccessLedger, ledgerPath } = await import("./ledger.js");
    const entries = await readAccessLedger(20);
    console.log(`Sense access ledger: ${ledgerPath()}`);
    if (entries.length === 0) {
      console.log("No entries yet.");
      return 0;
    }
    for (const entry of entries) {
      const domains = entry.context_domains.length ? entry.context_domains.join(",") : "none";
      const budget =
        entry.budget_mode && entry.max_tokens !== undefined
          ? ` budget=${entry.budget_mode}/${entry.max_tokens}`
          : "";
      console.log(
        `${entry.observed_at} ${entry.status} ${entry.tool} media=${entry.media_captured ? "yes" : "no"} domains=${domains}${budget} - ${entry.reason}`,
      );
    }
    return 0;
  }

  if (command === "consent") {
    const { listConsentReceipts, revokeAllConsent, revokeConsent, consentDirectory } = await import("./consent.js");
    if (!capability || capability === "list") {
      const receipts = await listConsentReceipts();
      console.log(`Sense capture consent: ${consentDirectory()}`);
      if (receipts.length === 0) {
        console.log("No active receipts.");
        return 0;
      }
      for (const receipt of receipts) {
        console.log(
          `${receipt.id} ${receipt.media_kind}/${receipt.scope} target=${receipt.target} expires=${receipt.expires_at}`,
        );
      }
      return 0;
    }
    if (capability !== "revoke" || !value) {
      console.error("Usage: sense-mcp consent [list|revoke <receipt-id|all>]");
      return 1;
    }
    const removed = value === "all" ? await revokeAllConsent() : Number(await revokeConsent(value));
    console.log(removed > 0 ? `Revoked ${removed} consent receipt(s).` : "No matching active consent receipt.");
    return 0;
  }

  if (command === "panel" || command === "settings" || command === "tray") {
    const open = argv.includes("--open");
    const lanBridge = argv.includes("--lan");
    const portIndex = argv.indexOf("--port");
    const port =
      portIndex === -1 || !argv[portIndex + 1] ? undefined : Number(argv[portIndex + 1]);
    const lanPortIndex = argv.indexOf("--lan-port");
    const lanPort =
      lanPortIndex === -1 || !argv[lanPortIndex + 1] ? undefined : Number(argv[lanPortIndex + 1]);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      console.error("Invalid port.");
      return 1;
    }
    if (lanPort !== undefined && (!Number.isInteger(lanPort) || lanPort < 1 || lanPort > 65535)) {
      console.error("Invalid LAN port.");
      return 1;
    }

    const { startPanel } = await import("./panel.js");
    const panel = await startPanel({ open, port, lanBridge, lanPort });
    console.log(`Sense panel running at ${panel.url}`);
    if (!open) {
      console.log(`Private panel launcher: ${panel.launcherPath}`);
      console.log("Open that protected file, or rerun with --open.");
    }
    if (panel.lanBridge) {
      console.log(`iPhone LAN bridge running at ${panel.lanBridge.url}`);
      console.log(await handoffPairingLink(panel.lanBridge.pairingUrl));
    }
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

  const policyKey = capabilityPolicyKey(capability);
  if (policyKey) {
    await updateSensePolicy({ [policyKey]: command === "enable" });
    await updateCodexConfig(key, command === "enable" ? "1" : null).catch(() => undefined);
    console.log(
      `${command === "enable" ? "Enabled" : "Disabled"} ${capability} in central Sense policy.`,
    );
    return 0;
  }

  await updateCodexConfig(key, command === "enable" ? value ?? "1" : null);
  console.log(`${command === "enable" ? "Enabled" : "Disabled"} ${capability}. Restart Codex.`);
  return 0;
}

async function existingBrokerStatus(): Promise<"reachable" | "not_running_or_unreachable"> {
  try {
    const { BrokerClient, defaultBrokerSocketPath } = await import("./broker.js");
    const client = await BrokerClient.connect(defaultBrokerSocketPath(), { requestTimeoutMs: 300 });
    await client.close();
    return "reachable";
  } catch {
    return "not_running_or_unreachable";
  }
}
