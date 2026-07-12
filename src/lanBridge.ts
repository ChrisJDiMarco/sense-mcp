import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";

const MAX_PLAINTEXT_BYTES = 16 * 1_024;
const MAX_ENCRYPTED_BYTES = 32 * 1_024;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_REPLAY_ENTRIES = 2_048;
const CONTENT_TYPE = "application/vnd.sense.encrypted+json";
const CONTEXT_PATH = "/api/iphone-context";
const CHECK_PATH = `${CONTEXT_PATH}/check`;

export interface LanBridgeState {
  url: string;
  pairingUrl: string;
}

export interface LanBridgeEnvelope {
  version: 1;
  timestamp: number;
  nonce: string;
  ciphertext: string;
  tag: string;
}

class LanBridgeSecurityError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LanBridgeSecurityError";
  }
}

export class BridgeReplayCache {
  private readonly seen = new Map<string, number>();

  consume(nonce: string, timestamp: number, now: number): void {
    for (const [candidate, observedAt] of this.seen) {
      if (Math.abs(now - observedAt) > MAX_CLOCK_SKEW_MS) this.seen.delete(candidate);
    }
    if (this.seen.has(nonce)) throw new LanBridgeSecurityError(401, "replayed bridge request");
    this.seen.set(nonce, timestamp);
    while (this.seen.size > MAX_REPLAY_ENTRIES) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (!oldest) break;
      this.seen.delete(oldest);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}

function bridgeKey(secret: string): Buffer {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("iPhone bridge pairing secret must be at least 32 bytes");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

function bridgeAad(
  method: string,
  pathname: string,
  envelope: Pick<LanBridgeEnvelope, "version" | "timestamp" | "nonce">,
  binding?: string,
): Buffer {
  const base = `${envelope.version}\n${method.toUpperCase()}\n${pathname}\n${envelope.timestamp}\n${envelope.nonce}`;
  return Buffer.from(binding ? `${base}\n${binding}` : base, "utf8");
}

function decodeField(value: unknown, field: string, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new LanBridgeSecurityError(401, `invalid bridge ${field}`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new LanBridgeSecurityError(401, `invalid bridge ${field}`);
  }
  return decoded;
}

function parseEnvelope(input: unknown, now: number): LanBridgeEnvelope {
  if (!input || typeof input !== "object") throw new LanBridgeSecurityError(401, "missing encrypted envelope");
  const body = input as Record<string, unknown>;
  if (body.version !== 1 || !Number.isSafeInteger(body.timestamp)) {
    throw new LanBridgeSecurityError(401, "invalid encrypted envelope");
  }
  const timestamp = body.timestamp as number;
  if (Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) {
    throw new LanBridgeSecurityError(401, "bridge timestamp exceeds allowed clock skew");
  }
  decodeField(body.nonce, "nonce", 12);
  decodeField(body.tag, "tag", 16);
  const ciphertext = decodeField(body.ciphertext, "ciphertext");
  if (ciphertext.length > MAX_PLAINTEXT_BYTES) {
    throw new LanBridgeSecurityError(413, "encrypted payload is too large");
  }
  return {
    version: 1,
    timestamp,
    nonce: body.nonce as string,
    ciphertext: body.ciphertext as string,
    tag: body.tag as string,
  };
}

export function sealLanBridgePayload(
  secret: string,
  method: string,
  pathname: string,
  payload: unknown,
  options: { timestamp?: number; nonce?: Buffer; binding?: string } = {},
): LanBridgeEnvelope {
  const encoded = JSON.stringify(payload);
  if (typeof encoded !== "string") throw new Error("bridge payload must be JSON serializable");
  const plaintext = Buffer.from(encoded, "utf8");
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error("bridge payload is too large");
  const timestamp = options.timestamp ?? Date.now();
  if (!Number.isSafeInteger(timestamp)) throw new Error("bridge timestamp must be a safe integer");
  const nonceBytes = options.nonce ?? randomBytes(12);
  if (nonceBytes.length !== 12) throw new Error("bridge nonce must be 12 bytes");
  const envelope: LanBridgeEnvelope = {
    version: 1,
    timestamp,
    nonce: nonceBytes.toString("base64url"),
    ciphertext: "",
    tag: "",
  };
  const cipher = createCipheriv("aes-256-gcm", bridgeKey(secret), nonceBytes);
  cipher.setAAD(bridgeAad(method, pathname, envelope, options.binding));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  envelope.ciphertext = ciphertext.toString("base64url");
  envelope.tag = cipher.getAuthTag().toString("base64url");
  return envelope;
}

export function openLanBridgePayload(
  secret: string,
  method: string,
  pathname: string,
  input: unknown,
  options: { now?: number; replayCache?: BridgeReplayCache; binding?: string } = {},
): unknown {
  const now = options.now ?? Date.now();
  const envelope = parseEnvelope(input, now);
  try {
    const decipher = createDecipheriv("aes-256-gcm", bridgeKey(secret), decodeField(envelope.nonce, "nonce", 12));
    decipher.setAAD(bridgeAad(method, pathname, envelope, options.binding));
    decipher.setAuthTag(decodeField(envelope.tag, "tag", 16));
    const plaintext = Buffer.concat([
      decipher.update(decodeField(envelope.ciphertext, "ciphertext")),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
    options.replayCache?.consume(envelope.nonce, envelope.timestamp, now);
    return parsed;
  } catch (error) {
    if (error instanceof LanBridgeSecurityError) throw error;
    throw new LanBridgeSecurityError(401, "bridge authentication failed");
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const contentLength = req.headers["content-length"];
  if (typeof contentLength !== "string" || !/^\d+$/.test(contentLength)) {
    throw new LanBridgeSecurityError(400, "content length is required");
  }
  if (Number(contentLength) > MAX_ENCRYPTED_BYTES) {
    throw new LanBridgeSecurityError(413, "request body too large");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_ENCRYPTED_BYTES) throw new LanBridgeSecurityError(413, "request body too large");
    chunks.push(buffer);
  }
  if (bytes !== Number(contentLength)) throw new LanBridgeSecurityError(400, "content length mismatch");
  return Buffer.concat(chunks, bytes);
}

async function readRequest(
  req: IncomingMessage,
  secret: string,
  pathname: string,
  replayCache: BridgeReplayCache,
): Promise<{ payload: unknown; nonce: string }> {
  if (
    req.headers["x-sense-bridge"] !== "sense-ios" ||
    !String(req.headers["content-type"] ?? "").startsWith(CONTENT_TYPE)
  ) {
    throw new LanBridgeSecurityError(401, "encrypted bridge authentication required");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse((await readBody(req)).toString("utf8"));
  } catch (error) {
    if (error instanceof LanBridgeSecurityError) throw error;
    throw new LanBridgeSecurityError(401, "invalid encrypted envelope");
  }
  const parsedEnvelope = parseEnvelope(envelope, Date.now());
  return {
    payload: openLanBridgePayload(secret, "POST", pathname, parsedEnvelope, { replayCache }),
    nonce: parsedEnvelope.nonce,
  };
}

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain"): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function sendEncrypted(
  res: ServerResponse,
  secret: string,
  pathname: string,
  requestNonce: string,
  payload: unknown,
): void {
  send(
    res,
    200,
    JSON.stringify(sealLanBridgePayload(secret, "RESPONSE", pathname, payload, { binding: requestNonce })),
    CONTENT_TYPE,
  );
}

export function isAllowedPairingIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

export function selectLanAddress(
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
): string {
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (
        address.family === "IPv4" &&
        !address.internal &&
        isAllowedPairingIpv4(address.address)
      ) {
        return address.address;
      }
    }
  }
  return "127.0.0.1";
}

function pairingDeepLink(url: string, secret: string): string {
  return `sense://pair?${new URLSearchParams({ url, secret }).toString()}`;
}

export async function startLanIphoneBridge(
  port: number,
  secret: string,
  acceptContext: (input: unknown) => Promise<unknown>,
): Promise<LanBridgeState & { close: () => Promise<void> }> {
  bridgeKey(secret);
  const replayCache = new BridgeReplayCache();
  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://sense.local");
    const pathname = requestUrl.pathname;
    try {
      if (requestUrl.search || requestUrl.hash) return send(res, 404, "Not found");
      if (pathname !== CONTEXT_PATH && pathname !== CHECK_PATH) return send(res, 404, "Not found");
      if (req.method !== "POST") return send(res, 405, "Method not allowed");
      const request = await readRequest(req, secret, pathname, replayCache);
      if (pathname === CHECK_PATH) {
        return sendEncrypted(res, secret, pathname, request.nonce, { ok: true, accepts: "sense_ios_check_in" });
      }
      sendEncrypted(res, secret, pathname, request.nonce, await acceptContext(request.payload));
    } catch (error) {
      if (error instanceof LanBridgeSecurityError) {
        send(res, error.status, error.status === 413 ? "Request too large" : "Unauthorized");
      } else {
        send(res, 400, "Invalid bridge request");
      }
    }
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 16;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${selectLanAddress()}:${actualPort}${CONTEXT_PATH}`;
  return {
    url,
    pairingUrl: pairingDeepLink(url, secret),
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
