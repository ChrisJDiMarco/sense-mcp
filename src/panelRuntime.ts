import os from "node:os";
import path from "node:path";
import {
  atomicWritePrivateFile,
  listPrivateFiles,
  readPrivateText,
  removePrivateFile,
} from "./privateFiles.js";

const MAX_RUNTIME_BYTES = 2_048;
const RUNTIME_PATTERN = /^runtime-([0-9a-f-]{36})\.json$/i;

export interface PanelRuntimeRecord {
  version: 1;
  instance_id: string;
  pid: number;
  port: number;
  started_at: string;
  file: string;
}

export function panelRuntimeDirectory(): string {
  return process.env.SENSE_PANEL_RUNTIME_DIR || path.join(
    os.tmpdir(),
    `sense-mcp-${process.getuid?.() ?? "user"}`,
    "panel",
  );
}

export function panelRuntimePath(instanceId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(instanceId)) throw new Error("Invalid panel instance id");
  return path.join(panelRuntimeDirectory(), `runtime-${instanceId}.json`);
}

export async function writePanelRuntime(
  instanceId: string,
  port: number,
  pid = process.pid,
): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid panel process id");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid panel port");
  const file = panelRuntimePath(instanceId);
  const record = {
    version: 1,
    instance_id: instanceId,
    pid,
    port,
    started_at: new Date().toISOString(),
  };
  await atomicWritePrivateFile(file, Buffer.from(`${JSON.stringify(record)}\n`), {
    maxBytes: MAX_RUNTIME_BYTES,
  });
  return file;
}

function parseRuntimeRecord(file: string, text: string): PanelRuntimeRecord | undefined {
  try {
    const value = JSON.parse(text) as Partial<PanelRuntimeRecord>;
    if (
      value.version !== 1 ||
      typeof value.instance_id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.instance_id) ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      !Number.isInteger(value.port) ||
      Number(value.port) < 1 ||
      Number(value.port) > 65_535 ||
      typeof value.started_at !== "string" ||
      !Number.isFinite(Date.parse(value.started_at))
    ) {
      return undefined;
    }
    return {
      version: 1,
      instance_id: value.instance_id,
      pid: Number(value.pid),
      port: Number(value.port),
      started_at: value.started_at,
      file,
    };
  } catch {
    return undefined;
  }
}

export async function readPanelRuntimes(): Promise<PanelRuntimeRecord[]> {
  const files = await listPrivateFiles(panelRuntimeDirectory(), {
    pattern: RUNTIME_PATTERN,
    maxEntries: 256,
  }).catch(() => []);
  const records = await Promise.all(
    files.map(async (file) =>
      readPrivateText(file, MAX_RUNTIME_BYTES)
        .then((text) => parseRuntimeRecord(file, text))
        .catch(() => undefined),
    ),
  );
  return records
    .filter((record): record is PanelRuntimeRecord => Boolean(record))
    .sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at));
}

export async function removePanelRuntime(file: string): Promise<void> {
  if (path.dirname(path.resolve(file)) !== path.resolve(panelRuntimeDirectory())) return;
  if (!RUNTIME_PATTERN.test(path.basename(file))) return;
  await removePrivateFile(file).catch(() => undefined);
}
