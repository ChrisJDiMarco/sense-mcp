import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  capabilityToEnvUpdate,
  hostAllowed,
  renderPanelHtml,
  sensePanelState,
  startPanel,
} from "../src/panel.js";

describe("sensePanelState", () => {
  test("builds trust-oriented panel state from Codex env", () => {
    const state = sensePanelState({
      SENSE_CAMERA_SNAPSHOT: "1",
      SENSE_SCREEN_SNAPSHOT: "1",
      SENSE_MIC_LEVEL: undefined,
      SENSE_RAW_TITLES: "0",
      SENSE_WORKSPACE_ROOTS: "/tmp/workspace",
      SENSE_SNAPSHOT_DIR: "/tmp/sense-snapshots",
    });

    expect(state.capabilities.camera.enabled).toBe(true);
    expect(state.capabilities.screen.enabled).toBe(true);
    expect(state.capabilities.mic.enabled).toBe(false);
    expect(state.capabilities.workspace.value).toBe("/tmp/workspace");
    expect(state.trust.local_only).toBe(true);
    expect(state.trust.background_capture).toBe(false);
    expect(state.health.enabled_capabilities).toBe(3);
    expect(state.health.snapshot_count).toBe(0);
    expect(state.health.doctor_command).toBe("sense-mcp doctor");
    expect(state.health.recommendations.join(" ")).toContain("Mic noise level is off");
    expect(state.health.recommendations.join(" ")).toContain("Focus mode needs");
    expect(state.recent_tool_activity).toEqual([]);
    expect(state.privacy_ledger.entries).toEqual([]);
  });

  test("derives recent explicit tool activity from temp snapshot metadata", () => {
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
          name: "sense-screen-2026.png",
          kind: "screen",
          path: "/tmp/sense-screen-2026.png",
          size_bytes: 4096,
          modified_at: "2026-06-15T12:01:00.000Z",
        },
      ],
    );

    expect(state.recent_tool_activity).toHaveLength(2);
    expect(state.recent_tool_activity[0].tool).toBe("take_camera_snapshot");
    expect(state.recent_tool_activity[1].tool).toBe("take_screen_snapshot");
    expect(state.recent_tool_activity[0].note).toContain("no extra audit database");
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
    expect(() => capabilityToEnvUpdate("workspace", true)).toThrow(/requires a path/);
  });
});

describe("hostAllowed", () => {
  test("allows only localhost host headers", () => {
    expect(hostAllowed("127.0.0.1:3777")).toBe(true);
    expect(hostAllowed("localhost:3777")).toBe(true);
    expect(hostAllowed("[::1]:3777")).toBe(true);
    expect(hostAllowed("evil.test:3777")).toBe(false);
  });
});

describe("renderPanelHtml", () => {
  test("renders controls and embeds the panel token", () => {
    const html = renderPanelHtml(
      sensePanelState({ SENSE_CAMERA_SNAPSHOT: "1", SENSE_SCREEN_SNAPSHOT: "0" }),
      "panel-token",
    );

    expect(html).toContain("Sense Settings");
    expect(html).toContain("Camera Snapshot");
    expect(html).toContain("Screen Snapshot");
    expect(html).toContain("panel-token");
    expect(html).toContain("Restart Codex");
    expect(html).toContain("Health");
    expect(html).toContain("Privacy Ledger");
    expect(html).toContain("Recent Tool Activity");
    expect(html).toContain("sense-mcp doctor");
  });

  test("renders trust model booleans without inverting background capture", () => {
    const html = renderPanelHtml(sensePanelState({}), "panel-token");

    expect(html).toContain("<div><span>Local only</span><strong>Yes</strong></div>");
    expect(html).toContain("<div><span>Pull based</span><strong>Yes</strong></div>");
    expect(html).toContain("<div><span>Background capture</span><strong>No</strong></div>");
    expect(html).toContain("<div><span>Temporary snapshots</span><strong>Yes</strong></div>");
  });
});

describe("startPanel", () => {
  test("serves status and requires token for permission updates", async () => {
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

    const panel = await startPanel({ port: 0, configPath });
    try {
      const html = await fetch(panel.url).then((res) => res.text());
      const token = html.match(/const token = "([^"]+)"/)?.[1];
      expect(token).toBeTruthy();

      const status = await fetch(`${panel.url}api/status`).then((res) => res.json());
      expect(status.capabilities.camera.enabled).toBe(true);

      const forbidden = await fetch(`${panel.url}api/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "screen", enabled: true }),
      });
      expect(forbidden.status).toBe(403);

      const saved = await fetch(`${panel.url}api/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sense-Panel-Token": token ?? "" },
        body: JSON.stringify({ capability: "screen", enabled: true }),
      });
      expect(saved.status).toBe(200);
      expect(await readFile(configPath, "utf8")).toContain('SENSE_SCREEN_SNAPSHOT = "1"');

      const routed = await fetch(`${panel.url}api/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sense-Panel-Token": token ?? "" },
        body: JSON.stringify({ user_request: "Can you help me debug this screen?" }),
      });
      expect(routed.status).toBe(200);
      const route = await routed.json();
      expect(route.intent).toBe("screen_debug");
      expect(route.recommended_tools).toContain("take_screen_snapshot");
    } finally {
      await panel.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("accepts iPhone companion context on the local bridge endpoint", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-panel-iphone-test-"));
    const configPath = path.join(dir, "config.toml");
    const contextPath = path.join(dir, "iphone-context.json");
    const previousPath = process.env.SENSE_IPHONE_CONTEXT_PATH;
    process.env.SENSE_IPHONE_CONTEXT_PATH = contextPath;
    await writeFile(configPath, `model = "test"\n`);

    const panel = await startPanel({ port: 0, configPath });
    try {
      const status = await fetch(`${panel.url}api/iphone-context`).then((res) => res.json());
      expect(status.ok).toBe(true);
      expect(status.accepts).toBe("sense_ios_check_in");

      const forbidden = await fetch(`${panel.url}api/iphone-context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          generated_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          internal_state: { note: "missing bridge header" },
        }),
      });
      expect(forbidden.status).toBe(403);

      const saved = await fetch(`${panel.url}api/iphone-context`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sense-Bridge": "sense-ios" },
        body: JSON.stringify({
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
            note: "Testing the companion bridge.",
            context_mode: "deep_work",
            semantic_tags: ["protect_focus", "direct"],
          },
          iphone_context: {
            generated_at: new Date().toISOString(),
            device: {
              battery_percent: 0.5,
              power_state: "battery",
              low_power_mode: true,
              thermal_state: "nominal",
              device_model: "iPhone",
              system_version: "26.5",
            },
          },
          assistive_hint: "protect_focus_and_keep_responses_concise",
          privacy: {
            scope: "semantic_self_report",
            audio_retained: "false",
          },
        }),
      });
      expect(saved.status).toBe(200);
      const receipt = await saved.json();
      expect(receipt.receipt_id).toBeTruthy();
      expect(receipt.context_mode).toBe("deep_work");
      expect(receipt.semantic_tags).toEqual(["protect_focus", "direct"]);
      expect(receipt.iphone_signals).toEqual(["device"]);
      expect(receipt.accepted_fields).toContain("semantic_tags");
      expect(receipt.accepted_summary).toContain("Mac accepted:");
      const stored = JSON.parse(await readFile(contextPath, "utf8"));
      expect(stored.internal_state.note).toBe("Testing the companion bridge.");
      expect(stored.internal_state.context_mode).toBe("deep_work");
      expect(stored.iphone_context.device.low_power_mode).toBe(true);
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

  test("starts a LAN-only iPhone bridge with bearer-token writes", async () => {
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
      bridgeToken: "test-token",
      configPath,
    });
    try {
      expect(panel.lanBridge?.url).toContain("/api/iphone-context");
      expect(panel.lanBridge?.token).toBe("test-token");

      const panelNotExposed = await fetch(panel.lanBridge?.url.replace("/api/iphone-context", "/api/status") ?? "");
      expect(panelNotExposed.status).toBe(404);

      const missingToken = await fetch(panel.lanBridge?.url ?? "", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sense-Bridge": "sense-ios" },
        body: JSON.stringify({}),
      });
      expect(missingToken.status).toBe(401);

      const missingHeader = await fetch(panel.lanBridge?.url ?? "", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: JSON.stringify({}),
      });
      expect(missingHeader.status).toBe(403);

      const saved = await fetch(panel.lanBridge?.url ?? "", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sense-Bridge": "sense-ios",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({
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
        }),
      });
      expect(saved.status).toBe(200);
      const receipt = await saved.json();
      expect(receipt.accepted_summary).toContain("Mac accepted:");
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
});
