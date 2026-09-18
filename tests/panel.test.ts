import { describe, expect, test } from "vitest";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import type { ContextResult } from "../src/contextProvider.js";
import type { PolicySnapshot } from "../src/policy.js";
import {
  capabilityToEnvUpdate,
  hostAllowed,
  originAllowed,
  renderPanelHtml,
  sensePanelState,
  startPanel,
} from "../src/panel.js";
import { openLanBridgePayload, sealLanBridgePayload } from "../src/lanBridge.js";
import { snapshotDirectory } from "../src/snapshotFiles.js";

function policy(values: Partial<PolicySnapshot["values"]> = {}): PolicySnapshot {
  const all = {
    calendar: false,
    location: false,
    mic_level: false,
    camera_snapshot: false,
    window_snapshot: false,
    full_screen_snapshot: false,
    raw_titles: false,
    ...values,
  };
  return {
    values: all,
    sources: Object.fromEntries(Object.keys(all).map((key) => [key, "file"])) as PolicySnapshot["sources"],
    path: "/tmp/sense-policy.json",
    valid: true,
    loaded_at: new Date().toISOString(),
  };
}

function runtime(): ContextResult {
  return {
    frame: {
      spec: "context-frame/0.2",
      generated_at: new Date().toISOString(),
      staleness_ms: 0,
      privacy: {
        tier: 2,
        capabilities: { calendar: "granted", screen_activity: "granted" },
        capability_states: { calendar: "healthy", screen_activity: "healthy" },
      },
      assistive_posture: "available",
    },
    health: {
      status: "degraded",
      source: "broker",
      checked_at: new Date().toISOString(),
      diagnostics: [
        { component: "audio-level", status: "degraded", message: "Microphone permission denied." },
      ],
    },
    refreshed_domains: [],
  };
}

async function bootstrapPanel(panel: Awaited<ReturnType<typeof startPanel>>): Promise<{
  cookie: string;
  token: string;
  response: Response;
}> {
  const launcher = await readFile(panel.launcherPath, "utf8");
  const token = launcher.match(/name="token" value="([^"]+)"/)?.[1] ?? "";
  const response = await fetch(`${panel.url}bootstrap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "null",
    },
    body: new URLSearchParams({ token }),
    redirect: "manual",
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  return { cookie, token, response };
}

describe("sensePanelState", () => {
  test("enumerates policy, sensor, and capture states without claiming provider-local delivery", () => {
    const state = sensePanelState(
      { SENSE_WORKSPACE_ROOTS: "/tmp/workspace", SENSE_SNAPSHOT_DIR: "/tmp/sense-snapshots" },
      [],
      "/tmp/config.toml",
      [],
      undefined,
      policy({ calendar: true, window_snapshot: true, full_screen_snapshot: true }),
      runtime(),
    );

    expect(state.capabilities.camera.enabled).toBe(false);
    expect(state.capabilities.window.enabled).toBe(true);
    expect(state.capabilities.fullScreen.enabled).toBe(true);
    expect(state.capabilities.mic.enabled).toBe(false);
    expect(state.capabilities.workspace.value).toBe("/tmp/workspace");
    expect(state.trust.acquisition).toBe("local_devices");
    expect(state.trust.delivery).toBe("controlled_by_mcp_client_and_model_provider");
    expect(state.trust.semantic_sampling).toBe("scheduled_while_client_connected");
    expect(state.trust.media_capture).toBe("explicit_local_consent_only");
    expect(Object.keys(state.operational_states.policy)).toHaveLength(7);
    expect(Object.keys(state.operational_states.sensors).length).toBeGreaterThan(10);
    expect(state.operational_states.sensors.calendar.state).toBe("idle_on_demand");
    expect(state.operational_states.sensors["audio-level"].state).toBe("disabled");
    expect(state.operational_states.captures.window_snapshot.tools).toEqual([
      "take_window_snapshot",
      "take_screen_snapshot",
    ]);
    expect(state.operational_states.captures.full_screen_snapshot.tools).toEqual([
      "take_full_screen_snapshot",
    ]);
    expect(state.operational_states.captures.window_snapshot.detail).toContain("deprecated");
    expect(state.operational_states.captures.full_screen_snapshot.detail).toContain("entire main display");
    expect(state.health.enabled_capabilities).toBe(4);
    expect(state.health.snapshot_count).toBe(0);
    expect(state.health.doctor_command).toBe("sense-mcp doctor");
    expect(state.health.recommendations.join(" ")).toContain("Mic-level semantic sampling is disabled");
    expect(state.health.recommendations.join(" ")).toContain("broker");
    expect(state.recent_tool_activity).toEqual([]);
    expect(state.privacy_ledger.entries).toEqual([]);
  });

  test("attributes window and full-screen artifacts from ledger receipts", () => {
    const windowPath = "/tmp/sense-screen-window.png";
    const fullPath = "/tmp/sense-screen-full.png";
    const state = sensePanelState(
      {},
      [
        {
          name: "sense-camera-2026.png",
          kind: "camera",
          path: "/tmp/sense-camera-2026.png",
          size_bytes: 2048,
          modified_at: "2026-06-15T12:00:00.000Z",
        },
        {
          name: "sense-screen-window.png",
          kind: "screen",
          path: windowPath,
          size_bytes: 4096,
          modified_at: "2026-06-15T12:01:00.000Z",
        },
        {
          name: "sense-screen-full.png",
          kind: "screen",
          path: fullPath,
          size_bytes: 8192,
          modified_at: "2026-06-15T12:02:00.000Z",
        },
      ],
      "/tmp/config.toml",
      [
        {
          id: "window",
          observed_at: "2026-06-15T12:01:00.000Z",
          tool: "take_screen_snapshot",
          status: "completed",
          reason: "Compatibility window capture.",
          media_captured: true,
          context_domains: [],
          artifact_paths: [windowPath],
        },
        {
          id: "full",
          observed_at: "2026-06-15T12:02:00.000Z",
          tool: "take_full_screen_snapshot",
          status: "completed",
          reason: "Explicit full-screen capture.",
          media_captured: true,
          context_domains: [],
          artifact_paths: [fullPath],
        },
      ],
    );

    expect(state.recent_tool_activity).toHaveLength(3);
    expect(state.recent_tool_activity[0].tool).toBe("take_camera_snapshot");
    expect(state.recent_tool_activity[1].tool).toBe("take_screen_snapshot");
    expect(state.recent_tool_activity[1].capture_scope).toBe("window_only");
    expect(state.recent_tool_activity[1].note).toContain("deprecated alias");
    expect(state.recent_tool_activity[2].tool).toBe("take_full_screen_snapshot");
    expect(state.recent_tool_activity[2].capture_scope).toBe("full_screen");
  });

  test("includes privacy ledger entries when provided", () => {
    const state = sensePanelState({}, [], "/tmp/config.toml", [
      {
        id: "1",
        observed_at: "2026-06-15T12:00:00.000Z",
        tool: "get_relevant_context",
        status: "planned",
        reason: "Local context is unlikely to change the answer.",
        media_captured: false,
        context_domains: [],
        plan_intent: "no_local_context_needed",
        expected_value: "none",
        budget_mode: "none",
        max_tokens: 0,
      },
    ]);

    expect(state.privacy_ledger.entries).toHaveLength(1);
    expect(state.privacy_ledger.entries[0].tool).toBe("get_relevant_context");
  });

  test("fails closed and exposes an invalid policy as an operational error", () => {
    const invalid = { ...policy({ camera_snapshot: true }), valid: false, error: "Invalid policy file" };
    const state = sensePanelState({}, [], "/tmp/config.toml", [], undefined, invalid);
    expect(state.capabilities.camera.enabled).toBe(false);
    expect(state.operational_states.policy.camera_snapshot.state).toBe("error");
    expect(state.operational_states.captures.camera_snapshot.state).toBe("disabled");
    expect(state.health.recommendations).toContain("Invalid policy file");
  });
});

describe("capabilityToEnvUpdate", () => {
  test("maps toggle actions to allowlisted env updates", () => {
    expect(capabilityToEnvUpdate("camera", true)).toEqual({
      key: "SENSE_CAMERA_SNAPSHOT",
      value: "1",
    });
    expect(capabilityToEnvUpdate("mic", false)).toEqual({
      key: "SENSE_MIC_LEVEL",
      value: null,
    });
    expect(capabilityToEnvUpdate("workspace", true, "/tmp/repo")).toEqual({
      key: "SENSE_WORKSPACE_ROOTS",
      value: "/tmp/repo",
    });
  });

  test("rejects unknown capabilities and workspace enable without path", () => {
    expect(() => capabilityToEnvUpdate("unknown", true)).toThrow(/Unknown capability/);
    expect(() => capabilityToEnvUpdate("toString", true)).toThrow(/Unknown capability/);
    expect(() => capabilityToEnvUpdate("workspace", true)).toThrow(/requires a path/);
    expect(() => capabilityToEnvUpdate("workspace", true, "bad\npath")).toThrow(/invalid/);
  });
});

describe("hostAllowed", () => {
  test("allows only localhost host headers", () => {
    expect(hostAllowed("127.0.0.1:3777")).toBe(true);
    expect(hostAllowed("localhost:3777")).toBe(true);
    expect(hostAllowed("[::1]:3777")).toBe(true);
    expect(hostAllowed("evil.test:3777")).toBe(false);
    expect(hostAllowed("localhost:3777@evil.test")).toBe(false);
    expect(hostAllowed("localhost:3777/path")).toBe(false);
  });

  test("allows only same-loopback HTTP origins", () => {
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed("http://127.0.0.1:3777")).toBe(true);
    expect(originAllowed("http://localhost:3777")).toBe(true);
    expect(originAllowed("http://[::1]:3777")).toBe(true);
    expect(originAllowed("https://localhost:3777")).toBe(false);
    expect(originAllowed("https://evil.test")).toBe(false);
    expect(originAllowed("null")).toBe(false);
  });
});

describe("renderPanelHtml", () => {
  test("renders controls without embedding a reusable credential", () => {
    const html = renderPanelHtml(
      sensePanelState({}, [], undefined, [], undefined, policy({ camera_snapshot: true })),
      "csp-nonce",
    );

    expect(html).toContain("Sense Settings");
    expect(html).toContain("Camera Snapshot");
    expect(html).toContain("App Window Snapshot");
    expect(html).toContain("Full-Screen Snapshot");
    expect(html).toContain('nonce="csp-nonce"');
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toContain("panel-token");
    expect(html).not.toContain("X-Sense-Panel-Token");
    expect(html).toContain('credentials: "same-origin"');
    expect(html).toContain("Reload behavior");
    expect(html).toContain("Health");
    expect(html).toContain("Privacy Ledger");
    expect(html).toContain("Recent Tool Activity");
    expect(html).toContain("sense-mcp doctor");
  });

  test("renders truthful acquisition, sampling, capture, and provider-delivery claims", () => {
    const html = renderPanelHtml(sensePanelState({}), "csp-nonce");

    expect(html).toContain("Local acquisition");
    expect(html).toContain("Mac / paired iPhone");
    expect(html).toContain("Provider delivery");
    expect(html).toContain("Client/provider controlled");
    expect(html).toContain("model provider control any delivery beyond this device");
    expect(html).toContain("Semantic sampling");
    expect(html).toContain("While client connected");
    expect(html).toContain("Explicit local consent");
    expect(html).not.toContain("Local only");
    expect(html).not.toContain("Pull based");
    expect(html).toContain("take_screen_snapshot is a deprecated window-only alias");
    expect(html).toContain("take_full_screen_snapshot captures the entire main display");
  });
});

describe("startPanel", () => {
  test("exchanges a private one-use bootstrap for a cookie session", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-panel-test-"));
    const configPath = path.join(dir, "config.toml");
    await writeFile(
      configPath,
      `model = "test"

[mcp_servers.sense]
command = "node"

[mcp_servers.sense.env]
SENSE_CAMERA_SNAPSHOT = "1"
`,
    );

    const policyFile = path.join(dir, "policy.json");
    const panel = await startPanel({ port: 0, configPath, policyFile, runtimeLoader: async () => undefined });
    try {
      expect(panel.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      const launcher = await readFile(panel.launcherPath, "utf8");
      expect((await lstat(panel.launcherPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(path.dirname(panel.launcherPath))).mode & 0o777).toBe(0o700);
      expect(launcher).toContain('method="post"');
      expect(launcher).not.toContain("?token=");
      expect((await fetch(panel.url)).status).toBe(403);
      expect((await fetch(`${panel.url}?token=wrong`)).status).toBe(404);
      expect((await fetch(`${panel.url}api/status`)).status).toBe(403);

      const wrongBootstrap = await fetch(`${panel.url}bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "null" },
        body: new URLSearchParams({ token: "wrong" }),
        redirect: "manual",
      });
      expect(wrongBootstrap.status).toBe(403);

      const bootstrap = await bootstrapPanel(panel);
      expect(bootstrap.response.status).toBe(303);
      expect(bootstrap.response.headers.get("location")).toBe("/");
      expect(bootstrap.response.headers.get("set-cookie")).toContain("HttpOnly");
      expect(bootstrap.response.headers.get("set-cookie")).toContain("SameSite=Strict");
      expect(bootstrap.cookie).toMatch(/^sense_panel_session=/);
      expect(bootstrap.cookie).not.toContain(bootstrap.token);
      await expect(readFile(panel.launcherPath)).rejects.toMatchObject({ code: "ENOENT" });

      const replay = await fetch(`${panel.url}bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "null" },
        body: new URLSearchParams({ token: bootstrap.token }),
        redirect: "manual",
      });
      expect(replay.status).toBe(403);

      const firstRoot = await fetch(panel.url, { headers: { Cookie: bootstrap.cookie } });
      const firstHtml = await firstRoot.text();
      const firstNonce = firstHtml.match(/<script nonce="([^"]+)"/)?.[1];
      expect(firstHtml).not.toContain(bootstrap.token);
      expect(firstHtml).not.toContain(bootstrap.cookie.split("=", 2)[1]);

      const rootResponse = await fetch(panel.url, { headers: { Cookie: bootstrap.cookie } });
      const csp = rootResponse.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'nonce-");
      expect(csp).not.toContain("unsafe-inline");
      expect(rootResponse.headers.get("x-frame-options")).toBe("DENY");
      expect(rootResponse.headers.get("referrer-policy")).toBe("no-referrer");
      expect(rootResponse.headers.get("permissions-policy")).toContain("camera=()");
      expect(rootResponse.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(rootResponse.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      const nonce = (await rootResponse.text()).match(/<script nonce="([^"]+)"/)?.[1];
      expect(nonce).toBeTruthy();
      expect(nonce).not.toBe(firstNonce);
      expect(csp).toContain(`'nonce-${nonce}'`);

      const status = await fetch(`${panel.url}api/status`, {
        headers: { Cookie: bootstrap.cookie },
      }).then((res) => res.json());
      expect(status.capabilities.camera.enabled).toBe(true);

      const forbidden = await fetch(`${panel.url}api/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "screen", enabled: true }),
      });
      expect(forbidden.status).toBe(403);

      const saved = await fetch(`${panel.url}api/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: bootstrap.cookie },
        body: JSON.stringify({ capability: "screen", enabled: true }),
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ ok: true, restart_required: false });
      expect(JSON.parse(await readFile(policyFile, "utf8")).capabilities.window_snapshot).toBe(true);
      expect(await readFile(configPath, "utf8")).not.toContain("SENSE_SCREEN_SNAPSHOT");

      const evilOrigin = await fetch(`${panel.url}api/status`, {
        headers: { Origin: "https://evil.test", Cookie: bootstrap.cookie },
      });
      expect(evilOrigin.status).toBe(403);

      const target = new URL(panel.url);
      const evilHostStatus = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            hostname: target.hostname,
            port: target.port,
            path: "/",
            headers: { Host: "evil.test", Cookie: bootstrap.cookie },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        req.once("error", reject);
        req.end();
      });
      expect(evilHostStatus).toBe(403);

      const wrongType = await fetch(`${panel.url}api/route`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", Cookie: bootstrap.cookie },
        body: "hello",
      });
      expect(wrongType.status).toBe(415);

      const missingLengthStatus = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            hostname: target.hostname,
            port: target.port,
            path: "/api/route",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Transfer-Encoding": "chunked",
              Cookie: bootstrap.cookie,
            },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        req.once("error", reject);
        req.write(JSON.stringify({ user_request: "hello" }));
        req.end();
      });
      expect(missingLengthStatus).toBe(411);

      const oversized = await fetch(`${panel.url}api/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: bootstrap.cookie },
        body: JSON.stringify({ user_request: "x".repeat(17 * 1024) }),
      });
      expect(oversized.status).toBe(413);

      expect((await fetch(`${panel.url}api/status?debug=1`, {
        headers: { Cookie: bootstrap.cookie },
      })).status).toBe(404);
      expect((await fetch(`${panel.url}api/status`, {
        method: "PUT",
        headers: { Cookie: bootstrap.cookie },
      })).status).toBe(405);

      const routed = await fetch(`${panel.url}api/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: bootstrap.cookie },
        body: JSON.stringify({ user_request: "Can you help me debug this screen?" }),
      });
      expect(routed.status).toBe(200);
      const route = await routed.json();
      expect(route.intent).toBe("screen_debug");
      expect(route.recommended_tools).toContain("take_window_snapshot");
    } finally {
      await panel.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("passes only a protected launcher path to the OS opener", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-panel-open-test-"));
    const configPath = path.join(dir, "config.toml");
    await writeFile(configPath, `model = "test"\n`);
    const opened: string[] = [];
    const panel = await startPanel({
      port: 0,
      configPath,
      open: true,
      openLauncher: async (launcherPath) => { opened.push(launcherPath); },
    });
    try {
      expect(opened).toEqual([panel.launcherPath]);
      expect(opened[0]).not.toContain("token=");
      expect((await lstat(opened[0])).mode & 0o777).toBe(0o600);
    } finally {
      await panel.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("bounds configuration reads and keeps failures generic", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-panel-config-bound-"));
    const configPath = path.join(dir, "config.toml");
    await writeFile(configPath, "x".repeat(1024 * 1024 + 1));
    const panel = await startPanel({ port: 0, configPath, runtimeLoader: async () => undefined });
    try {
      const bootstrap = await bootstrapPanel(panel);
      expect(bootstrap.response.status).toBe(303);
      const response = await fetch(panel.url, { headers: { Cookie: bootstrap.cookie } });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Invalid panel request");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    } finally {
      await panel.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not expose a fixed-header plaintext iPhone endpoint on the settings panel", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-panel-no-plaintext-iphone-"));
    const configPath = path.join(dir, "config.toml");
    await writeFile(configPath, `model = "test"\n`);
    const panel = await startPanel({ port: 0, configPath });
    try {
      const bootstrap = await bootstrapPanel(panel);
      expect(bootstrap.response.status).toBe(303);
      expect((await fetch(`${panel.url}api/iphone-context`)).status).toBe(403);
      expect((await fetch(`${panel.url}api/iphone-context`, {
        headers: { Cookie: bootstrap.cookie },
      })).status).toBe(404);
      expect((await fetch(`${panel.url}api/iphone-context`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: bootstrap.cookie,
          "X-Sense-Bridge": "sense-ios",
        },
        body: JSON.stringify({}),
      })).status).toBe(404);
    } finally {
      await panel.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("starts a LAN-only iPhone bridge with encrypted authenticated writes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-panel-lan-test-"));
    const configPath = path.join(dir, "config.toml");
    const contextPath = path.join(dir, "iphone-context.json");
    const previousPath = process.env.SENSE_IPHONE_CONTEXT_PATH;
    process.env.SENSE_IPHONE_CONTEXT_PATH = contextPath;
    await writeFile(configPath, `model = "test"\n`);

    const panel = await startPanel({
      port: 0,
      lanBridge: true,
      lanPort: 0,
      bridgeToken: "test-token-with-at-least-32-bytes",
      configPath,
    });
    try {
      expect(panel.lanBridge?.url).toContain("/api/iphone-context");
      expect(panel.lanBridge?.pairingUrl).toContain("sense://pair?");

      const panelNotExposed = await fetch(panel.lanBridge?.url.replace("/api/iphone-context", "/api/status") ?? "");
      expect(panelNotExposed.status).toBe(404);

      const bearerOnly = await fetch(panel.lanBridge?.url ?? "", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sense-Bridge": "sense-ios",
          Authorization: "Bearer test-token-with-at-least-32-bytes",
        },
        body: JSON.stringify({}),
      });
      expect(bearerOnly.status).toBe(401);

      const requestPayload = {
        type: "sense_ios_check_in",
        generated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        source: "iphone_action_button",
        internal_state: {
          feeling: "steady",
          energy: 0.6,
          stress: 0.2,
          focus: 0.8,
          confidence: "medium",
          note: "LAN bridge check-in.",
        },
        assistive_hint: "protect_focus_and_keep_responses_concise",
        privacy: {
          scope: "semantic_self_report",
          audio_retained: "false",
        },
      };
      const encrypted = sealLanBridgePayload(
        "test-token-with-at-least-32-bytes",
        "POST",
        "/api/iphone-context",
        requestPayload,
      );
      const saved = await fetch(panel.lanBridge?.url ?? "", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.sense.encrypted+json",
          "X-Sense-Bridge": "sense-ios",
        },
        body: JSON.stringify(encrypted),
      });
      expect(saved.status).toBe(200);
      const receipt = openLanBridgePayload(
        "test-token-with-at-least-32-bytes",
        "RESPONSE",
        "/api/iphone-context",
        await saved.json(),
        { binding: encrypted.nonce },
      ) as { accepted_summary: string; path?: string };
      expect(receipt.accepted_summary).toContain("Mac accepted:");
      expect(receipt.path).toBeUndefined();
      const stored = JSON.parse(await readFile(contextPath, "utf8"));
      expect(stored.internal_state.note).toBe("LAN bridge check-in.");
    } finally {
      await panel.close();
      if (previousPath === undefined) {
        delete process.env.SENSE_IPHONE_CONTEXT_PATH;
      } else {
        process.env.SENSE_IPHONE_CONTEXT_PATH = previousPath;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects replayed, skewed, and tampered LAN envelopes", async () => {
    const panel = await startPanel({
      port: 0,
      lanBridge: true,
      lanPort: 0,
      bridgeToken: "another-test-token-with-32-bytes",
      configPath: path.join(process.cwd(), "test-fixtures", "missing-config.toml"),
    });
    try {
      const url = `${panel.lanBridge?.url ?? ""}/check`;
      const envelope = sealLanBridgePayload(
        "another-test-token-with-32-bytes",
        "POST",
        "/api/iphone-context/check",
        {},
      );
      const first = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/vnd.sense.encrypted+json", "X-Sense-Bridge": "sense-ios" },
        body: JSON.stringify(envelope),
      });
      expect(first.status).toBe(200);

      const replay = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/vnd.sense.encrypted+json", "X-Sense-Bridge": "sense-ios" },
        body: JSON.stringify(envelope),
      });
      expect(replay.status).toBe(401);

      const skewed = sealLanBridgePayload(
        "another-test-token-with-32-bytes",
        "POST",
        "/api/iphone-context/check",
        {},
        { timestamp: Date.now() - 10 * 60_000 },
      );
      expect(
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/vnd.sense.encrypted+json", "X-Sense-Bridge": "sense-ios" },
          body: JSON.stringify(skewed),
        }),
      ).toMatchObject({ status: 401 });

      const tampered = {
        ...sealLanBridgePayload(
          "another-test-token-with-32-bytes",
          "POST",
          "/api/iphone-context/check",
          {},
        ),
        ciphertext: "AA",
      };
      expect(
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/vnd.sense.encrypted+json", "X-Sense-Bridge": "sense-ios" },
          body: JSON.stringify(tampered),
        }),
      ).toMatchObject({ status: 401 });
    } finally {
      await panel.close();
    }
  });
  test("serves the panel for clients that never create a Codex config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-panel-no-config-"));
    const configPath = path.join(dir, "config.toml");
    const panel = await startPanel({
      port: 0,
      configPath,
      policyFile: path.join(dir, "policy.json"),
      runtimeLoader: async () => undefined,
    });
    try {
      const bootstrap = await bootstrapPanel(panel);
      expect(bootstrap.response.status).toBe(303);
      const root = await fetch(panel.url, { headers: { Cookie: bootstrap.cookie } });
      expect(root.status).toBe(200);

      const status = await fetch(`${panel.url}api/status`, {
        headers: { Cookie: bootstrap.cookie },
      });
      expect(status.status).toBe(200);
      expect((await status.json()).config_path).toBe(configPath);

      const saved = await fetch(`${panel.url}api/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: bootstrap.cookie },
        body: JSON.stringify({ capability: "screen", enabled: true }),
      });
      expect(saved.status).toBe(200);
      await expect(readFile(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await panel.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses to create a Codex config for a workspace root and hands back the env instruction", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-panel-no-config-workspace-"));
    const configPath = path.join(dir, "config.toml");
    const panel = await startPanel({
      port: 0,
      configPath,
      policyFile: path.join(dir, "policy.json"),
      runtimeLoader: async () => undefined,
    });
    try {
      const bootstrap = await bootstrapPanel(panel);
      const response = await fetch(`${panel.url}api/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: bootstrap.cookie },
        body: JSON.stringify({ capability: "workspace", enabled: true, value: "/tmp/workspace" }),
      });
      expect(response.status).toBe(409);
      const body = await response.text();
      expect(body).toContain("SENSE_WORKSPACE_ROOTS");
      expect(body).toContain("/tmp/workspace");
      await expect(readFile(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await panel.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports the same snapshot directory the capture path writes to", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-panel-snapshot-dir-"));
    const configPath = path.join(dir, "config.toml");
    await writeFile(configPath, `model = "test"\n`);
    const previous = process.env.SENSE_SNAPSHOT_DIR;
    delete process.env.SENSE_SNAPSHOT_DIR;
    const panel = await startPanel({
      port: 0,
      configPath,
      policyFile: path.join(dir, "policy.json"),
      runtimeLoader: async () => undefined,
    });
    try {
      const bootstrap = await bootstrapPanel(panel);
      const status = await fetch(`${panel.url}api/status`, {
        headers: { Cookie: bootstrap.cookie },
      }).then((res) => res.json());
      expect(status.snapshot_dir).toBe(snapshotDirectory());
    } finally {
      await panel.close();
      if (previous === undefined) delete process.env.SENSE_SNAPSHOT_DIR;
      else process.env.SENSE_SNAPSHOT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("still lets the Codex config override the snapshot directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-panel-snapshot-override-"));
    const configPath = path.join(dir, "config.toml");
    const override = path.join(dir, "snapshots");
    await writeFile(
      configPath,
      `[mcp_servers.sense.env]\nSENSE_SNAPSHOT_DIR = "${override}"\n`,
    );
    const previous = process.env.SENSE_SNAPSHOT_DIR;
    delete process.env.SENSE_SNAPSHOT_DIR;
    const panel = await startPanel({
      port: 0,
      configPath,
      policyFile: path.join(dir, "policy.json"),
      runtimeLoader: async () => undefined,
    });
    try {
      const bootstrap = await bootstrapPanel(panel);
      const status = await fetch(`${panel.url}api/status`, {
        headers: { Cookie: bootstrap.cookie },
      }).then((res) => res.json());
      expect(status.snapshot_dir).toBe(override);
    } finally {
      await panel.close();
      if (previous === undefined) delete process.env.SENSE_SNAPSHOT_DIR;
      else process.env.SENSE_SNAPSHOT_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
