import type { CaptureConsentRequest, ConsentDecision } from "../consent.js";
import { consumeConsentReceipt, requestLocalConsent } from "../consent.js";
import { policyEnabled } from "../policy.js";
import { readPrivateFile, removePrivateFile } from "../privateFiles.js";
import type { PersistedSnapshot } from "../snapshotFiles.js";
import {
  createSnapshotPath,
  finalizeSnapshotFile,
  persistSnapshotBuffer as persistSnapshotFileBuffer,
} from "../snapshotFiles.js";
import { isMac, runCapture, type CommandResult } from "./exec.js";

const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;

export type ScreenSnapshotMode =
  | "screen_debug"
  | "ui_feedback"
  | "screen_summary"
  | "reading_help"
  | "general_screen";

export interface ScreenSnapshot {
  ok: boolean;
  generated_at: string;
  mode: ScreenSnapshotMode;
  mimeType?: "image/png";
  data?: string;
  path?: string;
  markdown_image?: string;
  size_bytes?: number;
  window_id?: number;
  error?: string;
}

interface SharedScreenCaptureDependencies {
  isMac: boolean;
  requestConsent: (request: CaptureConsentRequest) => Promise<ConsentDecision>;
  consumeConsent: (id: string, request: CaptureConsentRequest) => Promise<ConsentDecision>;
  runCommand: (
    command: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<CommandResult | null>;
  createPath: (generatedAt: string) => Promise<string>;
  readSnapshot: (file: string) => Promise<Buffer>;
  finalize: (file: string) => Promise<PersistedSnapshot>;
  cleanup: (file: string) => Promise<unknown>;
}

interface WindowCaptureDependencies extends SharedScreenCaptureDependencies {
  policyEnabled: () => Promise<boolean>;
  resolveWindowTarget: (
    requestedWindowId?: number,
    signal?: AbortSignal,
  ) => Promise<WindowTarget | null>;
}

interface FullScreenCaptureDependencies extends SharedScreenCaptureDependencies {
  policyEnabled: () => Promise<boolean>;
}

export interface WindowTarget {
  window_id: number;
  owner_pid: number;
  app: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const WINDOW_TARGET_SCRIPT = `
ObjC.import("Cocoa");
function run(argv) {
  const requested = argv.length > 0 ? Number(argv[0]) : 0;
  const frontmostPid = Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17, $.kCGNullWindowID));
  for (let index = 0; index < Number(list.count); index += 1) {
    const item = list.objectAtIndex(index);
    const windowId = Number(ObjC.unwrap(item.objectForKey("kCGWindowNumber")));
    const ownerPid = Number(ObjC.unwrap(item.objectForKey("kCGWindowOwnerPID")));
    const layer = Number(ObjC.unwrap(item.objectForKey("kCGWindowLayer")));
    const alpha = Number(ObjC.unwrap(item.objectForKey("kCGWindowAlpha")));
    const sharing = Number(ObjC.unwrap(item.objectForKey("kCGWindowSharingState")));
    const bounds = item.objectForKey("kCGWindowBounds");
    const width = Number(ObjC.unwrap(bounds.objectForKey("Width")));
    const height = Number(ObjC.unwrap(bounds.objectForKey("Height")));
    const x = Number(ObjC.unwrap(bounds.objectForKey("X")));
    const y = Number(ObjC.unwrap(bounds.objectForKey("Y")));
    if ((requested ? windowId === requested : ownerPid === frontmostPid) &&
        layer === 0 && alpha > 0 && sharing > 0 && width > 16 && height > 16) {
      const app = String(ObjC.unwrap(item.objectForKey("kCGWindowOwnerName")));
      return JSON.stringify({
        window_id: windowId,
        owner_pid: ownerPid,
        app: app,
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height)
      });
    }
  }
  throw new Error("No validated on-screen app window");
}
`;

function safeAppLabel(value: string): string {
  return value
    // Matching control characters is the point: this app name came from the
    // window server and is about to become part of a filename, so C0 and DEL
    // are stripped before anything else. (no-control-regex is off for sensors.)
    .replace(/[\u0000-\u001f\u007f:]/g, " ")
    .replace(/[^A-Za-z0-9._ -]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64) || "Unknown app";
}

export async function resolveWindowTarget(
  requestedWindowId?: number,
  signal?: AbortSignal,
): Promise<WindowTarget | null> {
  if (!isMac) return null;
  if (
    requestedWindowId !== undefined &&
    (!Number.isSafeInteger(requestedWindowId) || requestedWindowId <= 0 || requestedWindowId > 0xffff_ffff)
  ) {
    return null;
  }
  const result = await runCapture(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      WINDOW_TARGET_SCRIPT,
      "--",
      ...(requestedWindowId === undefined ? [] : [String(requestedWindowId)]),
    ],
    3_000,
    signal,
  );
  if (!result || result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as Partial<WindowTarget>;
    if (
      !Number.isSafeInteger(parsed.window_id) ||
      Number(parsed.window_id) <= 0 ||
      !Number.isSafeInteger(parsed.owner_pid) ||
      Number(parsed.owner_pid) <= 0 ||
      typeof parsed.app !== "string" ||
      !Number.isSafeInteger(parsed.x) ||
      !Number.isSafeInteger(parsed.y) ||
      !Number.isSafeInteger(parsed.width) ||
      Number(parsed.width) <= 16 ||
      !Number.isSafeInteger(parsed.height) ||
      Number(parsed.height) <= 16
    ) {
      return null;
    }
    return {
      window_id: Number(parsed.window_id),
      owner_pid: Number(parsed.owner_pid),
      app: safeAppLabel(parsed.app),
      x: Number(parsed.x),
      y: Number(parsed.y),
      width: Number(parsed.width),
      height: Number(parsed.height),
    };
  } catch {
    return null;
  }
}

export async function resolveFrontmostWindowId(signal?: AbortSignal): Promise<number | null> {
  return (await resolveWindowTarget(undefined, signal))?.window_id ?? null;
}

export async function windowSnapshotEnabled(): Promise<boolean> {
  return isMac && policyEnabled("window_snapshot");
}

export async function fullScreenSnapshotEnabled(): Promise<boolean> {
  return isMac && policyEnabled("full_screen_snapshot");
}

/** Compatibility helper: screen_snapshot now means the safer app-window policy. */
export const screenSnapshotEnabled = windowSnapshotEnabled;

export async function persistScreenSnapshotBuffer(
  buffer: Buffer,
  generatedAt: string,
): Promise<PersistedSnapshot> {
  return persistSnapshotFileBuffer("screen", buffer, generatedAt);
}

function sharedDefaults(): SharedScreenCaptureDependencies {
  return {
    isMac,
    requestConsent: requestLocalConsent,
    consumeConsent: consumeConsentReceipt,
    runCommand: runCapture,
    createPath: (generatedAt) => createSnapshotPath("screen", generatedAt),
    readSnapshot: (file) => readPrivateFile(file, MAX_SNAPSHOT_BYTES),
    finalize: (file) => finalizeSnapshotFile("screen", file),
    cleanup: (file) => removePrivateFile(file),
  };
}

function consentError(
  prefix: "window" | "full_screen",
  decision: Extract<ConsentDecision, { granted: false }>,
): string {
  return `${prefix}_consent_${decision.error}`;
}

function windowConsentTarget(target: WindowTarget): string {
  return (
    `window:${target.window_id}:pid:${target.owner_pid}:app:${target.app}:bounds:` +
    `${target.x},${target.y},${target.width},${target.height}`
  );
}

function sameWindowTarget(left: WindowTarget, right: WindowTarget): boolean {
  return (
    left.window_id === right.window_id &&
    left.owner_pid === right.owner_pid &&
    left.app === right.app &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

async function finishSnapshot(
  file: string,
  generatedAt: string,
  mode: ScreenSnapshotMode,
  dependencies: SharedScreenCaptureDependencies,
  windowId?: number,
): Promise<ScreenSnapshot> {
  try {
    const buffer = await dependencies.readSnapshot(file);
    if (buffer.length === 0) {
      await dependencies.cleanup(file).catch(() => undefined);
      return {
        ok: false,
        generated_at: generatedAt,
        mode,
        ...(windowId ? { window_id: windowId } : {}),
        error: "screen_capture_empty",
      };
    }
    const persisted = await dependencies.finalize(file);
    return {
      ok: true,
      generated_at: generatedAt,
      mode,
      mimeType: "image/png",
      data: buffer.toString("base64"),
      ...persisted,
      ...(windowId ? { window_id: windowId } : {}),
    };
  } catch {
    await dependencies.cleanup(file).catch(() => undefined);
    return {
      ok: false,
      generated_at: generatedAt,
      mode,
      ...(windowId ? { window_id: windowId } : {}),
      error: "screen_capture_finalize_failed",
    };
  }
}

export function createWindowSnapshotCapture(
  overrides: Partial<WindowCaptureDependencies> = {},
): (
  windowId?: number,
  mode?: ScreenSnapshotMode,
  reason?: string,
  signal?: AbortSignal,
) => Promise<ScreenSnapshot> {
  const dependencies: WindowCaptureDependencies = {
    ...sharedDefaults(),
    policyEnabled: () => policyEnabled("window_snapshot"),
    resolveWindowTarget,
    ...overrides,
  };

  return async (
    requestedWindowId?: number,
    mode: ScreenSnapshotMode = "general_screen",
    reason = "Explicit app-window snapshot requested by the local user.",
    signal?: AbortSignal,
  ): Promise<ScreenSnapshot> => {
    const generatedAt = new Date().toISOString();
    if (!dependencies.isMac || !(await dependencies.policyEnabled())) {
      return { ok: false, generated_at: generatedAt, mode, error: "window_snapshot_not_enabled" };
    }
    const target = await dependencies.resolveWindowTarget(requestedWindowId, signal);
    if (!target) {
      return { ok: false, generated_at: generatedAt, mode, error: "window_capture_unavailable" };
    }
    const windowId = target.window_id;

    const consentRequest: CaptureConsentRequest = {
      media_kind: "screen",
      scope: "window_only",
      target: windowConsentTarget(target),
      reason,
    };
    const consent = await dependencies.requestConsent(consentRequest);
    if (!consent.granted) {
      return { ok: false, generated_at: generatedAt, mode, window_id: windowId, error: consentError("window", consent) };
    }
    const consumed = await dependencies.consumeConsent(consent.receipt.id, consentRequest);
    if (!consumed.granted) {
      return { ok: false, generated_at: generatedAt, mode, window_id: windowId, error: consentError("window", consumed) };
    }
    const file = await dependencies.createPath(generatedAt);
    const confirmedTarget = await dependencies.resolveWindowTarget(windowId, signal);
    if (!confirmedTarget || !sameWindowTarget(confirmedTarget, target)) {
      await dependencies.cleanup(file).catch(() => undefined);
      return { ok: false, generated_at: generatedAt, mode, window_id: windowId, error: "window_target_changed" };
    }
    if (!(await dependencies.policyEnabled())) {
      await dependencies.cleanup(file).catch(() => undefined);
      return { ok: false, generated_at: generatedAt, mode, window_id: windowId, error: "window_policy_revoked" };
    }

    const result = await dependencies.runCommand(
      "/usr/sbin/screencapture",
      ["-x", "-l", String(windowId), "-t", "png", file],
      8_000,
      signal,
    );
    if (!result || result.exitCode !== 0) {
      await dependencies.cleanup(file).catch(() => undefined);
      return {
        ok: false,
        generated_at: generatedAt,
        mode,
        window_id: windowId,
        error: "window_capture_failed_or_denied",
      };
    }
    const finalTarget = await dependencies.resolveWindowTarget(windowId, signal);
    if (!finalTarget || !sameWindowTarget(finalTarget, target)) {
      await dependencies.cleanup(file).catch(() => undefined);
      return { ok: false, generated_at: generatedAt, mode, window_id: windowId, error: "window_target_changed" };
    }
    if (!(await dependencies.policyEnabled())) {
      await dependencies.cleanup(file).catch(() => undefined);
      return { ok: false, generated_at: generatedAt, mode, window_id: windowId, error: "window_policy_revoked" };
    }
    const snapshot = await finishSnapshot(file, generatedAt, mode, dependencies, windowId);
    if (
      snapshot.ok &&
      !(await dependencies.policyEnabled().catch(() => false))
    ) {
      await dependencies.cleanup(snapshot.path ?? file).catch(() => undefined);
      return { ok: false, generated_at: generatedAt, mode, window_id: windowId, error: "window_policy_revoked" };
    }
    return snapshot;
  };
}

export function createFullScreenSnapshotCapture(
  overrides: Partial<FullScreenCaptureDependencies> = {},
): (
  mode?: ScreenSnapshotMode,
  reason?: string,
  signal?: AbortSignal,
) => Promise<ScreenSnapshot> {
  const dependencies: FullScreenCaptureDependencies = {
    ...sharedDefaults(),
    policyEnabled: () => policyEnabled("full_screen_snapshot"),
    ...overrides,
  };

  return async (
    mode: ScreenSnapshotMode = "general_screen",
    reason = "Explicit full-screen snapshot requested by the local user.",
    signal?: AbortSignal,
  ): Promise<ScreenSnapshot> => {
    const generatedAt = new Date().toISOString();
    if (!dependencies.isMac || !(await dependencies.policyEnabled())) {
      return { ok: false, generated_at: generatedAt, mode, error: "full_screen_snapshot_not_enabled" };
    }
    const consentRequest: CaptureConsentRequest = {
      media_kind: "screen",
      scope: "full_screen",
      target: "main-display",
      reason,
    };
    const consent = await dependencies.requestConsent(consentRequest);
    if (!consent.granted) {
      return { ok: false, generated_at: generatedAt, mode, error: consentError("full_screen", consent) };
    }
    const consumed = await dependencies.consumeConsent(consent.receipt.id, consentRequest);
    if (!consumed.granted) {
      return { ok: false, generated_at: generatedAt, mode, error: consentError("full_screen", consumed) };
    }
    const file = await dependencies.createPath(generatedAt);
    if (!(await dependencies.policyEnabled())) {
      await dependencies.cleanup(file).catch(() => undefined);
      return { ok: false, generated_at: generatedAt, mode, error: "full_screen_policy_revoked" };
    }
    const result = await dependencies.runCommand(
      "/usr/sbin/screencapture",
      ["-x", "-m", "-t", "png", file],
      8_000,
      signal,
    );
    if (!result || result.exitCode !== 0) {
      await dependencies.cleanup(file).catch(() => undefined);
      return {
        ok: false,
        generated_at: generatedAt,
        mode,
        error: "full_screen_capture_failed_or_denied",
      };
    }
    if (!(await dependencies.policyEnabled())) {
      await dependencies.cleanup(file).catch(() => undefined);
      return { ok: false, generated_at: generatedAt, mode, error: "full_screen_policy_revoked" };
    }
    const snapshot = await finishSnapshot(file, generatedAt, mode, dependencies);
    if (
      snapshot.ok &&
      !(await dependencies.policyEnabled().catch(() => false))
    ) {
      await dependencies.cleanup(snapshot.path ?? file).catch(() => undefined);
      return { ok: false, generated_at: generatedAt, mode, error: "full_screen_policy_revoked" };
    }
    return snapshot;
  };
}

export const takeWindowSnapshot = createWindowSnapshotCapture();
export const takeFullScreenSnapshot = createFullScreenSnapshotCapture();

/** Deprecated compatibility alias. It deliberately remains window-only. */
export function takeScreenSnapshot(
  mode: ScreenSnapshotMode = "general_screen",
  reason = "Explicit app-window snapshot requested by the local user.",
  signal?: AbortSignal,
): Promise<ScreenSnapshot> {
  return takeWindowSnapshot(undefined, mode, reason, signal);
}
