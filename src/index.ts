#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StateStore } from "./state.js";
import { Daemon } from "./daemon.js";
import { sensors } from "./sensors/index.js";
import { isMac } from "./sensors/exec.js";
import { computePrivacy } from "./privacy.js";
import { createServer } from "./server.js";
import { runCli } from "./cli.js";

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    const code = await runCli(process.argv.slice(2));
    process.exit(code);
  }

  const store = new StateStore();
  const daemon = new Daemon(store, sensors);
  const active = await daemon.start();
  // stderr only — stdout is the MCP transport
  console.error(`sense-mcp: active sensors = [${active.join(", ")}]`);

  const config = {
    isMac,
    rawTitles: process.env.SENSE_RAW_TITLES === "1",
    cameraSnapshot: process.env.SENSE_CAMERA_SNAPSHOT === "1",
    screenSnapshot: process.env.SENSE_SCREEN_SNAPSHOT === "1",
  };
  const getPrivacy = () => computePrivacy(sensors, daemon.status(), config);

  const server = createServer(store, getPrivacy);
  await server.connect(new StdioServerTransport());

  const shutdown = () => {
    daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("sense-mcp fatal:", err);
  process.exit(1);
});
