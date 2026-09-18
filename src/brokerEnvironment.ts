import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const INTERNAL_BROKER_FLAG = "--sense-internal-broker";

const BROKER_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
]);

/** Keep unrelated API keys and client secrets out of the resident process. */
export function brokerProcessEnv(
  source: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) =>
        value !== undefined && (key.startsWith("SENSE_") || BROKER_ENV_ALLOWLIST.has(key)),
    ),
  );
}

/** The Sense entry point, as it sits beside this module on disk. */
const ENTRY_CANDIDATES = ["./index.js", "./index.ts"];

/**
 * `process.argv[1]` is the program the runtime was told to run, which is only
 * the Sense entry point when Sense is invoked directly. Under a launcher shim,
 * a symlinked wrapper, or an embedding host that imports Sense as a library,
 * re-executing argv[1] forks the *host* with the internal broker flag. The
 * entry point is instead resolved from this module's own location, where it
 * sits in both the published build (`dist/index.js`) and the source tree.
 */
export async function senseEntryPoint(): Promise<string> {
  for (const candidate of ENTRY_CANDIDATES) {
    const resolved = fileURLToPath(new URL(candidate, import.meta.url));
    const isFile = await stat(resolved).then(
      (entry) => entry.isFile(),
      () => false,
    );
    if (isFile) return resolved;
  }
  throw new Error("Cannot locate the Sense MCP entry point");
}

export async function spawnDetachedBroker(socketPath: string): Promise<void> {
  const entry = await senseEntryPoint();
  const execArgs = process.execArgv.filter((arg) => !arg.startsWith("--inspect"));
  const child = spawn(process.execPath, [...execArgs, entry, INTERNAL_BROKER_FLAG], {
    detached: true,
    stdio: "ignore",
    env: brokerProcessEnv({ ...process.env, SENSE_BROKER_SOCKET: socketPath }),
  });
  try {
    // Node reports EAGAIN/EMFILE/ENFILE/EACCES asynchronously, so an unwatched
    // failure would surface as an uncaught exception long after this call.
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } finally {
    // The `once` handler above is consumed by the first event; a later failure
    // on the detached child must still never crash the adapter.
    child.on("error", () => undefined);
    child.unref();
  }
}
