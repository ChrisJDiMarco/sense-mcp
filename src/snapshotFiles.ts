import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SNAPSHOT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export type SnapshotKind = "camera" | "screen";

export interface PersistedSnapshot {
  path: string;
  markdown_image: string;
  size_bytes: number;
}

function snapshotDir(): string {
  return process.env.SENSE_SNAPSHOT_DIR || path.join(os.tmpdir(), "sense-mcp", "snapshots");
}

function snapshotFilename(kind: SnapshotKind, generatedAt: string): string {
  const safeTimestamp = generatedAt.replace(/[^0-9A-Za-z]/g, "-");
  return `sense-${kind}-${safeTimestamp}-${randomUUID()}.png`;
}

async function cleanupOldSnapshots(dir: string, now = Date.now()): Promise<void> {
  try {
    const entries = await readdir(dir);
    await Promise.all(
      entries
        .filter((entry) => /^sense-(camera|screen)-.+\.png$/.test(entry))
        .map(async (entry) => {
          const file = path.join(dir, entry);
          const info = await stat(file).catch(() => null);
          if (!info || now - info.mtimeMs <= SNAPSHOT_MAX_AGE_MS) return;
          await unlink(file).catch(() => undefined);
        }),
    );
  } catch {
    // Snapshot cleanup is best-effort.
  }
}

export async function createSnapshotPath(
  kind: SnapshotKind,
  generatedAt: string,
): Promise<string> {
  const dir = snapshotDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await cleanupOldSnapshots(dir);
  return path.join(dir, snapshotFilename(kind, generatedAt));
}

export async function persistSnapshotBuffer(
  kind: SnapshotKind,
  buffer: Buffer,
  generatedAt: string,
): Promise<PersistedSnapshot> {
  const file = await createSnapshotPath(kind, generatedAt);
  await writeFile(file, buffer, { mode: 0o600 });

  return {
    path: file,
    markdown_image: `![Sense ${kind} snapshot](${file})`,
    size_bytes: buffer.length,
  };
}

export async function finalizeSnapshotFile(
  kind: SnapshotKind,
  file: string,
): Promise<PersistedSnapshot> {
  await chmod(file, 0o600).catch(() => undefined);
  const info = await stat(file);

  return {
    path: file,
    markdown_image: `![Sense ${kind} snapshot](${file})`,
    size_bytes: info.size,
  };
}
