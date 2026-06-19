import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Domain, Privacy } from "./types.js";
import { StateStore } from "./state.js";
import { buildFrame } from "./frame.js";
import { planRelevantContext } from "./relevance.js";
import { takeCameraSnapshot, type CameraSnapshotMode } from "./sensors/camera.js";
import { takeScreenSnapshot, type ScreenSnapshotMode } from "./sensors/screenSnapshot.js";
import { snapshotFailureHint } from "./snapshotAdvice.js";
import { recordAccess } from "./ledger.js";

const cameraModeSchema = z
  .enum([
    "appearance_check",
    "hair_check",
    "outfit_check",
    "lighting_check",
    "desk_check",
    "object_identification",
    "general_visual",
  ])
  .optional();

const screenModeSchema = z
  .enum(["screen_debug", "ui_feedback", "screen_summary", "reading_help", "general_screen"])
  .optional();

/**
 * Build the MCP server exposing context tools over the given store.
 * `getPrivacy` is sampled per call so the frame's privacy block always
 * reflects current capability status.
 */
export function createServer(store: StateStore, getPrivacy: () => Privacy): McpServer {
  const server = new McpServer({ name: "sense-mcp", version: "0.1.0" });

  const respond = (tool: string, domains?: Domain[]) => {
    const frame = buildFrame(store, domains, Date.now(), getPrivacy());
    void recordAccess({
      tool,
      status: "completed",
      reason: domains?.length ? `Requested ${domains.join(", ")} context.` : "Requested full context frame.",
      media_captured: false,
      context_domains: domains ?? ["screen", "user", "environment", "schedule"],
      privacy_tier: frame.privacy.tier,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(frame, null, 2),
        },
      ],
    };
  };

  server.tool(
    "get_context_frame",
    "Get the user's full current situational context: what they're doing on " +
      "screen, their presence/attention state, ambient environment, and " +
      "schedule pressure. Call this when knowing the user's immediate " +
      "situation would make your response more relevant — e.g. they mention " +
      "being busy, ask for help with 'this', reference their current work, " +
      "or when timing/availability matters. All data is local, semantic, and " +
      "ephemeral. Missing fields mean unknown. Respect assistive_posture for " +
      "proactive suggestions only — a direct question always gets an answer.",
    {},
    async () => respond("get_context_frame"),
  );

  server.tool(
    "get_relevant_context",
    "Classify a user request and return a context_plan with expected value, token budget, " +
      "plan-only guidance, connector hints, relevant ContextFrame domains, and explicit " +
      "Sense tools. Use this before deciding whether to call camera, screen, schedule, " +
      "environment, or full context tools. It does not capture images by itself.",
    {
      user_request: z
        .string()
        .min(1)
        .max(500)
        .describe("The user's current request or a faithful summary of it."),
    },
    async ({ user_request }) => {
      const plan = planRelevantContext(user_request);
      const frame = plan.context_plan.include_frame
        ? buildFrame(store, plan.relevant_domains, Date.now(), getPrivacy())
        : undefined;
      void recordAccess({
        tool: "get_relevant_context",
        status: plan.context_plan.plan_only ? "planned" : "completed",
        reason: plan.context_plan.reason,
        media_captured: false,
        context_domains: plan.context_plan.include_frame ? plan.relevant_domains : [],
        privacy_tier: frame?.privacy.tier,
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
            text: JSON.stringify(
              {
                ...plan,
                ...(frame
                  ? { context: frame }
                  : { context_omitted: "plan_only: local context is unlikely to change this answer" }),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "get_screen_context",
    "Get only what the user is currently doing on screen (active app, a " +
      "privacy-safe window label, activity class). Cheaper and more focused " +
      "than the full frame.",
    {},
    async () => respond("get_screen_context", ["screen"]),
  );

  server.tool(
    "get_user_state",
    "Get only the user's presence and input state (active/idle/away, input " +
      "cadence). Useful for judging whether they're heads-down or available.",
    {},
    async () => respond("get_user_state", ["user"]),
  );

  server.tool(
    "get_environment_context",
    "Get only ambient local context: time/daylight, battery/power, device setup, " +
      "coarse location class, media playback state, lighting/noise when available, " +
      "and optional local semantic health/weather bridge fields.",
    {},
    async () => respond("get_environment_context", ["environment"]),
  );

  server.tool(
    "get_schedule_context",
    "Get only local schedule pressure: whether the user appears to be in a " +
      "calendar event, minutes to the next event, and coarse time pressure. Event " +
      "titles are not exposed by default. If this reports calendar unavailable " +
      "and the client has a direct calendar connector, prefer the connector for " +
      "account calendar data.",
    {},
    async () => respond("get_schedule_context", ["schedule"]),
  );

  server.tool(
    "get_domains",
    "Get specific ContextFrame domains.",
    { domains: z.array(z.enum(["screen", "user", "environment", "schedule"])) },
    async ({ domains }) => respond("get_domains", domains as Domain[]),
  );

  server.tool(
    "take_camera_snapshot",
    "Take one explicit, in-memory webcam snapshot for a visual request the user " +
      "made in the current conversation. Use for prompts like 'how do I look?', " +
      "'how's my hair?', 'do I look tired?', 'fit check', 'is my lighting okay?', " +
      "or 'what is this thing on my desk?'. Do not call this for general context, " +
      "proactive suggestions, or non-visual tasks. Requires SENSE_CAMERA_SNAPSHOT=1. The " +
      "image is returned as both MCP image content and a private local PNG path. " +
      "After calling this tool, inspect snapshot_path with the local image viewer " +
      "before answering visual questions.",
    {
      reason: z
        .string()
        .min(3)
        .max(200)
        .describe("Why the current user request requires a camera snapshot."),
      device_index: z.number().int().min(0).max(20).optional(),
      mode: cameraModeSchema,
    },
    async ({ reason, device_index, mode }): Promise<CallToolResult> => {
      const snapshot = await takeCameraSnapshot(device_index ?? 0, mode as CameraSnapshotMode);
      const metadata = {
        ok: snapshot.ok,
        generated_at: snapshot.generated_at,
        mode: snapshot.mode,
        reason,
        device_label: snapshot.device_label,
        snapshot_path: snapshot.path,
        markdown_image: snapshot.markdown_image,
        size_bytes: snapshot.size_bytes,
        error: snapshot.error,
        fix_hint: snapshot.ok ? undefined : snapshotFailureHint("camera", snapshot.error),
      };
      void recordAccess({
        tool: "take_camera_snapshot",
        status: snapshot.ok ? "completed" : "failed",
        reason,
        media_captured: snapshot.ok,
        context_domains: [],
        artifact_paths: snapshot.path ? [snapshot.path] : [],
        error: snapshot.error,
      });

      if (!snapshot.ok || !snapshot.data || !snapshot.mimeType) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(metadata, null, 2) }],
          structuredContent: metadata,
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `${JSON.stringify(metadata, null, 2)}\n\n` +
              "If you need to visually inspect this snapshot, open `snapshot_path` " +
              "with the local image viewer before answering.",
          },
          {
            type: "image",
            data: snapshot.data,
            mimeType: snapshot.mimeType,
          },
        ],
        structuredContent: metadata,
      };
    },
  );

  server.tool(
    "take_screen_snapshot",
    "Take one explicit screenshot of the current screen for a visual or debugging request " +
      "the user made in the current conversation. Use for prompts like 'what is this error?', " +
      "'what am I looking at?', 'help me with this UI', or 'review this screen'. Do not call " +
      "for general context or proactive suggestions. Requires SENSE_SCREEN_SNAPSHOT=1. The " +
      "image is returned as both MCP image content and a private local PNG path. Inspect " +
      "snapshot_path before answering visual screen questions.",
    {
      reason: z
        .string()
        .min(3)
        .max(200)
        .describe("Why the current user request requires a screen snapshot."),
      mode: screenModeSchema,
    },
    async ({ reason, mode }): Promise<CallToolResult> => {
      const snapshot = await takeScreenSnapshot(mode as ScreenSnapshotMode);
      const metadata = {
        ok: snapshot.ok,
        generated_at: snapshot.generated_at,
        mode: snapshot.mode,
        reason,
        snapshot_path: snapshot.path,
        markdown_image: snapshot.markdown_image,
        size_bytes: snapshot.size_bytes,
        error: snapshot.error,
        fix_hint: snapshot.ok ? undefined : snapshotFailureHint("screen", snapshot.error),
      };
      void recordAccess({
        tool: "take_screen_snapshot",
        status: snapshot.ok ? "completed" : "failed",
        reason,
        media_captured: snapshot.ok,
        context_domains: [],
        artifact_paths: snapshot.path ? [snapshot.path] : [],
        error: snapshot.error,
      });

      if (!snapshot.ok || !snapshot.data || !snapshot.mimeType) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(metadata, null, 2) }],
          structuredContent: metadata,
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `${JSON.stringify(metadata, null, 2)}\n\n` +
              "If you need to visually inspect this screenshot, open `snapshot_path` " +
              "with the local image viewer before answering.",
          },
          {
            type: "image",
            data: snapshot.data,
            mimeType: snapshot.mimeType,
          },
        ],
        structuredContent: metadata,
      };
    },
  );

  return server;
}
