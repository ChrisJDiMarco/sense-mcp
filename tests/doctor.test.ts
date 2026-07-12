import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  calendarProviderDoctorCheck,
  createDoctorReport,
  ffmpegDoctorCheck,
  nodeVersionDoctorCheck,
  policyDoctorChecks,
  renderDoctorReport,
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
