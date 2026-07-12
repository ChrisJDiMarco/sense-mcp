import type {
  ContextProviderHealth,
  ContextResult,
} from "./contextProvider.js";
import type { ContextFrame, Domain } from "./types.js";

export type ContextProjection = "compact" | "brief" | "focused" | "debug" | "diff";

export const DEFAULT_CONTEXT_BUDGETS: Record<ContextProjection, number> = {
  compact: 120,
  brief: 180,
  focused: 280,
  debug: 1_200,
  diff: 140,
};

export interface ContextProjectionOptions {
  projection: ContextProjection;
  domains?: Domain[];
  max_tokens?: number;
  context_satisfied: boolean;
}

export interface ContextProjectionOutput {
  [key: string]: unknown;
  ok: true;
  context_satisfied: boolean;
  projection: ContextProjection;
  generated_at: string;
  budget: {
    max_tokens: number;
    max_bytes: number;
    estimated_tokens: number;
    serialized_bytes: number;
    truncated: boolean;
  };
  context: Record<string, unknown>;
  health: ContextProviderHealth;
  refreshed_domains: Domain[];
}

export interface SerializedBudget {
  max_tokens: number;
  max_bytes: number;
  estimated_tokens: number;
  serialized_bytes: number;
  truncated: boolean;
}

/** A conservative byte conversion; exact model tokenization remains client-specific. */
const MAX_SERIALIZED_BYTES_PER_TOKEN = 3;

export class ContextBudgetError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Context output cannot fit within the ${maxBytes}-byte serialized ceiling.`);
    this.name = "ContextBudgetError";
  }
}

const DOMAIN_FIELDS: Record<Domain, string[]> = {
  screen: [
    "active_app",
    "activity_class",
    "active_window_label",
    "workspace_name",
    "git_branch",
    "git_dirty_count",
  ],
  user: ["presence", "input_cadence", "focus_mode", "do_not_disturb"],
  environment: [
    "day_segment",
    "power_source",
    "battery_percent",
    "location_class",
    "noise_class",
    "lighting",
  ],
  schedule: ["in_meeting", "next_event_minutes", "time_pressure", "work_window"],
};

const ALL_DOMAINS: Domain[] = ["screen", "user", "environment", "schedule"];

export function estimateJsonTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / MAX_SERIALIZED_BYTES_PER_TOKEN);
}

function selectedDomains(domains?: Domain[]): Domain[] {
  return domains?.length ? [...new Set(domains)] : ALL_DOMAINS;
}

function selectedFrameDomains(
  frame: ContextFrame,
  domains: Domain[],
  compact: boolean,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const domain of domains) {
    const fields = frame[domain];
    if (!fields) continue;
    if (!compact) {
      output[domain] = fields;
      continue;
    }
    const chosen = Object.fromEntries(
      DOMAIN_FIELDS[domain]
        .filter((field) => fields[field] !== undefined)
        .map((field) => [field, fields[field]]),
    );
    if (Object.keys(chosen).length > 0) output[domain] = chosen;
  }
  return output;
}

function debugContext(frame: ContextFrame): Record<string, unknown> {
  return { ...frame };
}

function focusedContext(frame: ContextFrame, domains: Domain[]): Record<string, unknown> {
  const domainQuality = Object.fromEntries(
    domains
      .filter((domain) => frame.quality?.domains[domain])
      .map((domain) => [domain, frame.quality?.domains[domain]]),
  );
  return {
    spec: frame.spec,
    generated_at: frame.generated_at,
    staleness_ms: frame.staleness_ms,
    privacy: frame.privacy,
    assistive_posture: frame.assistive_posture,
    situation: frame.situation,
    quality: frame.quality
      ? {
          overall_freshness: frame.quality.overall_freshness,
          domains: domainQuality,
          stability: frame.quality.stability,
        }
      : undefined,
    ...selectedFrameDomains(frame, domains, false),
  };
}

function briefContext(frame: ContextFrame, domains: Domain[]): Record<string, unknown> {
  return {
    generated_at: frame.generated_at,
    staleness_ms: frame.staleness_ms,
    assistive_posture: frame.assistive_posture,
    summary: frame.situation?.summary,
    confidence: frame.situation?.confidence,
    risks: frame.situation?.risks.slice(0, 3),
    unknowns: frame.situation?.unknowns.slice(0, 3),
    freshness: frame.quality?.overall_freshness,
    privacy: {
      tier: frame.privacy.tier,
      capabilities: frame.privacy.capabilities,
    },
    ...selectedFrameDomains(frame, domains, true),
  };
}

function compactContext(frame: ContextFrame, domains: Domain[]): Record<string, unknown> {
  return {
    generated_at: frame.generated_at,
    assistive_posture: frame.assistive_posture,
    summary: frame.situation?.summary,
    freshness: frame.quality?.overall_freshness,
    privacy_tier: frame.privacy.tier,
    ...selectedFrameDomains(frame, domains, true),
  };
}

function diffContext(frame: ContextFrame): Record<string, unknown> {
  return {
    generated_at: frame.generated_at,
    staleness_ms: frame.staleness_ms,
    freshness: frame.quality?.overall_freshness,
    screen_activity_stability: frame.quality?.stability.screen_activity,
    recent_changes: frame.situation?.recent_changes ?? [],
  };
}

function minimalContext(frame: ContextFrame): Record<string, unknown> {
  return {
    generated_at: frame.generated_at,
    assistive_posture: frame.assistive_posture,
    summary: frame.situation?.summary.slice(0, 160),
  };
}

function contextCandidates(
  frame: ContextFrame,
  projection: ContextProjection,
  domains: Domain[],
): Record<string, unknown>[] {
  const compact = compactContext(frame, domains);
  const minimal = minimalContext(frame);
  const tiny = {
    generated_at: frame.generated_at,
    assistive_posture: frame.assistive_posture,
  };

  if (projection === "debug") {
    return [debugContext(frame), focusedContext(frame, domains), briefContext(frame, domains), compact, minimal, tiny];
  }
  if (projection === "focused") {
    return [focusedContext(frame, domains), briefContext(frame, domains), compact, minimal, tiny];
  }
  if (projection === "brief") return [briefContext(frame, domains), compact, minimal, tiny];
  if (projection === "diff") return [diffContext(frame), minimal, tiny];
  return [compact, minimal, tiny];
}

function healthCandidates(health: ContextProviderHealth): ContextProviderHealth[] {
  return [
    health,
    { ...health, diagnostics: [] },
  ];
}

function withMeasurements(output: ContextProjectionOutput): ContextProjectionOutput {
  let bytes = 0;
  for (let index = 0; index < 20; index += 1) {
    output.budget.serialized_bytes = bytes;
    output.budget.estimated_tokens = Math.ceil(bytes / MAX_SERIALIZED_BYTES_PER_TOKEN);
    const next = Buffer.byteLength(JSON.stringify(output), "utf8");
    if (next === bytes) return output;
    bytes = next;
  }
  output.budget.serialized_bytes = bytes;
  output.budget.estimated_tokens = Math.ceil(bytes / MAX_SERIALIZED_BYTES_PER_TOKEN);
  return output;
}

function withOutputMeasurements<T extends Record<string, unknown>>(
  output: T & { output_budget: SerializedBudget },
): T & { output_budget: SerializedBudget } {
  let bytes = 0;
  for (let index = 0; index < 20; index += 1) {
    output.output_budget.serialized_bytes = bytes;
    output.output_budget.estimated_tokens = Math.ceil(bytes / MAX_SERIALIZED_BYTES_PER_TOKEN);
    const next = Buffer.byteLength(JSON.stringify(output), "utf8");
    if (next === bytes) return output;
    bytes = next;
  }
  output.output_budget.serialized_bytes = bytes;
  output.output_budget.estimated_tokens = Math.ceil(bytes / MAX_SERIALIZED_BYTES_PER_TOKEN);
  return output;
}

/** Selects the richest candidate that fits the complete structured-content ceiling. */
export function fitStructuredContent<T extends Record<string, unknown>>(
  candidates: T[],
  requestedMaxTokens: number,
): T & { output_budget: SerializedBudget } {
  const maxTokens = Math.max(96, Math.floor(requestedMaxTokens));
  const maxBytes = maxTokens * MAX_SERIALIZED_BYTES_PER_TOKEN;
  for (let index = 0; index < candidates.length; index += 1) {
    const output = withOutputMeasurements({
      ...candidates[index],
      output_budget: {
        max_tokens: maxTokens,
        max_bytes: maxBytes,
        estimated_tokens: 0,
        serialized_bytes: 0,
        truncated: index > 0,
      },
    });
    if (Buffer.byteLength(JSON.stringify(output), "utf8") <= maxBytes) return output;
  }
  throw new ContextBudgetError(maxBytes);
}

/**
 * Projects an authoritative provider frame into a bounded MCP payload. The
 * budget applies to the complete structured object, not just its context body.
 */
export function projectContext(
  result: ContextResult,
  options: ContextProjectionOptions,
): ContextProjectionOutput {
  const projection = options.projection;
  const maxTokens = Math.max(96, Math.floor(options.max_tokens ?? DEFAULT_CONTEXT_BUDGETS[projection]));
  const maxBytes = maxTokens * MAX_SERIALIZED_BYTES_PER_TOKEN;
  const domains = selectedDomains(options.domains);
  const contexts = contextCandidates(result.frame, projection, domains);
  const health = healthCandidates(result.health);

  for (let contextIndex = 0; contextIndex < contexts.length; contextIndex += 1) {
    for (let healthIndex = 0; healthIndex < health.length; healthIndex += 1) {
      const output = withMeasurements({
        ok: true,
        context_satisfied: options.context_satisfied,
        projection,
        generated_at: result.frame.generated_at,
        budget: {
          max_tokens: maxTokens,
          max_bytes: maxBytes,
          estimated_tokens: 0,
          serialized_bytes: 0,
          truncated: contextIndex > 0 || healthIndex > 0,
        },
        context: contexts[contextIndex],
        health: health[healthIndex],
        refreshed_domains: result.refreshed_domains,
      });
      if (Buffer.byteLength(JSON.stringify(output), "utf8") <= maxBytes) return output;
    }
  }

  const fallback = withMeasurements({
    ok: true,
    context_satisfied: options.context_satisfied,
    projection,
    generated_at: result.frame.generated_at,
    budget: {
      max_tokens: maxTokens,
      max_bytes: maxBytes,
      estimated_tokens: 0,
      serialized_bytes: 0,
      truncated: true,
    },
    context: {},
    health: { ...result.health, diagnostics: [] },
    refreshed_domains: [],
  });
  if (Buffer.byteLength(JSON.stringify(fallback), "utf8") > maxBytes) {
    throw new ContextBudgetError(maxBytes);
  }
  return fallback;
}
