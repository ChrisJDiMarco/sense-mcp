import { lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  atomicWritePrivateFile,
  assertPrivatePath,
  readPrivateText,
  withPrivateFileLock,
} from "./privateFiles.js";

const POLICY_VERSION = 1;
const MAX_POLICY_BYTES = 16 * 1024;

export const POLICY_KEYS = [
  "calendar",
  "location",
  "mic_level",
  "camera_snapshot",
  "window_snapshot",
  "full_screen_snapshot",
  "raw_titles",
] as const;

export type PolicyKey = (typeof POLICY_KEYS)[number];
export type PolicyValues = Record<PolicyKey, boolean>;
export type PolicySource = "default" | "environment" | "file";
export type PolicyPatch = Partial<Record<PolicyKey, boolean | null>>;

export interface PolicySnapshot {
  values: PolicyValues;
  sources: Record<PolicyKey, PolicySource>;
  path: string;
  valid: boolean;
  loaded_at: string;
  file_updated_at?: string;
  error?: string;
}

interface PolicyDocument {
  version: 1;
  updated_at: string;
  capabilities: Partial<Record<PolicyKey, boolean>>;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

const ENV_KEYS: Record<PolicyKey, string> = {
  calendar: "SENSE_CALENDAR",
  location: "SENSE_LOCATION",
  mic_level: "SENSE_MIC_LEVEL",
  camera_snapshot: "SENSE_CAMERA_SNAPSHOT",
  window_snapshot: "SENSE_SCREEN_SNAPSHOT",
  full_screen_snapshot: "SENSE_FULL_SCREEN_SNAPSHOT",
  raw_titles: "SENSE_RAW_TITLES",
};

const DEFAULTS: PolicyValues = {
  calendar: false,
  location: false,
  mic_level: false,
  camera_snapshot: false,
  window_snapshot: false,
  full_screen_snapshot: false,
  raw_titles: false,
};

export function policyPath(): string {
  return process.env.SENSE_POLICY_PATH || path.join(os.homedir(), ".sense-mcp", "policy.json");
}

function policyLockPath(file: string): string {
  return `${file}.lock`;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function strictEnvironment(env: Record<string, string | undefined>): {
  values: PolicyValues;
  sources: Record<PolicyKey, PolicySource>;
} {
  const values = { ...DEFAULTS };
  const sources = Object.fromEntries(POLICY_KEYS.map((key) => [key, "default"])) as Record<
    PolicyKey,
    PolicySource
  >;
  for (const key of POLICY_KEYS) {
    const raw = env[ENV_KEYS[key]];
    if (raw !== "0" && raw !== "1") continue;
    values[key] = raw === "1";
    sources[key] = "environment";
  }
  return { values, sources };
}

function parseDocument(text: string): PolicyDocument | undefined {
  try {
    const value = JSON.parse(text) as Partial<PolicyDocument>;
    if (
      value.version !== POLICY_VERSION ||
      typeof value.updated_at !== "string" ||
      !Number.isFinite(Date.parse(value.updated_at)) ||
      !value.capabilities ||
      typeof value.capabilities !== "object" ||
      Array.isArray(value.capabilities)
    ) {
      return undefined;
    }
    const capabilities: Partial<Record<PolicyKey, boolean>> = {};
    for (const [key, enabled] of Object.entries(value.capabilities)) {
      if (!POLICY_KEYS.includes(key as PolicyKey) || typeof enabled !== "boolean") return undefined;
      capabilities[key as PolicyKey] = enabled;
    }
    return {
      version: POLICY_VERSION,
      updated_at: new Date(Date.parse(value.updated_at)).toISOString(),
      capabilities,
    };
  } catch {
    return undefined;
  }
}

function applyDocument(
  file: string,
  env: Record<string, string | undefined>,
  document: PolicyDocument | undefined,
  valid: boolean,
  error?: string,
): PolicySnapshot {
  // A malformed or unsafe policy file is a tamper/error condition: ignore all
  // legacy enable flags until the operator repairs it.
  const base = valid ? strictEnvironment(env) : strictEnvironment({});
  if (document) {
    for (const [key, enabled] of Object.entries(document.capabilities)) {
      base.values[key as PolicyKey] = enabled;
      base.sources[key as PolicyKey] = "file";
    }
  }
  return {
    values: base.values,
    sources: base.sources,
    path: file,
    valid,
    loaded_at: new Date().toISOString(),
    ...(document ? { file_updated_at: document.updated_at } : {}),
    ...(error ? { error } : {}),
  };
}

async function identity(file: string): Promise<FileIdentity | undefined> {
  try {
    const resolved = await assertPrivatePath(file);
    const info = await lstat(resolved);
    if (info.isSymbolicLink()) throw new Error("Sense policy path is a symbolic link");
    if (!info.isFile()) throw new Error("Sense policy path is not a regular file");
    return {
      dev: Number(info.dev),
      ino: Number(info.ino),
      size: Number(info.size),
      mtimeMs: Number(info.mtimeMs),
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  return (
    left?.dev === right?.dev &&
    left?.ino === right?.ino &&
    left?.size === right?.size &&
    left?.mtimeMs === right?.mtimeMs
  );
}

function envSignature(env: Record<string, string | undefined>): string {
  return POLICY_KEYS.map((key) => `${key}=${env[ENV_KEYS[key]] ?? ""}`).join(";");
}

export class SensePolicyStore {
  private cached?: PolicySnapshot;
  private cachedIdentity?: FileIdentity;
  private cachedEnvironment = "";

  constructor(
    readonly file = policyPath(),
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  async load(options: { force?: boolean } = {}): Promise<PolicySnapshot> {
    const signature = envSignature(this.env);
    let currentIdentity: FileIdentity | undefined;
    try {
      currentIdentity = await identity(this.file);
    } catch (error) {
      return applyDocument(
        this.file,
        {},
        undefined,
        false,
        error instanceof Error ? error.message : "Unsafe Sense policy file",
      );
    }

    if (
      !options.force &&
      this.cached &&
      sameIdentity(currentIdentity, this.cachedIdentity) &&
      signature === this.cachedEnvironment
    ) {
      return this.cached;
    }

    if (!currentIdentity) {
      this.cached = applyDocument(this.file, this.env, undefined, true);
      this.cachedIdentity = undefined;
      this.cachedEnvironment = signature;
      return this.cached;
    }

    try {
      const document = parseDocument(await readPrivateText(this.file, MAX_POLICY_BYTES));
      if (!document) {
        this.cached = applyDocument(this.file, {}, undefined, false, "Invalid Sense policy document");
      } else {
        this.cached = applyDocument(this.file, this.env, document, true);
      }
    } catch (error) {
      this.cached = applyDocument(
        this.file,
        {},
        undefined,
        false,
        error instanceof Error ? error.message : "Could not read Sense policy",
      );
    }
    this.cachedIdentity = currentIdentity;
    this.cachedEnvironment = signature;
    return this.cached;
  }

  async update(patch: PolicyPatch): Promise<PolicySnapshot> {
    for (const [key, value] of Object.entries(patch)) {
      if (!POLICY_KEYS.includes(key as PolicyKey) || (value !== null && typeof value !== "boolean")) {
        throw new Error(`Invalid Sense policy update: ${key}`);
      }
    }

    await withPrivateFileLock(policyLockPath(this.file), async () => {
      let document: PolicyDocument = {
        version: POLICY_VERSION,
        updated_at: new Date().toISOString(),
        capabilities: {},
      };
      try {
        const text = await readPrivateText(this.file, MAX_POLICY_BYTES);
        const existing = parseDocument(text);
        if (!existing) throw new Error("Refusing to overwrite an invalid Sense policy document");
        document = existing;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }

      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete document.capabilities[key as PolicyKey];
        else document.capabilities[key as PolicyKey] = value;
      }
      document.updated_at = new Date().toISOString();
      await atomicWritePrivateFile(this.file, `${JSON.stringify(document, null, 2)}\n`, {
        maxBytes: MAX_POLICY_BYTES,
      });
    });
    return this.load({ force: true });
  }
}

export async function loadSensePolicy(
  env: Record<string, string | undefined> = process.env,
): Promise<PolicySnapshot> {
  return new SensePolicyStore(policyPath(), env).load();
}

export async function updateSensePolicy(
  patch: PolicyPatch,
  env: Record<string, string | undefined> = process.env,
): Promise<PolicySnapshot> {
  return new SensePolicyStore(policyPath(), env).update(patch);
}

let sharedStore: SensePolicyStore | undefined;

/** Process-local cached store; reloads file content when its inode/mtime changes. */
export function sensePolicyStore(): SensePolicyStore {
  const file = policyPath();
  if (!sharedStore || sharedStore.file !== file) {
    sharedStore = new SensePolicyStore(file, process.env);
  }
  return sharedStore;
}

/** Sensor-friendly fail-closed policy check suitable for every availability/sample call. */
export async function policyEnabled(key: PolicyKey): Promise<boolean> {
  const snapshot = await sensePolicyStore().load();
  return snapshot.valid && snapshot.values[key] === true;
}
