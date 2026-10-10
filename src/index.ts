import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ContainmentCleanupError, launchSandbox, type LaunchOptions } from "./launch.ts";
import { lockState, refuseLinks, syncAgent, unlockState, type PackageSpec } from "./state.ts";

export interface PiBoxOptions extends LaunchOptions {
  sync?: { source: string; settings: Record<string, unknown>; packages: PackageSpec[]; extensions: string[] };
}

/** Runs one session, serializing all host preparation and guest access to its state. */
export async function runPiBox(options: PiBoxOptions): Promise<number> {
  const home = dirname(options.stateDir);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  lockState(home);
  let keepLock = false;
  try {
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    refuseLinks(options.stateDir);
    if (options.sync) {
      const s = options.sync;
      syncAgent(s.source, options.stateDir, s.settings, s.packages, s.extensions);
    }
    return await launchSandbox(options);
  } catch (error) {
    keepLock = error instanceof ContainmentCleanupError;
    throw error;
  } finally {
    if (!keepLock) unlockState(home);
  }
}
