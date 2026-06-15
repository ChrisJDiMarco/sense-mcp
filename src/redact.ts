/**
 * Window-title handling. The raw title never crosses the MCP boundary by
 * default: it is classified locally into a coarse, privacy-safe label. The
 * raw title is emitted only when the operator explicitly opts in, and even
 * then it is redacted first.
 */

/** Activity class → default safe label when the title reveals nothing more. */
const LABEL_BY_ACTIVITY: Record<string, string> = {
  coding: "code editor",
  designing: "design file",
  writing: "document",
  reading: "document",
  browsing: "browser",
  communicating: "messaging",
  media: "media",
  meeting: "meeting",
};

/**
 * Sensitive-content overrides keyed off the *local* title. These bias the
 * label toward "don't describe this" without ever emitting the title itself.
 */
const SENSITIVE_LABELS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /bank|chase|wells\s*fargo|capital\s*one|routing|\baccount\b|statement|invoice|paypal|venmo/i, label: "banking" },
  { pattern: /password|passphrase|1password|bitwarden|lastpass|keychain|secret|api[_\s-]?key|token/i, label: "credentials" },
  { pattern: /medical|patient|diagnos|prescription|health\s*record/i, label: "health record" },
  { pattern: /messages?|mail|inbox|slack|discord|dm\b|direct message|thread/i, label: "private communication" },
];

/**
 * Classify the frontmost window into a privacy-safe label. Reads the raw title
 * locally for sensitive-content detection, but the return value never contains
 * the title text.
 */
export function classifyWindowLabel(activityClass: string, title?: string): string {
  if (title) {
    for (const { pattern, label } of SENSITIVE_LABELS) {
      if (pattern.test(title)) return label;
    }
  }
  return LABEL_BY_ACTIVITY[activityClass] ?? "unknown";
}

export function classifyWindowSensitivity(label: string): {
  level: "normal" | "medium" | "high";
  reason?: string;
} {
  if (label === "banking" || label === "credentials" || label === "health record") {
    return { level: "high", reason: "financial_or_credentials_or_health" };
  }
  if (label === "private communication" || label === "messaging" || label === "meeting") {
    return { level: "medium", reason: "communication_context" };
  }
  return { level: "normal" };
}

/**
 * Redact a raw title before it crosses the boundary (Tier-3 opt-in only).
 * Strips long digit runs (account/card numbers), emails, and URLs. Best-effort
 * — labels are the safe default; titles are for users who accept the trade.
 */
export function redactTitle(title: string): string {
  return title
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\b\d[\d ._-]{5,}\d\b/g, "[number]")
    .trim();
}
