import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export class PrivateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateFileError";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PrivateFileError(`${label} must be a positive safe integer`);
  }
  return value;
}

/** macOS exposes these two root aliases as symlinks on every standard install. */
function canonicalSystemRootAlias(file: string): string {
  if (process.platform !== "darwin") return file;
  if (file === "/var" || file.startsWith("/var/")) return `/private${file}`;
  if (file === "/tmp" || file.startsWith("/tmp/")) return `/private${file}`;
  return file;
}

function resolvePrivatePath(file: string): string {
  return canonicalSystemRootAlias(path.resolve(file));
}

async function existingStat(file: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function requirePlainDirectory(
  directory: string,
  info: Awaited<ReturnType<typeof lstat>>,
): void {
  if (info.isSymbolicLink()) {
    throw new PrivateFileError(`Refusing symbolic link directory: ${directory}`);
  }
  if (!info.isDirectory()) {
    throw new PrivateFileError(`Private storage path is not a directory: ${directory}`);
  }
}

function requirePlainFile(file: string, info: Awaited<ReturnType<typeof lstat>>): void {
  if (info.isSymbolicLink()) {
    throw new PrivateFileError(`Refusing symbolic link file: ${file}`);
  }
  if (!info.isFile()) {
    throw new PrivateFileError(`Private storage path is not a regular file: ${file}`);
  }
}

async function rejectSymlinkComponents(resolved: string): Promise<void> {
  const parsed = path.parse(resolved);
  const relative = resolved.slice(parsed.root.length);
  let current = parsed.root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await existingStat(current);
    if (!info) return;
    if (info.isSymbolicLink()) {
      throw new PrivateFileError(`Refusing symbolic link path component: ${current}`);
    }
    if (current !== resolved && !info.isDirectory()) {
      throw new PrivateFileError(`Private storage ancestor is not a directory: ${current}`);
    }
  }
}

/** Verify that every currently existing component is non-symlinked. */
export async function assertPrivatePath(file: string): Promise<string> {
  const resolved = resolvePrivatePath(file);
  await rejectSymlinkComponents(resolved);
  return resolved;
}

/** Create (or verify) an application-owned directory with mode 0700. */
export async function ensurePrivateDirectory(directory: string): Promise<string> {
  const resolved = resolvePrivatePath(directory);
  await rejectSymlinkComponents(resolved);
  const before = await existingStat(resolved);
  if (before) requirePlainDirectory(resolved, before);

  await mkdir(resolved, { recursive: true, mode: 0o700 });
  await rejectSymlinkComponents(resolved);
  const after = await lstat(resolved);
  requirePlainDirectory(resolved, after);
  await chmod(resolved, 0o700);
  return resolved;
}

/** Read a regular file without following its final path component. */
export async function readPrivateFile(file: string, maxBytes = DEFAULT_MAX_FILE_BYTES): Promise<Buffer> {
  const limit = positiveLimit(maxBytes, "maxBytes");
  const resolved = resolvePrivatePath(file);
  await rejectSymlinkComponents(resolved);
  const info = await lstat(resolved);
  requirePlainFile(resolved, info);
  if (info.size > limit) {
    throw new PrivateFileError(`Private file exceeds maximum size of ${limit} bytes`);
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(resolved, constants.O_RDONLY | NO_FOLLOW);
    const opened = await handle.stat();
    requirePlainFile(resolved, opened);
    if (opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new PrivateFileError(`Private file changed while opening: ${resolved}`);
    }
    if (opened.size > limit) {
      throw new PrivateFileError(`Private file exceeds maximum size of ${limit} bytes`);
    }

    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new PrivateFileError(`Private file changed while reading: ${resolved}`);
    }
    if (bytesRead > limit || after.size > limit) {
      throw new PrivateFileError(`Private file exceeds maximum size of ${limit} bytes`);
    }
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      throw new PrivateFileError(`Refusing symbolic link file: ${resolved}`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readPrivateText(file: string, maxBytes = DEFAULT_MAX_FILE_BYTES): Promise<string> {
  return (await readPrivateFile(file, maxBytes)).toString("utf8");
}

export interface AtomicWriteOptions {
  maxBytes?: number;
}

/** Write through a same-directory 0600 temporary file, fsync, then rename. */
export async function atomicWritePrivateFile(
  file: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const limit = positiveLimit(options.maxBytes ?? DEFAULT_MAX_FILE_BYTES, "maxBytes");
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length > limit) {
    throw new PrivateFileError(`Private file exceeds maximum size of ${limit} bytes`);
  }

  const resolved = resolvePrivatePath(file);
  const directory = await ensurePrivateDirectory(path.dirname(resolved));
  await rejectSymlinkComponents(resolved);
  const current = await existingStat(resolved);
  if (current) requirePlainFile(resolved, current);

  const temporary = path.join(
    directory,
    `.${path.basename(resolved)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporary, resolved);
    await chmod(resolved, 0o600);

    // Directory fsync is supported on Unix and makes the rename durable. Some
    // filesystems reject it; the atomic rename still provides consistency.
    const directoryHandle = await open(directory, constants.O_RDONLY).catch(() => undefined);
    await directoryHandle?.sync().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

/** Remove only a regular file; never follow or delete through a symlink. */
export async function removePrivateFile(file: string): Promise<boolean> {
  const resolved = resolvePrivatePath(file);
  await rejectSymlinkComponents(resolved);
  const info = await existingStat(resolved);
  if (!info) return false;
  requirePlainFile(resolved, info);
  await unlink(resolved);
  return true;
}

export interface ListPrivateFilesOptions {
  pattern?: RegExp;
  maxEntries?: number;
}

/** List bounded regular files in one verified private directory. */
export async function listPrivateFiles(
  directory: string,
  options: ListPrivateFilesOptions = {},
): Promise<string[]> {
  const resolved = await ensurePrivateDirectory(directory);
  const maxEntries = positiveLimit(options.maxEntries ?? 256, "maxEntries");
  const names = (await readdir(resolved)).slice(0, maxEntries * 2);
  const files: string[] = [];
  for (const name of names) {
    if (files.length >= maxEntries) break;
    if (options.pattern && !options.pattern.test(name)) continue;
    const file = path.join(resolved, name);
    const info = await existingStat(file);
    if (!info || info.isSymbolicLink() || !info.isFile()) continue;
    files.push(file);
  }
  return files;
}

export interface PrivateLockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serialize a short cross-process critical section with a private O_EXCL lock. */
export async function withPrivateFileLock<T>(
  lockFile: string,
  action: () => Promise<T>,
  options: PrivateLockOptions = {},
): Promise<T> {
  const timeoutMs = positiveLimit(options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, "timeoutMs");
  const staleMs = positiveLimit(options.staleMs ?? DEFAULT_STALE_LOCK_MS, "staleMs");
  const resolved = resolvePrivatePath(lockFile);
  await ensurePrivateDirectory(path.dirname(resolved));
  await rejectSymlinkComponents(resolved);
  const deadline = Date.now() + timeoutMs;

  let handle: FileHandle | undefined;
  let identity: { dev: number; ino: number } | undefined;
  while (!handle && Date.now() <= deadline) {
    try {
      handle = await open(
        resolved,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      const info = await handle.stat();
      identity = { dev: info.dev, ino: info.ino };
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
      await handle.sync();
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        const current = await existingStat(resolved);
        if (current && identity && current.dev === identity.dev && current.ino === identity.ino) {
          await unlink(resolved).catch(() => undefined);
        }
        identity = undefined;
      }
      if (errorCode(error) !== "EEXIST") throw error;
      const current = await existingStat(resolved);
      if (current?.isSymbolicLink()) {
        throw new PrivateFileError(`Refusing symbolic link lock: ${resolved}`);
      }
      if (current && !current.isFile()) {
        throw new PrivateFileError(`Private lock is not a regular file: ${resolved}`);
      }
      if (current && Date.now() - Number(current.mtimeMs) > staleMs) {
        const metadata = await readPrivateText(resolved, 512)
          .then((text) => JSON.parse(text) as { pid?: unknown })
          .catch(() => undefined);
        const ownerPid = typeof metadata?.pid === "number" ? metadata.pid : undefined;
        if (ownerPid && processIsAlive(ownerPid)) {
          await delay(5 + Math.floor(Math.random() * 11));
          continue;
        }
        const check = await existingStat(resolved);
        if (check && check.dev === current.dev && check.ino === current.ino) {
          await unlink(resolved).catch(() => undefined);
          continue;
        }
      }
      await delay(5 + Math.floor(Math.random() * 11));
    }
  }

  if (!handle || !identity) {
    throw new PrivateFileError(`Timed out acquiring private lock: ${resolved}`);
  }

  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    const current = await existingStat(resolved);
    if (current && current.dev === identity.dev && current.ino === identity.ino) {
      await unlink(resolved).catch(() => undefined);
    }
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}
