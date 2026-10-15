import { parseLocalEndpoints } from "./sandbox/local-relay.ts";

export type SelectionProfile = string[] | { members: string[]; label?: string; description?: string };
export type SelectionProfiles = Record<string, SelectionProfile>;

export function profileMembers(profile: SelectionProfile): string[] {
  return Array.isArray(profile) ? profile : profile.members;
}

export function profileLabel(name: string, profile: SelectionProfile): string {
  return Array.isArray(profile) ? name : profile.label ?? name;
}

export function profileDescription(profile: SelectionProfile): string {
  return Array.isArray(profile) ? "" : profile.description ?? "";
}

export interface PiboxConfig {
  defaultProvider: string;
  providerEndpoints: Record<string, string[]>;
  endpoints: Record<string, string[]>;
  endpointProfiles: SelectionProfiles;
  agentProfiles: SelectionProfiles;
  defaultSelections?: { endpoints?: string[]; agent?: string[] };
}

export const DEFAULT_CONFIG: PiboxConfig = {
  defaultProvider: "openai",
  providerEndpoints: {
    openai: ["api.openai.com", "auth.openai.com"],
    "openai-codex": ["chatgpt.com", "auth.openai.com", "api.openai.com"],
    openrouter: ["openrouter.ai"],
    anthropic: ["api.anthropic.com"],
    google: ["generativelanguage.googleapis.com"],
  },
  endpoints: {
    npm: ["registry.npmjs.org"],
    github: ["github.com", "api.github.com", "codeload.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com"],
    pypi: ["pypi.org", "files.pythonhosted.org"],
    exa: ["api.exa.ai"],
    tavily: ["api.tavily.com"],
  },
  endpointProfiles: { "node-dev": ["npm", "github"] },
  agentProfiles: { research: ["pkg:pi-web-access", "pkg:pi-lens"] },
};

/** An explicit integration wins over a model ID's vendor namespace. */
export function providerForArgs(args: string[], fallback: string, providers: Record<string, string[]>): string {
  let explicit: string | undefined;
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg === "--provider") explicit = args[++i];
    else if (arg.startsWith("--provider=")) explicit = arg.slice("--provider=".length);
    else if (arg === "--model" || arg === "-m") model = args[++i];
    else if (arg.startsWith("--model=")) model = arg.slice("--model=".length);
  }
  if (explicit) return explicit;
  const prefix = model?.includes("/") ? model.split("/")[0] : undefined;
  return prefix && Object.hasOwn(providers, prefix) ? prefix : fallback;
}

/** The restricted allowlist is provider hosts plus selected extras and explicit additions. */
export function restrictedHosts(config: PiboxConfig, provider: string, extras: string[], explicit: string[]): string[] {
  if (!Object.hasOwn(config.providerEndpoints, provider)) {
    throw new Error(`no endpoint set for provider ${provider}; run pibox setup or add it to providerEndpoints in config.json`);
  }
  return [...new Set([...config.providerEndpoints[provider]!.filter((entry) => !entry.includes("://")), ...extras.flatMap((key) => config.endpoints[key] ?? []), ...explicit])];
}

/** Local access must be authorized by the selected provider, never an extra host. */
export function localProviderEndpoints(config: PiboxConfig, provider: string): string[] {
  const origins = (config.providerEndpoints[provider] ?? []).filter((entry) => entry.includes("://"));
  parseLocalEndpoints(origins);
  return origins;
}
