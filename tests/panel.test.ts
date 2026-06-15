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
    expect(state.recent_tool_activity).toEqual([]);
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

    expect(html).toContain("Sense Control Panel");
    expect(html).toContain("Camera Snapshot");
    expect(html).toContain("Screen Snapshot");
    expect(html).toContain("panel-token");
    expect(html).toContain("Restart Codex");
    expect(html).toContain("Health");
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
    } finally {
      await panel.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
