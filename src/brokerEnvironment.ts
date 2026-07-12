import { spawn } from "node:child_process";

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

export async function spawnDetachedBroker(socketPath: string): Promise<void> {
  const entry = process.argv[1];
  if (!entry) throw new Error("Cannot locate the Sense MCP entry point");
  const execArgs = process.execArgv.filter((arg) => !arg.startsWith("--inspect"));
  spawn(process.execPath, [...execArgs, entry, INTERNAL_BROKER_FLAG], {
    detached: true,
    stdio: "ignore",
    env: brokerProcessEnv({ ...process.env, SENSE_BROKER_SOCKET: socketPath }),
  }).unref();
}
