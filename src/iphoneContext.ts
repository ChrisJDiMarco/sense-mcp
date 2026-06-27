import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Observation } from "./types.js";

const MAX_NOTE_CHARS = 1_000;
const MAX_HINT_CHARS = 120;
const MAX_LABEL_CHARS = 80;
const MAX_TAGS = 8;
const MAX_CONTEXT_TTL_MS = 24 * 60 * 60 * 1_000;

const ALLOWED_PRIVACY_KEYS = new Set([
  "scope",
  "audio_retained",
  "expires",
  "iphone_signals",
  "health_scope",
  "motion_scope",
  "device_scope",
]);
const ALLOWED_FEELINGS = new Set([
  "steady",
  "anxious",
  "excited",
  "tired",
  "scattered",
  "focused",
  "blocked",
  "low",
]);

export interface IphoneContextPayload {
  type: "sense_ios_check_in";
  generated_at: string;
  expires_at: string;
  source: string;
  internal_state: {
    feeling: string;
    energy: number;
    stress: number;
    focus: number;
    confidence: string;
    note: string;
    context_mode?: string;
    semantic_tags?: string[];
  };
  iphone_context?: {
    generated_at: string;
    device?: {
      battery_percent?: number;
      power_state: string;
      low_power_mode: boolean;
      thermal_state: string;
      device_model: string;
      system_version: string;
    };
    motion?: {
      activity_class?: string;
      activity_confidence?: string;
      steps_today?: number;
      distance_meters_today?: number;
      floors_ascended_today?: number;
    };
    noise?: {
      noise_class: string;
      average_dbfs: number;
      peak_dbfs: number;
      sampled_seconds: number;
      audio_retained: boolean;
    };
    health?: {
      health_available: boolean;
      steps_today?: number;
      active_energy_kcal_today?: number;
      heart_rate_bpm?: number;
      resting_heart_rate_bpm?: number;
      sleep_minutes_last_24h?: number;
    };
  };
  assistive_hint: string;
  privacy: Record<string, string>;
}

function clamp01(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function cleanString(value: unknown, fallback: string, maxChars: number): string {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.slice(0, maxChars) || fallback;
}

function cleanOptionalString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, maxChars) : undefined;
}

function cleanOptionalNumber(value: unknown, min?: number, max?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  let clean = value;
  if (typeof min === "number") clean = Math.max(min, clean);
  if (typeof max === "number") clean = Math.min(max, clean);
  return clean;
}

function cleanOptionalInteger(value: unknown, min?: number, max?: number): number | undefined {
  const clean = cleanOptionalNumber(value, min, max);
  return typeof clean === "number" ? Math.round(clean) : undefined;
}

function cleanOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function cleanStringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const clean = cleanOptionalString(item, maxChars);
    return clean ? [clean.toLowerCase().replace(/\s+/g, "_")] : [];
  }).slice(0, maxItems);
}

function cleanIsoDate(value: unknown, fallback: Date): string {
  if (typeof value !== "string") return fallback.toISOString();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return fallback.toISOString();
  return new Date(ms).toISOString();
}

export function iphoneContextPath(env: Record<string, string | undefined> = process.env): string {
  return env.SENSE_IPHONE_CONTEXT_PATH || path.join(os.homedir(), ".sense-mcp", "iphone-context.json");
}

export function sanitizeIphoneContextPayload(input: unknown): IphoneContextPayload {
  if (!input || typeof input !== "object") {
    throw new Error("invalid iphone context payload");
  }

  const body = input as Record<string, unknown>;
  const state =
    body.internal_state && typeof body.internal_state === "object"
      ? (body.internal_state as Record<string, unknown>)
      : {};
  const now = new Date();
  const generatedAt = cleanIsoDate(body.generated_at, now);
  const generatedMs = Date.parse(generatedAt);
  const requestedExpiry = Date.parse(cleanIsoDate(body.expires_at, new Date(generatedMs + 2 * 60 * 60 * 1_000)));
  const maxExpiry = generatedMs + MAX_CONTEXT_TTL_MS;
  const expiresAt = new Date(Math.min(requestedExpiry, maxExpiry));
  if (expiresAt.getTime() <= now.getTime()) {
    throw new Error("iphone context is already expired");
  }

  const rawFeeling = cleanString(state.feeling, "steady", MAX_LABEL_CHARS).toLowerCase();
  const feeling = ALLOWED_FEELINGS.has(rawFeeling) ? rawFeeling : "steady";
  const contextMode = cleanOptionalString(state.context_mode, MAX_LABEL_CHARS);
  const semanticTags = cleanStringList(state.semantic_tags, MAX_TAGS, MAX_LABEL_CHARS);
  const privacy: Record<string, string> = {};
  if (body.privacy && typeof body.privacy === "object") {
    for (const [key, value] of Object.entries(body.privacy as Record<string, unknown>)) {
      if (ALLOWED_PRIVACY_KEYS.has(key) && typeof value === "string") {
        privacy[key] = cleanString(value, "", MAX_LABEL_CHARS);
      }
    }
  }

  const iphoneContext = sanitizeIphoneContext(body.iphone_context);
  return {
    type: "sense_ios_check_in",
    generated_at: generatedAt,
    expires_at: expiresAt.toISOString(),
    source: cleanString(body.source, "iphone_companion", MAX_LABEL_CHARS),
    internal_state: {
      feeling,
      energy: clamp01(state.energy, 0.5),
      stress: clamp01(state.stress, 0.5),
      focus: clamp01(state.focus, 0.5),
      confidence: cleanString(state.confidence, "medium", MAX_LABEL_CHARS),
      note: cleanString(state.note, "User shared a Sense iPhone check-in.", MAX_NOTE_CHARS),
      ...(contextMode ? { context_mode: contextMode } : {}),
      ...(semanticTags.length ? { semantic_tags: semanticTags } : {}),
    },
    ...(iphoneContext ? { iphone_context: iphoneContext } : {}),
    assistive_hint: cleanString(body.assistive_hint, "adapt_tone_to_current_internal_state", MAX_HINT_CHARS),
    privacy: {
      scope: privacy.scope || "semantic_self_report",
      audio_retained: privacy.audio_retained || "false",
      expires: privacy.expires || "temporary",
      ...(privacy.iphone_signals ? { iphone_signals: privacy.iphone_signals } : {}),
      ...(privacy.health_scope ? { health_scope: privacy.health_scope } : {}),
      ...(privacy.motion_scope ? { motion_scope: privacy.motion_scope } : {}),
      ...(privacy.device_scope ? { device_scope: privacy.device_scope } : {}),
    },
  };
}

function sanitizeIphoneContext(input: unknown): IphoneContextPayload["iphone_context"] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const body = input as Record<string, unknown>;
  const context: NonNullable<IphoneContextPayload["iphone_context"]> = {
    generated_at: cleanIsoDate(body.generated_at, new Date()),
  };

  if (body.device && typeof body.device === "object") {
    const device = body.device as Record<string, unknown>;
    context.device = {
      battery_percent: cleanOptionalNumber(device.battery_percent, 0, 1),
      power_state: cleanString(device.power_state, "unknown", MAX_LABEL_CHARS),
      low_power_mode: cleanOptionalBoolean(device.low_power_mode) ?? false,
      thermal_state: cleanString(device.thermal_state, "unknown", MAX_LABEL_CHARS),
      device_model: cleanString(device.device_model, "iPhone", MAX_LABEL_CHARS),
      system_version: cleanString(device.system_version, "unknown", MAX_LABEL_CHARS),
    };
  }

  if (body.motion && typeof body.motion === "object") {
    const motion = body.motion as Record<string, unknown>;
    context.motion = {
      activity_class: cleanOptionalString(motion.activity_class, MAX_LABEL_CHARS),
      activity_confidence: cleanOptionalString(motion.activity_confidence, MAX_LABEL_CHARS),
      steps_today: cleanOptionalInteger(motion.steps_today, 0, 200_000),
      distance_meters_today: cleanOptionalNumber(motion.distance_meters_today, 0, 250_000),
      floors_ascended_today: cleanOptionalInteger(motion.floors_ascended_today, 0, 5_000),
    };
  }

  if (body.noise && typeof body.noise === "object") {
    const noise = body.noise as Record<string, unknown>;
    context.noise = {
      noise_class: cleanString(noise.noise_class, "unknown", MAX_LABEL_CHARS),
      average_dbfs: cleanOptionalNumber(noise.average_dbfs, -160, 0) ?? -160,
      peak_dbfs: cleanOptionalNumber(noise.peak_dbfs, -160, 0) ?? -160,
      sampled_seconds: cleanOptionalNumber(noise.sampled_seconds, 0, 10) ?? 0,
      audio_retained: cleanOptionalBoolean(noise.audio_retained) ?? false,
    };
  }

  if (body.health && typeof body.health === "object") {
    const health = body.health as Record<string, unknown>;
    context.health = {
      health_available: cleanOptionalBoolean(health.health_available) ?? false,
      steps_today: cleanOptionalInteger(health.steps_today, 0, 200_000),
      active_energy_kcal_today: cleanOptionalNumber(health.active_energy_kcal_today, 0, 20_000),
      heart_rate_bpm: cleanOptionalNumber(health.heart_rate_bpm, 20, 240),
      resting_heart_rate_bpm: cleanOptionalNumber(health.resting_heart_rate_bpm, 20, 180),
      sleep_minutes_last_24h: cleanOptionalInteger(health.sleep_minutes_last_24h, 0, 24 * 60),
    };
  }

  return context.device || context.motion || context.noise || context.health ? context : undefined;
}

export async function writeIphoneContextPayload(
  input: unknown,
  file = iphoneContextPath(),
): Promise<IphoneContextPayload> {
  const payload = sanitizeIphoneContextPayload(input);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export function iphoneContextObservation(payload: IphoneContextPayload, now = Date.now()): Observation | null {
  const expiresAt = Date.parse(payload.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;

  const generatedAt = Date.parse(payload.generated_at);
  const observedAt = Number.isFinite(generatedAt) ? generatedAt : now;
  const fields: Record<string, string | number | boolean> = {
    self_report_source: payload.source,
    self_report_feeling: payload.internal_state.feeling,
    self_report_energy: payload.internal_state.energy,
    self_report_stress: payload.internal_state.stress,
    self_report_focus: payload.internal_state.focus,
    self_report_confidence: payload.internal_state.confidence,
    self_report_note: payload.internal_state.note,
    self_report_hint: payload.assistive_hint,
    self_report_expires_at: payload.expires_at,
  };
  addField(fields, "self_report_context_mode", payload.internal_state.context_mode);
  addField(fields, "self_report_semantic_tags", payload.internal_state.semantic_tags?.join(","));
  addIphoneContextFields(fields, payload.iphone_context);

  return {
    sensor: "iphone-context-bridge",
    domain: "user",
    observedAt,
    ttlMs: Math.min(expiresAt - now, MAX_CONTEXT_TTL_MS),
    fields,
  };
}

function addField(
  fields: Record<string, string | number | boolean>,
  key: string,
  value: string | number | boolean | undefined,
): void {
  if (value !== undefined) fields[key] = value;
}

function addIphoneContextFields(
  fields: Record<string, string | number | boolean>,
  context: IphoneContextPayload["iphone_context"],
): void {
  if (!context) return;
  addField(fields, "iphone_context_generated_at", context.generated_at);
  if (context.device) {
    addField(fields, "iphone_battery_percent", context.device.battery_percent);
    addField(fields, "iphone_power_state", context.device.power_state);
    addField(fields, "iphone_low_power_mode", context.device.low_power_mode);
    addField(fields, "iphone_thermal_state", context.device.thermal_state);
    addField(fields, "iphone_device_model", context.device.device_model);
    addField(fields, "iphone_system_version", context.device.system_version);
  }
  if (context.motion) {
    addField(fields, "iphone_activity_class", context.motion.activity_class);
    addField(fields, "iphone_activity_confidence", context.motion.activity_confidence);
    addField(fields, "iphone_steps_today", context.motion.steps_today);
    addField(fields, "iphone_distance_meters_today", context.motion.distance_meters_today);
    addField(fields, "iphone_floors_ascended_today", context.motion.floors_ascended_today);
  }
  if (context.noise) {
    addField(fields, "iphone_noise_class", context.noise.noise_class);
    addField(fields, "iphone_noise_average_dbfs", context.noise.average_dbfs);
    addField(fields, "iphone_noise_peak_dbfs", context.noise.peak_dbfs);
    addField(fields, "iphone_noise_sampled_seconds", context.noise.sampled_seconds);
    addField(fields, "iphone_audio_retained", context.noise.audio_retained);
  }
  if (context.health) {
    addField(fields, "iphone_health_available", context.health.health_available);
    addField(fields, "iphone_health_steps_today", context.health.steps_today);
    addField(fields, "iphone_active_energy_kcal_today", context.health.active_energy_kcal_today);
    addField(fields, "iphone_heart_rate_bpm", context.health.heart_rate_bpm);
    addField(fields, "iphone_resting_heart_rate_bpm", context.health.resting_heart_rate_bpm);
    addField(fields, "iphone_sleep_minutes_last_24h", context.health.sleep_minutes_last_24h);
  }
}

export async function readIphoneContextObservation(file = iphoneContextPath()): Promise<Observation[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    const payload = sanitizeIphoneContextPayload(parsed);
    const observation = iphoneContextObservation(payload);
    return observation ? [observation] : [];
  } catch {
    return [];
  }
}
