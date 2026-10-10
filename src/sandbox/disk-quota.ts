import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync, statfsSync } from "node:fs";
import { dirname, join, sep } from "node:path";

export const DISK_QUOTA_ROOT_ENV = "PIBOX_DISK_QUOTA_ROOT";

const BTRFS_SUPER_MAGIC = 0x9123683e;
const TMPFS_MAGIC = 0x01021994;

const SUBVOLUME_ROOT_INODE = 256;

const NO_LIMIT = 18446744073709551615n;

export interface WritableDir {
  hostPath: string;

  kind: "disk" | "socket";
}

export interface DiskQuotaProbe {
  fsMagic(path: string): number;

  identity(path: string): { dev: number; ino: number };

  subvolumeId(path: string, timeoutMs: number): string;
  fsUuid(path: string, timeoutMs: number): string;

  nestedSubvolumeBelow(path: string, timeoutMs: number): string | null;

  mountPointsBelow(path: string): string[];

  sysfsRoot: string;
}

const PROBE_TIMEOUT_MS = 10_000;

const run = (cmd: string, args: string[], timeoutMs: number): string => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: Math.max(1, Math.min(PROBE_TIMEOUT_MS, timeoutMs)) });
  const out = (r.stdout ?? "").trim();
  if (r.status !== 0 || out === "") {
    throw new Error(`\`${cmd} ${args.join(" ")}\` failed: ${(r.stderr ?? "").trim() || `exit ${r.status}`}`);
  }
  return out;
};

export const hostProbe: DiskQuotaProbe = {
  fsMagic: (path) => Number(statfsSync(path).type),
  identity: (path) => {
    const st = statSync(path, { throwIfNoEntry: true });
    return { dev: st.dev, ino: st.ino };
  },
  subvolumeId: (path, timeoutMs) => run("btrfs", ["inspect-internal", "rootid", path], timeoutMs),
  fsUuid: (path, timeoutMs) => run("findmnt", ["-n", "-o", "UUID", "--target", path], timeoutMs),
  nestedSubvolumeBelow: (path, timeoutMs) => {
    const r = spawnSync("find", [path, "-xdev", "-mindepth", "1", "-inum", "256", "-print", "-quit"], {
      encoding: "utf8",
      timeout: Math.max(1, timeoutMs),
      env: { ...process.env, LC_ALL: "C" },
    });
    if (r.status !== 0) {
      throw new Error(`\`find ${path}\` could not search it all: ${(r.stderr ?? "").trim() || `exit ${r.status ?? r.signal}`}`);
    }
    const hit = (r.stdout ?? "").split("\n")[0]!.trim();
    return hit === "" ? null : hit;
  },
  mountPointsBelow: (path) => {
    const unescape = (s: string): string => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
    return readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => unescape(l.split(" ")[4] ?? ""))
      .filter((m) => m.startsWith(path + sep));
  },
  sysfsRoot: "/sys/fs/btrfs",
};

export class DiskQuotaRefused extends Error {}

const refuse = (why: string): never => {
  throw new DiskQuotaRefused(`no sandbox is launched: ${why}. PIBOX_DISK_QUOTA_ROOT must name a quota-limited btrfs subvolume containing every writable disk directory.`);
};

const VERIFIED_FOR_MS = 60_000;
const verified = new Map<string, { dev: number; limit: bigint; at: number }>();

function verifyRoot(root: string, probe: DiskQuotaProbe, deadline: number): { dev: number; limit: bigint } {
  const cached = verified.get(root);
  if (cached !== undefined && Date.now() - cached.at < VERIFIED_FOR_MS && probe === hostProbe) return cached;
  const attempt = <T>(what: string, f: () => T): T => {
    try {
      return f();
    } catch (err) {
      return refuse(`${what} (${err instanceof Error ? err.message : String(err)})`);
    }
  };
  if (attempt(`cannot read the filesystem type of ${root}`, () => probe.fsMagic(root)) !== BTRFS_SUPER_MAGIC) {
    refuse(`${DISK_QUOTA_ROOT_ENV}=${root} is not on btrfs`);
  }
  const id = attempt(`cannot stat ${root}`, () => probe.identity(root));
  if (id.ino !== SUBVOLUME_ROOT_INODE) refuse(`${DISK_QUOTA_ROOT_ENV}=${root} is a directory, not a btrfs subvolume`);
  const left = (): number => deadline - Date.now();
  const subvol = attempt(`cannot read the subvolume id of ${root}`, () => probe.subvolumeId(root, left()));
  const uuid = attempt(`cannot read the filesystem uuid of ${root}`, () => probe.fsUuid(root, left()));
  if (!/^\d+$/.test(subvol) || !/^[0-9a-f-]+$/i.test(uuid)) refuse(`unexpected subvolume id "${subvol}" or uuid "${uuid}" for ${root}`);
  const file = join(probe.sysfsRoot, uuid, "qgroups", `0_${subvol}`, "max_referenced");
  const text = attempt(`no qgroup for ${root} at ${file}; quotas are not enabled on this filesystem`, () =>
    readFileSync(file, "utf8").trim(),
  );
  const limit = /^\d+$/.test(text) ? BigInt(text) : null;
  if (limit === null) refuse(`cannot read the qgroup limit of ${root} from ${file} ("${text}")`);
  if (limit === 0n || limit === NO_LIMIT) refuse(`the qgroup of ${root} has no limit set`);
  const ok = { dev: id.dev, limit: limit!, at: Date.now() };
  if (probe === hostProbe) verified.set(root, ok);
  return ok;
}

export function assertDiskQuota(
  dirs: readonly WritableDir[],
  opts: {

    filtered: boolean;

    timeoutMs?: number;
    probe?: DiskQuotaProbe;
  },
): void {
  const probe = opts.probe ?? hostProbe;
  const deadline = Date.now() + (opts.timeoutMs ?? 2 * PROBE_TIMEOUT_MS);
  const configured = process.env[DISK_QUOTA_ROOT_ENV];
  if (configured === undefined || configured === "") refuse(`${DISK_QUOTA_ROOT_ENV} is not set`);
  let root: string;
  try {
    root = realpathSync(configured!);
  } catch (err) {
    return refuse(`${DISK_QUOTA_ROOT_ENV}=${configured} cannot be resolved (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!opts.filtered) {
    refuse(
      `this host has no seccomp filter for bwrap sandboxes (${process.arch}), so a sandbox could create a btrfs ` +
        `subvolume of its own after this check and write outside the limit`,
    );
  }
  const { dev } = verifyRoot(root, probe, deadline);
  for (const d of dirs) {
    let real: string;
    try {
      real = realpathSync(d.hostPath);
    } catch (err) {
      return refuse(`the writable directory ${d.hostPath} cannot be resolved (${err instanceof Error ? err.message : String(err)})`);
    }
    if (d.kind === "socket") {
      let magic: number | null = null;
      try {
        magic = probe.fsMagic(real);
      } catch {
      }
      if (magic === TMPFS_MAGIC) continue;
    }
    if (real !== root && !real.startsWith(root + sep)) refuse(`${real} is writable by the sandbox and is outside ${root}`);
    for (let p = real; p !== root; p = dirname(p)) {
      let ino: number;
      try {
        ino = probe.identity(p).ino;
      } catch (err) {
        return refuse(`cannot stat ${p} (${err instanceof Error ? err.message : String(err)})`);
      }
      if (ino === SUBVOLUME_ROOT_INODE) {
        refuse(`${p} is a nested subvolume inside ${root}: it has its own qgroup and escapes the limit`);
      }
    }
    let here: number;
    try {
      here = probe.identity(real).dev;
    } catch (err) {
      return refuse(`cannot stat ${real} (${err instanceof Error ? err.message : String(err)})`);
    }
    if (here !== dev) refuse(`${real} is on a different subvolume or filesystem than ${root}, outside its limit`);
    let nested: string | null;
    try {
      nested = probe.nestedSubvolumeBelow(real, Math.max(1, deadline - Date.now()));
    } catch (err) {
      return refuse(`cannot check ${real} for nested subvolumes (${err instanceof Error ? err.message : String(err)})`);
    }
    if (nested !== null) refuse(`${nested} is a nested subvolume inside the writable ${real}: it has its own qgroup and escapes the limit`);
    let mounts: string[];
    try {
      mounts = probe.mountPointsBelow(real);
    } catch (err) {
      return refuse(`cannot read the mounts below ${real} (${err instanceof Error ? err.message : String(err)})`);
    }
    if (mounts.length > 0) refuse(`${mounts[0]} is a separate mount inside the writable ${real}, outside the limit`);
  }
}

export function resetDiskQuotaForTests(): void {
  verified.clear();
}
