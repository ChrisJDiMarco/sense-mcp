#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  connectSenseBroker,
  defaultBrokerSocketPath,
  INTERNAL_BROKER_FLAG,
  runBrokerProcess,
} from "./broker.js";
import { createServer } from "./server.js";
import { runCli } from "./cli.js";
import { sensePolicyStore } from "./policy.js";

async function main(): Promise<void> {
  if (process.argv[2] === INTERNAL_BROKER_FLAG) {
    const { sensors } = await import("./sensors/index.js");
    await runBrokerProcess({
      socketPath: defaultBrokerSocketPath(),
      sensors,
      privacyConfig: async () => {
        const policy = await sensePolicyStore().load();
        return {
          isMac: process.platform === "darwin",
          calendar: policy.valid && policy.values.calendar,
          location: policy.valid && policy.values.location,
          micLevel: policy.valid && policy.values.mic_level,
          rawTitles: policy.valid && policy.values.raw_titles,
          cameraSnapshot: policy.valid && policy.values.camera_snapshot,
          screenSnapshot: policy.valid && policy.values.window_snapshot,
          windowSnapshot: policy.valid && policy.values.window_snapshot,
          fullScreenSnapshot: policy.valid && policy.values.full_screen_snapshot,
        };
      },
      idleShutdownMs: positiveInteger(process.env.SENSE_BROKER_IDLE_MS),
    });
    return;
  }

  if (process.argv.length > 2) {
    const code = await runCli(process.argv.slice(2));
    process.exit(code);
  }

  const provider = await connectSenseBroker();
  // stderr only — stdout is the MCP transport
  console.error(`sense-mcp: connected to shared broker at ${defaultBrokerSocketPath()}`);

  const server = createServer(provider);
  await server.connect(new StdioServerTransport());

  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.allSettled([provider.close(), server.close()]);
    process.exit(exitCode);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stdin.once("end", () => void shutdown());
  process.stdin.once("close", () => void shutdown());
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

main().catch((err) => {
  console.error("sense-mcp fatal:", err);
  process.exit(1);
});
