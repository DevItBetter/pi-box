import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ContainmentCleanupError, launchSandbox, type LaunchOptions } from "./launch.ts";
import { lockState, refuseLinks, reserveInstance, syncAgent, unlockState, type PackageSpec } from "./state.ts";

export interface PiBoxOptions extends LaunchOptions {
  /** Automatically reserve a free persistent slot under this root. */
  instanceRoot?: string;
  sync?: { source: string; settings: Record<string, unknown>; packages: PackageSpec[]; extensions: string[] };
}

/** Runs one session, serializing all host preparation and guest access to its state. */
export async function runPiBox(options: PiBoxOptions): Promise<number> {
  const home = options.instanceRoot ? reserveInstance(options.instanceRoot) : dirname(options.stateDir);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!options.instanceRoot) lockState(home);
  const launch = options.instanceRoot ? { ...options, stateDir: join(home, "agent") } : options;
  let keepLock = false;
  try {
    mkdirSync(launch.stateDir, { recursive: true, mode: 0o700 });
    refuseLinks(launch.stateDir);
    if (launch.sync) {
      const s = launch.sync;
      syncAgent(s.source, launch.stateDir, s.settings, s.packages, s.extensions);
    }
    console.error(`pibox: instance state = ${launch.stateDir}`);
    return await launchSandbox(launch);
  } catch (error) {
    keepLock = error instanceof ContainmentCleanupError;
    throw error;
  } finally {
    if (!keepLock) unlockState(home);
  }
}
