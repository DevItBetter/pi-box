import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Credential, Provider } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG, type PiboxConfig } from "./config.ts";
import { hostAllowed } from "./sandbox/egress-proxy.ts";
import { parseLocalEndpoints } from "./sandbox/local-relay.ts";

const AUTH_HOSTS: Record<string, string[]> = {
  anthropic: ["claude.ai", "platform.claude.com"],
  openai: ["auth.openai.com"],
  "openai-codex": ["auth.openai.com"],
  "github-copilot": ["github.com", "api.github.com"],
  xai: ["auth.x.ai"],
  meta: ["auth.meta.com"],
  "kimi-coding": ["auth.kimi.com"],
};

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
  return value as RecordValue;
}

function readObject(path: string, followLink = false): RecordValue {
  if (!existsSync(path)) return {};
  if (!(followLink ? statSync(path) : lstatSync(path)).isFile()) throw new Error(`expected a regular file at ${path}`);
  try { return record(JSON.parse(readFileSync(path, "utf8"))); }
  catch { throw new Error(`invalid JSON object in ${path}`); }
}

/** Match syncAgent's newer-file rule without changing either Pi directory. */
function effectiveFile(source: string, guest: string, name: string): string {
  const from = join(source, name); const to = join(guest, name);
  for (const path of [source, guest]) {
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new Error(`expected a regular directory at ${path}`);
  }
  for (const path of [from, to]) {
    if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`expected a regular file at ${path}`);
  }
  return existsSync(to) && (!existsSync(from) || lstatSync(to).mtimeMs >= lstatSync(from).mtimeMs) ? to : from;
}

/** Store exact public HTTPS hosts or explicitly configured loopback origins. */
export function endpointForUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("endpoint URL is invalid or contains unresolved placeholders"); }
  if (url.username || url.password || /[{}$%]/.test(url.hostname)) throw new Error("endpoint URL contains credentials or unresolved placeholders");
  if (["localhost", "127.0.0.1"].includes(url.hostname)) {
    parseLocalEndpoints([url.origin]);
    return url.origin;
  }
  if (url.protocol !== "https:" || url.port || isIP(url.hostname) || !url.hostname.includes(".") || !/^[a-z0-9.-]+$/.test(url.hostname)) {
    throw new Error("remote endpoint needs an HTTPS hostname on port 443; LAN and IP endpoints are unsupported");
  }
  return url.hostname;
}

export interface ProviderFinding {
  id: string;
  auth: string;
  endpoints: string[];
  issues: string[];
}
export interface SetupReport { defaultProvider: string; providers: ProviderFinding[]; }

async function inspectProvider(id: string, provider: Provider | undefined, custom: RecordValue | undefined, stored: unknown, env: NodeJS.ProcessEnv): Promise<ProviderFinding> {
  const finding: ProviderFinding = { id, auth: "missing", endpoints: [], issues: [] };
  const credential = stored === undefined ? undefined : record(stored) as unknown as Credential;
  const urls: string[] = [];
  if (custom?.baseUrl !== undefined) {
    if (typeof custom.baseUrl !== "string") throw new Error(`baseUrl for ${id} must be a string`);
    urls.push(custom.baseUrl);
  } else if (provider?.baseUrl) urls.push(provider.baseUrl);
  else if (provider) urls.push(...provider.getModels().map((m) => m.baseUrl).filter(Boolean));
  if (Array.isArray(custom?.models)) {
    for (const model of custom.models) {
      const baseUrl = record(model).baseUrl;
      if (typeof baseUrl === "string") urls.push(baseUrl);
    }
  }

  if (credential?.type === "oauth") {
    if (!provider?.auth.oauth) finding.issues.push("OAuth integration is unknown; check the provider extension manually");
    else if (!credential.access || !credential.refresh || !Number.isFinite(credential.expires)) finding.issues.push("OAuth credentials are incomplete; run /login in Pi");
    else {
      finding.auth = "stored OAuth";
      if (credential.expires <= Date.now()) finding.auth += "; token expired, Pi must refresh it";
      try {
        const auth = await provider.auth.oauth.toAuth(credential);
        if (auth.baseUrl && !custom?.baseUrl) { urls.length = 0; urls.push(auth.baseUrl); }
      } catch { finding.issues.push("could not derive the OAuth API endpoint; run /login in Pi"); }
      if (id === "github-copilot" && typeof credential.enterpriseUrl === "string" && credential.enterpriseUrl) {
        try {
          const domain = endpointForUrl(`https://${credential.enterpriseUrl}`);
          urls.push(`https://${domain}`, `https://api.${domain}`);
        } catch { finding.issues.push("Copilot enterprise domain is invalid"); }
      }
    }
  } else if (custom?.apiKey !== undefined) {
    const key = custom.apiKey;
    if (typeof key !== "string" || !key) finding.issues.push("models.json API key is empty or invalid");
    else if (key.startsWith("!")) finding.issues.push("models.json API-key command was not executed; verify it works inside the sandbox");
    else if (env[key]) finding.issues.push("models.json API key references a host environment variable absent from the sandbox; configure a sandbox-accessible key in Pi");
    else finding.auth = "models.json API key";
  } else if (provider?.auth.apiKey) {
    const resolveAuth = (environment: NodeJS.ProcessEnv) => provider.auth.apiKey!.resolve({
      ctx: { env: async (name) => environment[name], fileExists: async () => false },
      ...(credential?.type === "api_key" ? { credential } : {}), signal: AbortSignal.timeout(3000),
    });
    try {
      if (await resolveAuth({})) finding.auth = "stored API-key configuration";
      else if (await resolveAuth(env)) finding.issues.push("authentication uses the host environment, which is absent from the sandbox; use /login in pibox");
    } catch { finding.issues.push("could not check API-key configuration"); }
  }
  if (finding.auth === "missing" && !finding.issues.length) finding.issues.push("authentication missing; run /login in Pi or configure an API key in models.json");
  if (!provider && !custom) finding.issues.push("provider metadata is unavailable; configure providerEndpoints manually for this extension");
  for (const url of new Set(urls)) {
    try { finding.endpoints.push(endpointForUrl(url)); }
    catch (error) { finding.issues.push((error as Error).message); }
  }
  if (provider?.auth.oauth) finding.endpoints.push(...AUTH_HOSTS[id] ?? []);
  finding.endpoints = [...new Set(finding.endpoints)];
  if (!urls.length) finding.issues.push("API endpoint is unknown; set a concrete baseUrl in Pi models.json or configure providerEndpoints manually");
  return finding;
}

export async function discoverProviders(source: string, guest: string, config: PiboxConfig, selected?: string, env = process.env): Promise<SetupReport> {
  const settings = readObject(join(source, "settings.json"), true);
  const auth = readObject(effectiveFile(source, guest, "auth.json"));
  const models = readObject(effectiveFile(source, guest, "models.json"));
  const custom = models.providers === undefined ? {} : record(models.providers);
  const providers = new Map(builtinProviders().map((p) => [p.id, p]));
  const defaultProvider = selected ?? String(settings.defaultProvider ?? config.defaultProvider);
  const ids = new Set([defaultProvider, ...Object.keys(auth), ...Object.keys(custom)]);
  // Resolve only builtin configuration checks, never user-supplied key commands or extensions.
  for (const provider of providers.values()) {
    if (ids.has(provider.id) || !provider.auth.apiKey) continue;
    try {
      const available = await provider.auth.apiKey.resolve({ ctx: { env: async (name) => env[name], fileExists: async () => false }, signal: AbortSignal.timeout(3000) });
      if (available) ids.add(provider.id);
    } catch { /* Unconfigured builtin providers need no diagnosis. */ }
  }
  return { defaultProvider, providers: await Promise.all([...ids].sort().map((id) => inspectProvider(id, providers.get(id), custom[id] === undefined ? undefined : record(custom[id]), auth[id], env))) };
}

export function missingEndpoints(config: PiboxConfig, finding: ProviderFinding): string[] {
  const existing = Object.hasOwn(config.providerEndpoints, finding.id) ? config.providerEndpoints[finding.id]! : [];
  return finding.endpoints.filter((endpoint) => endpoint.includes("://") ? !existing.includes(endpoint) : !hostAllowed(endpoint, existing));
}

export async function runSetup(command: "setup" | "doctor", configPath: string, source: string, guest: string, selected?: string): Promise<number> {
  const exists = existsSync(configPath);
  const config = (exists ? readObject(configPath) : structuredClone(DEFAULT_CONFIG)) as unknown as PiboxConfig;
  config.defaultProvider ??= DEFAULT_CONFIG.defaultProvider;
  config.providerEndpoints ??= {};
  record(config.providerEndpoints);
  for (const entries of Object.values(config.providerEndpoints)) {
    if (!Array.isArray(entries) || entries.some((e) => typeof e !== "string")) throw new Error("providerEndpoints must map provider IDs to arrays of endpoint strings");
  }
  const report = await discoverProviders(source, guest, config, selected);
  let changed = !exists;
  if (command === "setup") {
    for (const finding of report.providers) {
      const missing = missingEndpoints(config, finding);
      if (missing.length) {
        const existing = Object.hasOwn(config.providerEndpoints, finding.id) ? config.providerEndpoints[finding.id]! : [];
        Object.defineProperty(config.providerEndpoints, finding.id, { value: [...existing, ...missing], enumerable: true, configurable: true, writable: true });
        changed = true;
      }
    }
    if (config.defaultProvider !== report.defaultProvider) { config.defaultProvider = report.defaultProvider; changed = true; }
    if (changed) {
      mkdirSync(dirname(configPath), { recursive: true });
      const temporary = `${configPath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      try {
        renameSync(temporary, configPath);
      } finally { rmSync(temporary, { force: true }); }
    }
    console.log(`pibox: ${changed ? "updated" : "no changes to"} ${configPath}`);
  } else console.log(`pibox: checking ${configPath}${exists ? "" : "; missing, run pibox setup"}`);
  console.log(`Pi configuration: ${source}; sandbox state: ${guest}`);
  console.log(`Default provider: ${report.defaultProvider}`);
  let issues = command === "doctor" && !exists ? 1 : 0;
  for (const finding of report.providers) {
    const missing = missingEndpoints(config, finding);
    const problems = [...finding.issues];
    if (missing.length) problems.push(`egress endpoints missing: ${missing.join(", ")}; run pibox setup`);
    if (!(config.providerEndpoints[finding.id]?.length)) problems.push("no egress endpoints configured");
    issues += problems.length;
    console.log(`${problems.length ? "NEEDS ATTENTION" : "OK"} ${finding.id}: ${finding.auth}`);
    console.log(`  endpoints: ${(config.providerEndpoints[finding.id] ?? []).join(", ") || "none"}`);
    for (const problem of problems) console.log(`  ${problem}`);
  }
  console.log("Authentication checks are offline; token validity and provider connectivity were not tested.");
  if (issues) console.log("For sign-in, launch pibox --provider NAME and use /login, then rerun pibox setup.");
  return issues ? 1 : 0;
}
