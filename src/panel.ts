import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSenseEnvFromToml, setSenseEnvInToml } from "./cli.js";
import {
  iphoneContextPath,
  sanitizeIphoneContextPayload,
  writeIphoneContextPayload,
  type IphoneContextPayload,
} from "./iphoneContext.js";
import { ledgerPath, readAccessLedger, recordAccess, type AccessLedgerEntry } from "./ledger.js";
import { planRelevantContext } from "./relevance.js";

const DEFAULT_CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");
const DEFAULT_PORT = 3777;
const MAX_BODY_BYTES = 16 * 1024;

type CapabilityName = "camera" | "screen" | "mic" | "rawTitles" | "workspace";

interface CapabilityState {
  label: string;
  enabled: boolean;
  env: string;
  value?: string;
  description: string;
  preview: string;
  agent_sees: string[];
  agent_never_sees: string[];
}

interface SnapshotSummary {
  name: string;
  kind: "camera" | "screen";
  path: string;
  size_bytes: number;
  modified_at: string;
}

interface ToolActivitySummary {
  tool: "take_camera_snapshot" | "take_screen_snapshot";
  status: "completed";
  observed_at: string;
  artifact_path: string;
  size_bytes: number;
  note: string;
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
    local_only: boolean;
    pull_based: boolean;
    background_capture: boolean;
    snapshots_temporary: boolean;
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
  path: string;
}

interface LanBridgeState {
  url: string;
  token: string;
}

function boolEnv(env: Record<string, string | undefined>, key: string): boolean {
  return env[key] === "1";
}

function snapshotDir(env: Record<string, string | undefined>): string {
  return env.SENSE_SNAPSHOT_DIR || path.join(os.tmpdir(), "sense-mcp", "snapshots");
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
  try {
    const payload = sanitizeIphoneContextPayload(JSON.parse(await readFile(file, "utf8")));
    return Date.parse(payload.expires_at) > Date.now() ? payload : undefined;
  } catch {
    return undefined;
  }
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
    { label: "Privacy", value: "local only", tone: "good" },
    { label: "Capture", value: "explicit only", tone: "good" },
    { label: "Enabled", value: `${enabledCount}/5`, tone: enabledCount ? "info" : "muted" },
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

function snapshotToToolActivity(snapshot: SnapshotSummary): ToolActivitySummary {
  return {
    tool: snapshot.kind === "camera" ? "take_camera_snapshot" : "take_screen_snapshot",
    status: "completed",
    observed_at: snapshot.modified_at,
    artifact_path: snapshot.path,
    size_bytes: snapshot.size_bytes,
    note: "Derived from the temporary snapshot artifact; no extra audit database is written.",
  };
}

export function sensePanelState(
  env: Record<string, string | undefined>,
  snapshots: SnapshotSummary[] = [],
  configPath = DEFAULT_CODEX_CONFIG,
  ledgerEntries: AccessLedgerEntry[] = [],
  iphoneContext?: IphoneContextPayload,
): PanelState {
  const capabilities: PanelState["capabilities"] = {
    camera: {
      label: "Camera Snapshot",
      enabled: boolEnv(env, "SENSE_CAMERA_SNAPSHOT"),
      env: "SENSE_CAMERA_SNAPSHOT",
      description: "One-off webcam snapshot for explicit visual appearance or room requests.",
      preview: "Returns one temporary PNG path only after an explicit current visual request.",
      agent_sees: ["temporary image path", "device label", "capture status"],
      agent_never_sees: ["background video", "identity profile", "camera stream"],
    },
    screen: {
      label: "Screen Snapshot",
      enabled: boolEnv(env, "SENSE_SCREEN_SNAPSHOT"),
      env: "SENSE_SCREEN_SNAPSHOT",
      description: "One-off screenshot for explicit current-screen or UI/debug requests.",
      preview: "Returns one temporary screenshot path for current UI/debug questions.",
      agent_sees: ["temporary screenshot path", "capture status", "requested mode"],
      agent_never_sees: ["background recording", "keystrokes", "private messages by default"],
    },
    mic: {
      label: "Mic Level",
      enabled: boolEnv(env, "SENSE_MIC_LEVEL"),
      env: "SENSE_MIC_LEVEL",
      description: "One-second audio level sampling for noise class only. No audio content.",
      preview: "Emits noise class and dB level; never transcript or retained audio.",
      agent_sees: ["noise class", "average level", "sample length"],
      agent_never_sees: ["audio recording", "transcript", "speaker identity"],
    },
    rawTitles: {
      label: "Raw Window Titles",
      enabled: boolEnv(env, "SENSE_RAW_TITLES"),
      env: "SENSE_RAW_TITLES",
      description: "Redacted active-window title. Off by default.",
      preview: "Adds redacted title text only when you intentionally opt in.",
      agent_sees: ["redacted title", "privacy-safe label"],
      agent_never_sees: ["unredacted secrets", "message bodies", "credentials"],
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
    },
  };
  const enabledCapabilities = Object.values(capabilities).filter((capability) => capability.enabled)
    .length;
  const recommendations = [
    ...(capabilities.camera.enabled || capabilities.screen.enabled
      ? ["Restart your MCP client after changing snapshot permissions."]
      : ["Camera and screen snapshots are off. Enable only when you need explicit visual help."]),
    ...(capabilities.mic.enabled
      ? []
      : ["Mic noise level is off. Enable mic only if you want ambient noise class in context."]),
    ...(env.SENSE_FOCUS_MODE || env.SENSE_FOCUS_SHORTCUT
      ? []
      : ["Focus mode needs SENSE_FOCUS_MODE or a macOS Shortcut named Sense Current Focus."]),
    "Run sense-mcp doctor for live Calendar, mic, focus, and ambient light diagnostics.",
    ...(capabilities.rawTitles.enabled
      ? ["Raw titles are on. Keep this disabled unless you truly need redacted titles."]
      : []),
  ];

  return {
    generated_at: new Date().toISOString(),
    config_path: configPath,
    snapshot_dir: snapshotDir(env),
    capabilities,
    moment: buildMomentMap(capabilities, recommendations, snapshots, ledgerEntries, iphoneContext),
    trust: {
      local_only: true,
      pull_based: true,
      background_capture: false,
      snapshots_temporary: true,
    },
    health: {
      enabled_capabilities: enabledCapabilities,
      snapshot_count: snapshots.length,
      last_snapshot_at: snapshots[0]?.modified_at,
      doctor_command: "sense-mcp doctor",
      recommendations,
    },
    recent_tool_activity: snapshots.map(snapshotToToolActivity),
    recent_snapshots: snapshots,
    privacy_ledger: {
      path: ledgerPath(),
      entries: ledgerEntries,
    },
    restart_required_note: "Restart Codex after changing permissions so the MCP server reloads env.",
  };
}

export function capabilityToEnvUpdate(
  capability: string,
  enabled: boolean,
  value?: string,
): { key: string; value: string | null } {
  const map: Record<string, string> = {
    camera: "SENSE_CAMERA_SNAPSHOT",
    screen: "SENSE_SCREEN_SNAPSHOT",
    mic: "SENSE_MIC_LEVEL",
    rawTitles: "SENSE_RAW_TITLES",
    workspace: "SENSE_WORKSPACE_ROOTS",
  };
  const key = map[capability];
  if (!key) throw new Error(`Unknown capability: ${capability}`);
  if (!enabled) return { key, value: null };
  if (capability === "workspace") {
    const trimmed = value?.trim();
    if (!trimmed) throw new Error("workspace requires a path");
    return { key, value: trimmed };
  }
  return { key, value: "1" };
}

export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const clean = host.toLowerCase();
  return (
    clean === "localhost" ||
    clean.startsWith("localhost:") ||
    clean === "127.0.0.1" ||
    clean.startsWith("127.0.0.1:") ||
    clean === "[::1]" ||
    clean.startsWith("[::1]:")
  );
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
    <p class="muted" style="margin-top: 12px;">Hint: ${escapeHtml(receipt.hint)}</p>`;
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
          <strong>${escapeHtml(snapshot.kind)}</strong>
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
    <p class="muted" style="margin-top: 10px;">Ledger path: <code>${escapeHtml(state.privacy_ledger.path)}</code></p>`;
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
    <p class="muted" style="margin-top: 12px;">Run <code>${escapeHtml(state.health.doctor_command)}</code> for setup and permission checks.</p>
    ${
      state.health.recommendations.length
        ? `<ul class="recommendations">${state.health.recommendations
            .map((item) => `<li>${escapeHtml(item)}</li>`)
            .join("")}</ul>`
        : ""
    }`;
}

export function renderPanelHtml(state: PanelState, token: string): string {
  const caps = Object.entries(state.capabilities)
    .map(([name, cap]) => capabilityCard(name as CapabilityName, cap))
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sense Settings</title>
  <style>
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
    .path-input { display: block; width: min(100%, 560px); margin-top: 12px; background: #0e1012; color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; font: inherit; }
    .switch input { display: none; }
    .switch span { position: relative; display: block; width: 58px; height: 34px; background: #3a424b; border-radius: 999px; cursor: pointer; transition: background .16s ease; }
    .switch span:before { content: ""; position: absolute; top: 4px; left: 4px; width: 26px; height: 26px; background: white; border-radius: 50%; transition: transform .16s ease; }
    .switch input:checked + span { background: #2f8f55; }
    .switch input:checked + span:before { transform: translateX(24px); }
    .trust { display: grid; gap: 10px; }
    .trust div { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 10px; }
    .trust strong { color: var(--text); }
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
        <p>Local context controls for AI clients. Explicit snapshots only. No background camera or screen capture.</p>
      </div>
      <div class="status-pill">Context Active</div>
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
            <div><span>Local only</span><strong>${state.trust.local_only ? "Yes" : "No"}</strong></div>
            <div><span>Pull based</span><strong>${state.trust.pull_based ? "Yes" : "No"}</strong></div>
            <div><span>Background capture</span><strong>${state.trust.background_capture ? "Yes" : "No"}</strong></div>
            <div><span>Temporary snapshots</span><strong>${state.trust.snapshots_temporary ? "Yes" : "No"}</strong></div>
          </div>
        </section>
        <section class="panel" style="margin-top: 18px;">
          <h2>Health</h2>
          ${healthRows(state)}
        </section>
        <section class="panel" style="margin-top: 18px;">
          <h2>Privacy Ledger</h2>
          ${ledgerRows(state)}
        </section>
        <section class="panel" style="margin-top: 18px;">
          <h2>Recent Tool Activity</h2>
          ${toolActivityRows(state)}
        </section>
        <section class="panel" style="margin-top: 18px;">
          <h2>Recent Snapshots</h2>
          ${snapshotRows(state)}
        </section>
        <section class="notice">
          <strong>Restart Codex</strong><br />
          ${escapeHtml(state.restart_required_note)}
        </section>
      </aside>
    </div>
  </main>
  <div class="toast" id="toast">Saved. Restart Codex.</div>
  <script>
    const token = ${JSON.stringify(token)};
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
        headers: { "Content-Type": "application/json", "X-Sense-Panel-Token": token },
        body: JSON.stringify({ capability, enabled: input.checked, value })
      });
      if (!response.ok) {
        const text = await response.text();
        input.checked = !input.checked;
        showToast(text || "Could not save");
        return;
      }
      showToast("Saved. Restart Codex.");
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
        headers: { "Content-Type": "application/json", "X-Sense-Panel-Token": token },
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
          entry.style.display = show ? "" : "none";
        });
      });
    });
  </script>
</body>
</html>`;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new Error("request body too large");
  }
  return body ? JSON.parse(body) : {};
}

async function loadPanelState(configPath: string): Promise<PanelState> {
  const toml = await readFile(configPath, "utf8");
  const env = { ...process.env, ...parseSenseEnvFromToml(toml) };
  const snapshots = await recentSnapshots(snapshotDir(env));
  const ledger = await readAccessLedger(20);
  return sensePanelState(env, snapshots, configPath, ledger, await readActiveIphoneContext());
}

async function updatePermission(configPath: string, input: unknown): Promise<void> {
  const body = input as { capability?: unknown; enabled?: unknown; value?: unknown };
  if (typeof body.capability !== "string" || typeof body.enabled !== "boolean") {
    throw new Error("invalid permission request");
  }
  const update = capabilityToEnvUpdate(
    body.capability,
    body.enabled,
    typeof body.value === "string" ? body.value : undefined,
  );
  const current = await readFile(configPath, "utf8");
  await writeFile(configPath, setSenseEnvInToml(current, update.key, update.value));
}

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain"): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function iphoneBridgeHeaderAllowed(req: IncomingMessage): boolean {
  return req.headers["x-sense-bridge"] === "sense-ios";
}

function bearerTokenAllowed(req: IncomingMessage, token: string): boolean {
  return req.headers.authorization === `Bearer ${token}`;
}

function lanAddress(): string {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return "127.0.0.1";
}

async function acceptIphoneContext(input: unknown): Promise<IphoneBridgeReceipt> {
  const payload = await writeIphoneContextPayload(input);
  const receiptId = randomUUID();
  const acceptedFields = iphoneAcceptedFields(payload);
  void recordAccess({
    tool: "iphone_context_bridge",
    status: "completed",
    reason: `Accepted iPhone check-in with ${acceptedFields.length} semantic fields.`,
    media_captured: false,
    context_domains: ["user"],
    plan_intent: payload.internal_state.context_mode,
  });
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
    path: iphoneContextPath(),
  };
}

async function startLanIphoneBridge(port: number, token: string): Promise<LanBridgeState & { close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    try {
      if (req.url !== "/api/iphone-context") {
        send(res, 404, "Not found");
        return;
      }

      if (!bearerTokenAllowed(req, token)) {
        send(res, 401, "Missing bridge token");
        return;
      }

      if (req.method === "GET") {
        send(
          res,
          200,
          JSON.stringify(
            {
              ok: true,
              accepts: "sense_ios_check_in",
              path: iphoneContextPath(),
              note: "LAN bridge is limited to iPhone companion context reads/writes.",
            },
            null,
            2,
          ),
          "application/json",
        );
        return;
      }

      if (req.method === "POST") {
        if (!iphoneBridgeHeaderAllowed(req)) {
          send(res, 403, "Missing iPhone bridge header");
          return;
        }
        send(res, 200, JSON.stringify(await acceptIphoneContext(await readJsonBody(req)), null, 2), "application/json");
        return;
      }

      send(res, 405, "Method not allowed");
    } catch (err) {
      const message = err instanceof Error ? err.message : "bridge error";
      send(res, 400, message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://${lanAddress()}:${actualPort}/api/iphone-context`,
    token,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export async function startPanel(options: {
  port?: number;
  lanBridge?: boolean;
  lanPort?: number;
  bridgeToken?: string;
  open?: boolean;
  configPath?: string;
} = {}): Promise<{ url: string; lanBridge?: LanBridgeState; close: () => Promise<void> }> {
  const configPath = options.configPath || process.env.SENSE_CODEX_CONFIG || DEFAULT_CODEX_CONFIG;
  const token = randomUUID();
  const port = options.port ?? Number(process.env.SENSE_PANEL_PORT || DEFAULT_PORT);

  const server = createServer(async (req, res) => {
    if (!hostAllowed(req.headers.host)) {
      send(res, 403, "Forbidden host");
      return;
    }

    try {
      if (req.method === "GET" && req.url === "/") {
        const state = await loadPanelState(configPath);
        send(res, 200, renderPanelHtml(state, token), "text/html; charset=utf-8");
        return;
      }
      if (req.method === "GET" && req.url === "/api/status") {
        send(res, 200, JSON.stringify(await loadPanelState(configPath), null, 2), "application/json");
        return;
      }
      if (req.method === "GET" && req.url === "/api/iphone-context") {
        send(
          res,
          200,
          JSON.stringify(
            {
              ok: true,
              accepts: "sense_ios_check_in",
              path: iphoneContextPath(),
              note: "POST semantic self-report context here from the Sense iPhone companion.",
            },
            null,
            2,
          ),
          "application/json",
        );
        return;
      }
      if (req.method === "POST" && req.url === "/api/iphone-context") {
        if (!iphoneBridgeHeaderAllowed(req)) {
          send(res, 403, "Missing iPhone bridge header");
          return;
        }
        send(res, 200, JSON.stringify(await acceptIphoneContext(await readJsonBody(req)), null, 2), "application/json");
        return;
      }
      if (req.method === "POST" && req.url === "/api/permissions") {
        if (req.headers["x-sense-panel-token"] !== token) {
          send(res, 403, "Invalid panel token");
          return;
        }
        await updatePermission(configPath, await readJsonBody(req));
        send(res, 200, JSON.stringify({ ok: true }), "application/json");
        return;
      }
      if (req.method === "POST" && req.url === "/api/route") {
        if (req.headers["x-sense-panel-token"] !== token) {
          send(res, 403, "Invalid panel token");
          return;
        }
        const body = (await readJsonBody(req)) as { user_request?: unknown };
        if (typeof body.user_request !== "string" || !body.user_request.trim()) {
          send(res, 400, "user_request is required");
          return;
        }
        const plan = planRelevantContext(body.user_request.slice(0, 500));
        void recordAccess({
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
        });
        send(res, 200, JSON.stringify(plan, null, 2), "application/json");
        return;
      }
      send(res, 404, "Not found");
    } catch (err) {
      const message = err instanceof Error ? err.message : "panel error";
      send(res, 400, message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://127.0.0.1:${actualPort}/`;
  const lanBridge = options.lanBridge
    ? await startLanIphoneBridge(
        options.lanPort ?? Number(process.env.SENSE_LAN_BRIDGE_PORT || DEFAULT_PORT + 1),
        options.bridgeToken || process.env.SENSE_IPHONE_BRIDGE_TOKEN || randomUUID(),
      )
    : undefined;

  if (options.open) {
    const { spawn } = await import("node:child_process");
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  }

  return {
    url,
    ...(lanBridge ? { lanBridge: { url: lanBridge.url, token: lanBridge.token } } : {}),
    close: () =>
      Promise.all([
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
        lanBridge?.close() ?? Promise.resolve(),
      ]).then(() => undefined),
  };
}
