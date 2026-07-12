import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ContextProvider, ContextResult } from "../src/contextProvider.js";
import { createServer, type ServerDependencies } from "../src/server.js";

const connected: Array<{ client: Client; server: ReturnType<typeof createServer> }> = [];

function contextResult(): ContextResult {
  return {
    frame: {
      spec: "context-frame/0.2",
      generated_at: "2026-07-11T12:00:00.000Z",
      staleness_ms: 200,
      privacy: { tier: 1, capabilities: { screen_activity: "granted" } },
      assistive_posture: "do_not_interrupt",
      screen: {
        active_app: "Code",
        activity_class: "coding",
        workspace_name: "sense-mcp",
      },
      situation: {
        summary: "User appears active working in sense-mcp.",
        confidence: "medium",
        evidence: ["workspace sense-mcp", "activity coding"],
        unknowns: [],
        risks: [],
        recommendations: [],
        recent_changes: ["Working in sense-mcp (coding)"],
      },
      quality: {
        overall_freshness: "fresh",
        domains: {},
        fields: {},
        stability: { screen_activity: "stable" },
      },
    },
    health: {
      status: "healthy",
      source: "broker",
      checked_at: "2026-07-11T12:00:00.000Z",
      diagnostics: [],
    },
    refreshed_domains: [],
  };
}

async function connect(provider: ContextProvider, dependencies: ServerDependencies = {}) {
  const server = createServer(provider, {
    writeAccess: async () => undefined,
    ...dependencies,
  });
  const client = new Client({ name: "sense-protocol-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  connected.push({ client, server });
  return { client, server };
}

function expectWithinOutputBudget(structured: Record<string, unknown>, truncated = false): void {
  const budget = structured.output_budget as {
    max_bytes: number;
    serialized_bytes: number;
    truncated: boolean;
  };
  const actualBytes = Buffer.byteLength(JSON.stringify(structured), "utf8");
  expect(actualBytes).toBeLessThanOrEqual(budget.max_bytes);
  expect(budget.serialized_bytes).toBe(actualBytes);
  expect(budget.truncated).toBe(truncated);
}

afterEach(async () => {
  await Promise.all(connected.splice(0).map(({ client, server }) => Promise.all([client.close(), server.close()])));
});

describe("Sense MCP protocol surface", () => {
  test("SDK discovery exposes titled, schema-first, annotated tools and resources", async () => {
    const provider: ContextProvider = { getContext: vi.fn(async () => contextResult()) };
    const { client } = await connect(provider);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      [
        "get_context_frame",
        "get_domains",
        "get_environment_context",
        "get_relevant_context",
        "get_schedule_context",
        "get_screen_context",
        "get_user_state",
        "take_camera_snapshot",
        "take_full_screen_snapshot",
        "take_screen_snapshot",
        "take_window_snapshot",
      ].sort(),
    );
    for (const tool of listed.tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.annotations).toMatchObject({
        destructiveHint: false,
        openWorldHint: false,
      });
    }
    expect(listed.tools.find((tool) => tool.name === "get_context_frame")?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(listed.tools.find((tool) => tool.name === "take_window_snapshot")?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
    });
    expect(
      listed.tools.find((tool) => tool.name === "take_window_snapshot")?.inputSchema.required ?? [],
    ).not.toContain("window_id");
    expect(
      listed.tools.find((tool) => tool.name === "take_full_screen_snapshot")?.inputSchema.required,
    ).toContain("confirm_full_screen");

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri).sort()).toEqual(
      ["sense://context/current", "sense://health", "sense://privacy"].sort(),
    );
  });

  test("deprecated screen alias can only use safe window-scoped capture", async () => {
    const captureWindow = vi.fn(async (windowId?: number) => ({
      ok: true as const,
      generated_at: "2026-07-11T12:00:00.000Z",
      mode: "screen_debug" as const,
      window_id: windowId ?? 42,
      mimeType: "image/png" as const,
      data: "cG5n",
      path: "/tmp/window.png",
      markdown_image: "![window](/tmp/window.png)",
      size_bytes: 3,
    }));
    const captureFullScreen = vi.fn();
    const { client } = await connect(
      { getContext: async () => contextResult() },
      { captureWindow, captureFullScreen },
    );

    const response = await client.callTool({
      name: "take_screen_snapshot",
      arguments: { reason: "Review the current app window" },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ ok: true, context_satisfied: true });
    expect(captureWindow).toHaveBeenCalledWith(
      undefined,
      undefined,
      "Review the current app window",
    );
    expect(captureFullScreen).not.toHaveBeenCalled();
  });

  test("context calls return structured content and concise text through the SDK", async () => {
    const getContext = vi.fn(async () => contextResult());
    const { client } = await connect({ getContext });

    const response = await client.callTool({
      name: "get_screen_context",
      arguments: { projection: "compact", max_tokens: 140, refresh: "cached" },
    });
    const structured = response.structuredContent as Record<string, unknown>;

    expect(response.isError).not.toBe(true);
    expect(structured.ok).toBe(true);
    expect(structured.context_satisfied).toBe(true);
    expect(structured.projection).toBe("compact");
    expect(response.content[0]).toMatchObject({ type: "text" });
    expect((response.content[0] as { text: string }).text.startsWith("{")).toBe(false);
    expect(getContext).toHaveBeenCalledWith({
      domains: ["screen"],
      refresh: "cached",
      max_staleness_ms: undefined,
    });
  });

  test("router embeds useful context once and marks the request satisfied", async () => {
    const getContext = vi.fn(async () => contextResult());
    const { client } = await connect({ getContext });

    const response = await client.callTool({
      name: "get_relevant_context",
      arguments: { user_request: "what am I working on right now?", max_tokens: 240 },
    });
    const structured = response.structuredContent as Record<string, unknown> & {
      context_satisfied: boolean;
      follow_up_tools: string[];
      context?: unknown;
    };

    expect(structured.context_satisfied).toBe(true);
    expect(structured.follow_up_tools).toEqual([]);
    expect(structured.context).toBeDefined();
    expectWithinOutputBudget(structured, true);
    expect(getContext).toHaveBeenCalledTimes(1);

    const planOnly = await client.callTool({
      name: "get_relevant_context",
      arguments: { user_request: "write a friendly launch email", max_tokens: 200 },
    });
    expect(planOnly.structuredContent).toMatchObject({
      context_satisfied: true,
      follow_up_tools: [],
    });
    expectWithinOutputBudget(planOnly.structuredContent as Record<string, unknown>, true);
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  test("provider failures return stable machine-readable tool errors", async () => {
    const { client } = await connect({
      getContext: async () => {
        throw new Error("socket disappeared with secret details");
      },
    });

    const response = await client.callTool({ name: "get_context_frame", arguments: {} });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      ok: false,
      context_satisfied: false,
      error: {
        code: "context_provider_failed",
        retryable: true,
      },
    });
    expect(JSON.stringify(response.structuredContent)).not.toContain("secret details");
  });

  test("privacy, health, and current-context resources are readable without refresh", async () => {
    const getContext = vi.fn(async () => contextResult());
    const { client } = await connect({ getContext });

    const privacy = await client.readResource({ uri: "sense://privacy" });
    const health = await client.readResource({ uri: "sense://health" });
    const current = await client.readResource({ uri: "sense://context/current" });

    expect(JSON.parse(privacy.contents[0].text ?? "{}").privacy.tier).toBe(1);
    expect(JSON.parse(health.contents[0].text ?? "{}").health.status).toBe("healthy");
    expect(JSON.parse(current.contents[0].text ?? "{}").context_satisfied).toBe(true);
    expect(getContext).toHaveBeenCalledTimes(3);
    expect(getContext).toHaveBeenCalledWith({ refresh: "cached" });
  });
});
