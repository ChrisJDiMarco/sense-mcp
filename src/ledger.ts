import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  atomicWritePrivateFile,
  readPrivateText,
  withPrivateFileLock,
} from "./privateFiles.js";

const DEFAULT_LEDGER_PATH = path.join(os.homedir(), ".sense-mcp", "access-ledger.jsonl");
const MAX_LEDGER_ENTRIES = 200;
const MAX_LEDGER_BYTES = 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const DOMAIN_ALLOWLIST = new Set(["screen", "user", "environment", "schedule"]);
const EXPECTED_VALUE_ALLOWLIST = new Set(["none", "low", "medium", "high"]);
const BUDGET_MODE_ALLOWLIST = new Set([
  "none",
  "compact",
  "brief",
  "focused",
  "debug",
  "diff",
  "visual",
]);
const PLAN_INTENT_ALLOWLIST = new Set([
  "visual_appearance_check",
  "screen_debug",
  "time_pressure",
  "current_work",
  "focus_state",
  "environment_check",
  "writing_or_general_help",
  "privacy_boundary",
  "no_local_context_needed",
  "general_context",
]);
const EXTERNAL_CONTEXT_ALLOWLIST = new Set(["calendar_connector"]);
const ERROR_CLASS_ALLOWLIST = new Set([
  "capture_consent_error",
  "policy_revoked",
  "capability_disabled",
  "capture_target_changed",
  "capture_failed_or_denied",
  "capability_unavailable",
  "tool_error",
]);

export type AccessStatus = "completed" | "failed" | "planned" | "skipped";

export interface AccessLedgerEntry {
  id: string;
  observed_at: string;
  tool: string;
  status: AccessStatus;
  reason: string;
  reason_hash?: string;
  media_captured: boolean;
  context_domains: string[];
  privacy_tier?: number;
  plan_intent?: string;
  expected_value?: string;
  budget_mode?: string;
  max_tokens?: number;
  external_context_needed?: string[];
  artifact_paths?: string[];
  error?: string;
  error_hash?: string;
}

export type AccessLedgerInput = Omit<
  AccessLedgerEntry,
  "id" | "observed_at" | "reason_hash" | "error_hash"
> & {
  observed_at?: string;
};

export function ledgerPath(): string {
  return process.env.SENSE_LEDGER_PATH || DEFAULT_LEDGER_PATH;
}

function lockPath(file: string): string {
  return `${file}.lock`;
}

function clean(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringList(value: string[] | undefined, count: number, length: number): string[] | undefined {
  if (!value) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, count)
    .map((item) => clean(item, length))
    .filter(Boolean);
}

function allowedString(value: string | undefined, allowed: Set<string>): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function safeDomains(value: string[] | undefined): string[] {
  return [...new Set(value?.filter((domain) => DOMAIN_ALLOWLIST.has(domain)) ?? [])].slice(0, 4);
}

function reasonSummary(input: Pick<AccessLedgerInput, "status" | "media_captured" | "context_domains">): string {
  if (input.media_captured) return `Explicit media capture ${input.status}.`;
  if (input.status === "planned") return "Context routing decision recorded.";
  const domains = safeDomains(input.context_domains);
  if (domains.length > 0) return `Semantic context access ${input.status} for ${domains.join(", ")}.`;
  return `Sense tool access ${input.status}.`;
}

function errorClass(value: string): string {
  if (ERROR_CLASS_ALLOWLIST.has(value)) return value;
  if (value.includes("consent_")) return "capture_consent_error";
  if (value.endsWith("_policy_revoked")) return "policy_revoked";
  if (value.endsWith("_not_enabled")) return "capability_disabled";
  if (value.includes("target_changed")) return "capture_target_changed";
  if (value.includes("failed_or_denied")) return "capture_failed_or_denied";
  if (value.includes("unavailable")) return "capability_unavailable";
  return "tool_error";
}

function parseLines(text: string): AccessLedgerEntry[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line) as Partial<AccessLedgerEntry>;
        if (
          typeof entry.id !== "string" ||
          typeof entry.observed_at !== "string" ||
          typeof entry.tool !== "string" ||
          (entry.status !== "completed" &&
            entry.status !== "failed" &&
            entry.status !== "planned" &&
            entry.status !== "skipped") ||
          typeof entry.reason !== "string" ||
          typeof entry.media_captured !== "boolean" ||
          !Array.isArray(entry.context_domains)
        ) {
          return [];
        }
        const input: AccessLedgerInput = {
          tool: entry.tool,
          status: entry.status,
          reason: entry.reason,
          media_captured: entry.media_captured,
          context_domains: entry.context_domains.filter(
            (domain): domain is string => typeof domain === "string",
          ),
          privacy_tier: entry.privacy_tier,
          plan_intent: entry.plan_intent,
          expected_value: entry.expected_value,
          budget_mode: entry.budget_mode,
          max_tokens: entry.max_tokens,
          external_context_needed: entry.external_context_needed,
          artifact_paths: entry.artifact_paths,
          error: entry.error,
          observed_at: entry.observed_at,
        };
        const normalized = buildEntry(input);
        normalized.id = clean(entry.id, 80);
        if (typeof entry.reason_hash === "string" && HASH_PATTERN.test(entry.reason_hash)) {
          normalized.reason_hash = entry.reason_hash;
        }
        if (
          typeof entry.error_hash === "string" &&
          HASH_PATTERN.test(entry.error_hash) &&
          normalized.error
        ) {
          normalized.error_hash = entry.error_hash;
        }
        return [normalized];
      } catch {
        return [];
      }
    });
}

async function readEntries(file: string): Promise<AccessLedgerEntry[]> {
  return readPrivateText(file, MAX_LEDGER_BYTES)
    .then(parseLines)
    .catch(() => []);
}

function boundedNumber(value: number | undefined, minimum: number, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function timestamp(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return new Date().toISOString();
  return new Date(Date.parse(value)).toISOString();
}

function buildEntry(input: AccessLedgerInput): AccessLedgerEntry {
  const externalContext = input.external_context_needed
    ?.filter((value) => EXTERNAL_CONTEXT_ALLOWLIST.has(value))
    .slice(0, 8);
  const artifactPaths = stringList(input.artifact_paths, 4, 260);
  const domains = safeDomains(input.context_domains);
  const entry: AccessLedgerEntry = {
    id: randomUUID(),
    observed_at: timestamp(input.observed_at),
    tool: clean(input.tool, 80),
    status: input.status,
    reason: reasonSummary({ ...input, context_domains: domains }),
    reason_hash: digest(input.reason),
    media_captured: input.media_captured === true,
    context_domains: domains,
  };

  const privacyTier = boundedNumber(input.privacy_tier, 0, 3);
  const maxTokens = boundedNumber(input.max_tokens, 0, 1_000_000);
  const planIntent = allowedString(input.plan_intent, PLAN_INTENT_ALLOWLIST);
  const expectedValue = allowedString(input.expected_value, EXPECTED_VALUE_ALLOWLIST);
  const budgetMode = allowedString(input.budget_mode, BUDGET_MODE_ALLOWLIST);
  const error = input.error ? errorClass(input.error) : undefined;
  if (privacyTier !== undefined) entry.privacy_tier = privacyTier;
  if (maxTokens !== undefined) entry.max_tokens = maxTokens;
  if (planIntent) entry.plan_intent = planIntent;
  if (expectedValue) entry.expected_value = expectedValue;
  if (budgetMode) entry.budget_mode = budgetMode;
  if (externalContext?.length) entry.external_context_needed = externalContext;
  if (artifactPaths?.length) entry.artifact_paths = artifactPaths;
  if (error && input.error) {
    entry.error = error;
    entry.error_hash = digest(input.error);
  }
  return entry;
}

function serializedEntries(entries: AccessLedgerEntry[]): string {
  return entries.length ? `${entries.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
}

async function readAndMigrateEntries(file: string): Promise<AccessLedgerEntry[]> {
  return withPrivateFileLock(lockPath(file), async () => {
    const existing = await readPrivateText(file, MAX_LEDGER_BYTES).catch(() => "");
    const entries = parseLines(existing);
    const migrated = serializedEntries(entries);
    if (existing && existing !== migrated) {
      await atomicWritePrivateFile(file, migrated, { maxBytes: MAX_LEDGER_BYTES });
    }
    return entries;
  }).catch(() => []);
}

export async function readAccessLedger(limit = 30): Promise<AccessLedgerEntry[]> {
  const safeLimit = Math.max(0, Math.min(MAX_LEDGER_ENTRIES, Math.trunc(limit)));
  const entries = await readAndMigrateEntries(ledgerPath());
  return entries
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at))
    .slice(0, safeLimit);
}

export async function recordAccess(input: AccessLedgerInput): Promise<void> {
  if (process.env.SENSE_LEDGER_DISABLED === "1") return;

  try {
    const file = ledgerPath();
    const entry = buildEntry(input);
    await withPrivateFileLock(lockPath(file), async () => {
      const entries = await readEntries(file);
      entries.push(entry);
      const bounded = entries.slice(-MAX_LEDGER_ENTRIES);
      await atomicWritePrivateFile(
        file,
        serializedEntries(bounded),
        { maxBytes: MAX_LEDGER_BYTES },
      );
    });
  } catch {
    // Audit storage must never expand the data acquisition requested by a tool.
  }
}
