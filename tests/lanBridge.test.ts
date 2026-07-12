import { describe, expect, test } from "vitest";
import {
  BridgeReplayCache,
  isAllowedPairingIpv4,
  openLanBridgePayload,
  sealLanBridgePayload,
  selectLanAddress,
  startLanIphoneBridge,
} from "../src/lanBridge.js";

const SECRET = "test-secret-with-at-least-32-bytes";

describe("LAN bridge cryptography", () => {
  test("selects only an address accepted by the iOS pairing validator", () => {
    expect(isAllowedPairingIpv4("192.168.1.20")).toBe(true);
    expect(isAllowedPairingIpv4("100.64.2.3")).toBe(true);
    expect(isAllowedPairingIpv4("8.8.8.8")).toBe(false);
    expect(
      selectLanAddress({
        vpn0: [{ address: "8.8.8.8", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "8.8.8.8/24" }],
        en0: [{ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:01", internal: false, cidr: "192.168.1.20/24" }],
      }),
    ).toBe("192.168.1.20");
    expect(selectLanAddress({
      vpn0: [{ address: "203.0.113.8", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:02", internal: false, cidr: "203.0.113.8/24" }],
    })).toBe("127.0.0.1");
  });

  test("round trips authenticated payloads and binds method and path", () => {
    const envelope = sealLanBridgePayload(SECRET, "POST", "/api/iphone-context", {
      focus: 0.9,
      note: "private note",
    });
    expect(JSON.stringify(envelope)).not.toContain(SECRET);
    expect(JSON.stringify(envelope)).not.toContain("private note");
    expect(openLanBridgePayload(SECRET, "POST", "/api/iphone-context", envelope)).toEqual({
      focus: 0.9,
      note: "private note",
    });
    expect(() => openLanBridgePayload(SECRET, "GET", "/api/iphone-context", envelope)).toThrow(
      /authentication/i,
    );
    expect(() => openLanBridgePayload(SECRET, "POST", "/different", envelope)).toThrow(/authentication/i);
  });

  test("rejects malformed and oversized envelope fields", () => {
    const valid = sealLanBridgePayload(SECRET, "POST", "/api/iphone-context", {});
    expect(() => openLanBridgePayload(SECRET, "POST", "/api/iphone-context", { ...valid, nonce: "AA" })).toThrow(
      /nonce/i,
    );
    expect(() =>
      openLanBridgePayload(SECRET, "POST", "/api/iphone-context", {
        ...valid,
        ciphertext: Buffer.alloc(16 * 1024 + 1).toString("base64url"),
      }),
    ).toThrow(/too large/i);
  });

  test("bounds replay state and expires entries outside the skew window", () => {
    const replay = new BridgeReplayCache();
    const now = Date.now();
    for (let index = 0; index < 2_100; index += 1) replay.consume(`nonce-${index}`, now, now);
    expect(replay.size).toBe(2_048);
    replay.consume("fresh", now + 5 * 60_000 + 1, now + 5 * 60_000 + 1);
    expect(replay.size).toBe(1);
  });

  test("requires a 256-bit-class pairing secret", () => {
    expect(() => sealLanBridgePayload("too-short", "POST", "/api/iphone-context", {})).toThrow(/32 bytes/i);
  });

  test("binds encrypted responses to the request nonce", () => {
    const response = sealLanBridgePayload(SECRET, "RESPONSE", "/api/iphone-context", { ok: true }, {
      binding: "request-nonce-a",
    });
    expect(
      openLanBridgePayload(SECRET, "RESPONSE", "/api/iphone-context", response, {
        binding: "request-nonce-a",
      }),
    ).toEqual({ ok: true });
    expect(() =>
      openLanBridgePayload(SECRET, "RESPONSE", "/api/iphone-context", response, {
        binding: "request-nonce-b",
      }),
    ).toThrow(/authentication/i);
  });

  test("requires an integer timestamp", () => {
    expect(() =>
      sealLanBridgePayload(SECRET, "POST", "/api/iphone-context", {}, { timestamp: Number.NaN }),
    ).toThrow(/timestamp/i);
  });
});

describe("LAN bridge listener", () => {
  test("rejects oversized bodies before decrypting and keeps errors generic", async () => {
    const bridge = await startLanIphoneBridge(0, SECRET, async () => ({ ok: true }));
    try {
      const response = await fetch(bridge.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.sense.encrypted+json",
          "X-Sense-Bridge": "sense-ios",
        },
        body: "x".repeat(32 * 1024 + 1),
      });
      expect(response.status).toBe(413);
      expect(await response.text()).toBe("Request too large");
    } finally {
      await bridge.close();
    }
  });
});
