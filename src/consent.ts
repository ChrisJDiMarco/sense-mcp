import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  atomicWritePrivateFile,
  listPrivateFiles,
  readPrivateFile,
  readPrivateText,
  removePrivateFile,
  withPrivateFileLock,
} from "./privateFiles.js";

const RECEIPT_VERSION = 1;
const DEFAULT_TTL_MS = 60_000;
const MAX_TTL_MS = 2 * 60_000;
const MIN_TTL_MS = 1_000;
const MAX_RECEIPT_BYTES = 4_096;
const RECEIPT_PATTERN = /^receipt-([0-9a-f-]{36})\.json$/i;

export type ConsentMediaKind = "camera" | "screen";
export type ConsentScope = "single_capture" | "window_only" | "full_screen";

export interface CaptureConsentRequest {
  media_kind: ConsentMediaKind;
  scope: ConsentScope;
  target: string;
  reason: string;
}

export interface ConsentReceipt {
  version: 1;
  id: string;
  media_kind: ConsentMediaKind;
  scope: ConsentScope;
  target: string;
  reason_hash: string;
  issued_at: string;
  expires_at: string;
  signature: string;
}

export type ConsentFailure =
  | "confirmation_unavailable"
  | "confirmation_failed"
  | "invalid_request"
  | "receipt_expired"
  | "receipt_invalid"
  | "receipt_mismatch"
  | "receipt_not_found"
  | "user_denied";

export type ConsentDecision =
  | { granted: true; receipt: ConsentReceipt }
  | { granted: false; error: ConsentFailure };

export interface RequestConsentOptions {
  now?: () => number;
  ttlMs?: number;
  confirm?: (request: Readonly<CaptureConsentRequest>) => Promise<boolean>;
}

export interface ConsentClockOptions {
  now?: () => number;
}

interface BoundRequest {
  media_kind: ConsentMediaKind;
  scope: ConsentScope;
  target: string;
  normalized_reason: string;
  reason_hash: string;
}

export function consentDirectory(): string {
  return process.env.SENSE_CONSENT_DIR || path.join(os.homedir(), ".sense-mcp", "consent");
}

function receiptPath(id: string): string {
  return path.join(consentDirectory(), `receipt-${id}.json`);
}

function signingKeyPath(): string {
  return path.join(consentDirectory(), ".signing-key");
}

function consentLockPath(): string {
  return path.join(consentDirectory(), ".consent.lock");
}

function signingKeyLockPath(): string {
  return path.join(consentDirectory(), ".key.lock");
}

function safeReceiptId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function normalizeText(value: string, maxLength: number): string | undefined {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= maxLength ? normalized : undefined;
}

function bindRequest(request: CaptureConsentRequest): BoundRequest | undefined {
  if (request.media_kind !== "camera" && request.media_kind !== "screen") return undefined;
  if (
    request.scope !== "single_capture" &&
    request.scope !== "window_only" &&
    request.scope !== "full_screen"
  ) {
    return undefined;
  }
  if (request.media_kind === "camera" && request.scope !== "single_capture") return undefined;
  if (request.media_kind === "screen" && request.scope === "single_capture") return undefined;

  const target = normalizeText(request.target, 200);
  const normalizedReason = normalizeText(request.reason, 200);
  if (!target || !normalizedReason || normalizedReason.length < 3) return undefined;
  if (
    request.scope === "window_only" &&
    !/^window:[1-9]\d{0,9}:pid:[1-9]\d{0,9}:app:[A-Za-z0-9][A-Za-z0-9._ -]{0,63}:bounds:-?\d{1,6},-?\d{1,6},\d{1,6},\d{1,6}$/.test(target)
  ) {
    return undefined;
  }
  if (request.scope === "full_screen" && target !== "main-display") return undefined;
  if (request.media_kind === "camera" && !/^device:\d{1,4}$/.test(target)) return undefined;

  return {
    media_kind: request.media_kind,
    scope: request.scope,
    target,
    normalized_reason: normalizedReason,
    reason_hash: createHash("sha256").update(normalizedReason).digest("hex"),
  };
}

function unsignedReceipt(receipt: Omit<ConsentReceipt, "signature">): string {
  return [
    receipt.version,
    receipt.id,
    receipt.media_kind,
    receipt.scope,
    receipt.target,
    receipt.reason_hash,
    receipt.issued_at,
    receipt.expires_at,
  ].join("\n");
}

function signReceipt(receipt: Omit<ConsentReceipt, "signature">, key: Buffer): string {
  return createHmac("sha256", key).update(unsignedReceipt(receipt)).digest("hex");
}

function validSignature(receipt: ConsentReceipt, key: Buffer): boolean {
  const supplied = Buffer.from(receipt.signature, "hex");
  const expected = Buffer.from(
    signReceipt(
      {
        version: receipt.version,
        id: receipt.id,
        media_kind: receipt.media_kind,
        scope: receipt.scope,
        target: receipt.target,
        reason_hash: receipt.reason_hash,
        issued_at: receipt.issued_at,
        expires_at: receipt.expires_at,
      },
      key,
    ),
    "hex",
  );
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function signingKey(): Promise<Buffer> {
  const file = signingKeyPath();
  try {
    const existing = await readPrivateFile(file, 32);
    if (existing.length === 32) return existing;
  } catch {
    // Create under the key lock below. Invalid keys are replaced atomically.
  }

  return withPrivateFileLock(signingKeyLockPath(), async () => {
    try {
      const existing = await readPrivateFile(file, 32);
      if (existing.length === 32) return existing;
    } catch {
      // No usable key exists yet.
    }
    const created = randomBytes(32);
    await atomicWritePrivateFile(file, created, { maxBytes: 32 });
    return created;
  });
}

function parseReceipt(text: string): ConsentReceipt | undefined {
  try {
    const value = JSON.parse(text) as Partial<ConsentReceipt>;
    if (
      value.version !== RECEIPT_VERSION ||
      typeof value.id !== "string" ||
      !safeReceiptId(value.id) ||
      (value.media_kind !== "camera" && value.media_kind !== "screen") ||
      (value.scope !== "single_capture" && value.scope !== "window_only" && value.scope !== "full_screen") ||
      typeof value.target !== "string" ||
      typeof value.reason_hash !== "string" ||
      !/^[0-9a-f]{64}$/i.test(value.reason_hash) ||
      typeof value.issued_at !== "string" ||
      !Number.isFinite(Date.parse(value.issued_at)) ||
      typeof value.expires_at !== "string" ||
      !Number.isFinite(Date.parse(value.expires_at)) ||
      typeof value.signature !== "string" ||
      !/^[0-9a-f]{64}$/i.test(value.signature)
    ) {
      return undefined;
    }
    return value as ConsentReceipt;
  } catch {
    return undefined;
  }
}

function nativeConfirmation(request: Readonly<CaptureConsentRequest>): Promise<boolean> {
  const script = `on run argv
set mediaKind to item 1 of argv
set consentScope to item 2 of argv
set captureTarget to item 3 of argv
set captureReason to item 4 of argv
set promptText to "Sense wants one " & mediaKind & " capture (" & consentScope & ") of " & captureTarget & "." & return & return & "Reason: " & captureReason
set response to display dialog promptText with title "Sense MCP capture request" buttons {"Deny", "Allow once"} default button "Deny" cancel button "Deny" giving up after 30
if gave up of response then return "denied"
return button returned of response
end run`;

  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/osascript",
      ["-e", script, "--", request.media_kind, request.scope, request.target, request.reason],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    let settled = false;
    const finish = (error: Error | undefined, approved = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(approved);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Local consent prompt timed out"));
    }, 35_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output = `${output}${chunk}`.slice(0, 128);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(undefined, code === 0 && output.trim() === "Allow once"));
  });
}

/** Ask the local operator and persist a signed, bounded, short-lived lease. */
export async function requestLocalConsent(
  request: CaptureConsentRequest,
  options: RequestConsentOptions = {},
): Promise<ConsentDecision> {
  const bound = bindRequest(request);
  if (!bound) return { granted: false, error: "invalid_request" };

  const confirm = options.confirm ?? (process.platform === "darwin" ? nativeConfirmation : undefined);
  if (!confirm) return { granted: false, error: "confirmation_unavailable" };

  let approved = false;
  try {
    approved = await confirm({
      media_kind: bound.media_kind,
      scope: bound.scope,
      target: bound.target,
      reason: bound.normalized_reason,
    });
  } catch {
    return { granted: false, error: "confirmation_failed" };
  }
  if (!approved) return { granted: false, error: "user_denied" };

  const now = options.now?.() ?? Date.now();
  const requestedTtl = Number.isFinite(options.ttlMs) ? Math.trunc(options.ttlMs ?? DEFAULT_TTL_MS) : DEFAULT_TTL_MS;
  const ttlMs = Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, requestedTtl));
  const receiptWithoutSignature: Omit<ConsentReceipt, "signature"> = {
    version: RECEIPT_VERSION,
    id: randomUUID(),
    media_kind: bound.media_kind,
    scope: bound.scope,
    target: bound.target,
    reason_hash: bound.reason_hash,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
  };
  const key = await signingKey();
  const receipt: ConsentReceipt = {
    ...receiptWithoutSignature,
    signature: signReceipt(receiptWithoutSignature, key),
  };
  await atomicWritePrivateFile(receiptPath(receipt.id), `${JSON.stringify(receipt)}\n`, {
    maxBytes: MAX_RECEIPT_BYTES,
  });
  return { granted: true, receipt };
}

async function removeReceiptQuietly(id: string): Promise<void> {
  await removePrivateFile(receiptPath(id)).catch(() => undefined);
}

/** Verify exact binding and atomically consume a receipt so it cannot be reused. */
export async function consumeConsentReceipt(
  id: string,
  request: CaptureConsentRequest,
  options: ConsentClockOptions = {},
): Promise<ConsentDecision> {
  const bound = bindRequest(request);
  if (!safeReceiptId(id)) return { granted: false, error: "receipt_invalid" };
  if (!bound) return { granted: false, error: "invalid_request" };

  return withPrivateFileLock(consentLockPath(), async () => {
    let text: string;
    try {
      text = await readPrivateText(receiptPath(id), MAX_RECEIPT_BYTES);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      return { granted: false, error: code === "ENOENT" ? "receipt_not_found" : "receipt_invalid" };
    }

    const receipt = parseReceipt(text);
    if (!receipt || receipt.id !== id || !validSignature(receipt, await signingKey())) {
      await removeReceiptQuietly(id);
      return { granted: false, error: "receipt_invalid" };
    }
    const now = options.now?.() ?? Date.now();
    if (now >= Date.parse(receipt.expires_at)) {
      await removeReceiptQuietly(id);
      return { granted: false, error: "receipt_expired" };
    }
    if (
      receipt.media_kind !== bound.media_kind ||
      receipt.scope !== bound.scope ||
      receipt.target !== bound.target ||
      receipt.reason_hash !== bound.reason_hash
    ) {
      await removeReceiptQuietly(id);
      return { granted: false, error: "receipt_mismatch" };
    }

    await removePrivateFile(receiptPath(id));
    return { granted: true, receipt };
  });
}

export async function listConsentReceipts(
  options: ConsentClockOptions = {},
): Promise<ConsentReceipt[]> {
  const now = options.now?.() ?? Date.now();
  const key = await signingKey();
  const files = await listPrivateFiles(consentDirectory(), {
    pattern: RECEIPT_PATTERN,
    maxEntries: 128,
  });
  const receipts: ConsentReceipt[] = [];
  for (const file of files) {
    const receipt = await readPrivateText(file, MAX_RECEIPT_BYTES)
      .then(parseReceipt)
      .catch(() => undefined);
    if (!receipt || !validSignature(receipt, key) || now >= Date.parse(receipt.expires_at)) {
      await removePrivateFile(file).catch(() => undefined);
      continue;
    }
    receipts.push(receipt);
  }
  return receipts.sort((a, b) => a.expires_at.localeCompare(b.expires_at));
}

export async function revokeConsent(id: string): Promise<boolean> {
  if (!safeReceiptId(id)) return false;
  return withPrivateFileLock(consentLockPath(), () => removePrivateFile(receiptPath(id)));
}

export async function revokeAllConsent(): Promise<number> {
  return withPrivateFileLock(consentLockPath(), async () => {
    const files = await listPrivateFiles(consentDirectory(), {
      pattern: RECEIPT_PATTERN,
      maxEntries: 128,
    });
    let removed = 0;
    for (const file of files) {
      if (await removePrivateFile(file).catch(() => false)) removed += 1;
    }
    return removed;
  });
}
