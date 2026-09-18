import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import {
  createLocalContextProvider,
  isContextProvider,
  type ContextProvider,
  type ContextResult,
} from "./contextProvider.js";
import {
  DEFAULT_CONTEXT_BUDGETS,
  MAX_CONTEXT_MAX_TOKENS,
  MIN_CONTEXT_MAX_TOKENS,
  ContextBudgetError,
  contextCoverage,
  estimateJsonTokens,
  fitStructuredContent,
  projectContext,
  sufficientContextMaxTokens,
  type ContextOmission,
  type ContextProjection,
} from "./contextOutput.js";
import { SENSE_SERVER_INSTRUCTIONS } from "./instructions.js";
import { recordAccess, type AccessLedgerInput } from "./ledger.js";
import {
  cameraSnapshotInputSchema,
  contextQueryInputSchema,
  contextToolOutputSchema,
  domainsQueryInputSchema,
  fullScreenSnapshotInputSchema,
  relevantContextInputSchema,
  relevantContextOutputSchema,
  snapshotToolOutputSchema,
  windowSnapshotInputSchema,
} from "./mcpSchemas.js";
import { planRelevantContext, type RelevantContextPlan } from "./relevance.js";
import { takeCameraSnapshot, type CameraSnapshot } from "./sensors/camera.js";
import {
  takeFullScreenSnapshot,
  takeWindowSnapshot,
  type ScreenSnapshot,
  type ScreenSnapshotMode,
} from "./sensors/screenSnapshot.js";
import { snapshotFailureHint } from "./snapshotAdvice.js";
import { StateStore } from "./state.js";
import type { Domain, Privacy } from "./types.js";

type ContextQuery = z.infer<typeof contextQueryInputSchema>;
type RelevantContextQuery = z.infer<typeof relevantContextInputSchema>;

export interface WindowSnapshot extends ScreenSnapshot {
  window_id?: number;
}

export interface ServerDependencies {
  captureCamera?: (
    deviceIndex: number,
    mode: CameraSnapshot["mode"] | undefined,
    reason: string,
  ) => Promise<CameraSnapshot>;
  captureWindow?: (
    windowId: number | undefined,
    mode: ScreenSnapshotMode | undefined,
    reason: string,
  ) => Promise<WindowSnapshot>;
  captureFullScreen?: (
    mode: ScreenSnapshotMode | undefined,
    reason: string,
  ) => Promise<ScreenSnapshot>;
  writeAccess?: (input: AccessLedgerInput) => Promise<void>;
}

const CONTEXT_TOOL_NAMES = new Set([
  "get_context_frame",
  "get_screen_context",
  "get_user_state",
  "get_environment_context",
  "get_schedule_context",
  "get_domains",
]);

/**
 * The router's ceiling when the caller does not name one. get_relevant_context
 * is the first tool a client sees and the one the server instructions tell it to
 * call, so this default has to carry the whole answer: the routing plan, the
 * guidance, and the planned domains' context. Over a realistically full frame
 * (`npm run smoke` shape) that complete payload costs 1930 tokens, so the
 * default sits at the same 2800 the focused projection uses -- roughly 45%
 * headroom for one more sensor, diagnostic or guidance line. It was 1000, which
 * did not even cover the 1770-token focused context on its own, let alone the
 * ~414-token routing envelope on top of it.
 */
const ROUTER_DEFAULT_MAX_TOKENS = 2_800;

function readOnlyAnnotations(title: string) {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;
}

function captureAnnotations(title: string) {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  } as const;
}

function machineErrorResult(
  code: string,
  message: string,
  retryable: boolean,
  fixHint?: string,
): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: {
      ok: false,
      context_satisfied: false,
      error: {
        code,
        message,
        retryable,
        ...(fixHint ? { fix_hint: fixHint } : {}),
      },
    },
  };
}

/**
 * The one remaining hard error on a context path: the ceiling is so low that not
 * even the empty envelope fits, so there is no response to return at all. It is
 * retryable only when a budget that works was actually measured -- a retryable
 * error beside a hint saying no retry can work is worse than no hint.
 *
 * Every lesser shortfall is NOT an error. A response that fits but had to leave
 * requested domain data out comes back as `ok: true` with the partial context,
 * `context_satisfied: false`, and a `context_omitted` block naming what is
 * missing and the budget that returns it. Partial truthful context is useful to
 * a model; a hard error on a context-enrichment tool is not, and it takes the
 * tool out entirely for callers who cannot pick different arguments.
 */
function unusableBudgetResult(
  subject: string,
  requestedMaxTokens: number,
  suggestedMaxTokens: number | undefined,
): CallToolResult {
  return machineErrorResult(
    "context_budget_too_small",
    `${subject} could not return any response within max_tokens ${requestedMaxTokens}.`,
    suggestedMaxTokens !== undefined,
    suggestedMaxTokens === undefined
      ? `No max_tokens up to ${MAX_CONTEXT_MAX_TOKENS} returns this response; ` +
          "request fewer domains or a leaner projection."
      : `Retry with a larger max_tokens; ${suggestedMaxTokens} fits this request.`,
  );
}

function projectionFor(query: ContextQuery, fallback: ContextProjection): ContextProjection {
  return query.projection ?? fallback;
}

/**
 * The human-readable line beside the structured content. A partial response says
 * so and says what to do, because a client that reads only the text must not
 * conclude a partial answer was a complete one.
 */
function contextText(
  projection: ContextProjection,
  omitted: ContextOmission | undefined,
): string {
  if (!omitted) return `Sense context ready (${projection}).`;
  const named = omitted.domains.length > 0 ? ` Omitted: ${omitted.domains.join(", ")}.` : "";
  return `Sense context partial (${projection}).${named} ${omitted.reason}`;
}


function minimalRouterContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const compact = {
    generated_at: context.generated_at,
    assistive_posture: context.assistive_posture,
    summary: context.summary,
    freshness: context.freshness,
  };
  return Object.fromEntries(Object.entries(compact).filter(([, value]) => value !== undefined));
}

/** Keeps the routing header and the planned domains while shedding everything else. */
function plannedRouterContext(
  context: Record<string, unknown> | undefined,
  domains: Domain[],
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const reduced = minimalRouterContext(context) ?? {};
  for (const domain of domains) {
    if (context[domain] !== undefined) reduced[domain] = context[domain];
  }
  return Object.keys(reduced).length > 0 ? reduced : undefined;
}

function withoutDiagnostics(health: unknown): unknown {
  if (!health || typeof health !== "object") return health;
  return { ...(health as Record<string, unknown>), diagnostics: [] };
}

/**
 * The ladder `fitStructuredContent` walks, richest first. Each rung sheds one
 * more thing, so a budget slightly under the full payload costs the caller the
 * cheapest item rather than the answer: the advisory lists and any surviving
 * health diagnostics first, then the parts of the context body outside the
 * planned domains, and only then the plan itself. It used to be three rungs --
 * full, a lightly trimmed copy, and a `core` that drops context_plan, guidance
 * and the domain bodies at once -- so a payload a few tokens over budget
 * collapsed from 1341 estimated tokens to 180 and returned no context at all
 * under `context_satisfied: true`.
 *
 * Every rung here is reachable, and tests/server-protocol.test.ts pins each one
 * by searching the accepted budget range for a budget that selects it. A rung
 * that stops being reachable is dead code pretending to be a safety net.
 */
function routerCandidates(
  plan: RelevantContextPlan,
  additions: Record<string, unknown>,
  plannedDomains: Domain[] = [],
): Record<string, unknown>[] {
  const full = { ok: true, ...plan, ...additions };
  const concise = {
    ok: true,
    context_satisfied: additions.context_satisfied ?? plan.context_satisfied,
    intent: plan.intent,
    confidence: plan.confidence,
    minimum_tool: plan.minimum_tool,
    relevant_domains: plan.relevant_domains,
    recommended_tools: plan.recommended_tools,
    follow_up_tools: additions.follow_up_tools ?? plan.follow_up_tools,
    avoided_tools: plan.avoided_tools,
    requires_explicit_media: plan.requires_explicit_media,
    snapshot_mode: plan.snapshot_mode,
    context_plan: plan.context_plan,
    guidance: plan.guidance.slice(0, 1),
    fallbacks: plan.fallbacks.slice(0, 1),
    privacy_notes: plan.privacy_notes.slice(0, 1),
    ...additions,
  };
  // Then the advisory lists, which restate what context_plan already carries,
  // and the health diagnostics, which are the largest thing in the payload that
  // is not an answer. These used to be two rungs, with diagnostics shed first.
  // That rung was dead: by the time the router is tight enough to leave
  // `concise`, the embedded context has already come back from
  // `projectContext`'s own health ladder with `diagnostics: []`, so the
  // diagnostics-only rung was byte-identical to the one above it and could never
  // be the first that fits. Measured over every accepted budget for six router
  // prompts against docs/evals/real-frame-fixture.json: 0 selections out of
  // 47238. The stripping stays here so a health block that did survive is still
  // shed before the advisory lists' content.
  const lean = {
    ...concise,
    ...(additions.health === undefined ? {} : { health: withoutDiagnostics(additions.health) }),
    fallbacks: [],
    privacy_notes: [],
    avoided_tools: [],
    recommended_tools: plan.recommended_tools.slice(0, 1),
  };
  // Then everything in the context body outside the domains the plan asked for.
  const plannedContext = plannedRouterContext(
    additions.context as Record<string, unknown> | undefined,
    plannedDomains,
  );
  const planned = {
    ...lean,
    ...(plannedContext ? { context: plannedContext } : {}),
  };
  const minimalContext = minimalRouterContext(
    additions.context as Record<string, unknown> | undefined,
  );
  const core = {
    ok: true,
    context_satisfied: additions.context_satisfied ?? plan.context_satisfied,
    intent: plan.intent,
    confidence: plan.confidence,
    minimum_tool: plan.minimum_tool,
    follow_up_tools: additions.follow_up_tools ?? plan.follow_up_tools,
    requires_explicit_media: plan.requires_explicit_media,
    ...(plan.snapshot_mode ? { snapshot_mode: plan.snapshot_mode } : {}),
    ...(minimalContext && Object.keys(minimalContext).length > 0 ? { context: minimalContext } : {}),
    ...(additions.context_omitted === undefined
      ? {}
      : { context_omitted: additions.context_omitted }),
  };
  return [full, concise, lean, planned, core];
}

/**
 * The invariant applied to the payload that is ACTUALLY RETURNED. The inner
 * `projectContext` result is only an intermediate: `fitStructuredContent`
 * rebuilds the response from the candidate ladder afterwards and can pick a
 * leaner rung that strips the routing plan or the context body. Checking the
 * intermediate and returning the rebuild is how a call could report
 * `context_satisfied: true` with no context at all -- and the shipped server
 * instructions tell the model that `context_satisfied: true` means stop asking,
 * so the model concludes there is no context rather than retrying.
 *
 * Coverage is measured against the FRAME, not against the intermediate, so a
 * domain the inner projection had already shed is caught here too.
 */
interface RouterCoverage {
  satisfied: boolean;
  omitted_domains: Domain[];
  projection_limited_domains: Domain[];
  plan_omitted: boolean;
}

function routerCoverage(
  output: Record<string, unknown>,
  plan: RelevantContextPlan,
  result: ContextResult,
  projection: ContextProjection,
): RouterCoverage {
  const planOmitted =
    output.context_plan === undefined ||
    !Array.isArray(output.guidance) ||
    output.guidance.length === 0;
  const coverage = contextCoverage(
    result.frame,
    projection,
    (output.context as Record<string, unknown> | undefined) ?? {},
    plan.relevant_domains,
  );
  return {
    satisfied: coverage.satisfied && !planOmitted,
    omitted_domains: coverage.omitted_domains,
    projection_limited_domains: coverage.projection_limited_domains,
    plan_omitted: planOmitted,
  };
}

/**
 * How much of the router budget the routing envelope itself needs, so the
 * embedded context is fitted into what is left rather than into the whole
 * ceiling. Sizing the context against the full ceiling and then adding ~414
 * tokens of plan on top guarantees an overflow, which is what made the ladder
 * fire on a stock call in the first place.
 */
function routerEnvelopeTokens(
  plan: RelevantContextPlan,
  result: ContextResult,
  budgetHint: number,
): number {
  const placeholderBudget = {
    max_tokens: budgetHint,
    max_bytes: budgetHint * 3,
    estimated_tokens: budgetHint,
    serialized_bytes: budgetHint * 3,
    truncated: false,
  };
  return estimateJsonTokens({
    ok: true,
    ...plan,
    context_satisfied: true,
    follow_up_tools: plan.follow_up_tools,
    context: {},
    context_budget: placeholderBudget,
    output_budget: placeholderBudget,
    health: result.health,
    refreshed_domains: result.refreshed_domains,
  });
}

/**
 * One complete router response at one budget. `undefined` means not even the
 * leanest routing rung fits, which is the router's only unusable case.
 */
function buildRouterOutput(
  plan: RelevantContextPlan,
  result: ContextResult,
  projection: ContextProjection,
  outputMaxTokens: number,
  satisfied: boolean,
  omission: ContextOmission | undefined,
): Record<string, unknown> | undefined {
  const contextMaxTokens = Math.max(
    MIN_CONTEXT_MAX_TOKENS,
    outputMaxTokens - routerEnvelopeTokens(plan, result, outputMaxTokens),
  );
  let context;
  try {
    context = projectContext(result, {
      projection,
      domains: plan.relevant_domains,
      max_tokens: contextMaxTokens,
    });
  } catch {
    return undefined;
  }
  const additions = {
    context_satisfied: satisfied,
    follow_up_tools: plan.follow_up_tools.filter((tool) => !CONTEXT_TOOL_NAMES.has(tool)),
    context: context.context,
    context_budget: context.budget,
    health: context.health,
    refreshed_domains: context.refreshed_domains,
    ...(omission ? { context_omitted: omission } : {}),
  };
  try {
    return fitStructuredContent(
      routerCandidates(plan, additions, plan.relevant_domains),
      outputMaxTokens,
    );
  } catch {
    return undefined;
  }
}

/**
 * The smallest router max_tokens that genuinely returns the plan, the guidance
 * and the planned domains, and genuinely exceeds what the caller already sent.
 * Each candidate budget is verified by building the whole response at it and
 * measuring that response, rather than by adding up estimates -- the estimate
 * this used to sum double-counted health and still had to be corrected upward
 * by a constant. `undefined` means no accepted budget works.
 */
function sufficientRouterMaxTokens(
  plan: RelevantContextPlan,
  result: ContextResult,
  projection: ContextProjection,
  outputMaxTokens: number,
): number | undefined {
  const satisfiedAt = (budget: number): boolean => {
    const output = buildRouterOutput(plan, result, projection, budget, true, undefined);
    return output !== undefined && routerCoverage(output, plan, result, projection).satisfied;
  };
  const floor = Math.max(MIN_CONTEXT_MAX_TOKENS, Math.floor(outputMaxTokens) + 1);
  if (floor > MAX_CONTEXT_MAX_TOKENS) return undefined;
  if (!satisfiedAt(MAX_CONTEXT_MAX_TOKENS)) return undefined;
  let low = floor;
  let high = MAX_CONTEXT_MAX_TOKENS;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (satisfiedAt(middle)) high = middle;
    else low = middle + 1;
  }
  return high;
}

/** What the router left out, in the same shape the context tools report. */
function describeRouterOmission(
  projection: ContextProjection,
  coverage: RouterCoverage,
  suggested: number | undefined,
): ContextOmission {
  const parts: string[] = [];
  if (coverage.plan_omitted) parts.push("the routing plan and its guidance");
  if (coverage.omitted_domains.length > 0) {
    parts.push(`some of the planned ${coverage.omitted_domains.join(", ")} data`);
  }
  const subject = parts.length > 0 ? parts.join(" and ") : "part of the routing answer";
  if (suggested !== undefined) {
    return {
      domains: coverage.omitted_domains,
      reason: `Sense left out ${subject} to fit the serialized output budget. Retry with max_tokens ${suggested} for the complete response.`,
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
      `Sense left out ${subject}, and no max_tokens up to ${MAX_CONTEXT_MAX_TOKENS} returns ` +
      "all of it. Call a single-domain context tool for the part you need.",
  };
}

async function safeRecordAccess(
  writeAccess: (input: AccessLedgerInput) => Promise<void>,
  input: AccessLedgerInput,
): Promise<void> {
  await writeAccess(input).catch(() => undefined);
}

function resolveProvider(
  providerOrStore: ContextProvider | StateStore,
  getPrivacyOrDependencies?: (() => Privacy) | ServerDependencies,
): ContextProvider {
  if (isContextProvider(providerOrStore)) return providerOrStore;
  if (typeof getPrivacyOrDependencies !== "function") {
    throw new TypeError("A privacy provider is required when createServer receives a StateStore.");
  }
  return createLocalContextProvider(providerOrStore, getPrivacyOrDependencies);
}

function resolveDependencies(
  providerOrStore: ContextProvider | StateStore,
  getPrivacyOrDependencies?: (() => Privacy) | ServerDependencies,
  localDependencies?: ServerDependencies,
): ServerDependencies {
  return isContextProvider(providerOrStore)
    ? typeof getPrivacyOrDependencies === "object"
      ? getPrivacyOrDependencies
      : {}
    : localDependencies ?? {};
}

export function createServer(
  provider: ContextProvider,
  dependencies?: ServerDependencies,
): McpServer;
export function createServer(
  store: StateStore,
  getPrivacy: () => Privacy,
  dependencies?: ServerDependencies,
): McpServer;
export function createServer(
  providerOrStore: ContextProvider | StateStore,
  getPrivacyOrDependencies?: (() => Privacy) | ServerDependencies,
  localDependencies?: ServerDependencies,
): McpServer {
  const provider = resolveProvider(providerOrStore, getPrivacyOrDependencies);
  const dependencies = resolveDependencies(
    providerOrStore,
    getPrivacyOrDependencies,
    localDependencies,
  );
  const captureCamera =
    dependencies.captureCamera ??
    ((deviceIndex, mode, reason) => takeCameraSnapshot(deviceIndex, mode, reason));
  const captureWindow =
    dependencies.captureWindow ??
    ((windowId, mode, reason) => takeWindowSnapshot(windowId, mode, reason));
  const captureFullScreen =
    dependencies.captureFullScreen ??
    ((mode, reason) => takeFullScreenSnapshot(mode, reason));
  const writeAccess = dependencies.writeAccess ?? recordAccess;
  const server = new McpServer(
    { name: "sense-mcp", version: "0.1.0" },
    { instructions: SENSE_SERVER_INSTRUCTIONS },
  );

  const contextResponse = async (
    tool: string,
    title: string,
    query: ContextQuery,
    domains: Domain[] | undefined,
    fallbackProjection: ContextProjection,
  ): Promise<CallToolResult> => {
    const projection = projectionFor(query, fallbackProjection);
    const requestedMaxTokens = query.max_tokens ?? DEFAULT_CONTEXT_BUDGETS[projection];
    let result: ContextResult;
    try {
      result = await provider.getContext({
        ...(domains ? { domains } : {}),
        refresh: query.refresh ?? "if_stale",
        max_staleness_ms: query.max_staleness_ms,
      });
    } catch {
      return machineErrorResult(
        "context_provider_failed",
        `${title} is temporarily unavailable.`,
        true,
      );
    }
    try {
      const output = projectContext(result, {
        projection,
        domains,
        max_tokens: requestedMaxTokens,
      });
      await safeRecordAccess(writeAccess, {
        tool,
        status: "completed",
        reason: domains?.length
          ? `Requested ${domains.join(", ")} context.`
          : "Requested current context.",
        media_captured: false,
        context_domains: domains ?? ["screen", "user", "environment", "schedule"],
        privacy_tier: result.frame.privacy.tier,
        budget_mode: projection,
        max_tokens: output.budget.max_tokens,
      });
      return {
        content: [{ type: "text", text: contextText(projection, output.context_omitted) }],
        structuredContent: output,
      };
    } catch (error) {
      if (error instanceof ContextBudgetError) {
        // Not even the empty envelope fits, which is the only unusable case
        // left. The retry budget is measured the same way the omission block's
        // is, so the retryable flag and the hint cannot contradict each other.
        return unusableBudgetResult(
          title,
          requestedMaxTokens,
          sufficientContextMaxTokens(result, projection, domains, requestedMaxTokens),
        );
      }
      return machineErrorResult(
        "context_provider_failed",
        `${title} is temporarily unavailable.`,
        true,
      );
    }
  };

  const registerContextTool = (
    name: string,
    title: string,
    description: string,
    domains: Domain[] | undefined,
    fallbackProjection: ContextProjection,
  ) => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: contextQueryInputSchema,
        outputSchema: contextToolOutputSchema,
        annotations: readOnlyAnnotations(title),
      },
      async (query) => contextResponse(name, title, query, domains, fallbackProjection),
    );
  };

  server.registerTool(
    "get_relevant_context",
    {
      title: "Plan and Get Relevant Context",
      description:
        "Classify a request, return the minimum context plan, and embed useful semantic context once. " +
        "When context_satisfied is true, do not call another Sense context getter. Explicit media tools remain follow-ups.",
      inputSchema: relevantContextInputSchema,
      outputSchema: relevantContextOutputSchema,
      annotations: readOnlyAnnotations("Plan and Get Relevant Context"),
    },
    async (query: RelevantContextQuery): Promise<CallToolResult> => {
      const plan = planRelevantContext(query.user_request);
      if (!plan.context_plan.include_frame) {
        // No frame was planned, so nothing was left out for budget: the block
        // carries the reason there is no context, in the same shape a budget
        // omission uses, with no domains and no retry budget to name.
        const additions = {
          context_omitted: {
            domains: [],
            reason: plan.context_satisfied
              ? "No local context is needed; answer without another Sense call."
              : "Explicit media is required; use only the listed follow-up tool.",
          } satisfies ContextOmission,
        };
        let output: Record<string, unknown>;
        try {
          output = fitStructuredContent(
            routerCandidates(plan, additions),
            query.max_tokens ?? ROUTER_DEFAULT_MAX_TOKENS,
          );
        } catch {
          return unusableBudgetResult(
            "Routing output",
            query.max_tokens ?? ROUTER_DEFAULT_MAX_TOKENS,
            undefined,
          );
        }
        await safeRecordAccess(writeAccess, {
          tool: "get_relevant_context",
          status: plan.context_plan.plan_only ? "planned" : "completed",
          reason: plan.context_plan.reason,
          media_captured: false,
          context_domains: [],
          plan_intent: plan.intent,
          expected_value: plan.context_plan.expected_value,
          budget_mode: plan.context_plan.budget.mode,
          max_tokens: plan.context_plan.budget.max_tokens,
          external_context_needed: plan.context_plan.external_context_needed,
        });
        return {
          content: [
            {
              type: "text",
              text: `Sense routing complete; context_satisfied=${plan.context_satisfied}.`,
            },
          ],
          structuredContent: output,
        };
      }

      const projection = query.projection ??
        (plan.context_plan.budget.mode === "brief" ? "brief" : "focused");
      const outputMaxTokens = query.max_tokens ?? ROUTER_DEFAULT_MAX_TOKENS;
      let result: ContextResult;
      try {
        result = await provider.getContext({
          domains: plan.relevant_domains,
          refresh: query.refresh ?? "if_stale",
          max_staleness_ms: query.max_staleness_ms,
        });
      } catch {
        return machineErrorResult(
          "context_provider_failed",
          "Relevant context is temporarily unavailable.",
          true,
        );
      }

      // First the complete answer. If it fits, that is the response.
      let output = buildRouterOutput(plan, result, projection, outputMaxTokens, true, undefined);
      let coverage = output
        ? routerCoverage(output, plan, result, projection)
        : undefined;
      if (output && coverage && !coverage.satisfied) {
        // Something had to go. Say what, say which budget returns it, and still
        // return everything that did fit -- a partial routing answer under
        // `context_satisfied: false` is what the client can act on, and the
        // client is told to act on it. Measuring the retry budget first keeps
        // the omission block's own bytes inside the ceiling.
        const suggested = sufficientRouterMaxTokens(plan, result, projection, outputMaxTokens);
        const explained = buildRouterOutput(
          plan,
          result,
          projection,
          outputMaxTokens,
          false,
          describeRouterOmission(projection, coverage, suggested),
        );
        const bare =
          explained ??
          buildRouterOutput(plan, result, projection, outputMaxTokens, false, undefined);
        if (bare) {
          output = bare;
          coverage = routerCoverage(output, plan, result, projection);
        }
      }
      if (!output || !coverage) {
        // Not even the leanest routing rung fits: there is no answer to return.
        return unusableBudgetResult(
          "Relevant context",
          outputMaxTokens,
          sufficientRouterMaxTokens(plan, result, projection, outputMaxTokens),
        );
      }

      const satisfied = output.context_satisfied === true;
      await safeRecordAccess(writeAccess, {
        tool: "get_relevant_context",
        status: "completed",
        reason: plan.context_plan.reason,
        media_captured: false,
        context_domains: plan.relevant_domains,
        privacy_tier: result.frame.privacy.tier,
        plan_intent: plan.intent,
        expected_value: plan.context_plan.expected_value,
        budget_mode: projection,
        max_tokens: outputMaxTokens,
        external_context_needed: plan.context_plan.external_context_needed,
      });
      const omitted = output.context_omitted as ContextOmission | undefined;
      return {
        content: [
          {
            type: "text",
            text: satisfied
              ? "Sense routing complete; context_satisfied=true."
              : `Sense routing partial; context_satisfied=false. ${omitted?.reason ?? ""}`.trim(),
          },
        ],
        structuredContent: output,
      };
    },
  );

  registerContextTool(
    "get_context_frame",
    "Get Current Context",
    "Get bounded semantic context for the user's current situation. Choose compact, brief, " +
      "focused, debug, or semantic-diff output; missing fields mean unknown.",
    undefined,
    "focused",
  );
  registerContextTool(
    "get_screen_context",
    "Get Screen Context",
    "Get semantic active-app, privacy-safe window label, and workspace context without pixels.",
    ["screen"],
    "brief",
  );
  registerContextTool(
    "get_user_state",
    "Get User State",
    "Get presence, idle state, input cadence, and configured focus state.",
    ["user"],
    "brief",
  );
  registerContextTool(
    "get_environment_context",
    "Get Environment Context",
    "Get bounded semantic power, device, lighting, noise, location, and media context.",
    ["environment"],
    "brief",
  );
  registerContextTool(
    "get_schedule_context",
    "Get Schedule Context",
    "Get local meeting state and coarse time pressure; use a calendar connector for account data.",
    ["schedule"],
    "brief",
  );

  server.registerTool(
    "get_domains",
    {
      title: "Get Selected Context Domains",
      description: "Get only the selected semantic ContextFrame domains within a serialized budget.",
      inputSchema: domainsQueryInputSchema,
      outputSchema: contextToolOutputSchema,
      annotations: readOnlyAnnotations("Get Selected Context Domains"),
    },
    async ({ domains, ...query }) =>
      contextResponse("get_domains", "Selected context", query, domains as Domain[], "focused"),
  );

  server.registerTool(
    "take_camera_snapshot",
    {
      title: "Take Camera Snapshot",
      description:
        "Capture one explicit webcam still only for a current visual request such as appearance, hair, outfit, lighting, desk, or object identification.",
      inputSchema: cameraSnapshotInputSchema,
      outputSchema: snapshotToolOutputSchema,
      annotations: captureAnnotations("Take Camera Snapshot"),
    },
    async ({ reason, device_index, mode }): Promise<CallToolResult> => {
      try {
        const snapshot = await captureCamera(device_index ?? 0, mode, reason);
        const data = {
          generated_at: snapshot.generated_at,
          mode: snapshot.mode,
          reason,
          device_label: snapshot.device_label,
          snapshot_path: snapshot.path,
          markdown_image: snapshot.markdown_image,
          size_bytes: snapshot.size_bytes,
        };
        await safeRecordAccess(writeAccess, {
          tool: "take_camera_snapshot",
          status: snapshot.ok ? "completed" : "failed",
          reason,
          media_captured: snapshot.ok,
          context_domains: [],
          artifact_paths: snapshot.path ? [snapshot.path] : [],
          error: snapshot.error,
        });
        if (!snapshot.ok || !snapshot.data || !snapshot.mimeType) {
          return machineErrorResult(
            snapshot.error ?? "camera_capture_failed",
            "Camera snapshot was not captured.",
            false,
            snapshotFailureHint("camera", snapshot.error),
          );
        }
        return {
          content: [
            { type: "text", text: "Camera snapshot captured; inspect snapshot_path before answering." },
            { type: "image", data: snapshot.data, mimeType: snapshot.mimeType },
          ],
          structuredContent: { ok: true, context_satisfied: true, data },
        };
      } catch {
        return machineErrorResult("camera_capture_failed", "Camera snapshot failed.", true);
      }
    },
  );

  const handleWindowSnapshot = async (
    tool: "take_window_snapshot" | "take_screen_snapshot",
    { reason, window_id, mode }: z.infer<typeof windowSnapshotInputSchema>,
  ): Promise<CallToolResult> => {
    try {
      const snapshot = await captureWindow(window_id, mode, reason);
      const data = {
        generated_at: snapshot.generated_at,
        mode: snapshot.mode,
        reason,
        window_id: snapshot.window_id ?? window_id,
        snapshot_path: snapshot.path,
        markdown_image: snapshot.markdown_image,
        size_bytes: snapshot.size_bytes,
      };
      await safeRecordAccess(writeAccess, {
        tool,
        status: snapshot.ok ? "completed" : "failed",
        reason,
        media_captured: snapshot.ok,
        context_domains: [],
        artifact_paths: snapshot.path ? [snapshot.path] : [],
        error: snapshot.error,
      });
      if (!snapshot.ok || !snapshot.data || !snapshot.mimeType) {
        return machineErrorResult(
          snapshot.error ?? "window_capture_failed",
          "App window snapshot was not captured.",
          false,
          snapshotFailureHint("screen", snapshot.error),
        );
      }
      return {
        content: [
          { type: "text", text: "App window snapshot captured; inspect snapshot_path before answering." },
          { type: "image", data: snapshot.data, mimeType: snapshot.mimeType },
        ],
        structuredContent: { ok: true, context_satisfied: true, data },
      };
    } catch {
      return machineErrorResult("window_capture_failed", "App window snapshot failed.", true);
    }
  };

  server.registerTool(
    "take_window_snapshot",
    {
      title: "Take App Window Snapshot",
      description:
        "Capture one identified app window by CoreGraphics window id for local Mac visual QA. " +
        "This is the default screen action because it does not activate the app or expose unrelated displays.",
      inputSchema: windowSnapshotInputSchema,
      outputSchema: snapshotToolOutputSchema,
      annotations: captureAnnotations("Take App Window Snapshot"),
    },
    async (input) => handleWindowSnapshot("take_window_snapshot", input),
  );

  server.registerTool(
    "take_screen_snapshot",
    {
      title: "Take App Window Snapshot (Compatibility)",
      description:
        "Deprecated compatibility alias for take_window_snapshot. It always captures one safely resolved app window and never captures the full screen.",
      inputSchema: windowSnapshotInputSchema,
      outputSchema: snapshotToolOutputSchema,
      annotations: captureAnnotations("Take App Window Snapshot (Compatibility)"),
    },
    async (input) => handleWindowSnapshot("take_screen_snapshot", input),
  );

  server.registerTool(
    "take_full_screen_snapshot",
    {
      title: "Take Full-Screen Snapshot",
      description:
        "Higher-risk capture of the current main display. Use only when the user explicitly requests full-screen context and confirm_full_screen is true.",
      inputSchema: fullScreenSnapshotInputSchema,
      outputSchema: snapshotToolOutputSchema,
      annotations: captureAnnotations("Take Full-Screen Snapshot"),
    },
    async ({ reason, mode }): Promise<CallToolResult> => {
      try {
        const snapshot = await captureFullScreen(mode, reason);
        const data = {
          generated_at: snapshot.generated_at,
          mode: snapshot.mode,
          reason,
          snapshot_path: snapshot.path,
          markdown_image: snapshot.markdown_image,
          size_bytes: snapshot.size_bytes,
        };
        await safeRecordAccess(writeAccess, {
          tool: "take_full_screen_snapshot",
          status: snapshot.ok ? "completed" : "failed",
          reason,
          media_captured: snapshot.ok,
          context_domains: [],
          artifact_paths: snapshot.path ? [snapshot.path] : [],
          error: snapshot.error,
        });
        if (!snapshot.ok || !snapshot.data || !snapshot.mimeType) {
          return machineErrorResult(
            snapshot.error ?? "full_screen_capture_failed",
            "Full-screen snapshot was not captured.",
            false,
            snapshotFailureHint("screen", snapshot.error),
          );
        }
        return {
          content: [
            { type: "text", text: "Full-screen snapshot captured; inspect snapshot_path before answering." },
            { type: "image", data: snapshot.data, mimeType: snapshot.mimeType },
          ],
          structuredContent: { ok: true, context_satisfied: true, data },
        };
      } catch {
        return machineErrorResult("full_screen_capture_failed", "Full-screen snapshot failed.", true);
      }
    },
  );

  const registerJsonResource = (
    name: string,
    uri: string,
    title: string,
    description: string,
    select: (result: Awaited<ReturnType<ContextProvider["getContext"]>>) => unknown,
  ) => {
    server.registerResource(
      name,
      uri,
      { title, description, mimeType: "application/json" },
      async () => {
        try {
          const result = await provider.getContext({ refresh: "cached" });
          return {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(select(result)) }],
          };
        } catch {
          return {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify({
                  ok: false,
                  error: {
                    code: "context_provider_failed",
                    message: "Sense context provider is temporarily unavailable.",
                    retryable: true,
                  },
                }),
              },
            ],
          };
        }
      },
    );
  };

  registerJsonResource(
    "current-context",
    "sense://context/current",
    "Current Sense Context",
    "A compact cached view of the current semantic context; reading it never forces sensor refresh.",
    (result) =>
      projectContext(result, {
        projection: "compact",
        max_tokens: DEFAULT_CONTEXT_BUDGETS.compact,
      }),
  );
  registerJsonResource(
    "privacy-status",
    "sense://privacy",
    "Sense Privacy Status",
    "Current privacy tier and per-capability status from the authoritative provider frame.",
    (result) => ({
      ok: true,
      generated_at: result.frame.generated_at,
      privacy: result.frame.privacy,
    }),
  );
  registerJsonResource(
    "provider-health",
    "sense://health",
    "Sense Provider Health",
    "Current broker or local-provider health and bounded diagnostics.",
    (result) => ({ ok: true, health: result.health }),
  );

  return server;
}
