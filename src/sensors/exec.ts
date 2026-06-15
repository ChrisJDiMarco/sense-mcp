import { execFile } from "node:child_process";

/** Run a command, return trimmed stdout, or null on any failure. */
export function run(cmd: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  signal?: NodeJS.Signals | null;
  errorMessage?: string;
}

/** Run a command and return both streams, even when the process exits non-zero. */
export function runCapture(
  cmd: string,
  args: string[],
  timeoutMs = 3000,
): Promise<CommandResult | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: typeof err?.code === "number" ? err.code : err ? 1 : 0,
        timedOut: Boolean(err?.killed || err?.signal === "SIGTERM"),
        signal: err?.signal,
        errorMessage: err?.message,
      });
    });
  });
}

/** Run a command expected to write binary data to stdout. */
export function runBuffer(
  cmd: string,
  args: string[],
  timeoutMs = 8000,
  maxBuffer = 8 * 1024 * 1024,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer, encoding: "buffer" },
      (err, stdout) => {
        if (err || !stdout || stdout.length === 0) {
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export const isMac = process.platform === "darwin";
