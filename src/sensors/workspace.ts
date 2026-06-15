import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { Observation, Sensor } from "../types.js";
import { run } from "./exec.js";

const TTL_MS = 30_000;

export type WorkspaceFields = Record<string, string | number | boolean>;

interface WorkspaceMetadata {
  packageJson?: string;
  packageManager?: string;
}

function workspaceRoots(): string[] {
  return (process.env.SENSE_WORKSPACE_ROOTS ?? "")
    .split(":")
    .map((item) => item.trim())
    .filter(Boolean);
}

function branchFromHeader(header: string): string | undefined {
  const match = header.match(/^##\s+([^\s.]+)/);
  return match?.[1];
}

function dirtySeverity(count: number): string {
  if (count === 0) return "clean";
  if (count <= 5) return "light";
  if (count <= 25) return "moderate";
  return "heavy";
}

function projectType(metadata: WorkspaceMetadata): string {
  if (metadata.packageJson) return "node";
  return "unknown";
}

function sortedScripts(packageJson?: string): string[] {
  if (!packageJson) return [];
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
    return Object.keys(parsed.scripts ?? {}).sort();
  } catch {
    return [];
  }
}

export function parseWorkspaceStatus(
  workspaceName: string,
  status: string,
  metadata: WorkspaceMetadata = {},
): WorkspaceFields {
  const lines = status.split("\n").filter(Boolean);
  const branch = branchFromHeader(lines[0] ?? "");
  const dirtyCount = lines.filter((line) => !line.startsWith("##")).length;
  const scripts = sortedScripts(metadata.packageJson);

  return {
    workspace_name: workspaceName,
    ...(branch ? { git_branch: branch } : {}),
    git_dirty_count: dirtyCount,
    git_has_uncommitted_changes: dirtyCount > 0,
    git_dirty_severity: dirtySeverity(dirtyCount),
    project_type: projectType(metadata),
    ...(metadata.packageManager ? { package_manager: metadata.packageManager } : {}),
    has_test_script: scripts.includes("test"),
    has_build_script: scripts.includes("build"),
    has_dev_script: scripts.includes("dev"),
    ...(scripts.length > 0 ? { available_scripts: scripts.join(",") } : {}),
    work_mode: dirtyCount > 0 ? "implementation" : "ready",
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function packageManagerFor(root: string): Promise<string | undefined> {
  if (await exists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(root, "yarn.lock"))) return "yarn";
  if (await exists(path.join(root, "bun.lockb"))) return "bun";
  if (await exists(path.join(root, "package-lock.json"))) return "npm";
  return undefined;
}

/** Configured workspace/git state. Emits counts and branch, never filenames. */
export const workspaceSensor: Sensor = {
  name: "workspace",
  intervalMs: 30_000,
  tier: 1,
  capability: "workspace_state",
  available: async () => workspaceRoots().length > 0,
  async sample(): Promise<Observation[]> {
    const root = workspaceRoots()[0];
    if (!root) return [];

    const status = await run("git", ["-C", root, "status", "--short", "--branch"], 3000);
    if (!status) return [];

    const packageJson = await readFile(path.join(root, "package.json"), "utf8").catch(() => undefined);
    const packageManager = await packageManagerFor(root);

    return [
      {
        sensor: "workspace",
        domain: "screen",
        fields: parseWorkspaceStatus(path.basename(root), status, {
          packageJson,
          packageManager,
        }),
        observedAt: Date.now(),
        ttlMs: TTL_MS,
      },
    ];
  },
};
