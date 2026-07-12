import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { startLanIphoneBridge } from "../src/lanBridge.js";

const run = promisify(execFile);
const SECRET = "swift-node-interop-secret-with-32-bytes";

describe.skipIf(process.platform !== "darwin")("Swift/Node bridge interoperability", () => {
  test(
    "authenticates and decrypts production Swift requests in the Node listener",
    async () => {
      const output = await mkdtemp(path.join(os.tmpdir(), "sense-swift-interop-"));
      const binary = path.join(output, "bridge-interop");
      const source = path.join(process.cwd(), "apps", "ios", "SenseIOS");
      const bridge = await startLanIphoneBridge(0, SECRET, async (input) => {
        const payload = input as { internal_state?: { note?: string } };
        expect(payload.internal_state?.note).toBe("Swift to Node encrypted bridge test.");
        return { ok: true, stored: true, accepted_summary: "Swift payload accepted" };
      });
      try {
        await run(
          "xcrun",
          [
            "swiftc",
            "-parse-as-library",
            path.join(source, "SenseIOS", "BridgeClient.swift"),
            path.join(source, "SenseIOS", "Models.swift"),
            path.join(source, "Tests", "BridgeClientInterop.swift"),
            "-o",
            binary,
          ],
          { timeout: 60_000 },
        );
        const result = await run(binary, [bridge.url, SECRET], { timeout: 15_000 });
        expect(result.stdout.trim()).toBe("swift-node-aead-ok");
      } finally {
        await bridge.close();
        await rm(output, { recursive: true, force: true });
      }
    },
    90_000,
  );

  test(
    "migrates legacy secrets out of UserDefaults and consumes pairing deep links",
    async () => {
      const output = await mkdtemp(path.join(os.tmpdir(), "sense-swift-store-"));
      const binary = path.join(output, "store-security");
      const source = path.join(process.cwd(), "apps", "ios", "SenseIOS");
      try {
        await run(
          "xcrun",
          [
            "swiftc",
            "-parse-as-library",
            path.join(source, "SenseIOS", "BridgeClient.swift"),
            path.join(source, "SenseIOS", "Models.swift"),
            path.join(source, "SenseIOS", "CheckInStore.swift"),
            path.join(source, "Tests", "CheckInStoreSecurity.swift"),
            "-o",
            binary,
          ],
          { timeout: 60_000 },
        );
        const result = await run(binary, [], { timeout: 15_000 });
        expect(result.stdout.trim()).toBe("keychain-migration-pairing-ok");
      } finally {
        await rm(output, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
