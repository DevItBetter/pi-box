import { spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { assertDiskQuota } from "./disk-quota.ts";
import { seccompProgram } from "./seccomp.ts";

export interface BwrapSandboxSpec {
  workspaceDir: string;
  workspaceMode: "rw" | "ro";
  cmd: string[];
  env: Record<string, string>;
  roMounts: { hostPath: string; guestPath: string }[];
  rwMounts?: { hostPath: string; guestPath: string }[];
  cacheDir: string;
  cacheBytes?: number;
  fileBytes?: number;
  writeGrowthBytes?: number;
  egressSocketDir?: string;
  secretEnv?: Record<string, string>;
  tasksMax?: number;
  caps: { memoryMax: string; cpuQuota: string };
  networkMode?: "restricted" | "unrestricted" | "none";
  /** Launcher-generated localhost mapping, mounted at the reserved /etc/hosts path. */
  loopbackHostsFile?: string;
}

export function writableBinds(
  spec: Pick<BwrapSandboxSpec, "workspaceDir" | "workspaceMode" | "cacheDir" | "egressSocketDir" | "rwMounts">,
): { hostPath: string; guestPath: string; measure: "size" | "growth" }[] {
  return [
    { hostPath: spec.cacheDir, guestPath: "/cache", measure: "size" },
    ...(spec.egressSocketDir !== undefined
      ? [{ hostPath: spec.egressSocketDir, guestPath: "/proxy", measure: "growth" as const }]
      : []),
    ...(spec.rwMounts ?? []).map((m) => ({ hostPath: m.hostPath, guestPath: m.guestPath, measure: "growth" as const })),
    ...(spec.workspaceMode === "rw" ? [{ hostPath: spec.workspaceDir, guestPath: "/workspace", measure: "growth" as const }] : []),
  ];
}

export const SANDBOX_CACHE_BYTES = 4 * 1024 ** 3;

export const SANDBOX_FILE_BYTES = 4 * 1024 ** 3;

export const SANDBOX_WRITE_GROWTH_BYTES = 8 * 1024 ** 3;

export interface DiskLimitsConfig {

  fileMax?: string;

  writeGrowthMax?: string;

  cacheMax?: string;
}

export interface DiskLimits {
  fileBytes?: number;
  writeGrowthBytes?: number;
  cacheBytes?: number;
}

const SIZE_UNITS: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

export function parseSize(value: string, what: string): number {
  const m = /^([0-9]+)([KMGT]?)$/.exec(value.trim());
  const bytes = m !== null ? Number(m[1]) * SIZE_UNITS[m[2]!]! : NaN;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${what}: ${JSON.stringify(value)} is not a size (a positive whole number, optionally with K, M, G or T)`);
  }
  return bytes;
}

export function diskLimitsOf(cfg: DiskLimitsConfig, what: string): DiskLimits {
  return {
    ...(cfg.fileMax !== undefined ? { fileBytes: parseSize(cfg.fileMax, `${what} fileMax`) } : {}),
    ...(cfg.writeGrowthMax !== undefined ? { writeGrowthBytes: parseSize(cfg.writeGrowthMax, `${what} writeGrowthMax`) } : {}),
    ...(cfg.cacheMax !== undefined ? { cacheBytes: parseSize(cfg.cacheMax, `${what} cacheMax`) } : {}),
  };
}

const RESERVED_GUEST_PATHS = ["/", "/usr", "/etc", "/proc", "/dev", "/tmp", "/home", "/workspace", "/cache", "/proxy"];

export function canonicalGuestPath(guestPath: string): string {
  if (!guestPath.startsWith("/") || guestPath.split("/").includes("..")) {
    throw new Error(`roMount guestPath must be absolute with no "..": ${JSON.stringify(guestPath)}`);
  }
  const canonical = posix.normalize(guestPath).replace(/\/+$/, "") || "/";
  const under = canonical === "/" ? "/" : `${canonical}/`;
  if (RESERVED_GUEST_PATHS.some((r) => r === canonical || r.startsWith(under))) {
    throw new Error(`roMount guestPath ${JSON.stringify(guestPath)} would shadow a sandbox path`);
  }
  const beneath = RESERVED_GUEST_PATHS.find((r) => r !== "/" && canonical.startsWith(`${r}/`));
  if (beneath !== undefined) {
    throw new Error(
      `roMount guestPath ${JSON.stringify(guestPath)} is inside the sandbox path ${beneath}, which a mount may not cover` +
        (beneath === "/workspace" ? ` (mount dependencies outside it, e.g. /node_modules, which Node finds from /workspace)` : ""),
    );
  }
  return canonical;
}

export function assertSafeToolRoot(hostPath: string, what: string, home: string = homedir()): void {
  const root = resolve(hostPath);
  const h = resolve(home);
  const shallow = dirname(root) === h || dirname(root) === "/";
  if (root === "/" || root === "/usr" || root === h || h.startsWith(`${root}/`) || shallow) {
    throw new Error(
      `refusing to mount ${JSON.stringify(root)} into a sandbox as ${what}: it is the host root, /usr, a ` +
        `top-level directory, the home directory, an ancestor of it, or a direct child of it`,
    );
  }
}

export function sandboxTool(
  realPath: string,
  guestRoot: string,
  what: string,
  home: string = homedir(),
): { roMounts: { hostPath: string; guestPath: string }[]; guestPath: string } {
  const real = resolve(realPath);
  if (real.startsWith("/usr/")) return { roMounts: [], guestPath: real };
  const root = dirname(dirname(real));
  assertSafeToolRoot(root, what, home);
  return {
    roMounts: [{ hostPath: root, guestPath: guestRoot }],
    guestPath: join(guestRoot, basename(dirname(real)), basename(real)),
  };
}

const GUEST_HOME = "/home/sandbox";

function sandboxEnv(spec: { env: Record<string, string> }): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    ...spec.env,
    HOME: GUEST_HOME,
    TMPDIR: "/tmp",
  };
}

export function bwrapArgv(
  spec: BwrapSandboxSpec,
  unit: string,
  seccompFd: number | null = null,
  secretArgsFd: number | null = null,
): string[] {
  const git = join(spec.workspaceDir, ".git");
  if (existsSync(git) && lstatSync(git).isSymbolicLink()) throw new Error("refusing a symlink .git directory");
  const roMounts = spec.roMounts.map((m) => ({ hostPath: m.hostPath, guestPath: canonicalGuestPath(m.guestPath) }));
  const env = sandboxEnv(spec);
  return [
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--expand-environment=no",
    `--unit=${unit}`,
    "-p",
    `MemoryMax=${spec.caps.memoryMax}`,
    "-p",
    "MemorySwapMax=0",
    "-p",
    `CPUQuota=${spec.caps.cpuQuota}`,
    "-p",
    `TasksMax=${spec.tasksMax ?? 4096}`,
    "--",
    "prlimit",
    `--fsize=${spec.fileBytes ?? SANDBOX_FILE_BYTES}`,
    "--",
    "bwrap",
    "--unshare-all",
    ...(spec.networkMode === "unrestricted" ? ["--share-net"] : []),
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    ...(seccompFd !== null ? ["--seccomp", String(seccompFd)] : []),
    "--clearenv",
    ...(secretArgsFd !== null ? ["--args", String(secretArgsFd)] : []),
    "--hostname",
    "sandbox",
    "--ro-bind",
    "/usr",
    "/usr",
    ...["/etc/ssl/certs", "/etc/pki/ca-trust", "/etc/pki/tls/certs", "/etc/ld.so.cache", "/etc/localtime", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf"].filter(existsSync).flatMap((p) => ["--ro-bind", p, p]),
    ...(spec.networkMode === "unrestricted" ? ["/etc/resolv.conf", "/etc/hosts"].filter(existsSync).flatMap((p) => ["--ro-bind", p, p]) : []),
    ...(spec.networkMode !== "unrestricted" && spec.loopbackHostsFile ? ["--ro-bind", spec.loopbackHostsFile, "/etc/hosts"] : []),
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/home",
    "--dir",
    GUEST_HOME,
    ...writableBinds(spec).flatMap((b) => ["--bind", b.hostPath, b.guestPath]),
    ...(spec.workspaceMode === "ro" ? ["--ro-bind", spec.workspaceDir, "/workspace"] : []),
    ...(spec.workspaceMode === "rw" && existsSync(join(spec.workspaceDir, ".git"))
      ? ["--ro-bind", join(spec.workspaceDir, ".git"), "/workspace/.git"]
      : []),
    ...roMounts.flatMap((m) => ["--ro-bind", m.hostPath, m.guestPath]),
    "--chdir",
    "/workspace",
    ...(secretArgsFd === null ? Object.entries(env).flatMap(([k, v]) => ["--setenv", k, v]) : []),
    "--",
    ...spec.cmd,
  ];
}

const SECCOMP_FD = 3;
let seccompFile: string | null | undefined;

export function assertSandboxDiskQuota(
  spec: Pick<BwrapSandboxSpec, "workspaceDir" | "workspaceMode" | "cacheDir" | "egressSocketDir" | "rwMounts">,
  filtered: boolean = seccompFilterFile() !== null,
  timeoutMs?: number,
): void {
  if (!process.env["PIBOX_DISK_QUOTA_ROOT"]) return;
  assertDiskQuota(
    writableBinds(spec).map((b) => ({
      hostPath: b.hostPath,
      kind: b.guestPath === "/proxy" ? ("socket" as const) : ("disk" as const),
    })),
    { filtered, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
  );
}

function seccompFilterFile(): string | null {
  if (seccompFile === undefined) {
    const program = seccompProgram();
    if (program === null) {
      throw new Error(`pibox requires an x86_64 host for its seccomp filter, got ${process.arch}`);
    } else {
      seccompFile = join(mkdtempSync(join(process.env["XDG_RUNTIME_DIR"] ?? tmpdir(), "pibox-seccomp-")), "filter.bpf");
      writeFileSync(seccompFile, program, { mode: 0o400 });
      const filterDir = dirname(seccompFile);
      process.once("exit", () => rmSync(filterDir, { recursive: true, force: true }));
    }
  }
  return seccompFile;
}

export function openBwrapFds(
  spec: BwrapSandboxSpec,
  unit: string,
): { argv: string[]; fds: number[]; close(): void } {
  const filter = seccompFilterFile();
  assertSandboxDiskQuota(spec, filter !== null);
  const fds: number[] = [];
  const next = (): number => SECCOMP_FD + fds.length;
  let seccompFd: number | null = null;
  let secretFd: number | null = null;
  if (filter !== null) {
    seccompFd = next();
    fds.push(openSync(filter, "r"));
  }
  const secrets = [...Object.entries(spec.secretEnv ?? {}), ...Object.entries(sandboxEnv(spec))];
  if (secrets.length > 0) {
    const dir = mkdtempSync(join(process.env["XDG_RUNTIME_DIR"] ?? tmpdir(), "pibox-bwrap-args-"));
    const file = join(dir, "args");
    writeFileSync(file, secrets.map(([k, v]) => `--setenv\0${k}\0${v}\0`).join(""), { mode: 0o600 });
    secretFd = next();
    fds.push(openSync(file, "r"));
    rmSync(dir, { recursive: true, force: true });
  }
  const close = (): void => fds.forEach((fd) => closeSync(fd));
  let argv: string[];
  try {
    argv = bwrapArgv(spec, unit, seccompFd, secretFd);
  } catch (err) {
    close();
    throw err;
  }
  return { argv, fds, close };
}

export function bwrapAvailable(): boolean {
  return existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/systemd-run") && existsSync("/usr/bin/prlimit");
}

export const DISK_ENTRY_BYTES = 4096;

const DISK_SCAN_TIMEOUT_MS = 60_000;

export function diskUsage(dir: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    if (opts.signal?.aborted === true) return reject(new Error(`the scan of ${dir} was stopped before it began`));
    const child = spawn("find", ["-P", dir, "-ignore_readdir_race", "-printf", "%s %b\\n"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    });
    let total = 0;
    let partial = "";
    let stderr = "";
    let stderrLine = "";
    let onlyVanished = true;
    let failure: string | null = null;
    const fail = (why: string): void => {
      failure ??= why;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => fail(`timed out after ${opts.timeoutMs ?? DISK_SCAN_TIMEOUT_MS} ms`), opts.timeoutMs ?? DISK_SCAN_TIMEOUT_MS);
    const onAbort = (): void => fail("stopped");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      const lines = (partial + chunk.toString()).split("\n");
      partial = lines.pop()!;
      for (const line of lines) {
        const [size, blocks] = line.split(" ").map(Number);
        total += Math.max(size!, blocks! * 512) + DISK_ENTRY_BYTES;
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr = (stderr + text).slice(-500);
      const lines = (stderrLine + text).split("\n");
      stderrLine = lines.pop()!;
      if (lines.some((l) => !l.endsWith(": No such file or directory"))) onlyVanished = false;
    });
    child.on("error", (err) => fail(String(err)));
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (stderrLine !== "") onlyVanished = false;
      const vanishedOnly = code === 1 && stderr !== "" && onlyVanished;
      if (failure === null && ((code !== 0 && !vanishedOnly) || partial !== "" || !Number.isSafeInteger(total))) {
        failure = `find exited ${code ?? sig}${stderr.trim() !== "" ? `: ${stderr.trim()}` : ""}`;
      }
      if (failure !== null) reject(new Error(`could not measure ${dir}: ${failure}`));
      else resolvePromise(total);
    });
  });
}

async function sampleGroups(groups: string[][], opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<number[]> {
  const sample = new AbortController();
  const signal = opts.signal !== undefined ? AbortSignal.any([opts.signal, sample.signal]) : sample.signal;
  try {
    return await Promise.all(
      groups.map(async (dirs) =>
        (await Promise.all(dirs.map((d) => diskUsage(d, { ...opts, signal })))).reduce((a, b) => a + b, 0),
      ),
    );
  } catch (err) {
    sample.abort();
    throw err;
  }
}

export async function assertCacheUnderCeiling(
  dir: string,
  maxBytes: number,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  mkdirSync(dir, { recursive: true });
  let bytes: number;
  try {
    bytes = await diskUsage(dir, { ...(signal !== undefined ? { signal } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  } catch (err) {
    if (signal?.aborted === true) throw err;
    throw new Error(
      `the build cache ${dir} cannot be measured (${err instanceof Error ? err.message : String(err)}), so no sandbox is ` +
        `launched onto it; delete the directory (it is only a cache) and rerun`,
    );
  }
  signal?.throwIfAborted();
  if (bytes > maxBytes) {
    throw new Error(
      `the build cache ${dir} holds ${bytes} bytes, over its ceiling of ${maxBytes} (cacheMax), so no sandbox is ` +
        `launched onto it; delete the directory (it is only a cache) or raise cacheMax`,
    );
  }
}

export interface DiskBound {
  dirs: string[];
  maxBytes: number;
  measure: "growth" | "size";
}

export function sandboxDiskBounds(spec: Parameters<typeof writableBinds>[0], limits: DiskLimits): DiskBound[] {
  const binds = writableBinds(spec);
  const sized = binds.filter((b) => b.measure === "size").map((b) => b.hostPath);
  const grown = binds.filter((b) => b.measure === "growth").map((b) => b.hostPath);
  return [
    ...(sized.length > 0 ? [{ dirs: sized, maxBytes: limits.cacheBytes ?? SANDBOX_CACHE_BYTES, measure: "size" as const }] : []),
    ...(grown.length > 0
      ? [{ dirs: grown, maxBytes: limits.writeGrowthBytes ?? SANDBOX_WRITE_GROWTH_BYTES, measure: "growth" as const }]
      : []),
  ];
}

export interface DiskWatch {

  arm(onExceeded: (msg: string) => void): void;

  stop(): Promise<string | null>;

  finish(o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<string | null>;
}

export async function startDiskWatch(
  bounds: DiskBound[],
  opts: { signal?: AbortSignal; intervalMs?: number; baselineTimeoutMs?: number } = {},
): Promise<DiskWatch> {
  const baseline = {
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.baselineTimeoutMs !== undefined ? { timeoutMs: opts.baselineTimeoutMs } : {}),
  };
  const initial = await sampleGroups(bounds.map((b) => (b.measure === "growth" ? b.dirs : [])), baseline);
  const halt = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;
  let loop: Promise<void> = Promise.resolve();
  let armed = false;
  let breach: string | null = null;
  const measure = async (o: { signal?: AbortSignal; timeoutMs?: number }): Promise<string | null> => {
    let now: number[];
    try {
      now = await sampleGroups(bounds.map((b) => b.dirs), o);
    } catch (err) {
      if (o.signal?.aborted === true) return null;
      return `${err instanceof Error ? err.message : String(err)}; a scan that fails is treated as a breach, never as a size`;
    }
    for (const [i, b] of bounds.entries()) {
      const bytes = now[i]! - initial[i]!;
      if (bytes <= b.maxBytes) continue;
      return b.measure === "growth"
        ? `the sandbox wrote ${bytes} bytes to ${b.dirs.join(", ")}, past its write-growth ceiling of ${b.maxBytes} bytes`
        : `${b.dirs.join(", ")} grew to ${bytes} bytes, past its ceiling of ${b.maxBytes} bytes`;
    }
    return null;
  };
  const stop = async (): Promise<string | null> => {
    halt.abort();
    clearTimeout(timer);
    wake?.();
    await loop;
    return breach;
  };
  return {
    arm: (onExceeded) => {
      if (armed || halt.signal.aborted) return;
      armed = true;
      loop = (async () => {
        while (!halt.signal.aborted) {
          await new Promise<void>((r) => {
            wake = r;
            timer = setTimeout(r, opts.intervalMs ?? 2000);
          });
          if (halt.signal.aborted) return;
          const found = await measure({ signal: halt.signal });
          if (found !== null && !halt.signal.aborted) {
            breach = found;
            onExceeded(found);
            return;
          }
        }
      })();
    },
    stop,
    finish: async (o = {}) => {
      await stop();
      if (!armed || breach !== null) return breach;
      breach = await measure(o);
      return breach;
    },
  };
}
