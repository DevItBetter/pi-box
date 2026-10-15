import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionMetadata {
  version: 1;
  pid: number;
  scope: string;
  workspace: string;
  startedAt: string;
  network: string;
  access: string;
  kind: "pi" | "shell" | "exec";
}

export function inspectSession(home: string) {
  const locked = existsSync(join(home, "active.lock"));
  if (!locked) return { version: 1, state: "idle", locked: false, session: null, resources: null };
  let session: SessionMetadata;
  try {
    session = JSON.parse(readFileSync(join(home, "active.lock", "session.json"), "utf8")) as SessionMetadata;
    if (session.version !== 1 || !/^pibox-\d+-\d+\.scope$/.test(session.scope) || !Number.isSafeInteger(session.pid) || session.pid <= 0) throw new Error("invalid session metadata");
  } catch {
    return { version: 1, state: "unknown", locked: true, session: null, resources: null, detail: "Lock exists without readable session metadata; preparation may still be running." };
  }
  const result = spawnSync("/usr/bin/systemctl", ["--user", "show", session.scope,
    "--property=ActiveState,MemoryCurrent,MemoryMax,CPUUsageNSec,CPUQuotaPerSecUSec,TasksCurrent,TasksMax"], { encoding: "utf8", timeout: 5000 });
  if (result.error || result.status !== 0) return { version: 1, state: "unknown", locked: true, session, resources: null, detail: "Could not query the systemd user manager." };
  const properties = Object.fromEntries(result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
  }));
  let launcherAlive = true;
  try { process.kill(session.pid, 0); } catch (error) { launcherAlive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  const active = ["active", "activating", "deactivating"].includes(properties["ActiveState"] ?? "");
  return {
    version: 1, state: active ? "active" : launcherAlive ? "starting-or-stopping" : "stale", locked: true, session,
    activeState: properties["ActiveState"] ?? "unknown", launcherAlive,
    resources: properties,
  };
}
