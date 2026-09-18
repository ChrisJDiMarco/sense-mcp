import { lstat, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  buildInitConfig,
  capabilityPolicyKey,
  handoffPairingLink,
  parseSenseEnvFromToml,
  renderClaudeDesktopInitConfig,
  renderCodexInitBlock,
  renderInitPreview,
  renderPermissionStatus,
  runCli,
  setSenseEnvInToml,
  upsertCodexSenseServer,
} from "../src/cli.js";
import type { PolicyValues } from "../src/policy.js";
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
    expect(rendered).toContain("capture-consent: required");
    expect(rendered).toContain("model-egress: controlled by the MCP client and model provider");
    expect(rendered).not.toContain("local-only model");
  });

  test("renders authoritative central policy values and runtime state", () => {
    const values: PolicyValues = {
      calendar: true,
      location: false,
      mic_level: false,
      camera_snapshot: false,
      window_snapshot: true,
      full_screen_snapshot: false,
      raw_titles: false,
    };
    const rendered = renderPermissionStatus({}, values, {
      policyPath: "/private/policy.json",
      policyValid: true,
      activeConsentReceipts: 2,
      broker: "reachable",
    });
    expect(rendered).toContain("calendar: enabled");
    expect(rendered).toContain("window: enabled");
    expect(rendered).toContain("full-screen: disabled");
    expect(rendered).toContain("active-consent-receipts: 2");
    expect(rendered).toContain("broker: reachable");
    expect(rendered).toContain("policy: loaded from /private/policy.json");
  });
});

describe("central capability mapping", () => {
  test("maps compatibility aliases onto one policy key", () => {
    expect(capabilityPolicyKey("screen")).toBe("window_snapshot");
    expect(capabilityPolicyKey("window")).toBe("window_snapshot");
    expect(capabilityPolicyKey("full-screen")).toBe("full_screen_snapshot");
    expect(capabilityPolicyKey("calendar")).toBe("calendar");
  });
});

describe("iPhone pairing handoff", () => {
  test("copies the secret through stdin but never includes it in terminal output", async () => {
    const pairingUrl = "sense://pair?url=https%3A%2F%2Flocal&secret=top-secret";
    let copied = "";
    const message = await handoffPairingLink(pairingUrl, async (value) => {
      copied = value;
    });
    expect(copied).toBe(pairingUrl);
    expect(message).toBe("iPhone pairing link copied to clipboard.");
    expect(message).not.toContain("top-secret");
  });

  test("uses a secret-free fallback when clipboard handoff fails", async () => {
    const message = await handoffPairingLink(
      "sense://pair?url=https%3A%2F%2Flocal&secret=top-secret",
      async () => {
        throw new Error("pbcopy failed: top-secret");
      },
    );
    expect(message).toContain("could not be copied");
    expect(message).toContain("rerun the LAN settings command");
    expect(message).not.toContain("top-secret");
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
    expect(preview).toContain("sense-mcp settings --open");
  });
});

describe("sense-mcp broker", () => {
  async function captureCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...parts) => {
      out.push(parts.join(" "));
    });
    const error = vi.spyOn(console, "error").mockImplementation((...parts) => {
      err.push(parts.join(" "));
    });
    try {
      return { code: await runCli(argv), out: out.join("\n"), err: err.join("\n") };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  }

  test("reset clears the runtime files of a broker that is gone", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sense-cli-broker-reset-"));
    const socketPath = path.join(dir, "broker.sock");
    await writeFile(socketPath, "stale");
    await writeFile(`${socketPath}.owner.json`, "{}");
    const previous = process.env.SENSE_BROKER_SOCKET;
    process.env.SENSE_BROKER_SOCKET = socketPath;

    try {
      const result = await captureCli(["broker", "reset"]);

      expect(result.code).toBe(0);
      expect(result.out).toContain(`Sense broker socket: ${socketPath}`);
      expect(result.out).toContain(`Removed ${socketPath}`);
      expect(result.out).toContain("Sense will elect a new broker");
      await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previous === undefined) delete process.env.SENSE_BROKER_SOCKET;
      else process.env.SENSE_BROKER_SOCKET = previous;
    }
  });

  test("rejects an unknown broker subcommand", async () => {
    const result = await captureCli(["broker", "restart"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("Unknown broker command: restart");
    expect(result.err).toContain("sense-mcp broker <command>");
  });
});
