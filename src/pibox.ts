import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { launchResources, sandboxCommand, validateWorkspace, type AgentLaunchSettings } from "./launch.ts";
import { sandboxTool } from "./sandbox/bwrap.ts";
import { runPiBox } from "./index.ts";
import { packageSource, type PackageSpec } from "./state.ts";
import { pickItems, type PickerItem } from "./picker.ts";

import { DEFAULT_CONFIG, localProviderEndpoints, profileDescription, profileLabel, profileMembers, providerForArgs, restrictedHosts, type PiboxConfig, type SelectionProfiles } from "./config.ts";

interface PiboxState { endpoints: string[]; agent: string[]; }

const piAgentDir = join(homedir(), ".pi", "agent");
const piboxHome = process.env["PIBOX_HOME"] ?? join(homedir(), ".pibox");
const piboxAgentDir = join(piboxHome, "agent");
let configPath = join(piboxHome, "config.json");
const statePath = join(piboxHome, "state.json");

function fail(msg: string): never {
  console.error(`pibox: ${msg}`);
  process.exit(2);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    fail(`invalid JSON in ${path}: ${String(err)}`);
  }
}

// ---- args ------------------------------------------------------------------

let workspace = process.cwd();
let runShell = false;
let sync = true;
let printPlan = false;
let jsonPlan = false;
let noTui = false;
let saveDefaults = false;
let readOnly = false;
let networkMode: "restricted" | "unrestricted" | "none" = "restricted";
let egressProfile: string | undefined;
let agentBare = false;
let agentProfile: string | undefined;
let maintenance: "setup" | "doctor" | undefined;
let listProfiles = false;
const extraAllow: string[] = [];
if (process.env["PIBOX_ALLOW"] !== undefined && process.env["PIBOX_ALLOW"] !== "") {
  extraAllow.push(...process.env["PIBOX_ALLOW"].split(",").map((h) => h.trim()));
}
const piArgs: string[] = [];

const argv = process.argv.slice(2);
// bin/pibox prepends -C; recognize subcommands there as well as direct invocation.
const commandIndex = argv[0] === "-C" ? 2 : 0;
if (argv[commandIndex] === "setup" || argv[commandIndex] === "doctor") {
  maintenance = argv.splice(commandIndex, 1)[0] as "setup" | "doctor";
} else if (argv[commandIndex] === "profiles") {
  listProfiles = true;
  argv.splice(commandIndex, 1);
}
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  switch (arg) {
    case "--config":
      configPath = resolve(argv[++i] ?? fail("--config needs a file"));
      break;
    case "--network": {
      const mode = argv[++i];
      if (mode !== "restricted" && mode !== "unrestricted" && mode !== "none") fail("--network needs restricted, unrestricted, or none");
      networkMode = mode;
      break;
    }
    case "--read-only":
      readOnly = true;
      break;
    case "--":
      piArgs.push(...argv.slice(i + 1));
      i = argv.length;
      break;
    case "--shell":
      runShell = true;
      break;
    case "--no-sync":
      sync = false;
      break;
    case "--print-plan":
      printPlan = true;
      break;
    case "--print-plan=json":
      printPlan = true;
      jsonPlan = true;
      noTui = true;
      break;
    case "--no-tui":
      noTui = true;
      break;
    case "--save-defaults":
      saveDefaults = true;
      break;
    case "--none":
    case "--provider-only":
    case "--allow-only":
      fail(`${arg} is not supported; use --network restricted|unrestricted|none and --allow HOST`);
      break;
    case "--bare":
      agentBare = true;
      break;
    case "--profile":
      egressProfile = argv[++i] ?? fail("--profile needs a name");
      break;
    case "--agent-profile":
      agentProfile = argv[++i] ?? fail("--agent-profile needs a name");
      break;
    case "-C":
      workspace = resolve(argv[++i] ?? fail("-C needs a directory"));
      break;
    case "--allow":
      extraAllow.push(argv[++i] ?? fail("--allow needs a hostname"));
      break;
    case "-h":
    case "--help":
      console.log(
        "usage: pibox [--shell] [--no-sync] [-C dir] [--allow HOST]...\n" +
          "             [--network MODE] [--profile NAME] [--bare | --agent-profile NAME]\n" +
           "             [--print-plan] [pi args...]\n\n" +
            "       pibox setup|doctor [--config FILE] [--provider NAME]\n" +
            "       pibox profiles [--config FILE]\n" +
           "  setup           Discover Pi providers and add their egress endpoints.\n" +
           "  doctor          Check provider authentication and egress config without writing.\n\n" +
          "Personal pi agent inside bubblewrap. Workspace = cwd (or -C dir).\n" +
          "  --network MODE  restricted (default): enforce the allowed-host list.\n" +
          "                  unrestricted: host network, no endpoint restrictions.\n" +
          "                  none: no network, including provider services.\n" +
           "  --config FILE   Endpoint catalog and provider-specific host sets.\n" +
           "  --no-tui        Use remembered selections without prompting.\n" +
           "  --save-defaults Save selected endpoints and capabilities as defaults, then exit.\n" +
           "  --print-plan[=json] Show the resolved launch configuration without launching.\n" +
          "  --provider NAME Select the LLM integration; its endpoint set applies in restricted mode.\n" +
          "                  Config entries may include explicit loopback URLs for local models.\n" +
          "Extra endpoints and agent capabilities are picked in a TUI at launch\n" +
          "(catalog: ~/.pibox/config.json; last selection remembered; all off by\n" +
          "default). These options control different selections:\n" +
          "  --allow HOST     Add a host in restricted mode; repeat for more.\n" +
          "  --bare  Disable optional pi packages/extensions; skip the capability picker.\n" +
          "          Builtin pi tools remain available. This option does not change network access.\n" +
          "Provider endpoints + selected extras + --allow form the restricted allowlist.\n" +
          "Endpoint options have no effect in unrestricted or none mode.\n" +
          "--profile selects extra endpoints and skips their picker; an empty profile permits only the provider.\n" +
          "--agent-profile selects capabilities. --no-sync also skips\n" +
          "re-applying the agent selection to the synced config copy.\n" +
          "Env: PIBOX_MEMORY (4G), PIBOX_CPU_QUOTA (300%), PIBOX_HOME (~/.pibox), PIBOX_ALLOW (csv).\n" +
          "Everything unrecognized is passed to pi. See README.md. Use --read-only for a read-only workspace; -- separates pi arguments.",
      );
      process.exit(0);
      break;
    default:
      piArgs.push(arg);
  }
}

if (maintenance) {
  const { runSetup } = await import("./setup.ts");
  const selected = providerForArgs(piArgs, "", {});
  try { process.exitCode = await runSetup(maintenance, configPath, piAgentDir, piboxAgentDir, selected || undefined); }
  catch (error) { fail((error as Error).message); }
  process.exit(process.exitCode ?? 0);
}

if (!listProfiles) workspace = validateWorkspace(workspace);
// ---- catalogs --------------------------------------------------------------

mkdirSync(piboxHome, { recursive: true });
if (!existsSync(configPath)) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  console.error(`pibox: created endpoint/provider catalog at ${configPath}.`);
}
const config = readJson<PiboxConfig>(configPath)!;
config.defaultProvider ??= DEFAULT_CONFIG.defaultProvider;
config.providerEndpoints ??= DEFAULT_CONFIG.providerEndpoints;
config.endpoints ??= {};
config.endpointProfiles ??= {};
config.agentProfiles ??= {};
if (listProfiles) {
  for (const [title, entries] of [
    ["Endpoint groups", config.endpoints],
    ["Endpoint profiles", config.endpointProfiles],
    ["Capability profiles", config.agentProfiles],
  ] as const) {
    console.log(`${title}:`);
    for (const [name, profile] of Object.entries(entries)) {
      const label = profileLabel(name, profile);
      const description = profileDescription(profile);
      console.log(`  ${name}${label === name ? "" : ` [${label}]`}: ${profileMembers(profile).join(", ") || "(empty)"}${description ? ` — ${description}` : ""}`);
    }
    if (!Object.keys(entries).length) console.log("  (none)");
  }
  process.exit(0);
}
const state: PiboxState = { endpoints: [], agent: [], ...config.defaultSelections, ...readJson<Partial<PiboxState>>(statePath) };

// Agent capability catalog, discovered from the HOST's pi config: packages
// from settings.json (key = last path segment), extensions from extensions/.
interface PiSettings {
  packages?: PackageSpec[];
  [k: string]: unknown;
}
const hostSettings = readJson<PiSettings>(join(piAgentDir, "settings.json")) ?? {};
const pkgItems: { key: string; spec: PackageSpec }[] = (hostSettings.packages ?? []).map((spec) => ({
  key: `pkg:${packageSource(spec).split("/").pop()!.replace(/^npm:/, "")}`,
  spec,
}));
const hostExtDir = join(piAgentDir, "extensions");
const extItems: { key: string; file: string }[] = existsSync(hostExtDir)
  ? readdirSync(hostExtDir)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
      .sort()
      .map((file) => ({ key: `ext:${file.replace(/\.(ts|js)$/, "")}`, file }))
  : [];
const agentItems: PickerItem[] = [
  ...pkgItems.map((p) => ({ key: p.key, detail: `package ${packageSource(p.spec)}` })),
  ...extItems.map((e) => ({ key: e.key, detail: `extension ~/.pi/agent/extensions/${e.file}` })),
];

// ---- selection resolution --------------------------------------------------

function fromProfile(name: string, profiles: SelectionProfiles, what: string): Set<string> {
  const profile = profiles[name];
  if (profile === undefined) fail(`unknown ${what} profile "${name}" (defined in ${configPath})`);
  return new Set(profileMembers(profile));
}

async function resolveSelection(
  none: boolean,
  profile: string | undefined,
  profiles: SelectionProfiles,
  items: PickerItem[],
  last: string[],
  title: string,
  noneLabel: string,
  what: string,
): Promise<Set<string>> {
  if (none) return new Set();
  if (profile !== undefined) return fromProfile(profile, profiles, what);
  const remembered = new Set(last.filter((k) => items.some((i) => i.key === k)));
   if (noTui || !process.stdin.isTTY) return remembered;
  const picked = await pickItems({ title, noneLabel, items, profiles, emptyLabel: what === "endpoint" ? "provider only" : "bare" }, remembered);
  if (picked === null) {
    console.error("pibox: aborted");
    process.exit(130);
  }
  return picked;
}

const endpointItems: PickerItem[] = Object.entries(config.endpoints).map(([key, hosts]) => ({
  key,
  detail: hosts.join(", "),
}));
const provider = providerForArgs(piArgs, String(hostSettings.defaultProvider ?? config.defaultProvider), config.providerEndpoints);
const egressSel = networkMode === "restricted" ? await resolveSelection(
  false,
  egressProfile,
  config.endpointProfiles,
  endpointItems,
  state.endpoints,
  `pibox egress: ${provider} endpoints plus selected extras.`,
  "provider endpoints only: clear extras",
  "endpoint",
) : new Set<string>();
const agentSel = await resolveSelection(
  agentBare,
  agentProfile,
  config.agentProfiles,
  agentItems,
  state.agent,
  "pibox agent: pi packages/extensions to enable; extras default off.",
  "bare pi: clear all selections",
  "agent",
);

const allow = networkMode === "restricted" ? restrictedHosts(config, provider, [...egressSel], extraAllow) : [];
const localEndpoints = networkMode === "restricted" ? localProviderEndpoints(config, provider) : [];

if (saveDefaults) {
  if (printPlan) fail("--save-defaults cannot be combined with --print-plan");
  config.defaultSelections = { endpoints: networkMode === "restricted" ? [...egressSel] : state.endpoints, agent: [...agentSel] };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.error(`pibox: saved default selections to ${configPath}`);
  process.exit(0);
}

const planLines = [
  `network = ${networkMode}; egress = ${networkMode !== "restricted" ? "endpoint sets inactive" : `${provider} endpoints`}${egressSel.size > 0 ? ` + ${[...egressSel].join(", ")}` : ""}${networkMode === "restricted" && extraAllow.length > 0 ? ` + --allow ${extraAllow.join(", ")}` : ""}`,
  `agent  = ${agentSel.size > 0 ? [...agentSel].join(", ") : "bare pi"}`,
];
if (!jsonPlan) for (const l of planLines) console.error(`pibox: ${l}`);

if (printPlan) {
  const packages = pkgItems.filter((p) => agentSel.has(p.key)).map((p) => p.spec);
  const settings: AgentLaunchSettings = sync ? { ...hostSettings, packages } : readJson<AgentLaunchSettings>(join(piboxAgentDir, "settings.json")) ?? {};
  const extensionDir = join(piboxAgentDir, "extensions");
  const extensions = sync ? extItems.filter((e) => agentSel.has(e.key)).map((e) => e.file)
    : existsSync(extensionDir) ? readdirSync(extensionDir).filter((file) => /\.(ts|js)$/.test(file)) : [];
  const node = sandboxTool(realpathSync(process.execPath), "/opt/node", "Node.js").guestPath;
  const plan = {
    version: 1,
    workspace: { host: workspace, guest: "/workspace", access: readOnly ? "read-only" : "read-write" },
    network: { mode: networkMode, provider, hosts: allow, localEndpoints },
    stateDir: piboxAgentDir, configPath, sync,
    selections: { endpoints: [...egressSel], agent: [...agentSel] },
    agent: { packages: settings.packages ?? [], extensions: extensions.map((file) => `/home/sandbox/.pi/agent/extensions/${file}`), builtinExtensions: ["/opt/pibox/status-extension.ts"] },
    command: sandboxCommand(node, settings, extensions, runShell, piArgs),
    resources: launchResources(),
    diskQuotaRoot: process.env["PIBOX_DISK_QUOTA_ROOT"] ?? null,
  };
  if (jsonPlan) {
    console.log(JSON.stringify(plan, null, 2));
    process.exit(0);
  }
  console.error(`pibox: workspace = ${workspace} at /workspace (${readOnly ? "read-only" : "read-write"})`);
  console.error(`pibox: hosts = ${networkMode === "restricted" ? allow.length ? allow.join(", ") : "(none)" : "(endpoint rules inactive)"}`);
  if (localEndpoints.length) console.error(`pibox: local provider endpoints = ${localEndpoints.join(", ")}`);
  console.error(`pibox: state = ${piboxAgentDir}; sync = ${sync}`);
  console.error(`pibox: packages = ${JSON.stringify(plan.agent.packages)}`);
  console.error(`pibox: extensions = ${[...plan.agent.builtinExtensions, ...plan.agent.extensions].join(", ")}`);
  console.error(`pibox: command = ${JSON.stringify(plan.command)}`);
  console.error(`pibox: resources = ${JSON.stringify(plan.resources)}; disk quota root = ${plan.diskQuotaRoot ?? "none"}`);
  process.exit(0);
}

writeFileSync(statePath, `${JSON.stringify({ endpoints: networkMode === "restricted" ? [...egressSel] : state.endpoints, agent: [...agentSel] }, null, 2)}\n`);
process.exitCode = await runPiBox({
  workspace, stateDir: piboxAgentDir, readOnly, allow, localEndpoints, runShell, piArgs, networkMode, provider,
  ...(sync ? { sync: {
    source: piAgentDir, settings: { ...hostSettings, defaultProvider: provider },
    packages: pkgItems.filter((p) => agentSel.has(p.key)).map((p) => p.spec),
    extensions: extItems.filter((e) => agentSel.has(e.key)).map((e) => e.file),
  } } : {}),
});
