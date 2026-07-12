import { buildFrame } from "./frame.js";
import { StateStore } from "./state.js";
import type { ContextFrame, Domain, Privacy } from "./types.js";
import { enforcePrivacyRevocations } from "./privacy.js";

const ALL_DOMAINS: Domain[] = ["screen", "user", "environment", "schedule"];

export type ContextRefreshMode = "cached" | "if_stale" | "force";

export interface ContextRequest {
  domains?: Domain[];
  refresh?: ContextRefreshMode;
  max_staleness_ms?: number;
}

export interface ContextDiagnostic {
  component: string;
  status: "healthy" | "degraded" | "unavailable";
  message?: string;
  last_success_at?: string;
  latency_ms?: number;
}

export interface ContextProviderHealth {
  status: "initializing" | "healthy" | "degraded" | "unavailable";
  source: "local" | "broker";
  checked_at: string;
  diagnostics: ContextDiagnostic[];
}

export interface ContextResult {
  frame: ContextFrame;
  health: ContextProviderHealth;
  refreshed_domains: Domain[];
}

export interface ContextProvider {
  getContext(request?: ContextRequest): Promise<ContextResult>;
}

export interface LocalContextProviderOptions {
  now?: () => number;
  refreshDomains?: (
    domains: Domain[],
    mode: Exclude<ContextRefreshMode, "cached">,
    maxStalenessMs?: number,
  ) => Promise<Domain[] | void>;
}

function uniqueDomains(domains: Domain[] | undefined): Domain[] | undefined {
  return domains ? [...new Set(domains)] : undefined;
}

function localHealth(frame: ContextFrame): ContextProviderHealth {
  const diagnostics: ContextDiagnostic[] = Object.entries(frame.privacy.capability_details ?? {}).map(
    ([component, detail]) => ({
      component,
      status: frame.privacy.capabilities[component] === "unavailable" ? "unavailable" : "degraded",
      message: detail.detail,
    }),
  );
  const freshness = frame.quality?.overall_freshness;
  const status: ContextProviderHealth["status"] =
    freshness === "empty"
      ? "initializing"
      : freshness === "stale" || diagnostics.length > 0
        ? "degraded"
        : "healthy";

  return {
    status,
    source: "local",
    checked_at: frame.generated_at,
    diagnostics,
  };
}

/**
 * Compatibility adapter for the in-process daemon and deterministic tests.
 * The MCP layer consumes only ContextProvider; broker clients return the same
 * contract without mirroring observations into another StateStore.
 */
export function createLocalContextProvider(
  store: StateStore,
  getPrivacy: () => Privacy,
  options: LocalContextProviderOptions = {},
): ContextProvider {
  return {
    async getContext(request: ContextRequest = {}): Promise<ContextResult> {
      const domains = uniqueDomains(request.domains);
      const refresh = request.refresh ?? "cached";
      let refreshedDomains: Domain[] = [];

      if (refresh !== "cached" && options.refreshDomains) {
        const refreshed = await options.refreshDomains(
          domains ?? ALL_DOMAINS,
          refresh,
          request.max_staleness_ms,
        );
        refreshedDomains = uniqueDomains(refreshed ?? domains ?? ALL_DOMAINS) ?? [];
      }

      const privacy = getPrivacy();
      enforcePrivacyRevocations(store, privacy);
      const frame = buildFrame(store, domains, options.now?.() ?? Date.now(), privacy);
      return {
        frame,
        health: localHealth(frame),
        refreshed_domains: refreshedDomains,
      };
    },
  };
}

export function isContextProvider(value: ContextProvider | StateStore): value is ContextProvider {
  return typeof (value as Partial<ContextProvider>).getContext === "function";
}
