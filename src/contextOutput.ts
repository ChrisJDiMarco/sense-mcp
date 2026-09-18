import type {
  ContextProviderHealth,
  ContextResult,
} from "./contextProvider.js";
import type { ContextFrame, Domain } from "./types.js";

export type ContextProjection = "compact" | "brief" | "focused" | "debug" | "diff";

/**
 * Serialized-token defaults per projection. Each one is derived from the cost of
 * that projection's complete, untruncated output over a realistically full frame
 * (all four domains populated, real health diagnostics attached) as measured
 * against live `npm run smoke` output, then given roughly a 40% headroom margin
 * so a stock call still returns the projection's full shape after a sensor or a
 * diagnostic is added. Measured full-shape cost -> shipped default:
 * compact 792 -> 1150, brief 1054 -> 1500, focused 1770 -> 2800,
 * debug 3788 -> 5600, diff 563 -> 800. These are ceilings, not costs: a larger
 * default never inflates a response, it only stops one being truncated.
 * compact and brief moved up from 1000 and 1350 when DOMAIN_FIELDS took on the
 * emitted fields a client should receive at every detail level; the margin, not
 * the policy, changed.
 */
export const DEFAULT_CONTEXT_BUDGETS: Record<ContextProjection, number> = {
  compact: 1_150,
  brief: 1_500,
  focused: 2_800,
  debug: 5_600,
  diff: 800,
};

/**
 * The smallest budget that can still return a domain, not merely the envelope.
 * What it guarantees over a realistically full frame is the compact body: a
 * single-domain compact or brief call returns every field DOMAIN_FIELDS carries
 * for that domain at exactly this budget. It is not enough for focused or debug,
 * which carry the domain verbatim and cost 1275-3788 tokens for one domain; a
 * call at the floor with those projections falls back to the compact shape and
 * comes back `context_satisfied: false` with a `context_omitted` block naming
 * the fields' domains and the budget that returns them, rather than shedding
 * them silently. Callers get the projection defaults above unless they ask
 * otherwise, so the floor is what a caller who deliberately squeezes the budget
 * gets.
 */
export const MIN_CONTEXT_MAX_TOKENS = 320;

/**
 * The largest budget any Sense tool accepts. `mcpSchemas.ts` publishes it as the
 * input ceiling, and the server probes against it when it has to tell a caller
 * which max_tokens would actually have worked: a suggestion above this number
 * would be rejected by the very schema the caller has to retry through.
 */
export const MAX_CONTEXT_MAX_TOKENS = 8_192;

export interface ContextProjectionOptions {
  projection: ContextProjection;
  domains?: Domain[];
  max_tokens?: number;
  /**
   * Deprecated and ignored. `context_satisfied` is no longer something a caller
   * asserts: `projectContext` measures the response it actually built against
   * the frame it was built from and answers the question itself. The field stays
   * accepted so existing call sites keep compiling while they drop it.
   */
  context_satisfied?: boolean;
}

/**
 * What a response left out, why, and what to do about it. It rides on an
 * `ok: true` response beside `context_satisfied: false`: partial truthful
 * context plus an explicit account of the gap is useful, and a hard error is
 * not. `suggested_max_tokens` is present only when that budget was measured to
 * return the complete response, and it is always larger than the budget the
 * caller already sent.
 */
export interface ContextOmission {
  domains: Domain[];
  reason: string;
  suggested_max_tokens?: number;
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
  context_omitted?: ContextOmission;
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

/**
 * The fields `compact` and `brief` carry. Together with WITHHELD_COMPACT_FIELDS
 * this is a complete decision over every field the sensors in src/sensors and
 * src/iphoneContext.ts actually emit today: each emitted field is either listed
 * here because a client should receive it at every detail level, or listed as
 * withheld because the leaner projections deliberately leave it to focused and
 * debug.
 *
 * A field in NEITHER list is a field from a newer broker than this server, which
 * is routine: the MCP server consumes whatever frame the socket's broker sends
 * and the version probe compares protocol versions, not field names. Such a
 * field is a forward-compatibility event, never a budget failure. The rule,
 * enforced by `contextCoverage`, is that an unclassified field is ignored for
 * satisfaction accounting under compact and brief -- it cannot make a response
 * unsatisfied and it cannot make a tool fail -- and is returned verbatim under
 * focused, debug and diff, which carry the domain whole. Keeping the lists
 * complete is a maintenance task with a test of its own
 * (tests/protocol-output.test.ts), not something a running tool enforces against
 * the user's broker.
 */
const DOMAIN_FIELDS: Record<Domain, string[]> = {
  screen: [
    "active_app",
    "activity_class",
    "active_window_label",
    "sensitivity_level",
    "workspace_name",
    "git_branch",
    "git_dirty_count",
    "project_type",
    "work_mode",
  ],
  user: ["idle_seconds", "presence", "input_cadence", "focus_mode", "do_not_disturb"],
  environment: [
    "day_segment",
    "is_workday",
    "power_source",
    "battery_percent",
    "location_class",
    "noise_class",
    "lighting",
    "media_playback",
  ],
  schedule: [
    "in_meeting",
    "next_event_minutes",
    "time_pressure",
    "work_window",
    "meeting_state",
  ],
};

/**
 * Emitted fields `compact` and `brief` withhold on purpose. Each one is either a
 * raw measurement whose semantic form is already carried, a restatement of a
 * carried field, or an opt-in block large enough to crowd out the situation
 * summary in a low-detail response. None of them is lost: focused and debug
 * return the domain verbatim. Withholding one of these beside a carried field is
 * a projection decision and not an omission.
 *
 * A domain whose live fields are ALL withheld is a different case: compact and
 * brief then return nothing at all for a domain the frame populated, so the
 * response is honestly `context_satisfied: false` with the domain named in
 * `context_omitted` and a pointer at focused or debug. No budget can fix that
 * one, so none is suggested.
 */
const WITHHELD_COMPACT_FIELDS = new Set([
  // screen -- active-window
  "active_window_title", // the raw (redacted) title; the highest-sensitivity screen field, and active_window_label is its semantic form.
  "title_withheld", // only meaningful beside the title it replaces.
  "sensitivity_reason", // the explanation behind sensitivity_level, which is carried.
  // screen -- workspace
  "git_has_uncommitted_changes", // exactly git_dirty_count > 0, which is carried.
  "git_dirty_severity", // a bucketing of git_dirty_count, which is carried.
  "package_manager", // repo trivia the model can read off disk.
  "has_test_script",
  "has_build_script",
  "has_dev_script",
  "available_scripts",
  // user -- health bridge (opt-in body telemetry)
  "readiness_class",
  "recovery_class",
  "stress_class",
  "sleep_debt",
  "readiness_score",
  // environment -- time-context
  "local_time", // the client already has the clock; day_segment is the semantic form.
  "daylight_class", // a second lighting classification; lighting is the ambient one and is carried.
  // environment -- battery
  "low_power", // derivable from power_source and battery_percent, both carried.
  // environment -- camera policy
  "camera_capture_enabled", // capability facts; the privacy block is where a client reads these.
  "camera_requires_local_consent",
  // environment -- media
  "media_app", // which app and what kind; media_playback is the situational part.
  "media_type",
  "media_kind",
  // environment -- devices
  "external_display_count", // desk-hardware inventory; no bearing on how to answer.
  "multi_display",
  "airpods_connected",
  "bluetooth_input_connected",
  // environment -- ambient light and audio level
  "ambient_light_value", // the raw reading behind lighting, which is carried.
  "microphone_level_db", // the raw reading behind noise_class, which is carried.
  "microphone_level_sample_ms",
  // environment -- weather bridge (opt-in)
  "weather_class",
  "temperature_f",
  "precipitation_class",
  "wind_class",
  "uv_class",
  // schedule -- calendar
  "usable_work_minutes", // a numeric restatement of work_window, which is carried.
  "prep_window", // a restatement of next_event_minutes and meeting_state, both carried.
]);

/**
 * The iPhone companion writes a self-report block and a mirrored device block
 * into the `user` domain (src/iphoneContext.ts). Both are open-ended and can run
 * to a dozen fields including free text, so they are withheld by prefix rather
 * than enumerated field by field.
 */
const WITHHELD_COMPACT_PREFIXES = ["self_report_", "iphone_"];

function withheldFromCompact(field: string): boolean {
  return (
    WITHHELD_COMPACT_FIELDS.has(field) ||
    WITHHELD_COMPACT_PREFIXES.some((prefix) => field.startsWith(prefix))
  );
}

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
  const maxTokens = Math.max(MIN_CONTEXT_MAX_TOKENS, Math.floor(requestedMaxTokens));
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
 * What a requested domain is owed at this projection. compact and brief carry
 * exactly DOMAIN_FIELDS, so what they owe is the live fields that list names.
 * Every other projection carries the domain verbatim, so it owes every live
 * field. Fields the frame does not populate are unknown, not owed, and fields
 * this build has never heard of are ignored here on purpose: see DOMAIN_FIELDS
 * for why an unclassified field from a newer broker is a compatibility event and
 * not a failure.
 */
function owedFields(frame: ContextFrame, domain: Domain, filtered: boolean): string[] {
  const live = frame[domain];
  if (!live) return [];
  const present = Object.keys(live).filter((field) => live[field] !== undefined);
  if (!filtered) return present;
  const carried = new Set(DOMAIN_FIELDS[domain]);
  return present.filter((field) => carried.has(field));
}

function hasLiveFields(frame: ContextFrame, domain: Domain): boolean {
  const live = frame[domain];
  return live !== undefined && Object.values(live).some((value) => value !== undefined);
}

export interface ContextCoverage {
  /** True when every requested domain the frame populated is in the response. */
  satisfied: boolean;
  /** The requested domains whose frame data the response does not carry. */
  omitted_domains: Domain[];
  /**
   * The omitted domains that are absent because this projection carries none of
   * the fields they currently have, which no budget can change. They are named
   * separately from the rest so a message about them cannot blame a domain that
   * a larger budget would have returned.
   */
  projection_limited_domains: Domain[];
  /** `diff` only: the frame had a recent-change timeline and the response lost it. */
  timeline_omitted: boolean;
}

/**
 * Measures the response that was actually built against the frame it was built
 * from. This is the whole definition of `context_satisfied`: true only when
 * every requested domain that ACTUALLY HAS DATA in the frame is present in the
 * response. A domain the frame never populated is unknown, so nothing is owed
 * for it and its absence is not an omission.
 *
 * `diff` carries no domain bodies at any budget by contract -- it answers "what
 * changed", not "what is the state" -- so its domains are never owed. What it
 * does owe is the recent-change timeline, and losing that to a leaner candidate
 * is the one way a diff response can come back unsatisfied.
 */
export function contextCoverage(
  frame: ContextFrame,
  projection: ContextProjection,
  context: Record<string, unknown>,
  domains?: Domain[],
): ContextCoverage {
  if (projection === "diff") {
    const timelineOmitted =
      frame.situation !== undefined && context.recent_changes === undefined;
    return {
      satisfied: !timelineOmitted,
      omitted_domains: [],
      projection_limited_domains: [],
      timeline_omitted: timelineOmitted,
    };
  }
  const filtered = projection === "compact" || projection === "brief";
  const omitted: Domain[] = [];
  const projectionLimited: Domain[] = [];
  for (const domain of selectedDomains(domains)) {
    if (!hasLiveFields(frame, domain)) continue;
    const body = context[domain] as Record<string, unknown> | undefined;
    const present = body !== undefined && Object.keys(body).length > 0;
    const owed = owedFields(frame, domain, filtered);
    if (owed.length === 0) {
      // The frame has data here and this projection carries none of it. No
      // budget can recover it, so the caller is pointed at a richer projection.
      if (!present) {
        omitted.push(domain);
        projectionLimited.push(domain);
      }
      continue;
    }
    if (!present || owed.some((field) => body?.[field] === undefined)) omitted.push(domain);
  }
  return {
    satisfied: omitted.length === 0,
    omitted_domains: omitted,
    projection_limited_domains: projectionLimited,
    timeline_omitted: false,
  };
}

interface ProjectionRung {
  context: Record<string, unknown>;
  health: ContextProviderHealth;
  refreshed_domains: Domain[];
  truncated: boolean;
}

/**
 * Every response shape this projection can fall back to, richest first: each
 * context candidate with full diagnostics, then the same candidate without
 * them, and finally an envelope with no context body at all.
 */
function projectionLadder(
  result: ContextResult,
  projection: ContextProjection,
  domains: Domain[],
): ProjectionRung[] {
  const contexts = contextCandidates(result.frame, projection, domains);
  const healths = healthCandidates(result.health);
  const ladder: ProjectionRung[] = [];
  for (let contextIndex = 0; contextIndex < contexts.length; contextIndex += 1) {
    for (let healthIndex = 0; healthIndex < healths.length; healthIndex += 1) {
      ladder.push({
        context: contexts[contextIndex],
        health: healths[healthIndex],
        refreshed_domains: result.refreshed_domains,
        truncated: contextIndex > 0 || healthIndex > 0,
      });
    }
  }
  ladder.push({
    context: {},
    health: { ...result.health, diagnostics: [] },
    refreshed_domains: [],
    truncated: true,
  });
  return ladder;
}

function buildProjection(
  rung: ProjectionRung,
  projection: ContextProjection,
  generatedAt: string,
  maxTokens: number,
  maxBytes: number,
  satisfied: boolean,
  omission: ContextOmission | undefined,
): ContextProjectionOutput {
  return withMeasurements({
    ok: true,
    context_satisfied: satisfied,
    projection,
    generated_at: generatedAt,
    budget: {
      max_tokens: maxTokens,
      max_bytes: maxBytes,
      estimated_tokens: 0,
      serialized_bytes: 0,
      truncated: rung.truncated,
    },
    context: rung.context,
    health: rung.health,
    refreshed_domains: rung.refreshed_domains,
    ...(omission ? { context_omitted: omission } : {}),
  });
}

/** The richest rung whose complete serialized response fits the ceiling. */
function fitProjection(
  ladder: ProjectionRung[],
  maxBytes: number,
  build: (rung: ProjectionRung) => ContextProjectionOutput,
): ContextProjectionOutput | undefined {
  for (const rung of ladder) {
    const output = build(rung);
    if (Buffer.byteLength(JSON.stringify(output), "utf8") <= maxBytes) return output;
  }
  return undefined;
}

function satisfiedAtBudget(
  result: ContextResult,
  projection: ContextProjection,
  domains: Domain[],
  ladder: ProjectionRung[],
  maxTokens: number,
): boolean {
  const maxBytes = maxTokens * MAX_SERIALIZED_BYTES_PER_TOKEN;
  const output = fitProjection(ladder, maxBytes, (rung) =>
    buildProjection(rung, projection, result.frame.generated_at, maxTokens, maxBytes, true, undefined),
  );
  if (!output) return false;
  return contextCoverage(result.frame, projection, output.context, domains).satisfied;
}

/**
 * The smallest max_tokens that genuinely returns this exact frame, projection
 * and domain set complete -- and genuinely exceeds what the caller already sent.
 * Every candidate is verified by building the response at that budget and
 * measuring its coverage, so a suggestion this returns is a suggestion that
 * works; `undefined` means no budget the input schema accepts would, and the
 * caller is told that instead of a number they cannot use.
 */
export function sufficientContextMaxTokens(
  result: ContextResult,
  projection: ContextProjection,
  domains: Domain[] | undefined,
  requestedMaxTokens: number,
): number | undefined {
  const selected = selectedDomains(domains);
  const ladder = projectionLadder(result, projection, selected);
  const floor = Math.max(MIN_CONTEXT_MAX_TOKENS, Math.floor(requestedMaxTokens) + 1);
  if (floor > MAX_CONTEXT_MAX_TOKENS) return undefined;
  if (!satisfiedAtBudget(result, projection, selected, ladder, MAX_CONTEXT_MAX_TOKENS)) {
    return undefined;
  }
  let low = floor;
  let high = MAX_CONTEXT_MAX_TOKENS;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (satisfiedAtBudget(result, projection, selected, ladder, middle)) high = middle;
    else low = middle + 1;
  }
  return high;
}

function describeOmission(
  projection: ContextProjection,
  coverage: ContextCoverage,
  suggested: number | undefined,
): ContextOmission {
  const named = coverage.omitted_domains.join(", ");
  // "Some of" is load-bearing: a domain counts as omitted when the response
  // carries the key but not every field this projection owes for it, which is
  // the same loss as losing the domain outright but does not look like one.
  const subject = coverage.timeline_omitted
    ? "The recent-change timeline"
    : `Some of the requested ${named} data`;
  if (suggested !== undefined) {
    return {
      domains: coverage.omitted_domains,
      reason: `${subject} did not fit the serialized output budget. Retry with max_tokens ${suggested} for the complete response.`,
      suggested_max_tokens: suggested,
    };
  }
  if (coverage.projection_limited_domains.length > 0) {
    return {
      domains: coverage.omitted_domains,
      reason:
        `The ${projection} projection carries none of the fields ` +
        `${coverage.projection_limited_domains.join(", ")} currently has, so no budget ` +
        "returns it. Retry with projection focused or debug.",
    };
  }
  return {
    domains: coverage.omitted_domains,
    reason:
      `${subject} does not fit any max_tokens up to ${MAX_CONTEXT_MAX_TOKENS} at the ` +
      `${projection} projection. Request fewer domains or a leaner projection.`,
  };
}

/**
 * The omission block, in decreasing verbosity. Both variants name the same
 * domains and the same retry budget; only the prose shrinks, so a response
 * squeezed toward the floor still says which domains are missing and what to
 * send instead.
 */
function omissionVariants(
  projection: ContextProjection,
  coverage: ContextCoverage,
  suggested: number | undefined,
): ContextOmission[] {
  const full = describeOmission(projection, coverage, suggested);
  const terse: ContextOmission = {
    domains: coverage.omitted_domains,
    reason:
      suggested === undefined
        ? `Retry with projection focused or debug; ${projection} cannot carry this.`
        : `Retry with max_tokens ${suggested}.`,
    ...(suggested === undefined ? {} : { suggested_max_tokens: suggested }),
  };
  return [full, terse];
}

/**
 * Projects an authoritative provider frame into a bounded MCP payload. The
 * budget applies to the complete structured object, not just its context body.
 *
 * The response is always the most complete one that fits. When that is not all
 * of it, the shortfall is reported in place rather than raised: `ok` stays true,
 * `context_satisfied` goes false, the partial context that did fit is returned,
 * and `context_omitted` names what is missing and the budget that would return
 * it. Partial truthful context is useful to a model; an exception is not.
 *
 * The only case that still throws is the genuinely unusable one -- not even the
 * empty envelope fits the ceiling -- because there is then no response to
 * return at all.
 */
export function projectContext(
  result: ContextResult,
  options: ContextProjectionOptions,
): ContextProjectionOutput {
  const projection = options.projection;
  const maxTokens = Math.max(
    MIN_CONTEXT_MAX_TOKENS,
    Math.floor(options.max_tokens ?? DEFAULT_CONTEXT_BUDGETS[projection]),
  );
  const maxBytes = maxTokens * MAX_SERIALIZED_BYTES_PER_TOKEN;
  const domains = selectedDomains(options.domains);
  const ladder = projectionLadder(result, projection, domains);
  const generatedAt = result.frame.generated_at;

  const complete = fitProjection(ladder, maxBytes, (rung) =>
    buildProjection(rung, projection, generatedAt, maxTokens, maxBytes, true, undefined),
  );
  if (!complete) throw new ContextBudgetError(maxBytes);
  if (contextCoverage(result.frame, projection, complete.context, domains).satisfied) {
    return complete;
  }

  // Something was left out. The report of what is missing is part of the
  // response, not a garnish on it: a caller who is told which domains are gone
  // and which max_tokens returns them can act, and a caller handed a quietly
  // partial body cannot. So the ladder is walked again with the block attached,
  // trying the full wording first and a terse one next at each rung. The
  // suggestion depends only on the frame and the request, not on the rung, so it
  // is measured once.
  const suggested = sufficientContextMaxTokens(result, projection, domains, maxTokens);
  for (const rung of ladder) {
    const coverage = contextCoverage(result.frame, projection, rung.context, domains);
    if (coverage.satisfied) {
      // A leaner rung cannot gain coverage, so this only happens at the rung
      // pass one already rejected for size. Nothing to report here.
      continue;
    }
    for (const omission of omissionVariants(projection, coverage, suggested)) {
      const output = buildProjection(
        rung,
        projection,
        generatedAt,
        maxTokens,
        maxBytes,
        false,
        omission,
      );
      if (Buffer.byteLength(JSON.stringify(output), "utf8") <= maxBytes) return output;
    }
  }

  // Not even the bare `context_satisfied: false` fit anywhere above, which takes
  // one more byte than `true`. Step down until something does.
  const bare = fitProjection(ladder, maxBytes, (candidate) =>
    buildProjection(candidate, projection, generatedAt, maxTokens, maxBytes, false, undefined),
  );
  if (!bare) throw new ContextBudgetError(maxBytes);
  return bare;
}
