import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  calendarProviderDoctorCheck,
  createDoctorReport,
  ffmpegDoctorCheck,
  hostProcessDoctorCheck,
  macGrantDoctorChecks,
  nodeVersionDoctorCheck,
  pathFromProcessEnvironment,
  policyDoctorChecks,
  renderDoctorReport,
  resolveHostSearchPath,
  responsibleHostApp,
} from "../src/doctor.js";
import type { PolicySnapshot } from "../src/policy.js";
import { startPanel } from "../src/panel.js";

const policy: PolicySnapshot = {
  values: {
    calendar: false,
    location: false,
    mic_level: false,
    camera_snapshot: false,
    window_snapshot: true,
    full_screen_snapshot: false,
    raw_titles: false,
  },
  sources: {
    calendar: "file",
    location: "default",
    mic_level: "default",
    camera_snapshot: "default",
    window_snapshot: "file",
    full_screen_snapshot: "default",
    raw_titles: "default",
  },
  path: "/private/policy.json",
  valid: true,
  loaded_at: "2026-07-11T12:00:00.000Z",
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("doctor privacy/runtime checks", () => {
  test("enforces the Node floor and media/calendar helper requirements", () => {
    expect(nodeVersionDoctorCheck("20.19.0")).toMatchObject({ status: "fail" });
    expect(nodeVersionDoctorCheck("22.0.0")).toMatchObject({ status: "pass" });

    const micEnabled: PolicySnapshot = {
      ...policy,
      values: { ...policy.values, mic_level: true, camera_snapshot: false },
    };
    expect(ffmpegDoctorCheck(false, micEnabled)).toMatchObject({ status: "fail" });
    expect(ffmpegDoctorCheck(false, policy)).toMatchObject({ status: "pass" });

    const calendarEnabled: PolicySnapshot = {
      ...policy,
      values: { ...policy.values, calendar: true },
    };
    expect(calendarProviderDoctorCheck(false, calendarEnabled)).toMatchObject({ status: "fail" });
    expect(calendarProviderDoctorCheck(false, policy)).toMatchObject({ status: "pass" });
  });

  test("reports central policy, shared broker, consent, and model-egress boundaries truthfully", () => {
    const checks = policyDoctorChecks(policy, 1, true);
    expect(checks.find((check) => check.name === "Central policy")).toMatchObject({ status: "pass" });
    expect(checks.find((check) => check.name === "Shared broker")).toMatchObject({ status: "pass" });
    expect(checks.find((check) => check.name === "Capture consent")?.detail).toContain("1 active");
    expect(checks.find((check) => check.name === "Window snapshot policy")?.detail).toContain("enabled");
    expect(checks.find((check) => check.name === "Full-screen snapshot policy")?.detail).toContain("disabled");
    const egress = checks.find((check) => check.name === "Model egress boundary")?.detail ?? "";
    expect(egress).toContain("MCP client and model provider");
    expect(egress).not.toContain("local-only");
  });

  test("fails closed and makes invalid policy actionable", () => {
    const checks = policyDoctorChecks(
      { ...policy, valid: false, error: "symbolic link policy" },
      undefined,
      false,
    );
    expect(checks.find((check) => check.name === "Central policy")).toMatchObject({
      status: "fail",
      fix: "Repair or remove the unsafe policy file, then run sense-mcp doctor again.",
    });
    expect(checks.find((check) => check.name === "Shared broker")?.status).toBe("warn");
  });

  test("separates a terminal-only ffmpeg from one the MCP host process can reach", () => {
    const micEnabled: PolicySnapshot = {
      ...policy,
      values: { ...policy.values, mic_level: true },
    };
    // The state lookupCommand really reaches here: the host PATH came from the sense entry's own
    // env block, so it differs from this shell's and the helper can be on one but not the other.
    // A "posix_default" host PATH cannot produce a shell_only hit at all — that source is only
    // chosen when no session PATH was measurable, and the shell_only probe reads that same PATH.
    const shellOnly = {
      command: "ffmpeg",
      available: false,
      host_path: "/usr/bin:/bin:/usr/sbin:/sbin",
      host_path_source: "client_config" as const,
      shell_only: "/opt/homebrew/bin/ffmpeg",
    };
    const shellOnlyCheck = ffmpegDoctorCheck(shellOnly, micEnabled);
    expect(shellOnlyCheck.status).toBe("warn");
    expect(shellOnlyCheck.detail).toContain("/opt/homebrew/bin/ffmpeg");
    expect(shellOnlyCheck.detail).toContain("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(shellOnlyCheck.detail).toContain("sense entry env PATH");
    expect(shellOnlyCheck.fix).toContain("/opt/homebrew/bin");

    const reachable = ffmpegDoctorCheck(
      { ...shellOnly, available: true, resolved: "/usr/bin/ffmpeg", shell_only: undefined },
      micEnabled,
    );
    expect(reachable.status).toBe("pass");
    expect(reachable.detail).toContain("/usr/bin/ffmpeg");
    expect(reachable.detail).toContain("/usr/bin:/bin:/usr/sbin:/sbin");

    const missing = ffmpegDoctorCheck({ ...shellOnly, shell_only: undefined }, micEnabled);
    expect(missing.status).toBe("fail");
  });

  test("reports macOS grants separately from Sense policy", () => {
    const cameraEnabled: PolicySnapshot = {
      ...policy,
      values: { ...policy.values, camera_snapshot: true, window_snapshot: true },
    };
    const app = { pid: 42, name: "Claude", path: "/Applications/Claude.app/Contents/MacOS/Claude" };
    const checks = macGrantDoctorChecks(
      cameraEnabled,
      { screen_recording: "not_granted", camera: "denied", microphone: "not_determined" },
      app,
    );
    const camera = checks.find((check) => check.name === "Camera grant (macOS)");
    const screen = checks.find((check) => check.name === "Screen recording grant (macOS)");
    expect(camera).toMatchObject({ status: "fail" });
    expect(camera?.detail).toContain("denied");
    expect(camera?.detail).toContain("Claude");
    expect(screen).toMatchObject({ status: "fail" });

    const policyChecks = policyDoctorChecks(cameraEnabled, 0, true);
    const cameraPolicy = policyChecks.find((check) => check.name === "Camera snapshot policy");
    expect(cameraPolicy?.detail).toContain("enabled");
    expect(checks.map((check) => check.name)).not.toContain("Camera snapshot policy");

    const granted = macGrantDoctorChecks(
      cameraEnabled,
      { screen_recording: "granted", camera: "authorized", microphone: "authorized" },
      app,
    );
    expect(granted.find((check) => check.name === "Camera grant (macOS)")).toMatchObject({
      status: "pass",
    });

    const unreadable = macGrantDoctorChecks(cameraEnabled, undefined, app);
    expect(unreadable.every((check) => check.status === "warn")).toBe(true);
  });

  test("names the app ancestor macOS will attribute the grant to", () => {
    const app = responsibleHostApp([
      { pid: 900, command: "/bin/zsh" },
      { pid: 800, command: "/Applications/Claude.app/Contents/MacOS/Claude" },
      { pid: 1, command: "/sbin/launchd" },
    ]);
    expect(app).toMatchObject({
      pid: 800,
      name: "Claude",
      path: "/Applications/Claude.app/Contents/MacOS/Claude",
    });
    expect(hostProcessDoctorCheck(app)).toMatchObject({ status: "pass" });
    expect(hostProcessDoctorCheck(app).detail).toContain("Claude.app");

    expect(responsibleHostApp([{ pid: 1, command: "/sbin/launchd" }])).toBeUndefined();
    expect(hostProcessDoctorCheck(undefined)).toMatchObject({ status: "warn" });
  });

  test("skips nested helper bundles for the outermost .app the user can actually grant", () => {
    // The real chain on a Mac running Claude Code inside Claude for Desktop, walked from process.ppid:
    // the nearest .app ancestor is a claude-code sidecar bundle under Application Support, which never
    // appears in System Settings > Privacy & Security.
    const nested = responsibleHostApp([
      { pid: 67136, command: "/bin/zsh" },
      {
        pid: 18953,
        command:
          "/Users/example/Library/Application Support/Claude/claude-code/2.1.275/claude.app/Contents/MacOS/claude",
      },
      { pid: 18952, command: "/Applications/Claude.app/Contents/Helpers/disclaimer" },
      { pid: 77057, command: "/Applications/Claude.app/Contents/MacOS/Claude" },
    ]);
    expect(nested).toMatchObject({
      pid: 77057,
      name: "Claude",
      path: "/Applications/Claude.app/Contents/MacOS/Claude",
    });

    // Helper bundles nested inside one path belong to the enclosing app too.
    expect(
      responsibleHostApp([
        {
          pid: 4242,
          command:
            "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)",
        },
      ]),
    ).toMatchObject({ name: "Claude" });
  });

  test("runs an end-to-end bounded doctor report with strict defaults", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sense-doctor-test-"));
    temporaryDirectories.push(directory);
    const previous = {
      policy: process.env.SENSE_POLICY_PATH,
      consent: process.env.SENSE_CONSENT_DIR,
    };
    process.env.SENSE_POLICY_PATH = path.join(directory, "policy.json");
    process.env.SENSE_CONSENT_DIR = path.join(directory, "consent");

    try {
      const report = await createDoctorReport(path.join(directory, "missing-config.toml"));
      const rendered = renderDoctorReport(report);

      expect(report.checks.find((check) => check.name === "Node.js")?.status).toBe("pass");
      expect(report.checks.find((check) => check.name === "Central policy")?.detail).toContain(
        "loaded from",
      );
      expect(report.checks.find((check) => check.name === "Codex config")?.status).toBe("warn");
      expect(rendered).toContain("Sense Doctor");
      expect(rendered).toContain("Model egress boundary");
    } finally {
      if (previous.policy === undefined) delete process.env.SENSE_POLICY_PATH;
      else process.env.SENSE_POLICY_PATH = previous.policy;
      if (previous.consent === undefined) delete process.env.SENSE_CONSENT_DIR;
      else process.env.SENSE_CONSENT_DIR = previous.consent;
    }
  });

  test("discovers an authenticated panel on its actual ephemeral port", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sense-doctor-panel-test-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "config.toml");
    const policyPath = path.join(directory, "policy.json");
    await writeFile(configPath, `model = "test"\n`);
    const previousPolicy = process.env.SENSE_POLICY_PATH;
    const previousRuntimeDir = process.env.SENSE_PANEL_RUNTIME_DIR;
    process.env.SENSE_POLICY_PATH = policyPath;
    process.env.SENSE_PANEL_RUNTIME_DIR = path.join(directory, "panel-runtime");
    const panel = await startPanel({
      port: 0,
      configPath,
      policyFile: policyPath,
      runtimeLoader: async () => undefined,
    });
    try {
      const report = await createDoctorReport(configPath);
      expect(report.checks.find((check) => check.name === "Settings panel")).toMatchObject({
        status: "pass",
      });
      expect(report.checks.find((check) => check.name === "Settings panel")?.detail).toContain(
        new URL(panel.url).port,
      );
    } finally {
      await panel.close();
      if (previousPolicy === undefined) delete process.env.SENSE_POLICY_PATH;
      else process.env.SENSE_POLICY_PATH = previousPolicy;
      if (previousRuntimeDir === undefined) delete process.env.SENSE_PANEL_RUNTIME_DIR;
      else process.env.SENSE_PANEL_RUNTIME_DIR = previousRuntimeDir;
    }
  });
});

/** A real `ps -wwEp <pid>` dump for /Applications/Claude.app, captured on the machine this was fixed on. */
const CLAUDE_APP_PS_DUMP = [
  "  PID TTY           TIME CMD",
  "77057 ??         8:50.42 /Applications/Claude.app/Contents/MacOS/Claude OSLogRateLimit=64 " +
    "MallocNanoZone=0 USER=example COMMAND_MODE=unix2003 " +
    "__CFBundleIdentifier=com.anthropic.claudefordesktop PATH=/usr/bin:/bin:/usr/sbin:/sbin " +
    "LOGNAME=example SSH_AUTH_SOCK=/var/run/com.apple.launchd.EXAMPLE/Listeners " +
    "HOME=/Users/example SHELL=/bin/zsh XPC_FLAGS=1",
].join("\n");

async function fakeExecutable(directory: string, command: string): Promise<string> {
  const binary = path.join(directory, command);
  await writeFile(binary, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return binary;
}

describe("doctor host PATH resolution", () => {
  test("reads the PATH out of a real process environment dump", () => {
    expect(pathFromProcessEnvironment(CLAUDE_APP_PS_DUMP)).toBe("/usr/bin:/bin:/usr/sbin:/sbin");

    // PATH entries may contain spaces; environment keys never do.
    const spaced =
      "1 ?? 0:01.00 /Applications/Thing.app/Contents/MacOS/Thing " +
      "PATH=/opt/homebrew/bin:/Applications/VMware Fusion.app/Contents/Public:/usr/bin HOME=/Users/x";
    expect(pathFromProcessEnvironment(spaced)).toBe(
      "/opt/homebrew/bin:/Applications/VMware Fusion.app/Contents/Public:/usr/bin",
    );

    expect(pathFromProcessEnvironment("  PID TTY TIME CMD\n1 ?? 0:00.01 /sbin/launchd")).toBeUndefined();
  });

  test("prefers the configured env PATH, then the measured session PATH, over any assumed one", () => {
    const appPath = { name: "Claude", path: "/usr/bin:/bin:/usr/sbin:/sbin" };

    // The client spawns the server with the configured env PATH, so following doctor's fix works.
    expect(
      resolveHostSearchPath({
        configuredPath: "/opt/homebrew/bin:/usr/bin",
        sessionPath: "/usr/local/bin:/usr/bin",
        appPath,
        platform: "darwin",
      }),
    ).toEqual({ path: "/opt/homebrew/bin:/usr/bin", source: "client_config" });

    // A CLI or terminal-hosted MCP server really does inherit this session's PATH.
    const inherited = resolveHostSearchPath({
      sessionPath: "/opt/homebrew/bin:/usr/bin:/bin",
      appPath,
      launchdPath: undefined,
      platform: "darwin",
    });
    expect(inherited).toMatchObject({ path: "/opt/homebrew/bin:/usr/bin:/bin", source: "inherited" });
    expect(inherited.app).toEqual(appPath);

    // Nothing measurable left: fall back to the launchd PATH before the POSIX constant.
    expect(
      resolveHostSearchPath({ launchdPath: "/opt/homebrew/bin:/usr/bin", platform: "darwin" }),
    ).toEqual({ path: "/opt/homebrew/bin:/usr/bin", source: "launchd" });
    expect(resolveHostSearchPath({ platform: "darwin" })).toEqual({
      path: "/usr/bin:/bin:/usr/sbin:/sbin",
      source: "posix_default",
    });
  });

  /**
   * platform only decides the last-resort default, so it is only observable once every measurable
   * candidate is gone. Asserting it against a session PATH proved nothing: that branch returns the
   * measured value on every platform, so the option could be — and was — ignored entirely.
   */
  test("does not force the macOS launchd default onto non-darwin hosts", () => {
    const darwin = resolveHostSearchPath({ platform: "darwin" });
    const linux = resolveHostSearchPath({ platform: "linux" });

    expect(darwin).toEqual({ path: "/usr/bin:/bin:/usr/sbin:/sbin", source: "posix_default" });
    expect(linux.source).toBe("posix_default");
    expect(linux.path).not.toBe(darwin.path);
    // launchd's stripped set omits /usr/local/bin, where non-macOS hosts put local installs.
    expect(linux.path).toContain("/usr/local/bin");

    // A measured PATH still wins on every platform, whatever the default would have been.
    expect(
      resolveHostSearchPath({ sessionPath: "/opt/tools/bin:/usr/bin", platform: "linux" }),
    ).toEqual({ path: "/opt/tools/bin:/usr/bin", source: "inherited" });
  });

  /**
   * (a) The regression this pins: doctor runs from a shell whose PATH carries /opt/homebrew/bin,
   * while the .app that will actually spawn the server runs with launchd's stripped PATH. The
   * helper resolves for doctor and not for the server, and reporting that as a pass with a
   * parenthetical note hid the only failure these checks exist to catch.
   */
  test("warns when the host app's own PATH cannot reach a helper doctor resolved", () => {
    const micEnabled: PolicySnapshot = {
      ...policy,
      values: { ...policy.values, mic_level: true, calendar: true },
    };
    const gapped = {
      available: true,
      resolved: "/opt/homebrew/bin/ffmpeg",
      host_path: "/opt/homebrew/bin:/usr/bin:/bin",
      host_path_source: "inherited" as const,
      host_app_gap: { name: "Claude", path: "/usr/bin:/bin:/usr/sbin:/sbin" },
    };

    const check = ffmpegDoctorCheck({ ...gapped, command: "ffmpeg" }, micEnabled);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("Claude");
    expect(check.detail).toContain("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(check.detail).toContain("/opt/homebrew/bin/ffmpeg");
    // The advice has to name the directory to add and the app to restart, or it clears nothing.
    expect(check.fix).toContain("/opt/homebrew/bin");
    expect(check.fix).toContain("env PATH");
    expect(check.fix).toContain("Claude");

    const calendar = calendarProviderDoctorCheck(
      { ...gapped, command: "icalBuddy", resolved: "/opt/homebrew/bin/icalBuddy" },
      micEnabled,
    );
    expect(calendar.status).toBe("warn");
    expect(calendar.fix).toContain("/opt/homebrew/bin");

    // No gap measured (doctor was launched by the same app, or none) stays a clean pass.
    expect(
      ffmpegDoctorCheck({ ...gapped, command: "ffmpeg", host_app_gap: undefined }, micEnabled),
    ).toMatchObject({ status: "pass" });
  });

  /** The gap only matters for a helper something enabled actually needs. */
  test("does not warn about a host app PATH gap for a helper nothing requires", () => {
    const check = ffmpegDoctorCheck(
      {
        command: "ffmpeg",
        available: true,
        resolved: "/opt/homebrew/bin/ffmpeg",
        host_path: "/opt/homebrew/bin:/usr/bin",
        host_path_source: "inherited",
        host_app_gap: { name: "Claude", path: "/usr/bin:/bin:/usr/sbin:/sbin" },
      },
      policy,
    );
    expect(check.status).toBe("pass");
    expect(check.fix).toBeUndefined();
  });

  test("resolves helpers on the PATH this session really inherited", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sense-doctor-path-"));
    temporaryDirectories.push(directory);
    const bin = path.join(directory, "bin");
    await mkdir(bin, { recursive: true });
    const icalBuddy = await fakeExecutable(bin, "icalBuddy");
    const previous = {
      policy: process.env.SENSE_POLICY_PATH,
      consent: process.env.SENSE_CONSENT_DIR,
      path: process.env.PATH,
    };
    process.env.SENSE_POLICY_PATH = path.join(directory, "policy.json");
    process.env.SENSE_CONSENT_DIR = path.join(directory, "consent");
    process.env.PATH = `${bin}${path.delimiter}${previous.path ?? ""}`;

    try {
      const report = await createDoctorReport(path.join(directory, "missing-config.toml"));
      const check = report.checks.find((entry) => entry.name === "icalBuddy");
      expect(check?.status).toBe("pass");
      expect(check?.detail).toContain(`available at ${icalBuddy}`);
      expect(check?.detail).not.toContain("shell's PATH only");
    } finally {
      if (previous.policy === undefined) delete process.env.SENSE_POLICY_PATH;
      else process.env.SENSE_POLICY_PATH = previous.policy;
      if (previous.consent === undefined) delete process.env.SENSE_CONSENT_DIR;
      else process.env.SENSE_CONSENT_DIR = previous.consent;
      if (previous.path === undefined) delete process.env.PATH;
      else process.env.PATH = previous.path;
    }
  }, 30_000);

  /**
   * (d) `which` resolves regular files. Every directory on the PATH carries the execute bit, so an
   * X_OK-only probe reports a folder named ffmpeg as the helper and doctor passes a host that has
   * no ffmpeg at all.
   */
  test("does not accept a directory on the PATH as a helper executable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sense-doctor-dir-"));
    temporaryDirectories.push(directory);
    const bin = path.join(directory, "bin");
    // A directory named exactly like the helper, execute bit and all.
    await mkdir(path.join(bin, "ffmpeg"), { recursive: true });
    const searchPath = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    const configPath = path.join(directory, "config.toml");
    await writeFile(
      configPath,
      [
        "[mcp_servers.sense]",
        'command = "node"',
        "",
        "[mcp_servers.sense.env]",
        'SENSE_MIC_LEVEL = "1"',
        `PATH = "${searchPath}"`,
        "",
      ].join("\n"),
    );
    const previous = {
      policy: process.env.SENSE_POLICY_PATH,
      consent: process.env.SENSE_CONSENT_DIR,
      path: process.env.PATH,
    };
    process.env.SENSE_POLICY_PATH = path.join(directory, "policy.json");
    process.env.SENSE_CONSENT_DIR = path.join(directory, "consent");
    // Pin this shell's PATH too, so a real Homebrew ffmpeg on the host cannot decide the result.
    process.env.PATH = searchPath;

    try {
      const report = await createDoctorReport(configPath);
      const check = report.checks.find((entry) => entry.name === "ffmpeg");
      expect(check?.status).toBe("fail");
      expect(check?.detail).toContain("not found");
      expect(check?.detail).not.toContain("available at");

      // Positive control: the same path with a real file resolves, so the test is measuring the
      // file-type check and not some unrelated reason ffmpeg went missing.
      await rm(path.join(bin, "ffmpeg"), { recursive: true });
      const ffmpeg = await fakeExecutable(bin, "ffmpeg");
      const after = await createDoctorReport(configPath);
      expect(after.checks.find((entry) => entry.name === "ffmpeg")).toMatchObject({
        status: "pass",
        detail: expect.stringContaining(`available at ${ffmpeg}`),
      });
    } finally {
      if (previous.policy === undefined) delete process.env.SENSE_POLICY_PATH;
      else process.env.SENSE_POLICY_PATH = previous.policy;
      if (previous.consent === undefined) delete process.env.SENSE_CONSENT_DIR;
      else process.env.SENSE_CONSENT_DIR = previous.consent;
      if (previous.path === undefined) delete process.env.PATH;
      else process.env.PATH = previous.path;
    }
  }, 30_000);

  /**
   * (c) Proves the shell_only branch is reachable end to end, through the real lookup rather than
   * a hand-built CommandLookup: a configured env PATH that lacks the helper, a session PATH that
   * has it. This is the only way that state arises, because every other host PATH source is the
   * session PATH itself.
   */
  test("warns when the configured env PATH misses a helper this shell can see", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sense-doctor-shellonly-"));
    temporaryDirectories.push(directory);
    const bin = path.join(directory, "bin");
    await mkdir(bin, { recursive: true });
    const ffmpeg = await fakeExecutable(bin, "ffmpeg");
    const configPath = path.join(directory, "config.toml");
    await writeFile(
      configPath,
      [
        "[mcp_servers.sense]",
        'command = "node"',
        "",
        "[mcp_servers.sense.env]",
        'SENSE_MIC_LEVEL = "1"',
        // The sense entry's PATH cannot see bin; this shell can.
        'PATH = "/usr/bin:/bin:/usr/sbin:/sbin"',
        "",
      ].join("\n"),
    );
    const previous = {
      policy: process.env.SENSE_POLICY_PATH,
      consent: process.env.SENSE_CONSENT_DIR,
      path: process.env.PATH,
    };
    process.env.SENSE_POLICY_PATH = path.join(directory, "policy.json");
    process.env.SENSE_CONSENT_DIR = path.join(directory, "consent");
    process.env.PATH = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;

    try {
      const report = await createDoctorReport(configPath);
      const check = report.checks.find((entry) => entry.name === "ffmpeg");
      expect(check?.status).toBe("warn");
      expect(check?.detail).toContain(`found at ${ffmpeg}`);
      expect(check?.detail).toContain("shell's PATH only");
      expect(check?.fix).toContain(bin);
    } finally {
      if (previous.policy === undefined) delete process.env.SENSE_POLICY_PATH;
      else process.env.SENSE_POLICY_PATH = previous.policy;
      if (previous.consent === undefined) delete process.env.SENSE_CONSENT_DIR;
      else process.env.SENSE_CONSENT_DIR = previous.consent;
      if (previous.path === undefined) delete process.env.PATH;
      else process.env.PATH = previous.path;
    }
  }, 30_000);

  test("clears the warning when the user follows the env PATH fix doctor printed", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sense-doctor-envpath-"));
    temporaryDirectories.push(directory);
    const bin = path.join(directory, "bin");
    await mkdir(bin, { recursive: true });
    const ffmpeg = await fakeExecutable(bin, "ffmpeg");
    const configPath = path.join(directory, "config.toml");
    await writeFile(
      configPath,
      [
        "[mcp_servers.sense]",
        'command = "node"',
        "",
        "[mcp_servers.sense.env]",
        'SENSE_MIC_LEVEL = "1"',
        `PATH = "${bin}:/usr/bin:/bin:/usr/sbin:/sbin"`,
        "",
      ].join("\n"),
    );
    const previous = {
      policy: process.env.SENSE_POLICY_PATH,
      consent: process.env.SENSE_CONSENT_DIR,
    };
    process.env.SENSE_POLICY_PATH = path.join(directory, "policy.json");
    process.env.SENSE_CONSENT_DIR = path.join(directory, "consent");

    try {
      const report = await createDoctorReport(configPath);
      const check = report.checks.find((entry) => entry.name === "ffmpeg");
      // mic_level is enabled, so ffmpeg is required: before this fix the configured PATH was never
      // consulted and the check warned no matter what the user put in the sense entry.
      expect(check?.status).toBe("pass");
      expect(check?.detail).toContain(`available at ${ffmpeg}`);
      expect(check?.detail).toContain("sense entry env PATH");
      expect(check?.fix).toBeUndefined();
    } finally {
      if (previous.policy === undefined) delete process.env.SENSE_POLICY_PATH;
      else process.env.SENSE_POLICY_PATH = previous.policy;
      if (previous.consent === undefined) delete process.env.SENSE_CONSENT_DIR;
      else process.env.SENSE_CONSENT_DIR = previous.consent;
    }
  }, 30_000);
});
