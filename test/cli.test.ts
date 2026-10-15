import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";

test("defaults fill absent selections, preserve empty state, and save without launching", () => {
  const dir = mkdtempSync(join(tmpdir(), "pibox-defaults-"));
  try {
    const project = join(dir, "project"); const home = join(dir, "home");
    mkdirSync(project); mkdirSync(home);
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ ...DEFAULT_CONFIG, defaultSelections: { endpoints: ["github"], agent: [] } }));
    const run = (...args: string[]) => spawnSync(process.execPath, [new URL("../src/pibox.ts", import.meta.url).pathname, "-C", project, "--no-tui", ...args], {
      env: { ...process.env, HOME: home, PIBOX_HOME: dir, PIBOX_ALLOW: "" }, encoding: "utf8", timeout: 5000,
    });
    assert.match(run("--print-plan").stderr, /egress = openai endpoints \+ github/);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ endpoints: [], agent: [] }));
    assert.doesNotMatch(run("--print-plan").stderr, /\+ github/);
    const saved = run("--profile", "node-dev", "--save-defaults");
    assert.equal(saved.status, 0, saved.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).defaultSelections, { endpoints: ["npm", "github"], agent: [] });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")), { endpoints: [], agent: [] });
    assert.equal(run("--save-defaults", "--print-plan").status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("profiles lists catalog members without validating the workspace or loading Pi state", () => {
  const dir = mkdtempSync(join(tmpdir(), "pibox-profiles-"));
  try {
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ ...DEFAULT_CONFIG, endpointProfiles: { minimal: [], dev: ["npm", "github"], described: { members: ["github"], label: "GitHub access", description: "Fetch repository sources" } } }));
    const result = spawnSync(process.execPath, [new URL("../src/pibox.ts", import.meta.url).pathname, "profiles", "--config", config, "-C", "/"], {
      env: { ...process.env, PIBOX_HOME: dir }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Endpoint groups:\n  npm: registry.npmjs.org/);
    assert.match(result.stdout, /minimal: \(empty\)/);
    assert.match(result.stdout, /dev: npm, github/);
    assert.match(result.stdout, /described \[GitHub access\]: github.*Fetch repository sources/);
    assert.match(result.stdout, /Capability profiles:\n  research: pkg:pi-web-access, pkg:pi-lens/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--no-tui reuses selections even with interactive stdin", () => {
  const dir = mkdtempSync(join(tmpdir(), "pibox-cli-"));
  try {
    const home = join(dir, "home"); const state = join(dir, "state"); const project = join(dir, "project");
    mkdirSync(home); mkdirSync(state); mkdirSync(project);
    writeFileSync(join(state, "config.json"), JSON.stringify(DEFAULT_CONFIG));
    writeFileSync(join(state, "state.json"), JSON.stringify({ endpoints: ["github"], agent: [] }));
    const cli = new URL("../src/pibox.ts", import.meta.url).href;
    const code = `process.stdin.isTTY = true; process.stdin.setRawMode = () => { throw new Error("unexpected picker"); }; process.argv = [process.execPath, "pibox", ...process.argv.slice(1)]; await import(${JSON.stringify(cli)});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, "--", "-C", project, "--no-tui", "--print-plan"], {
      env: { ...process.env, HOME: home, PIBOX_HOME: state, PIBOX_ALLOW: "" }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /egress = openai endpoints \+ github/);
    assert.match(result.stderr, /agent  = bare pi/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
