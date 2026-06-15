import { describe, expect, test } from "vitest";
import { parseSenseEnvFromToml, renderPermissionStatus, setSenseEnvInToml } from "../src/cli.js";
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
