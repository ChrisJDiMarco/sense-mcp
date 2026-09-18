import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { open, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSenseEnvFromToml, setSenseEnvInToml } from "./cli.js";
import {
  iphoneContextPath,
  readActiveIphoneContextPayload,
  writeIphoneContextPayload,
  type IphoneContextPayload,
} from "./iphoneContext.js";
import { ledgerPath, readAccessLedger, recordAccess, type AccessLedgerEntry } from "./ledger.js";
import { startLanIphoneBridge, type LanBridgeState } from "./lanBridge.js";
import { BrokerClient, defaultBrokerSocketPath } from "./broker.js";
import type { ContextResult } from "./contextProvider.js";
import {
  POLICY_KEYS,
  SensePolicyStore,
  policyPath,
  type PolicyKey,
  type PolicySnapshot,
} from "./policy.js";
import { planRelevantContext } from "./relevance.js";
import { sensors } from "./sensors/index.js";
import type { CapabilityOperationalState, Sensor } from "./types.js";
import { atomicWritePrivateFile, removePrivateFile } from "./privateFiles.js";
import { removePanelRuntime, writePanelRuntime } from "./panelRuntime.js";
import { snapshotDirectory } from "./snapshotFiles.js";

const DEFAULT_CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");
const DEFAULT_PORT = 3777;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const PANEL_REQUEST_TIMEOUT_MS = 5_000;
const PANEL_SESSION_COOKIE = "sense_panel_session";
const MAX_BOOTSTRAP_BYTES = 512;
const MAX_LAUNCHER_BYTES = 8 * 1024;

type CapabilityName =
  | "camera"
  | "window"
  | "fullScreen"
  | "mic"
  | "calendar"
  | "location"
  | "rawTitles"
  | "workspace";

interface CapabilityState {
  label: string;
  enabled: boolean;
  env: string;
  value?: string;
  description: string;
  preview: string;
  agent_sees: string[];
  agent_never_sees: string[];
  operational_state: string;
  source: string;
}

interface SnapshotSummary {
  name: string;
  kind: "camera" | "screen";
  path: string;
  size_bytes: number;
  modified_at: string;
  capture_scope?: "camera" | "window_only" | "full_screen" | "unknown_screen";
}

interface ToolActivitySummary {
  tool:
    | "take_camera_snapshot"
    | "take_window_snapshot"
    | "take_screen_snapshot"
    | "take_full_screen_snapshot"
    | "screen_snapshot_artifact";
  status: "completed";
  observed_at: string;
  artifact_path: string;
  size_bytes: number;
  note: string;
  capture_scope: "camera" | "window_only" | "full_screen" | "unknown_screen";
}

interface PolicyOperationalState {
  state: "enabled" | "disabled" | "error";
  source: string;
  detail: string;
}

interface SensorOperationalState {
  state:
    | CapabilityOperationalState
    | "healthy"
    | "degraded"
    | "unavailable"
    | "not_connected"
    | "idle_on_demand";
  sampling_mode: "scheduled" | "on_demand";
  interval_ms: number;
  capability?: string;
  policy_key?: PolicyKey;
  detail: string;
}

interface CaptureOperationalState {
  state: "disabled" | "consent_required";
  tools: string[];
  detail: string;
}

interface MomentChip {
  label: string;
  value: string;
  tone: "good" | "warn" | "muted" | "info";
}

interface IphoneReceipt {
  feeling: string;
  energy: string;
  stress: string;
  focus: string;
  context_mode?: string;
  semantic_tags: string[];
  hint: string;
  expires_at: string;
  signals: string[];
  note: string;
}

interface MomentMap {
  title: string;
  summary: string;
  chips: MomentChip[];
  friction: string[];
  receipt?: IphoneReceipt;
}

export interface PanelState {
  generated_at: string;
  config_path: string;
  snapshot_dir: string;
  capabilities: Record<CapabilityName, CapabilityState>;
  moment: MomentMap;
  trust: {
    acquisition: "local_devices";
    delivery: "controlled_by_mcp_client_and_model_provider";
    semantic_sampling: "scheduled_while_client_connected";
    media_capture: "explicit_local_consent_only";
    snapshot_retention: "temporary_local_files";
  };
  operational_states: {
    runtime: {
      connected: boolean;
      state: "not_connected" | ContextResult["health"]["status"];
      source: "none" | ContextResult["health"]["source"];
    };
    policy: Record<PolicyKey, PolicyOperationalState>;
    sensors: Record<string, SensorOperationalState>;
    captures: Record<"camera_snapshot" | "window_snapshot" | "full_screen_snapshot", CaptureOperationalState>;
  };
  health: {
    enabled_capabilities: number;
    snapshot_count: number;
    last_snapshot_at?: string;
    doctor_command: string;
    recommendations: string[];
  };
  recent_tool_activity: ToolActivitySummary[];
  recent_snapshots: SnapshotSummary[];
  privacy_ledger: {
    path: string;
    entries: AccessLedgerEntry[];
  };
  restart_required_note: string;
}

interface IphoneBridgeReceipt {
  ok: true;
  stored: true;
  receipt_id: string;
  accepted_at: string;
  expires_at: string;
  context_mode: string;
  semantic_tags: string[];
  iphone_signals: string[];
  accepted_fields: string[];
  accepted_summary: string;
  path?: string;
}

const POLICY_ENV: Record<PolicyKey, string> = {
  calendar: "SENSE_CALENDAR",
  location: "SENSE_LOCATION",
  mic_level: "SENSE_MIC_LEVEL",
  camera_snapshot: "SENSE_CAMERA_SNAPSHOT",
  window_snapshot: "SENSE_SCREEN_SNAPSHOT",
  full_screen_snapshot: "SENSE_FULL_SCREEN_SNAPSHOT",
  raw_titles: "SENSE_RAW_TITLES",
};

const CAPABILITY_POLICY: Record<Exclude<CapabilityName, "workspace">, PolicyKey> = {
  camera: "camera_snapshot",
  window: "window_snapshot",
  fullScreen: "full_screen_snapshot",
  mic: "mic_level",
  calendar: "calendar",
  location: "location",
  rawTitles: "raw_titles",
};

const SENSOR_POLICY: Partial<Record<string, PolicyKey>> = {
  calendar: "calendar",
  location: "location",
  "audio-level": "mic_level",
  camera: "camera_snapshot",
};

function panelPolicyFromEnv(env: Record<string, string | undefined>): PolicySnapshot {
  const values = Object.fromEntries(
    POLICY_KEYS.map((key) => [key, env[POLICY_ENV[key]] === "1"]),
  ) as PolicySnapshot["values"];
  const sources = Object.fromEntries(
    POLICY_KEYS.map((key) => [
      key,
      env[POLICY_ENV[key]] === "0" || env[POLICY_ENV[key]] === "1" ? "environment" : "default",
    ]),
  ) as PolicySnapshot["sources"];
  return {
    values,
    sources,
    path: env.SENSE_POLICY_PATH || policyPath(),
    valid: true,
    loaded_at: new Date().toISOString(),
  };
}

function policyOperationalStates(policy: PolicySnapshot): Record<PolicyKey, PolicyOperationalState> {
  return Object.fromEntries(
    POLICY_KEYS.map((key) => [
      key,
      {
        state: policy.valid ? (policy.values[key] ? "enabled" : "disabled") : "error",
        source: policy.sources[key],
        detail: policy.valid
          ? `${key} is ${policy.values[key] ? "enabled" : "disabled"} by ${policy.sources[key]} policy.`
          : policy.error ?? "The policy file is invalid; Sense fails closed.",
      } satisfies PolicyOperationalState,
    ]),
  ) as Record<PolicyKey, PolicyOperationalState>;
}

function sensorOperationalStates(
  policy: PolicySnapshot,
  runtime: ContextResult | undefined,
): Record<string, SensorOperationalState> {
  const diagnostics = new Map(runtime?.health.diagnostics.map((item) => [item.component, item]) ?? []);
  const capabilityStates = runtime?.frame.privacy.capability_states ?? {};
  return Object.fromEntries(
    sensors.map((sensor: Sensor) => {
      const policyKey = SENSOR_POLICY[sensor.name];
      const diagnostic = diagnostics.get(sensor.name);
      const samplingMode = sensor.samplingMode === "on_demand" ? "on_demand" : "scheduled";
      let state: SensorOperationalState["state"];
      let detail: string;
      if (policyKey && (!policy.valid || !policy.values[policyKey])) {
        state = "disabled";
        detail = `${sensor.name} is disabled by ${policyKey} policy.`;
      } else if (!runtime) {
        state = "not_connected";
        detail = "No running sensor broker was attached when this panel state was generated.";
      } else if (diagnostic) {
        state = diagnostic.status;
        detail = diagnostic.message ?? `${sensor.name} reports ${diagnostic.status}.`;
      } else if (sensor.samplingMode === "on_demand") {
        state = "idle_on_demand";
        detail = "Available for an explicit context refresh; it is not sampled on a timer.";
      } else {
        state = sensor.capability
          ? (capabilityStates[sensor.capability] ?? "healthy")
          : "healthy";
        detail = `Semantic sampling may run every ${sensor.intervalMs} ms while an AI client is connected.`;
      }
      return [
        sensor.name,
        {
          state,
          sampling_mode: samplingMode,
          interval_ms: sensor.intervalMs,
          capability: sensor.capability,
          policy_key: policyKey,
          detail,
        } satisfies SensorOperationalState,
      ];
    }),
  );
}

function captureOperationalStates(
  policy: PolicySnapshot,
): PanelState["operational_states"]["captures"] {
  const state = (key: "camera_snapshot" | "window_snapshot" | "full_screen_snapshot") =>
    policy.valid && policy.values[key] ? "consent_required" : "disabled";
  return {
    camera_snapshot: {
      state: state("camera_snapshot"),
      tools: ["take_camera_snapshot"],
      detail: "take_camera_snapshot captures one still image only after an explicit local consent receipt.",
    },
    window_snapshot: {
      state: state("window_snapshot"),
      tools: ["take_window_snapshot", "take_screen_snapshot"],
      detail:
        "take_screen_snapshot is a deprecated window-only alias for take_window_snapshot; neither tool captures the full display.",
    },
    full_screen_snapshot: {
      state: state("full_screen_snapshot"),
      tools: ["take_full_screen_snapshot"],
      detail:
        "take_full_screen_snapshot captures the entire main display and requires explicit full-screen confirmation plus local consent.",
    },
  };
}

function snapshotDir(env: Record<string, string | undefined>): string {
  // snapshotDirectory() reads process.env only, so honour the Codex-config override first.
  return env.SENSE_SNAPSHOT_DIR ? path.resolve(env.SENSE_SNAPSHOT_DIR) : snapshotDirectory();
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function iphoneSignalLabels(payload: IphoneContextPayload): string[] {
  const context = payload.iphone_context;
  if (!context) return [];
  return [
    context.device ? "device" : undefined,
    context.motion ? "motion" : undefined,
    context.noise ? "noise" : undefined,
    context.health ? "health" : undefined,
  ].filter((label): label is string => Boolean(label));
}

function iphoneAcceptedFields(payload: IphoneContextPayload): string[] {
  return [
    "feeling",
    "energy",
    "stress",
    "focus",
    "assistive_hint",
    payload.internal_state.context_mode ? "context_mode" : undefined,
    payload.internal_state.semantic_tags?.length ? "semantic_tags" : undefined,
    ...iphoneSignalLabels(payload).map((signal) => `iphone_${signal}`),
  ].filter((field): field is string => Boolean(field));
}

function acceptedSummary(fields: string[]): string {
  if (fields.length === 0) return "Mac accepted semantic context.";
  const names = fields.map((field) => field.replace(/^iphone_/, "").replace(/_/g, " "));
  return `Mac accepted: ${names.join(", ")}.`;
}

function iphoneReceipt(payload: IphoneContextPayload): IphoneReceipt {
  return {
    feeling: payload.internal_state.feeling,
    energy: percent(payload.internal_state.energy),
    stress: percent(payload.internal_state.stress),
    focus: percent(payload.internal_state.focus),
    context_mode: payload.internal_state.context_mode,
    semantic_tags: payload.internal_state.semantic_tags ?? [],
    hint: payload.assistive_hint.replace(/_/g, " "),
    expires_at: payload.expires_at,
    signals: iphoneSignalLabels(payload),
    note: payload.internal_state.note,
  };
}

async function readActiveIphoneContext(file = iphoneContextPath()): Promise<IphoneContextPayload | undefined> {
  return readActiveIphoneContextPayload(file);
}

function buildMomentMap(
  capabilities: Record<CapabilityName, CapabilityState>,
  recommendations: string[],
  snapshots: SnapshotSummary[],
  ledgerEntries: AccessLedgerEntry[],
  iphoneContext?: IphoneContextPayload,
): MomentMap {
  const enabledCount = Object.values(capabilities).filter((capability) => capability.enabled).length;
  const lastLedger = ledgerEntries[0];
  const receipt = iphoneContext ? iphoneReceipt(iphoneContext) : undefined;
  const chips: MomentChip[] = [
    { label: "Acquisition", value: "local Mac", tone: "good" },
    { label: "Media capture", value: "explicit consent", tone: "good" },
    {
      label: "Enabled",
      value: `${enabledCount}/${Object.keys(capabilities).length}`,
      tone: enabledCount ? "info" : "muted",
    },
    {
      label: "iPhone",
      value: receipt ? `${receipt.feeling}, ${receipt.focus} focus` : "no active check-in",
      tone: receipt ? "info" : "muted",
    },
    {
      label: "Last Tool",
      value: lastLedger ? lastLedger.tool : snapshots[0]?.kind ?? "quiet",
      tone: lastLedger?.media_captured ? "warn" : lastLedger ? "info" : "muted",
    },
  ];

  return {
    title: receipt ? "iPhone context is live" : "Sense is ready",
    summary: receipt
      ? receipt.note
      : "No active iPhone check-in yet. Sense can still broker local, semantic context from the Mac.",
    chips,
    friction: recommendations.slice(0, 3),
    ...(receipt ? { receipt } : {}),
  };
}

async function recentSnapshots(dir: string): Promise<SnapshotSummary[]> {
  try {
    const entries = await readdir(dir);
    const snapshots = await Promise.all(
      entries
        .filter((name) => /^sense-(camera|screen)-.+\.png$/.test(name))
        .map(async (name) => {
          const file = path.join(dir, name);
          const info = await stat(file);
          return {
            name,
            kind: name.startsWith("sense-camera-") ? "camera" : "screen",
            path: file,
            size_bytes: info.size,
            modified_at: new Date(info.mtimeMs).toISOString(),
          } satisfies SnapshotSummary;
        }),
    );
    return snapshots.sort((a, b) => (a.modified_at < b.modified_at ? 1 : -1)).slice(0, 8);
  } catch {
    return [];
  }
}

function snapshotReceipt(
  snapshot: SnapshotSummary,
  ledgerEntries: AccessLedgerEntry[],
): AccessLedgerEntry | undefined {
  return ledgerEntries.find(
    (entry) =>
      entry.status === "completed" &&
      entry.media_captured &&
      entry.artifact_paths?.includes(snapshot.path),
  );
}

function snapshotScope(
  snapshot: SnapshotSummary,
  receipt: AccessLedgerEntry | undefined,
): SnapshotSummary["capture_scope"] {
  if (snapshot.kind === "camera") return "camera";
  if (receipt?.tool === "take_full_screen_snapshot") return "full_screen";
  if (receipt?.tool === "take_window_snapshot" || receipt?.tool === "take_screen_snapshot") {
    return "window_only";
  }
  return "unknown_screen";
}

function snapshotToToolActivity(
  snapshot: SnapshotSummary,
  ledgerEntries: AccessLedgerEntry[],
): ToolActivitySummary {
  const receipt = snapshotReceipt(snapshot, ledgerEntries);
  const captureScope = snapshotScope(snapshot, receipt);
  const tool: ToolActivitySummary["tool"] =
    snapshot.kind === "camera"
      ? "take_camera_snapshot"
      : receipt?.tool === "take_window_snapshot" ||
          receipt?.tool === "take_screen_snapshot" ||
          receipt?.tool === "take_full_screen_snapshot"
        ? receipt.tool
        : "screen_snapshot_artifact";
  const note =
    tool === "take_screen_snapshot"
      ? "Ledger-attributed deprecated alias capture; this was window-only, not full-screen."
      : tool === "take_full_screen_snapshot"
        ? "Ledger-attributed explicit full-screen capture of the main display."
        : tool === "take_window_snapshot"
          ? "Ledger-attributed app-window capture."
          : "Derived from the temporary snapshot artifact; no matching capture receipt was found.";
  return {
    tool,
    status: "completed",
    observed_at: snapshot.modified_at,
    artifact_path: snapshot.path,
    size_bytes: snapshot.size_bytes,
    note,
    capture_scope: captureScope ?? "unknown_screen",
  };
}

export function sensePanelState(
  env: Record<string, string | undefined>,
  snapshots: SnapshotSummary[] = [],
  configPath = DEFAULT_CODEX_CONFIG,
  ledgerEntries: AccessLedgerEntry[] = [],
  iphoneContext?: IphoneContextPayload,
  loadedPolicy?: PolicySnapshot,
  runtime?: ContextResult,
): PanelState {
  const policy = loadedPolicy ?? panelPolicyFromEnv(env);
  const policyStates = policyOperationalStates(policy);
  const captureStates = captureOperationalStates(policy);
  const capabilities: PanelState["capabilities"] = {
    camera: {
      label: "Camera Snapshot",
      enabled: policy.valid && policy.values.camera_snapshot,
      env: "SENSE_CAMERA_SNAPSHOT",
      description: "One-off webcam snapshot for explicit visual appearance or room requests.",
      preview: "The still-image tool requires an exact, short-lived local consent receipt.",
      agent_sees: ["temporary image path", "device label", "capture status"],
      agent_never_sees: ["background video", "identity profile", "camera stream"],
      operational_state: captureStates.camera_snapshot.state,
      source: policy.sources.camera_snapshot,
    },
    window: {
      label: "App Window Snapshot",
      enabled: policy.valid && policy.values.window_snapshot,
      env: "SENSE_SCREEN_SNAPSHOT",
      description: "Captures one identified app window without activating it.",
      preview: "take_screen_snapshot remains only as a deprecated window-only compatibility alias.",
      agent_sees: ["one app window image", "window id", "capture status"],
      agent_never_sees: ["other displays", "background recording", "keystrokes"],
      operational_state: captureStates.window_snapshot.state,
      source: policy.sources.window_snapshot,
    },
    fullScreen: {
      label: "Full-Screen Snapshot",
      enabled: policy.valid && policy.values.full_screen_snapshot,
      env: "SENSE_FULL_SCREEN_SNAPSHOT",
      description: "Higher-risk capture of the entire main display.",
      preview: "Uses take_full_screen_snapshot and requires explicit full-screen confirmation and local consent.",
      agent_sees: ["entire main display image", "capture status", "requested reason"],
      agent_never_sees: ["background recording", "keystrokes", "other displays by default"],
      operational_state: captureStates.full_screen_snapshot.state,
      source: policy.sources.full_screen_snapshot,
    },
    mic: {
      label: "Mic Level",
      enabled: policy.valid && policy.values.mic_level,
      env: "SENSE_MIC_LEVEL",
      description: "Scheduled one-second audio-level samples while an AI client is connected.",
      preview: "Emits a noise class and dB level; never transcript or retained audio.",
      agent_sees: ["noise class", "average level", "sample length"],
      agent_never_sees: ["audio recording", "transcript", "speaker identity"],
      operational_state: policyStates.mic_level.state,
      source: policy.sources.mic_level,
    },
    calendar: {
      label: "Calendar Availability",
      enabled: policy.valid && policy.values.calendar,
      env: "SENSE_CALENDAR",
      description: "On-demand semantic availability windows from a headless calendar provider.",
      preview: "Samples only for an explicit schedule-domain refresh; event titles are not emitted.",
      agent_sees: ["busy/free window", "time until next event", "schedule pressure"],
      agent_never_sees: ["event titles", "attendees", "notes", "Calendar.app UI"],
      operational_state: policyStates.calendar.state,
      source: policy.sources.calendar,
    },
    location: {
      label: "Coarse Location Class",
      enabled: policy.valid && policy.values.location,
      env: "SENSE_LOCATION",
      description: "Scheduled local classification such as home, office, cafe, or unknown.",
      preview: "The raw network name is used locally for classification and is not emitted.",
      agent_sees: ["coarse location class"],
      agent_never_sees: ["raw Wi-Fi name", "GPS coordinates", "network credentials"],
      operational_state: policyStates.location.state,
      source: policy.sources.location,
    },
    rawTitles: {
      label: "Raw Window Titles",
      enabled: policy.valid && policy.values.raw_titles,
      env: "SENSE_RAW_TITLES",
      description: "Redacted active-window title. Off by default.",
      preview: "Adds redacted title text only when you intentionally opt in.",
      agent_sees: ["redacted title", "privacy-safe label"],
      agent_never_sees: ["unredacted secrets", "message bodies", "credentials"],
      operational_state: policyStates.raw_titles.state,
      source: policy.sources.raw_titles,
    },
    workspace: {
      label: "Workspace Context",
      enabled: Boolean(env.SENSE_WORKSPACE_ROOTS),
      env: "SENSE_WORKSPACE_ROOTS",
      value: env.SENSE_WORKSPACE_ROOTS,
      description: "Git branch, dirty count, scripts, and project class for configured roots.",
      preview: "Adds branch, dirty count, scripts, and broad project class for configured roots.",
      agent_sees: ["workspace name", "branch", "dirty count"],
      agent_never_sees: ["file contents", "commit secrets", "unrequested diffs"],
      operational_state: env.SENSE_WORKSPACE_ROOTS ? "enabled" : "disabled",
      source: "client configuration",
    },
  };
  const enabledCapabilities = Object.values(capabilities).filter((capability) => capability.enabled)
    .length;
  const recommendations = [
    ...(!policy.valid ? [policy.error ?? "Policy is invalid; protected capabilities fail closed."] : []),
    ...(runtime
      ? runtime.health.status === "healthy"
        ? []
        : [`Sensor broker reports ${runtime.health.status}; inspect the operational states below.`]
      : ["Sensor broker is not connected; sensor rows are listed as not connected, not healthy."]),
    ...(capabilities.camera.enabled || capabilities.window.enabled || capabilities.fullScreen.enabled
      ? []
      : ["Camera, window, and full-screen capture are disabled by policy."]),
    ...(capabilities.mic.enabled
      ? []
      : ["Mic-level semantic sampling is disabled by policy."]),
    ...(env.SENSE_FOCUS_MODE || env.SENSE_FOCUS_SHORTCUT
      ? []
      : ["Focus mode needs SENSE_FOCUS_MODE or a macOS Shortcut named Sense Current Focus."]),
    "Run sense-mcp doctor for live Calendar, mic, focus, and ambient light diagnostics.",
    ...(capabilities.rawTitles.enabled
      ? ["Raw titles are on. Keep this disabled unless you truly need redacted titles."]
      : []),
  ];
  const enrichedSnapshots = snapshots.map((snapshot) => ({
    ...snapshot,
    capture_scope: snapshotScope(snapshot, snapshotReceipt(snapshot, ledgerEntries)),
  }));
  const sensorStates = sensorOperationalStates(policy, runtime);

  return {
    generated_at: new Date().toISOString(),
    config_path: configPath,
    snapshot_dir: snapshotDir(env),
    capabilities,
    moment: buildMomentMap(capabilities, recommendations, snapshots, ledgerEntries, iphoneContext),
    trust: {
      acquisition: "local_devices",
      delivery: "controlled_by_mcp_client_and_model_provider",
      semantic_sampling: "scheduled_while_client_connected",
      media_capture: "explicit_local_consent_only",
      snapshot_retention: "temporary_local_files",
    },
    operational_states: {
      runtime: {
        connected: Boolean(runtime),
        state: runtime?.health.status ?? "not_connected",
        source: runtime?.health.source ?? "none",
      },
      policy: policyStates,
      sensors: sensorStates,
      captures: captureStates,
    },
    health: {
      enabled_capabilities: enabledCapabilities,
      snapshot_count: snapshots.length,
      last_snapshot_at: snapshots[0]?.modified_at,
      doctor_command: "sense-mcp doctor",
      recommendations,
    },
    recent_tool_activity: snapshots.map((snapshot) => snapshotToToolActivity(snapshot, ledgerEntries)),
    recent_snapshots: enrichedSnapshots,
    privacy_ledger: {
      path: ledgerPath(),
      entries: ledgerEntries,
    },
    restart_required_note:
      "Policy changes reload automatically. Restart the MCP client only after changing workspace roots or other client configuration.",
  };
}

export function capabilityToEnvUpdate(
  capability: string,
  enabled: boolean,
  value?: string,
): { key: string; value: string | null } {
  const map: Record<string, string> = {
    camera: "SENSE_CAMERA_SNAPSHOT",
    window: "SENSE_SCREEN_SNAPSHOT",
    screen: "SENSE_SCREEN_SNAPSHOT",
    fullScreen: "SENSE_FULL_SCREEN_SNAPSHOT",
    mic: "SENSE_MIC_LEVEL",
    calendar: "SENSE_CALENDAR",
    location: "SENSE_LOCATION",
    rawTitles: "SENSE_RAW_TITLES",
    workspace: "SENSE_WORKSPACE_ROOTS",
  };
  const key = Object.hasOwn(map, capability) ? map[capability] : undefined;
  if (!key) throw new Error(`Unknown capability: ${capability}`);
  if (!enabled) return { key, value: null };
  if (capability === "workspace") {
    const trimmed = value?.trim();
    if (!trimmed) throw new Error("workspace requires a path");
    if (trimmed.length > 4_096 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new Error("workspace path is invalid");
    }
    return { key, value: trimmed };
  }
  return { key, value: "1" };
}

export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const parsed = new URL(`http://${host}`);
    return (
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function escapeHtml(value: string | number | boolean | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function capabilityCard(name: CapabilityName, cap: CapabilityState): string {
  const checked = cap.enabled ? "checked" : "";
  const valueInput =
    name === "workspace"
      ? `<input class="path-input" data-value-for="${name}" value="${escapeHtml(cap.value)}" placeholder="/path/to/workspace" />`
      : "";
  return `
    <section class="capability">
      <div>
        <h2>${escapeHtml(cap.label)}</h2>
        <p>${escapeHtml(cap.description)}</p>
        <p class="preview">${escapeHtml(cap.preview)}</p>
        <div class="capability-receipt">
          <div>
            <span>Agents see</span>
            <strong>${escapeHtml(cap.agent_sees.join(", "))}</strong>
          </div>
          <div>
            <span>Never see</span>
            <strong>${escapeHtml(cap.agent_never_sees.join(", "))}</strong>
          </div>
        </div>
        <code>${escapeHtml(cap.env)}</code>
        <span class="operation-state">${escapeHtml(cap.operational_state)} · ${escapeHtml(cap.source)}</span>
        ${valueInput}
      </div>
      <label class="switch">
        <input type="checkbox" data-capability="${name}" ${checked} />
        <span></span>
      </label>
    </section>`;
}

function chipRows(chips: MomentChip[]): string {
  return chips
    .map(
      (chip) => `
        <div class="chip ${escapeHtml(chip.tone)}">
          <span>${escapeHtml(chip.label)}</span>
          <strong>${escapeHtml(chip.value)}</strong>
        </div>`,
    )
    .join("");
}

function receiptRows(receipt: IphoneReceipt | undefined): string {
  if (!receipt) {
    return `<p class="muted">Send a check-in from the iPhone app to see the active context receipt here.</p>`;
  }
  const signals = receipt.signals.length ? receipt.signals.join(", ") : "none";
  return `
    <div class="receipt-grid">
      <div><span>Feeling</span><strong>${escapeHtml(receipt.feeling)}</strong></div>
      <div><span>Energy</span><strong>${escapeHtml(receipt.energy)}</strong></div>
      <div><span>Stress</span><strong>${escapeHtml(receipt.stress)}</strong></div>
      <div><span>Focus</span><strong>${escapeHtml(receipt.focus)}</strong></div>
      <div><span>Mode</span><strong>${escapeHtml(receipt.context_mode ?? "manual")}</strong></div>
      <div><span>Signals</span><strong>${escapeHtml(signals)}</strong></div>
      <div><span>Expires</span><strong>${escapeHtml(new Date(receipt.expires_at).toLocaleString())}</strong></div>
    </div>
    ${
      receipt.semantic_tags.length
        ? `<div class="tag-row">${receipt.semantic_tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>`
        : ""
    }
    <p class="muted space-top-12">Hint: ${escapeHtml(receipt.hint)}</p>`;
}

function momentMapRows(state: PanelState): string {
  return `
    <section class="moment">
      <div>
        <p class="eyebrow">Moment</p>
        <h1>${escapeHtml(state.moment.title)}</h1>
        <p>${escapeHtml(state.moment.summary)}</p>
      </div>
      <div class="chip-grid">
        ${chipRows(state.moment.chips)}
      </div>
      <div class="moment-footer">
        <div>
          <h2>Context Receipt</h2>
          ${receiptRows(state.moment.receipt)}
        </div>
        <div>
          <h2>Friction</h2>
          ${
            state.moment.friction.length
              ? `<ul class="recommendations tight">${state.moment.friction
                  .map((item) => `<li>${escapeHtml(item)}</li>`)
                  .join("")}</ul>`
              : `<p class="muted">No setup friction detected.</p>`
          }
        </div>
      </div>
    </section>`;
}

function routerPlaygroundRows(): string {
  return `
    <section class="panel route-lab">
      <div>
        <p class="eyebrow">Router Playground</p>
        <h2>Ask what Sense would use</h2>
        <p>Paste a prompt and preview the smallest context plan. This does not capture media.</p>
      </div>
      <form id="route-form">
        <textarea id="route-input" maxlength="500" placeholder="Can you help me debug this screen?"></textarea>
        <div class="route-examples">
          <button type="button" data-route-example="Can you help me debug this screen?">Screen</button>
          <button type="button" data-route-example="Do I have time to start this before my next meeting?">Time</button>
          <button type="button" data-route-example="How do I look before this call?">Camera</button>
          <button type="button" data-route-example="Write a tighter version of this update.">No Context</button>
        </div>
        <button type="submit">Preview Route</button>
      </form>
      <div>
        <div class="route-summary" id="route-summary">No route preview yet.</div>
        <details class="raw-route">
          <summary>Raw JSON</summary>
          <pre id="route-output">{}</pre>
        </details>
      </div>
    </section>`;
}

function snapshotRows(state: PanelState): string {
  if (state.recent_snapshots.length === 0) {
    return `<p class="muted">No explicit snapshots in the temp directory yet.</p>`;
  }
  return `
    <div class="snapshot-list">
      ${state.recent_snapshots
        .map(
          (snapshot) => `
        <div class="snapshot">
          <strong>${escapeHtml(snapshot.capture_scope ?? snapshot.kind)}</strong>
          <span>${escapeHtml(new Date(snapshot.modified_at).toLocaleString())}</span>
          <code>${escapeHtml(snapshot.path)}</code>
          <small>${Math.round(snapshot.size_bytes / 1024)} KB</small>
        </div>`,
        )
        .join("")}
    </div>`;
}

function toolActivityRows(state: PanelState): string {
  if (state.recent_tool_activity.length === 0) {
    return `<p class="muted">No explicit camera or screen tools have created temp artifacts yet.</p>`;
  }
  return `
    <div class="activity-list">
      ${state.recent_tool_activity
        .map(
          (activity) => `
        <div class="activity">
          <div>
            <strong>${escapeHtml(activity.tool)}</strong>
            <span>${escapeHtml(new Date(activity.observed_at).toLocaleString())}</span>
          </div>
          <code>${escapeHtml(activity.artifact_path)}</code>
          <small>${escapeHtml(activity.status)} - ${Math.round(activity.size_bytes / 1024)} KB</small>
          <small>Scope: ${escapeHtml(activity.capture_scope)}</small>
          <p>${escapeHtml(activity.note)}</p>
        </div>`,
        )
        .join("")}
    </div>`;
}

function ledgerRows(state: PanelState): string {
  if (state.privacy_ledger.entries.length === 0) {
    return `<p class="muted">No Sense access ledger entries yet.</p>`;
  }
  return `
    <div class="ledger-filters">
      <button type="button" data-ledger-filter="all">All</button>
      <button type="button" data-ledger-filter="media">Media</button>
      <button type="button" data-ledger-filter="planned">Plans</button>
      <button type="button" data-ledger-filter="iphone">iPhone</button>
    </div>
    <div class="activity-list">
      ${state.privacy_ledger.entries
        .map((entry) => {
          const domains = entry.context_domains.length ? entry.context_domains.join(", ") : "none";
          const budget =
            entry.budget_mode && entry.max_tokens !== undefined
              ? `${entry.budget_mode}, ${entry.max_tokens} tokens`
              : "not set";
          const external = entry.external_context_needed?.length
            ? `<p>External context: ${escapeHtml(entry.external_context_needed.join(", "))}</p>`
            : "";
          const artifacts = entry.artifact_paths?.length
            ? `<p>Artifacts: ${escapeHtml(entry.artifact_paths.join(", "))}</p>`
            : "";
          return `
        <div class="activity ledger-entry" data-media="${entry.media_captured ? "1" : "0"}" data-status="${escapeHtml(entry.status)}" data-tool="${escapeHtml(entry.tool)}">
          <div>
            <strong>${escapeHtml(entry.tool)}</strong>
            <span>${escapeHtml(new Date(entry.observed_at).toLocaleString())}</span>
          </div>
          <small>${escapeHtml(entry.status)} - media ${entry.media_captured ? "yes" : "no"} - domains ${escapeHtml(domains)} - budget ${escapeHtml(budget)}</small>
          <p>${escapeHtml(entry.reason)}</p>
          ${external}
          ${artifacts}
        </div>`;
        })
        .join("")}
    </div>
    <p class="muted space-top-10">Ledger path: <code>${escapeHtml(state.privacy_ledger.path)}</code></p>`;
}

function healthRows(state: PanelState): string {
  const lastSnapshot = state.health.last_snapshot_at
    ? new Date(state.health.last_snapshot_at).toLocaleString()
    : "None";
  return `
    <div class="trust">
      <div><span>Enabled capabilities</span><strong>${state.health.enabled_capabilities}</strong></div>
      <div><span>Recent snapshots</span><strong>${state.health.snapshot_count}</strong></div>
      <div><span>Last snapshot</span><strong>${escapeHtml(lastSnapshot)}</strong></div>
    </div>
    <p class="muted space-top-12">Run <code>${escapeHtml(state.health.doctor_command)}</code> for setup and permission checks.</p>
    ${
      state.health.recommendations.length
        ? `<ul class="recommendations">${state.health.recommendations
            .map((item) => `<li>${escapeHtml(item)}</li>`)
            .join("")}</ul>`
        : ""
    }`;
}

function operationalStateRows(state: PanelState): string {
  const runtime = state.operational_states.runtime;
  const policyRows = Object.entries(state.operational_states.policy)
    .map(
      ([name, item]) =>
        `<div class="operation-row"><code>${escapeHtml(name)}</code><strong>${escapeHtml(item.state)}</strong><small>${escapeHtml(item.source)}</small></div>`,
    )
    .join("");
  const captureRows = Object.entries(state.operational_states.captures)
    .map(
      ([name, item]) => `
        <div class="operation-detail">
          <div><code>${escapeHtml(name)}</code><strong>${escapeHtml(item.state)}</strong></div>
          <p>${escapeHtml(item.detail)}</p>
        </div>`,
    )
    .join("");
  const sensorRows = Object.entries(state.operational_states.sensors)
    .map(
      ([name, item]) => `
        <div class="operation-detail">
          <div><code>${escapeHtml(name)}</code><strong>${escapeHtml(item.state)}</strong></div>
          <small>${escapeHtml(item.sampling_mode)} · ${escapeHtml(item.interval_ms)} ms</small>
          <p>${escapeHtml(item.detail)}</p>
        </div>`,
    )
    .join("");
  return `
    <div class="trust">
      <div><span>Sensor broker</span><strong>${runtime.connected ? escapeHtml(runtime.state) : "Not connected"}</strong></div>
    </div>
    <h3>Policy</h3>
    <div class="operation-list compact">${policyRows}</div>
    <h3>Capture tools</h3>
    <div class="operation-list">${captureRows}</div>
    <details class="sensor-details">
      <summary>All registered sensors (${Object.keys(state.operational_states.sensors).length})</summary>
      <div class="operation-list">${sensorRows}</div>
    </details>`;
}

export function renderPanelHtml(state: PanelState, cspNonce = "panel-static"): string {
  const caps = Object.entries(state.capabilities)
    .map(([name, cap]) => capabilityCard(name as CapabilityName, cap))
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sense Settings</title>
  <style nonce="${escapeHtml(cspNonce)}">
    :root {
      color-scheme: dark;
      --bg: #0d1115;
      --panel: #151a20;
      --panel-2: #1d252d;
      --panel-3: #222c34;
      --text: #f2f4f5;
      --muted: #9da8b2;
      --line: #313942;
      --green: #64d38a;
      --blue: #78a8ff;
      --yellow: #e8c468;
      --red: #ef7f7f;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: radial-gradient(circle at top left, #18212a 0, var(--bg) 34%); color: var(--text); }
    main { max-width: 1120px; margin: 0 auto; padding: 24px; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
    h1 { font-size: 32px; margin: 0 0 8px; letter-spacing: 0; }
    h2 { font-size: 16px; margin: 0 0 8px; letter-spacing: 0; }
    h3 { font-size: 13px; margin: 16px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
    p { margin: 0; color: var(--muted); line-height: 1.45; }
    code { color: #c7d0d8; background: #0e1012; border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; }
    button { cursor: pointer; border: 1px solid #31547a; background: #19314c; color: var(--text); border-radius: 8px; padding: 10px 12px; font: inherit; transition: .16s ease; }
    button:hover { border-color: #527aa5; transform: translateY(-1px); }
    textarea { min-height: 86px; resize: vertical; background: #0e1012; color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 12px; font: inherit; line-height: 1.4; }
    .status-pill { border: 1px solid #2f5f42; background: #153220; color: var(--green); border-radius: 999px; padding: 8px 12px; white-space: nowrap; }
    .grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr); gap: 18px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .moment { margin-bottom: 16px; display: grid; gap: 14px; background: linear-gradient(135deg, #151d24, #11161b); border: 1px solid #34404a; border-radius: 8px; padding: 18px; box-shadow: 0 18px 44px rgba(0,0,0,.22); }
    .moment h1 { font-size: clamp(28px, 4vw, 48px); line-height: 1; max-width: 760px; }
    .eyebrow { color: var(--blue); text-transform: uppercase; letter-spacing: .08em; font-size: 12px; font-weight: 700; margin-bottom: 8px; }
    .chip-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
    .chip { min-height: 64px; display: grid; align-content: space-between; border: 1px solid var(--line); background: var(--panel-2); border-radius: 8px; padding: 10px; }
    .chip span, .receipt-grid span { color: var(--muted); font-size: 12px; }
    .chip strong { font-size: 14px; overflow-wrap: anywhere; }
    .chip.good { border-color: #2f5f42; }
    .chip.info { border-color: #31547a; }
    .chip.warn { border-color: #665326; }
    .chip.muted { opacity: .76; }
    .moment-footer { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(280px, .9fr); gap: 18px; border-top: 1px solid var(--line); padding-top: 18px; }
    .receipt-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .receipt-grid div { display: grid; gap: 3px; background: rgba(255,255,255,.035); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
    .tag-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .tag-row span { border: 1px solid #31547a; background: rgba(120,168,255,.12); color: #d6e3ff; border-radius: 999px; padding: 5px 8px; font-size: 12px; }
    .route-lab { display: grid; grid-template-columns: minmax(0, .8fr) minmax(280px, 1fr); gap: 16px; align-items: start; margin-bottom: 18px; }
    .route-lab form { display: grid; gap: 10px; }
    .route-examples { display: flex; flex-wrap: wrap; gap: 8px; }
    .route-examples button { padding: 7px 9px; font-size: 12px; background: #111922; border-color: var(--line); color: #cbd5df; }
    .route-summary { display: grid; gap: 8px; min-height: 116px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
    .route-summary div { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 7px; }
    .route-summary span { color: var(--muted); }
    .raw-route { margin-top: 10px; color: var(--muted); }
    .raw-route summary { cursor: pointer; }
    .route-lab pre { max-height: 220px; overflow: auto; margin: 10px 0 0; background: #0e1012; border: 1px solid var(--line); border-radius: 8px; padding: 12px; color: #cad4dc; font-size: 12px; }
    .capability { min-height: 118px; display: flex; align-items: center; justify-content: space-between; gap: 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 10px; transition: border-color .16s ease, transform .16s ease; }
    .capability:hover { border-color: #46535f; transform: translateY(-1px); }
    .capability p { max-width: 640px; margin-bottom: 12px; }
    .capability .preview { color: #c7d0d8; font-size: 13px; }
    .capability-receipt { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0 0 12px; max-width: 640px; }
    .capability-receipt div { display: grid; gap: 2px; background: rgba(255,255,255,.03); border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
    .capability-receipt span { color: var(--muted); font-size: 12px; }
    .capability-receipt strong { font-size: 12px; color: #d8e0e7; font-weight: 600; }
    .operation-state { display: inline-block; margin-left: 8px; color: var(--muted); font-size: 12px; }
    .path-input { display: block; width: min(100%, 560px); margin-top: 12px; background: #0e1012; color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; font: inherit; }
    .switch input { display: none; }
    .switch span { position: relative; display: block; width: 58px; height: 34px; background: #3a424b; border-radius: 999px; cursor: pointer; transition: background .16s ease; }
    .switch span:before { content: ""; position: absolute; top: 4px; left: 4px; width: 26px; height: 26px; background: white; border-radius: 50%; transition: transform .16s ease; }
    .switch input:checked + span { background: #2f8f55; }
    .switch input:checked + span:before { transform: translateX(24px); }
    .trust { display: grid; gap: 10px; }
    .trust div { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 10px; }
    .trust strong { color: var(--text); }
    .panel-stack { margin-top: 18px; }
    .space-top-10 { margin-top: 10px; }
    .space-top-12 { margin-top: 12px; }
    .operation-list { display: grid; gap: 8px; }
    .operation-list.compact { gap: 4px; }
    .operation-row, .operation-detail { border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); padding: 9px; }
    .operation-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; align-items: center; }
    .operation-row small { grid-column: 1 / -1; color: var(--muted); }
    .operation-detail { display: grid; gap: 6px; }
    .operation-detail div { display: flex; justify-content: space-between; gap: 8px; }
    .operation-detail small { color: var(--muted); }
    .operation-detail p { font-size: 12px; }
    .sensor-details { margin-top: 16px; }
    .sensor-details summary { cursor: pointer; color: var(--blue); margin-bottom: 10px; }
    .recommendations { margin: 12px 0 0; padding-left: 18px; color: var(--muted); line-height: 1.45; }
    .recommendations.tight { margin: 0; }
    .muted { color: var(--muted); }
    .ledger-filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    .ledger-filters button { padding: 7px 9px; font-size: 12px; background: #111922; border-color: var(--line); color: #cbd5df; }
    .snapshot-list { display: grid; gap: 10px; }
    .snapshot { display: grid; gap: 6px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
    .snapshot code { overflow-wrap: anywhere; }
    .activity-list { display: grid; gap: 10px; }
    .activity { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
    .activity div { display: flex; justify-content: space-between; gap: 12px; }
    .activity span, .activity small { color: var(--muted); }
    .activity code { overflow-wrap: anywhere; }
    .activity p { font-size: 13px; }
    .notice { margin-top: 18px; border: 1px solid #5e4d20; background: #28230f; color: var(--yellow); border-radius: 8px; padding: 14px; }
    .toast { position: fixed; right: 20px; bottom: 20px; background: #0f2719; color: var(--green); border: 1px solid #2f5f42; border-radius: 8px; padding: 12px 14px; opacity: 0; transform: translateY(8px); transition: .16s ease; }
    .toast.show { opacity: 1; transform: translateY(0); }
    @media (max-width: 860px) { main { padding: 20px; } header, .grid, .route-lab, .moment-footer { display: block; } .status-pill { display: inline-block; margin-top: 16px; } .chip-grid, .receipt-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .route-lab pre { margin-top: 12px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Sense Settings</h1>
        <p>Local device acquisition controls. Semantic sensors may sample while a client is connected; media capture always requires explicit local consent.</p>
      </div>
      <div class="status-pill">${state.operational_states.runtime.connected ? `Broker ${escapeHtml(state.operational_states.runtime.state)}` : "Settings Ready"}</div>
    </header>

    ${momentMapRows(state)}
    ${routerPlaygroundRows()}

    <div class="grid">
      <section>
        ${caps}
      </section>
      <aside>
        <section class="panel">
          <h2>Trust Model</h2>
          <div class="trust">
            <div><span>Local acquisition</span><strong>Mac / paired iPhone</strong></div>
            <div><span>Provider delivery</span><strong>Client/provider controlled</strong></div>
            <div><span>Semantic sampling</span><strong>While client connected</strong></div>
            <div><span>Media capture</span><strong>Explicit local consent</strong></div>
            <div><span>Snapshot retention</span><strong>Temporary local files</strong></div>
          </div>
          <p class="muted space-top-12">Sense keeps acquisition and brokering local. The MCP client and its model provider control any delivery beyond this device.</p>
        </section>
        <section class="panel panel-stack">
          <h2>Operational States</h2>
          ${operationalStateRows(state)}
        </section>
        <section class="panel panel-stack">
          <h2>Health</h2>
          ${healthRows(state)}
        </section>
        <section class="panel panel-stack">
          <h2>Privacy Ledger</h2>
          ${ledgerRows(state)}
        </section>
        <section class="panel panel-stack">
          <h2>Recent Tool Activity</h2>
          ${toolActivityRows(state)}
        </section>
        <section class="panel panel-stack">
          <h2>Recent Snapshots</h2>
          ${snapshotRows(state)}
        </section>
        <section class="notice">
          <strong>Reload behavior</strong><br />
          ${escapeHtml(state.restart_required_note)}
        </section>
      </aside>
    </div>
  </main>
  <div class="toast" id="toast">Saved.</div>
  <script nonce="${escapeHtml(cspNonce)}">
    const toast = document.getElementById("toast");
    function showToast(text) {
      toast.textContent = text;
      toast.classList.add("show");
      setTimeout(() => toast.classList.remove("show"), 2600);
    }
    async function updateCapability(input) {
      const capability = input.dataset.capability;
      const valueInput = document.querySelector('[data-value-for="' + capability + '"]');
      const value = valueInput ? valueInput.value : undefined;
      const response = await fetch("/api/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ capability, enabled: input.checked, value })
      });
      if (!response.ok) {
        const text = await response.text();
        input.checked = !input.checked;
        showToast(text || "Could not save");
        return;
      }
      const result = await response.json();
      showToast(result.restart_required ? "Saved. Restart the MCP client." : "Saved. Policy is live.");
    }
    document.querySelectorAll("[data-capability]").forEach((input) => {
      input.addEventListener("change", () => updateCapability(input));
    });
    const routeForm = document.getElementById("route-form");
    const routeInput = document.getElementById("route-input");
    const routeOutput = document.getElementById("route-output");
    const routeSummary = document.getElementById("route-summary");
    function escapeClientText(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
    }
    function showRouteSummary(plan) {
      const tool = plan.recommended_tools?.join(", ") || "none";
      const skipped = plan.avoided_tools?.join(", ") || "none";
      routeSummary.innerHTML =
        '<div><span>Intent</span><strong>' + escapeClientText(plan.intent) + '</strong></div>' +
        '<div><span>Tool</span><strong>' + escapeClientText(tool) + '</strong></div>' +
        '<div><span>Budget</span><strong>' + escapeClientText(plan.context_plan?.budget?.mode) + ', ' + escapeClientText(plan.context_plan?.budget?.max_tokens) + ' tokens</strong></div>' +
        '<div><span>Skipped</span><strong>' + escapeClientText(skipped) + '</strong></div>' +
        '<p>' + escapeClientText(plan.context_plan?.reason) + '</p>';
    }
    document.querySelectorAll("[data-route-example]").forEach((button) => {
      button.addEventListener("click", () => {
        routeInput.value = button.dataset.routeExample;
        routeForm.requestSubmit();
      });
    });
    routeForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      routeOutput.textContent = "Checking route...";
      const response = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ user_request: routeInput.value })
      });
      const text = await response.text();
      if (!response.ok) {
        routeSummary.textContent = text;
        routeOutput.textContent = "{}";
        return;
      }
      const plan = JSON.parse(text);
      showRouteSummary(plan);
      routeOutput.textContent = JSON.stringify(plan, null, 2);
    });
    document.querySelectorAll("[data-ledger-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        const filter = button.dataset.ledgerFilter;
        document.querySelectorAll(".ledger-entry").forEach((entry) => {
          const show =
            filter === "all" ||
            (filter === "media" && entry.dataset.media === "1") ||
            (filter === "planned" && entry.dataset.status === "planned") ||
            (filter === "iphone" && entry.dataset.tool.includes("iphone"));
          entry.hidden = !show;
        });
      });
    });
  </script>
</body>
</html>`;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = String(req.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new PanelHttpError(415, "JSON content type required");
  }
  const declared = req.headers["content-length"];
  if (typeof declared !== "string" || !/^\d+$/.test(declared)) {
    throw new PanelHttpError(411, "Content length required");
  }
  const declaredBytes = Number(declared);
  if (!Number.isSafeInteger(declaredBytes)) throw new PanelHttpError(400, "Invalid content length");
  if (declaredBytes > MAX_BODY_BYTES) throw new PanelHttpError(413, "Request body too large");
  const body = await readBoundedBody(req, MAX_BODY_BYTES);
  if (body.length !== declaredBytes) throw new PanelHttpError(400, "Content length mismatch");
  return body.length ? JSON.parse(body.toString("utf8")) : {};
}

async function readBootstrapToken(req: IncomingMessage): Promise<string> {
  const contentType = String(req.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new PanelHttpError(415, "Form content type required");
  }
  const declared = req.headers["content-length"];
  if (typeof declared !== "string" || !/^\d+$/.test(declared)) {
    throw new PanelHttpError(411, "Content length required");
  }
  const declaredBytes = Number(declared);
  if (!Number.isSafeInteger(declaredBytes)) throw new PanelHttpError(400, "Invalid content length");
  if (declaredBytes > MAX_BOOTSTRAP_BYTES) throw new PanelHttpError(413, "Request body too large");
  const body = await readBoundedBody(req, MAX_BOOTSTRAP_BYTES);
  if (body.length !== declaredBytes) throw new PanelHttpError(400, "Content length mismatch");
  const entries = [...new URLSearchParams(body.toString("utf8")).entries()];
  if (entries.length !== 1 || entries[0][0] !== "token") {
    throw new PanelHttpError(400, "Invalid bootstrap request");
  }
  return entries[0][1];
}

async function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new PanelHttpError(413, "Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

async function readBoundedTextFile(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("panel configuration is not a regular file");
    if (info.size > maxBytes) throw new Error("panel configuration is too large");
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error("panel configuration is too large");
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Read an optional Codex config: clients other than Codex never create one. */
async function readOptionalConfig(file: string, maxBytes: number): Promise<string> {
  try {
    return await readBoundedTextFile(file, maxBytes);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "";
    throw error;
  }
}

export type PanelRuntimeLoader = () => Promise<ContextResult | undefined>;

async function loadExistingBrokerRuntime(): Promise<ContextResult | undefined> {
  let client: BrokerClient | undefined;
  try {
    client = await BrokerClient.connect(defaultBrokerSocketPath(), { requestTimeoutMs: 500 });
    return await client.getContext({ refresh: "cached" });
  } catch {
    return undefined;
  } finally {
    await client?.close().catch(() => undefined);
  }
}

async function loadPanelState(
  configPath: string,
  policyFile: string | undefined,
  runtimeLoader: PanelRuntimeLoader,
): Promise<PanelState> {
  const toml = await readOptionalConfig(configPath, MAX_CONFIG_BYTES);
  const env = { ...process.env, ...parseSenseEnvFromToml(toml) };
  const store = new SensePolicyStore(policyFile ?? env.SENSE_POLICY_PATH ?? policyPath(), env);
  const [snapshots, ledger, iphoneContext, policy, runtime] = await Promise.all([
    recentSnapshots(snapshotDir(env)),
    readAccessLedger(20),
    readActiveIphoneContext(),
    store.load(),
    runtimeLoader().catch(() => undefined),
  ]);
  return sensePanelState(env, snapshots, configPath, ledger, iphoneContext, policy, runtime);
}

function capabilityPolicyKey(capability: string): PolicyKey | undefined {
  if (capability === "screen") return "window_snapshot";
  return Object.hasOwn(CAPABILITY_POLICY, capability)
    ? CAPABILITY_POLICY[capability as Exclude<CapabilityName, "workspace">]
    : undefined;
}

function envUpdateInstruction(update: { key: string; value: string | null }): string {
  return update.value === null
    ? `Remove ${update.key} from the sense entry in your MCP client configuration, then restart the client.`
    : `Set ${update.key}=${update.value} in the env block of the sense entry in your MCP client configuration, then restart the client.`;
}

/**
 * Codex keeps this setting in config.toml. Other clients never create that file, and writing one
 * would strand the value somewhere the client never reads, so hand back the env instruction instead.
 */
async function readWritableConfig(
  configPath: string,
  update: { key: string; value: string | null },
): Promise<string> {
  try {
    return await readBoundedTextFile(configPath, MAX_CONFIG_BYTES);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    throw new PanelHttpError(
      409,
      `No Codex config at ${configPath}. ${envUpdateInstruction(update)}`,
    );
  }
}

async function updatePermission(
  configPath: string,
  policyFile: string | undefined,
  input: unknown,
): Promise<{ restart_required: boolean }> {
  const body = input as { capability?: unknown; enabled?: unknown; value?: unknown };
  if (typeof body.capability !== "string" || typeof body.enabled !== "boolean") {
    throw new Error("invalid permission request");
  }
  if (body.capability === "workspace") {
    const update = capabilityToEnvUpdate(
      body.capability,
      body.enabled,
      typeof body.value === "string" ? body.value : undefined,
    );
    const current = await readWritableConfig(configPath, update);
    const updated = setSenseEnvInToml(current, update.key, update.value);
    if (Buffer.byteLength(updated) > MAX_CONFIG_BYTES) throw new Error("panel configuration is too large");
    await writeFile(configPath, updated);
    return { restart_required: true };
  }

  const key = capabilityPolicyKey(body.capability);
  if (!key) throw new Error(`Unknown capability: ${body.capability}`);
  const current = await readOptionalConfig(configPath, MAX_CONFIG_BYTES);
  const env = { ...process.env, ...parseSenseEnvFromToml(current) };
  await new SensePolicyStore(policyFile ?? env.SENSE_POLICY_PATH ?? policyPath(), env).update({
    [key]: body.enabled,
  });
  return { restart_required: false };
}

class PanelHttpError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "PanelHttpError";
  }
}

export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function panelTokenMatches(candidate: string, token: string): boolean {
  const expected = Buffer.from(token, "utf8");
  const received = Buffer.from(candidate, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function panelSessionAllowed(headers: IncomingHttpHeaders, token: string): boolean {
  const cookie = headers.cookie;
  if (typeof cookie !== "string") return false;
  const values = cookie
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${PANEL_SESSION_COOKIE}=`))
    .map((entry) => entry.slice(PANEL_SESSION_COOKIE.length + 1));
  return values.length === 1 && panelTokenMatches(values[0], token);
}

function panelSessionCookie(token: string): string {
  return `${PANEL_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

function panelSecurityHeaders(cspNonce: string): OutgoingHttpHeaders {
  return {
    "Content-Security-Policy":
      `default-src 'none'; script-src 'nonce-${cspNonce}'; style-src 'nonce-${cspNonce}'; ` +
      "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; " +
      "frame-ancestors 'none'; object-src 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), display-capture=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-DNS-Prefetch-Control": "off",
  };
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
  extraHeaders: OutgoingHttpHeaders = {},
): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(body);
}

async function acceptIphoneContext(input: unknown): Promise<IphoneBridgeReceipt> {
  const payload = await writeIphoneContextPayload(input);
  const receiptId = randomUUID();
  const acceptedFields = iphoneAcceptedFields(payload);
  await recordAccess({
    tool: "iphone_context_bridge",
    status: "completed",
    reason: `Accepted iPhone check-in with ${acceptedFields.length} semantic fields.`,
    media_captured: false,
    context_domains: ["user"],
    plan_intent: payload.internal_state.context_mode,
  }).catch(() => undefined);
  return {
    ok: true,
    stored: true,
    receipt_id: receiptId,
    accepted_at: new Date().toISOString(),
    expires_at: payload.expires_at,
    context_mode: payload.internal_state.context_mode ?? "manual",
    semantic_tags: payload.internal_state.semantic_tags ?? [],
    iphone_signals: iphoneSignalLabels(payload),
    accepted_fields: acceptedFields,
    accepted_summary: acceptedSummary(acceptedFields),
  };
}

function renderPanelLauncher(panelUrl: string, bootstrapToken: string): string {
  const nonce = randomBytes(16).toString("base64url");
  const bootstrapUrl = new URL("bootstrap", panelUrl).toString();
  const origin = new URL(panelUrl).origin;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="referrer" content="no-referrer" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${escapeHtml(nonce)}'; form-action ${escapeHtml(origin)}; base-uri 'none'" />
  <title>Opening Sense Settings</title>
</head>
<body>
  <form id="sense-launch" method="post" action="${escapeHtml(bootstrapUrl)}">
    <input type="hidden" name="token" value="${escapeHtml(bootstrapToken)}" />
    <noscript><button type="submit">Open Sense Settings</button></noscript>
  </form>
  <script nonce="${escapeHtml(nonce)}">document.getElementById("sense-launch").submit();</script>
</body>
</html>`;
}

function panelLauncherPath(): string {
  return path.join(
    os.tmpdir(),
    `sense-mcp-${process.getuid?.() ?? "user"}`,
    "panel",
    `sense-panel-${randomUUID()}.html`,
  );
}

export async function startPanel(options: {
  port?: number;
  lanBridge?: boolean;
  lanPort?: number;
  bridgeToken?: string;
  open?: boolean;
  configPath?: string;
  policyFile?: string;
  runtimeLoader?: PanelRuntimeLoader;
  openLauncher?: (launcherPath: string) => void | Promise<void>;
} = {}): Promise<{
  url: string;
  launcherPath: string;
  lanBridge?: LanBridgeState;
  close: () => Promise<void>;
}> {
  const configPath = options.configPath || process.env.SENSE_CODEX_CONFIG || DEFAULT_CODEX_CONFIG;
  const bootstrapToken = randomBytes(32).toString("base64url");
  const sessionToken = randomBytes(32).toString("base64url");
  const panelInstanceId = randomUUID();
  let bootstrapAvailable = true;
  let activeLauncherPath: string | undefined;
  let runtimeFile: string | undefined;
  const port = options.port ?? Number(process.env.SENSE_PANEL_PORT || DEFAULT_PORT);
  const runtimeLoader = options.runtimeLoader ?? loadExistingBrokerRuntime;

  const server = createServer(async (req, res) => {
    const cspNonce = randomBytes(16).toString("base64url");
    const securityHeaders = panelSecurityHeaders(cspNonce);
    const respond = (
      status: number,
      body: string,
      contentType?: string,
      extraHeaders: OutgoingHttpHeaders = {},
    ) => send(res, status, body, contentType, { ...securityHeaders, ...extraHeaders });
    if (!hostAllowed(req.headers.host)) {
      respond(403, "Forbidden host");
      return;
    }
    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url ?? "/", "http://sense.local");
    } catch {
      respond(400, "Invalid panel request");
      return;
    }
    const pathname = requestUrl.pathname;
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const privateLauncherBootstrap =
      req.method === "POST" && pathname === "/bootstrap" && origin === "null";
    if (!originAllowed(origin) && !privateLauncherBootstrap) {
      respond(403, "Forbidden origin");
      return;
    }

    try {
      if (requestUrl.search || requestUrl.hash) throw new PanelHttpError(404, "Not found");
      if (req.method === "POST" && pathname === "/bootstrap") {
        const candidate = await readBootstrapToken(req);
        if (!bootstrapAvailable || !panelTokenMatches(candidate, bootstrapToken)) {
          throw new PanelHttpError(403, "Invalid or expired panel bootstrap");
        }
        bootstrapAvailable = false;
        const launcher = activeLauncherPath;
        activeLauncherPath = undefined;
        if (launcher) await removePrivateFile(launcher).catch(() => undefined);
        respond(303, "", undefined, {
          Location: "/",
          "Set-Cookie": panelSessionCookie(sessionToken),
        });
        return;
      }
      if (req.method === "GET" && pathname === "/") {
        if (!panelSessionAllowed(req.headers, sessionToken)) {
          throw new PanelHttpError(403, "Secure panel session required");
        }
        const state = await loadPanelState(configPath, options.policyFile, runtimeLoader);
        respond(200, renderPanelHtml(state, cspNonce), "text/html; charset=utf-8");
        return;
      }
      if (pathname.startsWith("/api/") && !panelSessionAllowed(req.headers, sessionToken)) {
        throw new PanelHttpError(403, "Invalid panel session");
      }
      if (req.method === "GET" && pathname === "/api/status") {
        respond(
          200,
          JSON.stringify(await loadPanelState(configPath, options.policyFile, runtimeLoader), null, 2),
          "application/json",
        );
        return;
      }
      if (req.method === "POST" && pathname === "/api/permissions") {
        const result = await updatePermission(configPath, options.policyFile, await readJsonBody(req));
        respond(200, JSON.stringify({ ok: true, ...result }), "application/json");
        return;
      }
      if (req.method === "POST" && pathname === "/api/route") {
        const body = (await readJsonBody(req)) as { user_request?: unknown };
        if (typeof body.user_request !== "string" || !body.user_request.trim()) {
          throw new PanelHttpError(400, "user_request is required");
          return;
        }
        const plan = planRelevantContext(body.user_request.slice(0, 500));
        await recordAccess({
          tool: "panel_router_playground",
          status: "planned",
          reason: plan.context_plan.reason,
          media_captured: false,
          context_domains: [],
          plan_intent: plan.intent,
          expected_value: plan.context_plan.expected_value,
          budget_mode: plan.context_plan.budget.mode,
          max_tokens: plan.context_plan.budget.max_tokens,
          external_context_needed: plan.context_plan.external_context_needed,
        }).catch(() => undefined);
        respond(200, JSON.stringify(plan, null, 2), "application/json");
        return;
      }
      const knownPath = ["/", "/bootstrap", "/api/status", "/api/permissions", "/api/route"].includes(
        pathname,
      );
      respond(knownPath ? 405 : 404, knownPath ? "Method not allowed" : "Not found");
    } catch (err) {
      if (err instanceof PanelHttpError) respond(err.status, err.publicMessage);
      else respond(400, "Invalid panel request");
    }
  });

  server.requestTimeout = PANEL_REQUEST_TIMEOUT_MS;
  server.headersTimeout = PANEL_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 32;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://127.0.0.1:${actualPort}/`;
  const launcherPath = panelLauncherPath();
  let closePanelPromise: Promise<void> | undefined;
  const closePanelServer = () => {
    closePanelPromise ??= new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    return closePanelPromise;
  };
  let lanBridge: Awaited<ReturnType<typeof startLanIphoneBridge>> | undefined;
  try {
    lanBridge = options.lanBridge
      ? await startLanIphoneBridge(
          options.lanPort ?? Number(process.env.SENSE_LAN_BRIDGE_PORT || DEFAULT_PORT + 1),
          options.bridgeToken ||
            process.env.SENSE_IPHONE_BRIDGE_TOKEN ||
            randomBytes(32).toString("base64url"),
          (input) => acceptIphoneContext(input),
        )
      : undefined;
    await atomicWritePrivateFile(
      launcherPath,
      Buffer.from(renderPanelLauncher(url, bootstrapToken), "utf8"),
      { maxBytes: MAX_LAUNCHER_BYTES },
    );
    activeLauncherPath = launcherPath;
    runtimeFile = await writePanelRuntime(panelInstanceId, actualPort);
    if (options.open) {
      if (options.openLauncher) {
        await options.openLauncher(launcherPath);
      } else {
        const { spawn } = await import("node:child_process");
        spawn("/usr/bin/open", [launcherPath], { stdio: "ignore", detached: true }).unref();
      }
    }
  } catch (error) {
    activeLauncherPath = undefined;
    await removePrivateFile(launcherPath).catch(() => undefined);
    if (runtimeFile) await removePanelRuntime(runtimeFile);
    await lanBridge?.close().catch(() => undefined);
    await closePanelServer().catch(() => undefined);
    throw error;
  }

  return {
    url,
    launcherPath,
    ...(lanBridge
      ? { lanBridge: { url: lanBridge.url, pairingUrl: lanBridge.pairingUrl } }
      : {}),
    close: () =>
      Promise.all([
        closePanelServer(),
        lanBridge?.close() ?? Promise.resolve(),
        removePrivateFile(launcherPath).catch(() => undefined),
        runtimeFile ? removePanelRuntime(runtimeFile) : Promise.resolve(),
      ]).then(() => undefined),
  };
}
