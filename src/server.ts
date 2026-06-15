import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Domain, Privacy } from "./types.js";
import { StateStore } from "./state.js";
import { buildFrame } from "./frame.js";
import { planRelevantContext } from "./relevance.js";
import { takeCameraSnapshot, type CameraSnapshotMode } from "./sensors/camera.js";
import { takeScreenSnapshot, type ScreenSnapshotMode } from "./sensors/screenSnapshot.js";

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

  const respond = (domains?: Domain[]) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(buildFrame(store, domains, Date.now(), getPrivacy()), null, 2),
      },
    ],
  });

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
    async () => respond(),
  );

  server.tool(
    "get_relevant_context",
    "Classify a user request and return the ContextFrame domains plus explicit Sense tools " +
      "that are most relevant. Use this when deciding whether to call camera, screen, " +
      "schedule, environment, or full context tools. It does not capture images by itself.",
    {
      user_request: z
        .string()
        .min(1)
        .max(500)
        .describe("The user's current request or a faithful summary of it."),
    },
    async ({ user_request }) => {
      const plan = planRelevantContext(user_request);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...plan,
                context: buildFrame(store, plan.relevant_domains, Date.now(), getPrivacy()),
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
    async () => respond(["screen"]),
  );

  server.tool(
    "get_user_state",
    "Get only the user's presence and input state (active/idle/away, input " +
      "cadence). Useful for judging whether they're heads-down or available.",
    {},
    async () => respond(["user"]),
  );

  server.tool(
    "get_environment_context",
    "Get only ambient local context: time/daylight, battery/power, device setup, " +
      "coarse location class, media playback state, lighting/noise when available, " +
      "and optional local semantic health/weather bridge fields.",
    {},
    async () => respond(["environment"]),
  );

  server.tool(
    "get_schedule_context",
    "Get only local schedule pressure: whether the user appears to be in a " +
      "calendar event, minutes to the next event, and coarse time pressure. Event " +
      "titles are not exposed by default.",
    {},
    async () => respond(["schedule"]),
  );

  server.tool(
    "get_domains",
    "Get specific ContextFrame domains.",
    { domains: z.array(z.enum(["screen", "user", "environment", "schedule"])) },
    async ({ domains }) => respond(domains as Domain[]),
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
      };

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
      };

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
