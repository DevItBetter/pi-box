import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCacheUnderCeiling, bwrapAvailable, diskLimitsOf, openBwrapFds, sandboxDiskBounds, sandboxTool, startDiskWatch, type BwrapSandboxSpec } from "./sandbox/bwrap.ts";
import { startEgressProxy, type EgressProxy } from "./sandbox/egress-proxy.ts";
import { parseLocalEndpoints, startLocalRelay } from "./sandbox/local-relay.ts";

export interface LaunchOptions {
  workspace: string;
  stateDir: string;
  readOnly: boolean;
  allow: string[];
  /** Explicit host-loopback origins, forwarded only in restricted mode. */
  localEndpoints?: string[];
  runShell: boolean;
  piArgs: string[];
  networkMode?: "restricted" | "unrestricted" | "none";
}

export function validateWorkspace(input: string): string {
  const workspace = realpathSync(input);
  const home = realpathSync(homedir());
  if (!lstatSync(workspace).isDirectory()) throw new Error(`workspace is not a directory: ${workspace}`);
  if (workspace === "/" || workspace === home || home.startsWith(`${workspace}/`) || workspace.startsWith(`${home}/.`)) {
    throw new Error(`refusing workspace ${workspace}: it exposes home or a hidden home directory`);
  }
  const mountPoints = readFileSync("/proc/self/mountinfo", "utf8").split("\n").map((line) =>
    (line.split(" ")[4] ?? "").replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))));
  if (mountPoints.some((p) => p.startsWith(`${workspace}/`))) throw new Error("workspace contains a nested mount");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSocket() || entry.isFIFO() || entry.isBlockDevice() || entry.isCharacterDevice()) throw new Error(`workspace contains a live endpoint: ${path}`);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(workspace);
  const git = join(workspace, ".git");
  if (existsSync(git) && lstatSync(git).isSymbolicLink()) throw new Error("refusing a symlink .git directory");
  return workspace;
}

export class ContainmentCleanupError extends Error {}

function systemctl(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("/usr/bin/systemctl", ["--user", ...args], { encoding: "utf8", timeout: 5000 });
}

export async function launchSandbox(opts: LaunchOptions): Promise<number> {
  const networkMode = opts.networkMode ?? "restricted";
  if (!["restricted", "unrestricted", "none"].includes(networkMode)) throw new Error(`unknown network mode: ${networkMode}`);
  const workspace = validateWorkspace(opts.workspace);
  if (!bwrapAvailable()) throw new Error("pibox requires bubblewrap, systemd-run, and prlimit");
  const probe = systemctl(["show-environment"]);
  if (probe.status !== 0) throw new Error("pibox needs a working systemd user manager. Set XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS for this user session.");
  const stateDir = realpathSync(opts.stateDir);
  if (stateDir === workspace || stateDir.startsWith(`${workspace}/`) || workspace.startsWith(`${stateDir}/`)) throw new Error("pi state and workspace must be separate directories");
  const node = sandboxTool(realpathSync(process.execPath), "/opt/node", "Node.js");
  // Resolve the dependency where npm installed it, including a consumer's hoisted layout.
  const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  const modules = realpathSync(dirname(dirname(piRoot)));
  const pi = "/opt/pi-modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
  const cachePath = join(dirname(stateDir), "cache");
  mkdirSync(cachePath, { recursive: true, mode: 0o700 });
  const cache = realpathSync(cachePath);
  const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  if (overlaps(cache, workspace) || overlaps(cache, stateDir)) throw new Error("cache, state, and workspace must be separate directories");
  const settingsFile = join(stateDir, "settings.json");
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) as { packages?: unknown[] } : {};
  const extensions = existsSync(join(stateDir, "extensions")) ? readdirSync(join(stateDir, "extensions")).filter((f) => /\.(ts|js)$/.test(f)) : [];
  const agentArgs = ["--no-approve", "--no-mcp"];
  if (!(settings.packages?.length)) {
    agentArgs.push("--no-extensions");
    for (const file of extensions) agentArgs.push("-e", `/home/sandbox/.pi/agent/extensions/${file}`);
  }
  const limits = diskLimitsOf({
    fileMax: process.env["PIBOX_FILE_MAX"] ?? "4G",
    cacheMax: process.env["PIBOX_CACHE_MAX"] ?? "4G",
    writeGrowthMax: process.env["PIBOX_WRITE_GROWTH_MAX"] ?? "8G",
  }, "pibox");
  await assertCacheUnderCeiling(cache, limits.cacheBytes!);
  const scratch = networkMode === "restricted" ? mkdtempSync(join(process.env["XDG_RUNTIME_DIR"] ?? tmpdir(), "pibox-proxy-")) : undefined;
  const unit = `pibox-${process.pid}-${Date.now()}`;
  let proxy: EgressProxy | undefined;
  const localRelays: { close(): Promise<void> }[] = [];
  let cleanupSafe = true;
  try {
    if (scratch) proxy = await startEgressProxy({ socketPath: join(scratch, "egress.sock"), allow: opts.allow });
    if (scratch) {
      const local = parseLocalEndpoints(opts.localEndpoints ?? []);
      for (const endpoint of local) localRelays.push(await startLocalRelay(join(scratch, `local-${endpoint.port}.sock`), endpoint));
      writeFileSync(join(scratch, "local.json"), JSON.stringify(local.map(({ port }) => ({ port, socketPath: `/proxy/local-${port}.sock` }))));
      writeFileSync(join(scratch, "hosts"), "127.0.0.1 localhost\n");
    }
    const env: Record<string, string> = {
      PATH: `${dirname(node.guestPath)}:/usr/bin:/bin`,
      TERM: process.env["TERM"] ?? "xterm-256color",
      COLORTERM: process.env["COLORTERM"] ?? "",
      PI_CODING_AGENT_DIR: "/home/sandbox/.pi/agent",
      ...(networkMode === "restricted" ? {
        HTTPS_PROXY: "http://127.0.0.1:18080",
        HTTP_PROXY: "http://127.0.0.1:18080",
        https_proxy: "http://127.0.0.1:18080",
        http_proxy: "http://127.0.0.1:18080",
        NODE_USE_ENV_PROXY: "1",
        NO_PROXY: "localhost,127.0.0.1",
        no_proxy: "localhost,127.0.0.1",
      } : {}),
    };
    const spec: BwrapSandboxSpec = {
      workspaceDir: workspace, workspaceMode: opts.readOnly ? "ro" : "rw",
      cacheDir: cache, networkMode, ...(scratch ? { egressSocketDir: scratch, loopbackHostsFile: join(scratch, "hosts") } : {}),
      rwMounts: [{ hostPath: stateDir, guestPath: "/home/sandbox/.pi/agent" }],
      roMounts: [...node.roMounts,
        { hostPath: modules, guestPath: "/opt/pi-modules" },
        { hostPath: fileURLToPath(new URL("./sandbox/egress-forwarder.mjs", import.meta.url)), guestPath: "/opt/pibox/egress-forwarder.mjs" }],
      env, ...limits,
      caps: { memoryMax: process.env["PIBOX_MEMORY"] ?? "4G", cpuQuota: process.env["PIBOX_CPU_QUOTA"] ?? "300%" },
      tasksMax: 512,
      cmd: [...(networkMode === "restricted" ? [node.guestPath, "/opt/pibox/egress-forwarder.mjs", "/proxy/egress.sock", "18080", "/proxy/local.json", "--"] : []),
        ...(opts.runShell ? ["/bin/bash", "--noprofile", "--norc"] : [node.guestPath, pi, "--offline", ...agentArgs, ...opts.piArgs])],
    };
    if (!process.env["PIBOX_DISK_QUOTA_ROOT"]) console.error("pibox: disk growth is monitored; no hard aggregate disk quota is configured.");
    const watch = await startDiskWatch(sandboxDiskBounds(spec, limits));
    try {
      const opened = openBwrapFds(spec, unit);
      const child = spawn(opened.argv[0]!, opened.argv.slice(1), { stdio: ["inherit", "inherit", "inherit", ...opened.fds], env: { ...process.env, PATH: "/usr/bin:/bin" } });
      opened.close();
      const stop = (): void => { child.kill("SIGKILL"); };
      const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
      for (const signal of signals) process.on(signal, stop);
      watch.arm((why) => { console.error(`pibox: ${why}`); stop(); });
      let code: number;
      try {
        code = await new Promise<number>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (status, signal) => resolve(status ?? (signal ? 128 + 9 : 1)));
        });
      } finally {
        for (const signal of signals) process.off(signal, stop);
        systemctl(["stop", `${unit}.scope`]);
        const state = systemctl(["show", `${unit}.scope`, "--property=ActiveState", "--value"]);
        if (state.error || !["inactive", "failed", ""].includes(String(state.stdout ?? "").trim())) {
          cleanupSafe = false;
          throw new ContainmentCleanupError(`could not confirm ${unit}.scope stopped; state lock kept`);
        }
      }
      const breach = code === 0 ? await watch.finish() : await watch.stop();
      if (breach) { console.error(`pibox: ${breach}`); return 1; }
      return code;
    } finally { await watch.stop(); }
  } finally {
    for (const relay of localRelays) await relay.close();
    await proxy?.close();
    if (cleanupSafe && scratch) rmSync(scratch, { recursive: true, force: true });
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l\x1b[?1004l\x1b[?25h\x1b[?1049l");
  }
}
