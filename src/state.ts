import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PackageSpec = string | { source: string; [key: string]: unknown };
export const packageSource = (spec: PackageSpec): string => typeof spec === "string" ? spec : spec.source;
const SYNC_FILES = ["auth.json", "models.json", "models-store.json", "keybindings.json"];

/** Stage next to the destination so rename replaces it atomically. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const scratch = mkdtempSync(join(dirname(path), ".pibox-write-"));
  try {
    const staged = join(scratch, "value.json");
    writeFileSync(staged, content, { mode: 0o600 });
    renameSync(staged, path);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Host preparation touches only these entries, never guest-owned package/session trees. */
export function refuseLinks(dir: string): void {
  if (!existsSync(dir)) return;
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error(`pi state is not a regular directory: ${dir}`);
  for (const name of [...SYNC_FILES, "settings.json", "extensions"]) {
    const file = join(dir, name);
    let stat;
    try { stat = lstatSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`pi state contains a symlink: ${file}`);
    if (name === "extensions" ? !stat.isDirectory() : !stat.isFile()) throw new Error(`pi state contains a special file: ${file}`);
  }
}

export function lockState(home: string): void {
  try { mkdirSync(join(home, "active.lock")); }
  catch { throw new Error(`another pibox session uses ${home}. If it stopped abnormally, remove ${join(home, "active.lock")} after checking that session has ended.`); }
}

export function unlockState(home: string): void {
  rmSync(join(home, "active.lock"), { recursive: true, force: true });
}

export function syncAgent(source: string, dest: string, settings: Record<string, unknown>, packages: PackageSpec[], extensions: string[]): void {
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  refuseLinks(dest);
  const scratch = mkdtempSync(join(dirname(dest), ".sync-"));
  try {
    if (!existsSync(source)) console.error(`pibox: ${source} is absent; use /login inside pibox.`);
    for (const name of SYNC_FILES) {
      const from = join(source, name); const to = join(dest, name);
      if (!existsSync(from)) continue;
      const stat = lstatSync(from);
      if (!stat.isFile()) throw new Error(`pi source is not a regular file: ${from}`);
      if (existsSync(to) && lstatSync(to).mtimeMs >= stat.mtimeMs) continue;
      const staged = join(scratch, name);
      cpSync(from, staged, { preserveTimestamps: true });
      renameSync(staged, to);
    }
    for (const spec of packages) {
      const src = packageSource(spec);
      if (!src.startsWith("npm:") && !src.startsWith("git:")) throw new Error(`selected package ${src} uses a host path; install it as an npm or git pi package first`);
    }
    // Seed installed packages once. Existing guest caches are never traversed by host sync.
    if (packages.length > 0) {
      for (const name of ["npm", "git"]) {
        const from = join(source, name); const to = join(dest, name);
        if (!existsSync(from) || existsSync(to)) continue;
        if (!lstatSync(from).isDirectory()) throw new Error(`pi package cache is not a regular directory: ${from}`);
        const staged = join(scratch, name);
        cpSync(from, staged, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
        renameSync(staged, to);
      }
    }
    const guestSettings: Record<string, unknown> = { ...settings, packages };
    delete guestSettings["extensions"];
    const stagedSettings = join(scratch, "settings.json");
    writeFileSync(stagedSettings, `${JSON.stringify(guestSettings, null, 2)}\n`, { mode: 0o600 });
    renameSync(stagedSettings, join(dest, "settings.json"));
    const stagedExt = join(scratch, "extensions"); mkdirSync(stagedExt);
    for (const file of extensions) {
      if (file !== file.split("/").pop() || file === "." || file === "..") throw new Error(`extension must be a filename: ${file}`);
      const from = join(source, "extensions", file);
      if (!lstatSync(from).isFile()) throw new Error(`selected extension is not a regular file: ${from}`);
      cpSync(from, join(stagedExt, file));
    }
    rmSync(join(dest, "extensions"), { recursive: true, force: true });
    renameSync(stagedExt, join(dest, "extensions"));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
