import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { launchResources, sandboxCommand, validateWorkspace, type AgentLaunchSettings } from "./launch.ts";
import { sandboxTool } from "./sandbox/bwrap.ts";
import { runPiBox } from "./index.ts";
import { instanceHome, packageSource, writeJsonAtomic, type PackageSpec } from "./state.ts";
import { pickItems, type PickerItem } from "./picker.ts";

import { DEFAULT_CONFIG, localProviderEndpoints, profileDescription, profileLabel, profileMembers, providerForArgs, restrictedHosts, type PiboxConfig, type SelectionProfiles } from "./config.ts";

interface PiboxState { endpoints: string[]; agent: string[]; }

const piAgentDir = join(homedir(), ".pi", "agent");
const piboxHome = process.env["PIBOX_HOME"] ?? join(homedir(), ".pibox");
let piboxAgentDir = join(piboxHome, "agent");
let instance: string | undefined;
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
const egressProfiles: string[] = [];
let agentBare = false;
const agentProfiles: string[] = [];
let maintenance: "setup" | "doctor" | undefined;
let listProfiles = false;
let execMode = false;
let command: string[] | undefined;
let showStatus = false;
let jsonStatus = false;
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
} else if (argv[commandIndex] === "exec") {
  execMode = true;
  noTui = true;
  sync = false;
  argv.splice(commandIndex, 1);
} else if (argv[commandIndex] === "status") {
  showStatus = true;
  argv.splice(commandIndex, 1);
}
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  switch (arg) {
    case "--instance":
      instance = argv[++i] ?? fail("--instance needs a name");
      try { piboxAgentDir = join(instanceHome(piboxHome, instance), "agent"); }
      catch (error) { fail((error as Error).message); }
      break;
    case "--config":
      configPath = resolve(argv[++i] ?? fail("--config needs a file"));
      break;
    case "--json":
      if (!showStatus) fail("--json is only supported by status; use --print-plan=json for previews");
      jsonStatus = true;
      break;
    case "--provider":
      piArgs.push(arg, argv[++i] ?? fail("--provider needs a name"));
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
      if (execMode) command = argv.slice(i + 1);
      else piArgs.push(...argv.slice(i + 1));
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
      egressProfiles.push(argv[++i] ?? fail("--profile needs a name"));
      break;
    case "--agent-profile":
      agentProfiles.push(argv[++i] ?? fail("--agent-profile needs a name"));
      break;
    case "-C":
      workspace = resolve(argv[++i] ?? fail("-C needs a directory"));
      break;
    case "--allow":
      extraAllow.push(argv[++i] ?? fail("--allow needs a hostname"));
      break;
    case "-h":
    case "--help":
      console.log(`Run Pi inside a Linux bubblewrap sandbox.

Usage:
  pibox [options] [pi args...]
  pibox exec [options] -- COMMAND [ARG...]
  pibox setup|doctor [--config FILE] [--provider NAME] [--instance NAME]
  pibox profiles [--config FILE]
  pibox status [--json] [--instance NAME]

Workspace and state:
  -C DIR             Mount DIR at /workspace. Default: current directory.
  --read-only        Block workspace writes. Other writers' changes stay visible.
  --shell            Start bash instead of Pi.
  --instance NAME    Reuse separate Pi state and cache. An occupied name fails.
                     Use default for the original ~/.pibox/agent state.
  --no-sync          Reuse the chosen slot's config without copying host Pi files.

Without --instance, pibox uses the first free persistent state slot.
Instances can share a workspace, with separate credentials, sessions, and locks.
New slots copy host Pi config on synced launches; --no-sync leaves them empty.

Network:
  --network MODE     restricted: provider endpoints plus selected extras. Default.
                     unrestricted: host network, without endpoint restrictions.
                     none: no network, including provider connections.
  --provider NAME    Choose the provider and its endpoint set.
  --allow HOST       Add a public HTTPS host. Repeat to add more.
  --profile NAME     Select extra endpoint groups and skip their picker.
  --config FILE      Read endpoint rules and profiles from FILE.

Endpoint options apply only in restricted mode. An empty endpoint profile
allows only provider endpoints. Local models need explicit loopback config.

Selections and previews:
  --agent-profile NAME  Select packages/extensions and skip their picker.
  --bare                Disable optional packages/extensions; keep built-in tools.
  --no-tui              Use remembered selections without prompts.
  --save-defaults       Save selections to config and exit. Incompatible with previews.
  --print-plan         Show launch details without syncing or launching.
  --print-plan=json    Write JSON to stdout and skip prompts.
  -h, --help           Show this help. Use -- --help for Pi's own help.

Repeat either profile flag to combine members. --bare overrides agent profiles.
Defaults apply when remembered selections are absent; empty selections stay empty.
Automatic previews describe default state; pibox chooses the free slot at launch.
Inside Pi, use /pibox to inspect the settings shown in its footer.

Commands:
  exec      Run a command at /workspace; preserve arguments and exit status.
            Skip prompts and sync; leave remembered selections unchanged.
            Shell syntax needs an explicit /bin/bash -c command.
            Rejects --shell, --bare, --agent-profile, and --save-defaults.
  setup     Discover provider endpoints and add them to config.
  doctor    Check auth and endpoint config without writing or network requests.
            Both inspect --instance NAME, or default state if omitted.
  profiles  List endpoint groups and endpoint/capability profiles.
  status    List slots and resource use. --instance filters; --json writes JSON.
            Never remove locks or stop processes.

Environment:
  PIBOX_HOME              Config and state root. Default: ~/.pibox.
  PIBOX_ALLOW             Extra public HTTPS hosts, comma-separated.
  PIBOX_MEMORY            Memory limit per instance. Default: 4G.
  PIBOX_CPU_QUOTA         CPU quota per instance. Default: 300%.
  PIBOX_FILE_MAX          Maximum file size. Default: 4G.
  PIBOX_CACHE_MAX         Monitored cache limit per instance. Default: 4G.
  PIBOX_WRITE_GROWTH_MAX  Monitored write growth per instance. Default: 8G.
  PIBOX_DISK_QUOTA_ROOT   Optional btrfs subvolume with a hard quota.

Examples, from the same project in separate terminals:
  pibox --instance writer
  pibox --instance reviewer --read-only
  pibox status --json
  pibox exec --network none -- /bin/bash -c 'pwd && ls'

Unknown launch arguments go to Pi. Use -- to pass Pi arguments unchanged.
See README.md for profile formats, authentication, state paths, and limits.`);
      process.exit(0);
      break;
    default:
      if (showStatus) fail(`unknown status option ${arg}`);
      if (execMode) fail(`unknown exec option ${arg}; put the command after --`);
      piArgs.push(arg);
  }
}

if (showStatus) {
  const { inspectInstances } = await import("./session.ts");
  const report = inspectInstances(piboxHome, instance);
  if (jsonStatus) console.log(JSON.stringify(report, null, 2));
  else for (const status of report.sessions) {
    console.log(`pibox ${status.instance}: ${status.state}`);
    if (status.session) {
      console.log(`scope: ${status.session.scope}`);
      console.log(`workspace: ${status.session.workspace} (${status.session.access})`);
      console.log(`started: ${status.session.startedAt}; kind: ${status.session.kind}; network: ${status.session.network}`);
    }
    if (status.resources) for (const [key, value] of Object.entries(status.resources)) console.log(`${key}: ${value}`);
    if ("detail" in status) console.log(status.detail);
  }
  process.exit(0);
}

if (execMode) {
  if (!command?.length || !command[0]) fail("exec needs a command after --");
  if (runShell || saveDefaults || agentProfiles.length || agentBare) fail("exec cannot be combined with --shell, --save-defaults, --bare, or --agent-profile");
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
  requestedProfiles: string[],
  profiles: SelectionProfiles,
  items: PickerItem[],
  last: string[],
  title: string,
  noneLabel: string,
  what: string,
): Promise<Set<string>> {
  if (none) return new Set();
  if (requestedProfiles.length) return new Set(requestedProfiles.flatMap((name) => [...fromProfile(name, profiles, what)]));
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
  egressProfiles,
  config.endpointProfiles,
  endpointItems,
  state.endpoints,
  `pibox egress: ${provider} endpoints plus selected extras.`,
  "provider endpoints only: clear extras",
  "endpoint",
) : new Set<string>();
const agentSel = await resolveSelection(
  agentBare || execMode,
  agentProfiles,
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
  writeJsonAtomic(configPath, config);
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
    stateDir: piboxAgentDir, instance: instance ?? "auto", stateAllocation: instance ? "named" : "first-free-at-launch", configPath, sync,
    selections: { endpoints: [...egressSel], agent: [...agentSel] },
    agent: { packages: settings.packages ?? [], extensions: extensions.map((file) => `/home/sandbox/.pi/agent/extensions/${file}`), builtinExtensions: ["/opt/pibox/status-extension.ts"] },
    command: sandboxCommand(node, settings, extensions, runShell, piArgs, command),
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

if (!execMode) writeJsonAtomic(statePath, { endpoints: networkMode === "restricted" ? [...egressSel] : state.endpoints, agent: [...agentSel] });
process.exitCode = await runPiBox({
  workspace, stateDir: piboxAgentDir, readOnly, allow, localEndpoints, runShell, piArgs, networkMode, provider,
  ...(instance ? {} : { instanceRoot: piboxHome }),
  ...(command ? { command } : {}),
  ...(sync ? { sync: {
    source: piAgentDir, settings: { ...hostSettings, defaultProvider: provider },
    packages: pkgItems.filter((p) => agentSel.has(p.key)).map((p) => p.spec),
    extensions: extItems.filter((e) => agentSel.has(e.key)).map((e) => e.file),
  } } : {}),
});
