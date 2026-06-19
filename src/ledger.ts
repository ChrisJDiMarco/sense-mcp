import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_LEDGER_PATH = path.join(os.tmpdir(), "sense-mcp", "access-ledger.jsonl");
const MAX_LEDGER_ENTRIES = 200;

export type AccessStatus = "completed" | "failed" | "planned" | "skipped";

export interface AccessLedgerEntry {
  id: string;
  observed_at: string;
  tool: string;
  status: AccessStatus;
  reason: string;
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
}

export type AccessLedgerInput = Omit<AccessLedgerEntry, "id" | "observed_at"> & {
  observed_at?: string;
};

export function ledgerPath(): string {
  return process.env.SENSE_LEDGER_PATH || DEFAULT_LEDGER_PATH;
}

function scrubReason(reason: string): string {
  return reason
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\b\d[\d ._-]{4,}\d\b/g, "[number]")
    .replace(/\b(password|passcode|2fa|otp|security code|api key|secret)\b/gi, "[sensitive]")
    .slice(0, 220)
    .trim();
}

function parseLines(text: string): AccessLedgerEntry[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as AccessLedgerEntry];
      } catch {
        return [];
      }
    });
}

async function writeEntries(file: string, entries: AccessLedgerEntry[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

export async function readAccessLedger(limit = 30): Promise<AccessLedgerEntry[]> {
  try {
    const entries = parseLines(await readFile(ledgerPath(), "utf8"));
    return entries
      .sort((a, b) => (a.observed_at < b.observed_at ? 1 : -1))
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function recordAccess(input: AccessLedgerInput): Promise<void> {
  if (process.env.SENSE_LEDGER_DISABLED === "1") return;

  try {
    const file = ledgerPath();
    const entry: AccessLedgerEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      observed_at: input.observed_at ?? new Date().toISOString(),
      ...input,
      reason: scrubReason(input.reason),
      context_domains: input.context_domains.slice(0, 8),
      external_context_needed: input.external_context_needed?.slice(0, 8),
      artifact_paths: input.artifact_paths?.slice(0, 4),
    };
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`);
    const entries = await readFile(file, "utf8")
      .then(parseLines)
      .catch(() => []);
    if (entries.length > MAX_LEDGER_ENTRIES) {
      await writeEntries(file, entries.slice(-MAX_LEDGER_ENTRIES));
    }
  } catch {
    // The ledger is a trust aid, not a hard dependency for context tools.
  }
}
