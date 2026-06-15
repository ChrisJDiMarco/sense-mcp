import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSenseEnvFromToml, setSenseEnvInToml } from "./cli.js";

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
}

interface SnapshotSummary {
  name: string;
  kind: "camera" | "screen";
  path: string;
  size_bytes: number;
  modified_at: string;
}

export interface PanelState {
  generated_at: string;
  config_path: string;
  snapshot_dir: string;
  capabilities: Record<CapabilityName, CapabilityState>;
  trust: {
    local_only: boolean;
    pull_based: boolean;
    background_capture: boolean;
    snapshots_temporary: boolean;
  };
  recent_snapshots: SnapshotSummary[];
  restart_required_note: string;
}

function boolEnv(env: Record<string, string | undefined>, key: string): boolean {
  return env[key] === "1";
}

function snapshotDir(env: Record<string, string | undefined>): string {
  return env.SENSE_SNAPSHOT_DIR || path.join(os.tmpdir(), "sense-mcp", "snapshots");
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

export function sensePanelState(
  env: Record<string, string | undefined>,
  snapshots: SnapshotSummary[] = [],
  configPath = DEFAULT_CODEX_CONFIG,
): PanelState {
  return {
    generated_at: new Date().toISOString(),
    config_path: configPath,
    snapshot_dir: snapshotDir(env),
    capabilities: {
      camera: {
        label: "Camera Snapshot",
        enabled: boolEnv(env, "SENSE_CAMERA_SNAPSHOT"),
        env: "SENSE_CAMERA_SNAPSHOT",
        description: "One-off webcam snapshot for explicit visual appearance or room requests.",
      },
      screen: {
        label: "Screen Snapshot",
        enabled: boolEnv(env, "SENSE_SCREEN_SNAPSHOT"),
        env: "SENSE_SCREEN_SNAPSHOT",
        description: "One-off screenshot for explicit current-screen or UI/debug requests.",
      },
      mic: {
        label: "Mic Level",
        enabled: boolEnv(env, "SENSE_MIC_LEVEL"),
        env: "SENSE_MIC_LEVEL",
        description: "One-second audio level sampling for noise class only. No audio content.",
      },
      rawTitles: {
        label: "Raw Window Titles",
        enabled: boolEnv(env, "SENSE_RAW_TITLES"),
        env: "SENSE_RAW_TITLES",
        description: "Redacted active-window title. Off by default.",
      },
      workspace: {
        label: "Workspace Context",
        enabled: Boolean(env.SENSE_WORKSPACE_ROOTS),
        env: "SENSE_WORKSPACE_ROOTS",
        value: env.SENSE_WORKSPACE_ROOTS,
        description: "Git branch, dirty count, scripts, and project class for configured roots.",
      },
    },
    trust: {
      local_only: true,
      pull_based: true,
      background_capture: false,
      snapshots_temporary: true,
    },
    recent_snapshots: snapshots,
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
        <code>${escapeHtml(cap.env)}</code>
        ${valueInput}
      </div>
      <label class="switch">
        <input type="checkbox" data-capability="${name}" ${checked} />
        <span></span>
      </label>
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

export function renderPanelHtml(state: PanelState, token: string): string {
  const caps = Object.entries(state.capabilities)
    .map(([name, cap]) => capabilityCard(name as CapabilityName, cap))
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sense Control Panel</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101214;
      --panel: #181c20;
      --panel-2: #20262c;
      --text: #f2f4f5;
      --muted: #9da8b2;
      --line: #313942;
      --green: #64d38a;
      --yellow: #e8c468;
      --red: #ef7f7f;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    main { max-width: 1120px; margin: 0 auto; padding: 32px; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
    h1 { font-size: 32px; margin: 0 0 8px; letter-spacing: 0; }
    h2 { font-size: 16px; margin: 0 0 8px; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); line-height: 1.45; }
    code { color: #c7d0d8; background: #0e1012; border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; }
    .status-pill { border: 1px solid #2f5f42; background: #153220; color: var(--green); border-radius: 999px; padding: 8px 12px; white-space: nowrap; }
    .grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr); gap: 18px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; }
    .capability { min-height: 116px; display: flex; align-items: center; justify-content: space-between; gap: 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; margin-bottom: 12px; }
    .capability p { max-width: 640px; margin-bottom: 12px; }
    .path-input { display: block; width: min(100%, 560px); margin-top: 12px; background: #0e1012; color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; font: inherit; }
    .switch input { display: none; }
    .switch span { position: relative; display: block; width: 58px; height: 34px; background: #3a424b; border-radius: 999px; cursor: pointer; transition: background .16s ease; }
    .switch span:before { content: ""; position: absolute; top: 4px; left: 4px; width: 26px; height: 26px; background: white; border-radius: 50%; transition: transform .16s ease; }
    .switch input:checked + span { background: #2f8f55; }
    .switch input:checked + span:before { transform: translateX(24px); }
    .trust { display: grid; gap: 10px; }
    .trust div { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 10px; }
    .trust strong { color: var(--text); }
    .muted { color: var(--muted); }
    .snapshot-list { display: grid; gap: 10px; }
    .snapshot { display: grid; gap: 6px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
    .snapshot code { overflow-wrap: anywhere; }
    .notice { margin-top: 18px; border: 1px solid #5e4d20; background: #28230f; color: var(--yellow); border-radius: 8px; padding: 14px; }
    .toast { position: fixed; right: 20px; bottom: 20px; background: #0f2719; color: var(--green); border: 1px solid #2f5f42; border-radius: 8px; padding: 12px 14px; opacity: 0; transform: translateY(8px); transition: .16s ease; }
    .toast.show { opacity: 1; transform: translateY(0); }
    @media (max-width: 860px) { main { padding: 20px; } header, .grid { display: block; } .status-pill { display: inline-block; margin-top: 16px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Sense Control Panel</h1>
        <p>Local context controls for Codex. Explicit snapshots only. No background camera or screen capture.</p>
      </div>
      <div class="status-pill">Context Active</div>
    </header>

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
  return sensePanelState(env, await recentSnapshots(snapshotDir(env)), configPath);
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

export async function startPanel(options: {
  port?: number;
  open?: boolean;
  configPath?: string;
} = {}): Promise<{ url: string; close: () => Promise<void> }> {
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
      if (req.method === "POST" && req.url === "/api/permissions") {
        if (req.headers["x-sense-panel-token"] !== token) {
          send(res, 403, "Invalid panel token");
          return;
        }
        await updatePermission(configPath, await readJsonBody(req));
        send(res, 200, JSON.stringify({ ok: true }), "application/json");
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

  if (options.open) {
    const { spawn } = await import("node:child_process");
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  }

  return {
    url,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
