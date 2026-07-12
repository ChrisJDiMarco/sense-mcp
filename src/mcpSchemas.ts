import { z } from "zod";

export const domainSchema = z.enum(["screen", "user", "environment", "schedule"]);
export const contextProjectionSchema = z.enum(["compact", "brief", "focused", "debug", "diff"]);
export const contextRefreshSchema = z.enum(["cached", "if_stale", "force"]);

const contextControls = {
  projection: contextProjectionSchema.optional().describe("Output detail profile."),
  max_tokens: z
    .number()
    .int()
    .min(96)
    .max(4_096)
    .optional()
    .describe("Hard budget for the complete structured context payload."),
  refresh: contextRefreshSchema.optional().describe("Whether the provider may refresh stale domains."),
  max_staleness_ms: z.number().int().min(0).max(86_400_000).optional(),
};

export const contextQueryInputSchema = z.object(contextControls);
export const domainsQueryInputSchema = z.object({
  domains: z.array(domainSchema).min(1).max(4),
  ...contextControls,
});
export const relevantContextInputSchema = z.object({
  user_request: z
    .string()
    .min(1)
    .max(500)
    .describe("The user's current request or a faithful summary of it."),
  ...contextControls,
  max_tokens: z
    .number()
    .int()
    .min(160)
    .max(4_096)
    .optional()
    .describe("Hard budget for the complete router structuredContent payload."),
});

export const cameraModeSchema = z.enum([
  "appearance_check",
  "hair_check",
  "outfit_check",
  "lighting_check",
  "desk_check",
  "object_identification",
  "general_visual",
]);

export const screenModeSchema = z.enum([
  "screen_debug",
  "ui_feedback",
  "screen_summary",
  "reading_help",
  "general_screen",
]);

export const cameraSnapshotInputSchema = z.object({
  reason: z.string().min(3).max(200),
  device_index: z.number().int().min(0).max(20).optional(),
  mode: cameraModeSchema.optional(),
});

export const windowSnapshotInputSchema = z.object({
  reason: z.string().min(3).max(200),
  window_id: z
    .number()
    .int()
    .positive()
    .max(0xffff_ffff)
    .optional()
    .describe(
      "Optional CoreGraphics window id. Sense validates it as an on-screen normal window and names its owner app in the local consent prompt; omit it to resolve the frontmost window without activation.",
    ),
  mode: screenModeSchema.optional(),
});

export const fullScreenSnapshotInputSchema = z.object({
  reason: z.string().min(3).max(200),
  confirm_full_screen: z
    .literal(true)
    .describe("Explicit confirmation that full-screen capture is required for this request."),
  mode: screenModeSchema.optional(),
});

export const machineErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  fix_hint: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});

export const diagnosticSchema = z.object({
  component: z.string(),
  status: z.enum(["healthy", "degraded", "unavailable"]),
  message: z.string().optional(),
  last_success_at: z.string().optional(),
  latency_ms: z.number().optional(),
});

export const providerHealthSchema = z.object({
  status: z.enum(["initializing", "healthy", "degraded", "unavailable"]),
  source: z.enum(["local", "broker"]),
  checked_at: z.string(),
  diagnostics: z.array(diagnosticSchema),
});

export const contextBudgetSchema = z.object({
  max_tokens: z.number().int(),
  max_bytes: z.number().int(),
  estimated_tokens: z.number().int(),
  serialized_bytes: z.number().int(),
  truncated: z.boolean(),
});

export const contextToolOutputSchema = z.object({
  ok: z.boolean(),
  context_satisfied: z.boolean(),
  projection: contextProjectionSchema.optional(),
  generated_at: z.string().optional(),
  budget: contextBudgetSchema.optional(),
  context: z.record(z.unknown()).optional(),
  health: providerHealthSchema.optional(),
  refreshed_domains: z.array(domainSchema).optional(),
  error: machineErrorSchema.optional(),
});

const contextPlanSchema = z.object({
  expected_value: z.enum(["none", "low", "medium", "high"]),
  budget: z.object({
    mode: z.enum(["none", "brief", "focused", "visual"]),
    max_tokens: z.number().int(),
  }),
  plan_only: z.boolean(),
  include_frame: z.boolean(),
  include_situation: z.boolean(),
  included_context: z.array(z.string()),
  excluded_context: z.array(z.string()),
  external_context_needed: z.array(z.string()),
  reason: z.string(),
});

export const relevantContextOutputSchema = z.object({
  ok: z.boolean(),
  context_satisfied: z.boolean(),
  intent: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  minimum_tool: z.string().optional(),
  relevant_domains: z.array(domainSchema).optional(),
  recommended_tools: z.array(z.string()).optional(),
  follow_up_tools: z.array(z.string()).optional(),
  avoided_tools: z.array(z.string()).optional(),
  requires_explicit_media: z.boolean().optional(),
  snapshot_mode: z.string().optional(),
  context_plan: contextPlanSchema.optional(),
  guidance: z.array(z.string()).optional(),
  fallbacks: z.array(z.string()).optional(),
  privacy_notes: z.array(z.string()).optional(),
  context: z.record(z.unknown()).optional(),
  context_budget: contextBudgetSchema.optional(),
  output_budget: contextBudgetSchema.optional(),
  health: providerHealthSchema.optional(),
  refreshed_domains: z.array(domainSchema).optional(),
  context_omitted: z.string().optional(),
  error: machineErrorSchema.optional(),
});

export const snapshotMetadataSchema = z.object({
  generated_at: z.string(),
  mode: z.string(),
  reason: z.string(),
  window_id: z.number().int().positive().optional(),
  device_label: z.string().optional(),
  snapshot_path: z.string().optional(),
  markdown_image: z.string().optional(),
  size_bytes: z.number().int().nonnegative().optional(),
});

export const snapshotToolOutputSchema = z.object({
  ok: z.boolean(),
  context_satisfied: z.boolean(),
  data: snapshotMetadataSchema.optional(),
  error: machineErrorSchema.optional(),
});
