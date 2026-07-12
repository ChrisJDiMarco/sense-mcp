import { constants } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  readIphoneContextObservation,
  sanitizeIphoneContextPayload,
  writeIphoneContextPayload,
} from "../src/iphoneContext.js";

function payload(now = Date.now()): Record<string, unknown> {
  return {
    type: "sense_ios_check_in",
    generated_at: new Date(now).toISOString(),
    expires_at: new Date(now + 30 * 60_000).toISOString(),
    source: "iphone_action_button",
    internal_state: {
      feeling: "focused",
      energy: 0.7,
      stress: 0.2,
      focus: 0.9,
      confidence: "medium",
      note: "Protect this focus block.",
    },
    assistive_hint: "protect_focus_and_keep_responses_concise",
    privacy: { scope: "semantic_self_report", audio_retained: "false" },
  };
}

describe("iPhone context validation", () => {
  test("rejects future-generated, backwards-expiry, and overlong context windows", () => {
    const now = Date.now();
    expect(() =>
      sanitizeIphoneContextPayload({
        ...payload(now),
        generated_at: new Date(now + 10 * 60_000).toISOString(),
        expires_at: new Date(now + 40 * 60_000).toISOString(),
      }),
    ).toThrow(/clock/i);

    expect(() =>
      sanitizeIphoneContextPayload({
        ...payload(now),
        generated_at: new Date(now).toISOString(),
        expires_at: new Date(now - 1).toISOString(),
      }),
    ).toThrow(/expired|expiry/i);

    expect(() =>
      sanitizeIphoneContextPayload({
        ...payload(now),
        expires_at: new Date(now + 25 * 60 * 60_000).toISOString(),
      }),
    ).toThrow(/24 hours/i);
  });

  test("rejects invalid top-level timestamps instead of silently replacing them", () => {
    expect(() => sanitizeIphoneContextPayload({ ...payload(), generated_at: "not-a-date" })).toThrow(
      /generated_at/i,
    );
    expect(() => sanitizeIphoneContextPayload({ ...payload(), expires_at: "not-a-date" })).toThrow(
      /expires_at/i,
    );
  });

  test("requires the declared iPhone check-in payload type", () => {
    expect(() => sanitizeIphoneContextPayload({ ...payload(), type: "unexpected" })).toThrow(/type/i);
  });
});

describe("iPhone context private file lifecycle", () => {
  test("writes atomically with private modes and no temporary file residue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sense-iphone-"));
    const file = path.join(root, "context.json");
    try {
      await writeIphoneContextPayload(payload(), file);
      const directory = await lstat(root);
      const stored = await lstat(file);
      expect(directory.mode & 0o077).toBe(0);
      expect(stored.mode & 0o077).toBe(0);
      expect(JSON.parse(await readFile(file, "utf8")).internal_state.note).toBe(
        "Protect this focus block.",
      );
      const entries = await readdir(root);
      expect(entries).toEqual(["context.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to follow a symlink at the context path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sense-iphone-"));
    const target = path.join(root, "target.json");
    const link = path.join(root, "context.json");
    await writeFile(target, "unchanged", { mode: constants.S_IRUSR | constants.S_IWUSR });
    await symlink(target, link);
    try {
      await expect(writeIphoneContextPayload(payload(), link)).rejects.toThrow(/symbolic link/i);
      expect(await readFile(target, "utf8")).toBe("unchanged");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deletes an expired context deterministically when it is read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sense-iphone-"));
    const file = path.join(root, "context.json");
    const expiredAt = Date.now() - 60_000;
    await writeFile(
      file,
      JSON.stringify({
        ...payload(expiredAt - 60_000),
        generated_at: new Date(expiredAt - 60_000).toISOString(),
        expires_at: new Date(expiredAt).toISOString(),
      }),
    );
    try {
      expect(await readIphoneContextObservation(file)).toEqual([]);
      await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not follow or remove a symlink while reading expired context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sense-iphone-"));
    const target = path.join(root, "target.json");
    const link = path.join(root, "context.json");
    const expiredAt = Date.now() - 60_000;
    await writeFile(
      target,
      JSON.stringify({
        ...payload(expiredAt - 60_000),
        generated_at: new Date(expiredAt - 60_000).toISOString(),
        expires_at: new Date(expiredAt).toISOString(),
      }),
    );
    await symlink(target, link);
    try {
      expect(await readIphoneContextObservation(link)).toEqual([]);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect((await lstat(target)).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
