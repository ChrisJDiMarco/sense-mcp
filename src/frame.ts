import type { ContextFrame, Domain, Privacy } from "./types.js";
import { StateStore } from "./state.js";
import { derivePosture } from "./posture.js";

const DOMAINS: Domain[] = ["screen", "user", "environment", "schedule"];
const TIER_ZERO: Privacy = { tier: 0, capabilities: {} };

/**
 * Assemble a ContextFrame from live observations.
 * Later observations win field-wise within a domain. Empty domains are omitted.
 * `assistive_posture` is derived from the assembled domains.
 */
export function buildFrame(
  store: StateStore,
  domains: Domain[] = DOMAINS,
  now: number = Date.now(),
  privacy: Privacy = TIER_ZERO,
): ContextFrame {
  const frame: ContextFrame = {
    spec: "context-frame/0.2",
    generated_at: new Date(now).toISOString(),
    staleness_ms: 0,
    privacy,
    assistive_posture: "unknown",
  };

  let oldest = now;
  for (const domain of domains) {
    const observations = store
      .live(domain, now)
      .sort((a, b) => a.observedAt - b.observedAt);
    if (observations.length === 0) continue;

    let merged: Record<string, string | number | boolean> = {};
    for (const obs of observations) {
      merged = { ...merged, ...obs.fields };
      if (obs.observedAt < oldest) oldest = obs.observedAt;
    }
    frame[domain] = merged;
  }

  frame.staleness_ms = now - oldest;
  frame.assistive_posture = derivePosture(frame);
  return frame;
}
