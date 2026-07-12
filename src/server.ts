import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import {
  createLocalContextProvider,
  isContextProvider,
  type ContextProvider,
} from "./contextProvider.js";
import {
  DEFAULT_CONTEXT_BUDGETS,
  ContextBudgetError,
  fitStructuredContent,
  projectContext,
  type ContextProjection,
} from "./contextOutput.js";
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

const ROUTER_DEFAULT_MAX_TOKENS = 480;

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

function projectionFor(query: ContextQuery, fallback: ContextProjection): ContextProjection {
  return query.projection ?? fallback;
}

function conciseContextText(projection: ContextProjection): string {
  return `Sense context ready (${projection}).`;
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

function routerCandidates(
  plan: RelevantContextPlan,
  additions: Record<string, unknown>,
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
    ...(typeof additions.context_omitted === "string"
      ? { context_omitted: additions.context_omitted }
      : {}),
  };
  return [full, concise, core];
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
  const server = new McpServer({ name: "sense-mcp", version: "0.1.0" });

  const contextResponse = async (
    tool: string,
    title: string,
    query: ContextQuery,
    domains: Domain[] | undefined,
    fallbackProjection: ContextProjection,
  ): Promise<CallToolResult> => {
    const projection = projectionFor(query, fallbackProjection);
    try {
      const result = await provider.getContext({
        ...(domains ? { domains } : {}),
        refresh: query.refresh ?? "if_stale",
        max_staleness_ms: query.max_staleness_ms,
      });
      const output = projectContext(result, {
        projection,
        domains,
        max_tokens: query.max_tokens ?? DEFAULT_CONTEXT_BUDGETS[projection],
        context_satisfied: true,
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
        content: [{ type: "text", text: conciseContextText(projection) }],
        structuredContent: output,
      };
    } catch (error) {
      if (error instanceof ContextBudgetError) {
        return machineErrorResult(
          "context_budget_too_small",
          `${title} could not fit the requested serialized output budget.`,
          false,
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
        const additions = {
          context_omitted: plan.context_satisfied
            ? "No local context is needed; answer without another Sense call."
            : "Explicit media is required; use only the listed follow-up tool.",
        };
        let output: Record<string, unknown>;
        try {
          output = fitStructuredContent(
            routerCandidates(plan, additions),
            query.max_tokens ?? ROUTER_DEFAULT_MAX_TOKENS,
          );
        } catch {
          return machineErrorResult(
            "context_budget_too_small",
            "Routing output could not fit the requested serialized output budget.",
            false,
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
      try {
        const outputMaxTokens = query.max_tokens ?? ROUTER_DEFAULT_MAX_TOKENS;
        const result = await provider.getContext({
          domains: plan.relevant_domains,
          refresh: query.refresh ?? "if_stale",
          max_staleness_ms: query.max_staleness_ms,
        });
        const context = projectContext(result, {
          projection,
          domains: plan.relevant_domains,
          max_tokens: outputMaxTokens,
          context_satisfied: true,
        });
        const followUpTools = plan.follow_up_tools.filter(
          (tool) => !CONTEXT_TOOL_NAMES.has(tool),
        );
        const additions = {
          context_satisfied: true,
          follow_up_tools: followUpTools,
          context: context.context,
          context_budget: context.budget,
          health: context.health,
          refreshed_domains: context.refreshed_domains,
        };
        const output = fitStructuredContent(
          routerCandidates(plan, additions),
          outputMaxTokens,
        );
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
          max_tokens: context.budget.max_tokens,
          external_context_needed: plan.context_plan.external_context_needed,
        });
        return {
          content: [{ type: "text", text: "Sense routing complete; context_satisfied=true." }],
          structuredContent: output,
        };
      } catch (error) {
        if (error instanceof ContextBudgetError) {
          return machineErrorResult(
            "context_budget_too_small",
            "Relevant context could not fit the requested serialized output budget.",
            false,
          );
        }
        return machineErrorResult(
          "context_provider_failed",
          "Relevant context is temporarily unavailable.",
          true,
        );
      }
    },
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
        max_tokens: 180,
        context_satisfied: true,
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
