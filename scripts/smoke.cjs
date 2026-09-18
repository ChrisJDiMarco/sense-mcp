// Deterministic transport smoke: spawn the server through the official MCP
// client, complete the current handshake, and read cached broker context
// without forcing hardware I/O.
const path = require("node:path");

async function main() {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/client"),
    import("@modelcontextprotocol/client/stdio"),
  ]);
  const server = path.join(__dirname, "..", "dist", "index.js");
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    cwd: path.dirname(server),
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });
  const client = new Client({ name: "sense-smoke", version: "1" });

  try {
    await client.connect(transport);
    const result = await client.callTool(
      { name: "get_context_frame", arguments: { refresh: "cached" } },
      undefined,
      { timeout: 15_000 },
    );
    if (result.isError || result.structuredContent?.ok !== true) {
      throw new Error("get_context_frame did not return successful structured content");
    }
    console.log(JSON.stringify(result.structuredContent));
  } catch (error) {
    if (stderr.trim()) console.error(stderr.trim());
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
