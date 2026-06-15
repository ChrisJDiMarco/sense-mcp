// Smoke test: spawn the server, call get_context_frame, print the frame.
const { spawn } = require("child_process");
const path = require("path");

const server = path.join(__dirname, "..", "dist", "index.js");
const p = spawn("node", [server], { env: process.env });
const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
let buf = "";

p.stdout.on("data", (d) => {
  buf += d;
  for (const line of buf.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.id === 3) {
        console.log(m.result.content[0].text);
        p.kill();
        process.exit(0);
      }
    } catch {}
  }
});
p.stderr.on("data", (d) => console.error("[server]", String(d).trim()));

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }), 200);
// give sensors a moment to prime (osascript can be slow on first run)
setTimeout(() => send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_context_frame", arguments: {} } }), 4000);
setTimeout(() => { console.error("TIMEOUT"); p.kill(); process.exit(1); }, 15000);
