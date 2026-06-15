import { describe, expect, test } from "vitest";
import {
  buildInitConfig,
  parseSenseEnvFromToml,
  renderClaudeDesktopInitConfig,
  renderCodexInitBlock,
  renderInitPreview,
  renderPermissionStatus,
  setSenseEnvInToml,
  upsertCodexSenseServer,
} from "../src/cli.js";
import { renderDoctorReport, type DoctorReport } from "../src/doctor.js";

const baseToml = `model = "gpt-5.5"

[mcp_servers.sense]
command = "node"
args = ["/tmp/sense/dist/index.js"]

[marketplaces.local]
source = "/tmp"
`;

describe("setSenseEnvInToml", () => {
  test("adds a sense env section when missing", () => {
    const updated = setSenseEnvInToml(baseToml, "SENSE_SCREEN_SNAPSHOT", "1");
    expect(updated).toContain("[mcp_servers.sense.env]");
    expect(updated).toContain('SENSE_SCREEN_SNAPSHOT = "1"');
    expect(updated.indexOf("[mcp_servers.sense.env]")).toBeLessThan(
      updated.indexOf("[marketplaces.local]"),
    );
  });

  test("updates an existing key and removes a disabled key", () => {
    const existing = `${baseToml}
[mcp_servers.sense.env]
SENSE_SCREEN_SNAPSHOT = "0"
SENSE_MIC_LEVEL = "1"
`;
    const enabled = setSenseEnvInToml(existing, "SENSE_SCREEN_SNAPSHOT", "1");
    expect(enabled).toContain('SENSE_SCREEN_SNAPSHOT = "1"');

    const disabled = setSenseEnvInToml(enabled, "SENSE_MIC_LEVEL", null);
    expect(disabled).not.toContain("SENSE_MIC_LEVEL");
  });
});

describe("renderDoctorReport", () => {
  test("renders actionable setup checks", () => {
    const report: DoctorReport = {
      generated_at: "2026-06-15T12:00:00.000Z",
      checks: [
        { name: "Node.js", status: "pass", detail: "v22.0.0" },
        { name: "ffmpeg", status: "fail", detail: "not found", fix: "Install ffmpeg with Homebrew." },
        { name: "Camera snapshot", status: "warn", detail: "disabled" },
      ],
    };

    const rendered = renderDoctorReport(report);
    expect(rendered).toContain("Sense Doctor");
    expect(rendered).toContain("PASS Node.js");
    expect(rendered).toContain("FAIL ffmpeg");
    expect(rendered).toContain("Fix: Install ffmpeg with Homebrew.");
  });
});

describe("renderPermissionStatus", () => {
  test("renders enabled and disabled explicit capabilities", () => {
    const rendered = renderPermissionStatus({
      SENSE_CAMERA_SNAPSHOT: "1",
      SENSE_SCREEN_SNAPSHOT: undefined,
      SENSE_MIC_LEVEL: "0",
    });
    expect(rendered).toContain("camera: enabled");
    expect(rendered).toContain("screen: disabled");
    expect(rendered).toContain("mic: disabled");
  });
});

describe("parseSenseEnvFromToml", () => {
  test("extracts the registered Codex env for sense", () => {
    const parsed = parseSenseEnvFromToml(`${baseToml}
[mcp_servers.sense.env]
SENSE_CAMERA_SNAPSHOT = "1"
SENSE_SCREEN_SNAPSHOT = "1"
`);
    expect(parsed.SENSE_CAMERA_SNAPSHOT).toBe("1");
    expect(parsed.SENSE_SCREEN_SNAPSHOT).toBe("1");
  });
});

describe("sense-mcp init helpers", () => {
  test("builds a visual Codex init config with explicit workspace context", () => {
    const config = buildInitConfig([
      "--profile",
      "visual",
      "--workspace",
      "/tmp/workspace",
      "--entry",
      "/tmp/sense/dist/index.js",
    ]);

    expect(config.client).toBe("codex");
    expect(config.profile).toBe("visual");
    expect(config.args).toEqual(["/tmp/sense/dist/index.js"]);
    expect(config.env.SENSE_CAMERA_SNAPSHOT).toBe("1");
    expect(config.env.SENSE_SCREEN_SNAPSHOT).toBe("1");
    expect(config.env.SENSE_WORKSPACE_ROOTS).toBe("/tmp/workspace");

    const block = renderCodexInitBlock(config);
    expect(block).toContain("[mcp_servers.sense]");
    expect(block).toContain('SENSE_CAMERA_SNAPSHOT = "1"');
    expect(block).toContain('SENSE_WORKSPACE_ROOTS = "/tmp/workspace"');
  });

  test("renders Claude Desktop JSON without Codex-only fields", () => {
    const config = buildInitConfig([
      "--client",
      "claude-desktop",
      "--camera",
      "--entry",
      "/tmp/sense/dist/index.js",
    ]);

    const rendered = renderClaudeDesktopInitConfig(config);
    expect(rendered).toContain('"mcpServers"');
    expect(rendered).toContain('"sense"');
    expect(rendered).toContain('"SENSE_CAMERA_SNAPSHOT": "1"');
    expect(rendered).not.toContain("startup_timeout_sec");
  });

  test("keeps an explicit entry when command appears after entry", () => {
    const config = buildInitConfig(["--entry", "/tmp/sense/dist/index.js", "--command", "node"]);
    expect(config.command).toBe("node");
    expect(config.args).toEqual(["/tmp/sense/dist/index.js"]);
  });

  test("upserts the Codex sense server while preserving unrelated config", () => {
    const config = buildInitConfig(["--screen", "--entry", "/tmp/new/dist/index.js"]);
    const updated = upsertCodexSenseServer(baseToml, config);

    expect(updated).toContain("[mcp_servers.sense]");
    expect(updated).toContain('args = ["/tmp/new/dist/index.js"]');
    expect(updated).toContain('SENSE_SCREEN_SNAPSHOT = "1"');
    expect(updated).toContain("[marketplaces.local]");
  });

  test("renders next steps in init preview", () => {
    const config = buildInitConfig(["--profile", "developer", "--entry", "/tmp/sense/dist/index.js"]);
    const preview = renderInitPreview(config);
    expect(preview).toContain("Sense init (codex, developer profile)");
    expect(preview).toContain("Run sense-mcp doctor");
  });
});
