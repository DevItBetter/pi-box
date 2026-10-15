import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), "pibox-live-"));
const fixture = spawn(process.execPath, [join(root, "test/local-model-fixture.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
try {
  const ports = await new Promise<{ model: number; other: number }>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("local model fixture did not start")), 5000);
    fixture.once("error", reject);
    fixture.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.trim())); }
    });
  });
  const workspace = join(dir, "project"); mkdirSync(workspace);
  const outside = join(dir, "host-secret"); writeFileSync(outside, "must remain hidden");
  const run = (extra: string[], input?: string) => spawnSync(join(root, "bin/pibox"), ["-C", workspace, "--bare", "--no-sync", ...(extra.includes("--provider") ? [] : ["--provider", "openai"]), ...extra], {
    env: { ...process.env, PIBOX_HOME: join(dir, "state") }, encoding: "utf8", timeout: 60000, ...(input ? { input } : {}),
  });
  const none = run(["--network", "none", "--print-plan"]);
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stderr, /hosts = \(endpoint rules inactive\)/);
  const blocked = run(["--network", "none", "--shell"], "curl -sS --max-time 5 https://api.openai.com/v1/models\n");
  assert.notEqual(blocked.status, 0);
  const version = run(["--", "--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /1\.1\.0/);
  // script supplies a controlling PTY. Changing its size must reach the guest
  // even though bubblewrap starts a separate session with --new-session.
  const resizeConfig = join(dir, "resize-config.json");
  writeFileSync(resizeConfig, JSON.stringify({ providerEndpoints: { openai: ["api.openai.com"] }, endpointProfiles: { test: [] } }));
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  for (const mode of ["none", "restricted", "unrestricted"]) {
    const command = [join(root, "bin/pibox"), "-C", workspace, "--bare", "--no-sync", "--provider", "openai", "--config", resizeConfig, "--profile", "test", "--network", mode, "--shell"];
    const terminal = spawn("/usr/bin/script", ["--quiet", "--return", "--command", command.map(quote).join(" "), "/dev/null"], {
      env: { ...process.env, TERM: "xterm-256color", PIBOX_HOME: join(dir, "state") }, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    terminal.stdout.on("data", (chunk) => { output += String(chunk); });
    terminal.stderr.on("data", (chunk) => { output += String(chunk); });
    const probe = `
      const { spawnSync } = require("node:child_process");
      const sizes = [[120, 35], [45, 12], [80, 24]];
      const timer = setTimeout(() => { console.error("resize timed out"); process.exit(1); }, 5000);
      function resize() {
        const [columns, rows] = sizes[0];
        const result = spawnSync("/usr/bin/stty", ["cols", String(columns), "rows", String(rows)], { stdio: "inherit" });
        if (result.status !== 0) process.exit(2);
      }
      process.stdout.on("resize", () => {
        const [columns, rows] = sizes[0];
        if (process.stdout.columns !== columns || process.stdout.rows !== rows) process.exit(3);
        sizes.shift();
        if (sizes.length) setTimeout(resize, 50);
        else { clearTimeout(timer); console.log("terminal-resize-ok"); }
      });
      resize();
    `;
    terminal.stdin.end(`stty cols 80 rows 24\nexec node -e ${quote(probe)}\n`);
    const status = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => { terminal.kill("SIGKILL"); reject(new Error(`terminal resize test timed out: ${output}`)); }, 20000);
      terminal.once("error", (error) => { clearTimeout(timeout); reject(error); });
      terminal.once("close", (code) => { clearTimeout(timeout); resolve(code); });
    });
    assert.equal(status, 0, `${mode} terminal resize: ${output}`);
  }
  const script = `set -eu\ntest "$HOME" = /home/sandbox\ntest -z "\u0024{PIBOX_TEST_SECRET:-}"\ntest ! -e '${outside}'\ntest ! -e '${join(homedir(), '.ssh')}'\nprintf written > /workspace/result\ncurl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://api.openai.com/v1/models\nprintf '\\n'\nif curl -sS --max-time 5 https://example.com; then exit 9; fi\necho sandbox-ok\n`;
  process.env["PIBOX_TEST_SECRET"] = "not forwarded";
  const rw = run(["--allow", "api.openai.com", "--shell"], script);
  assert.equal(rw.status, 0, rw.stderr);
  assert.match(rw.stdout, /401/); assert.match(rw.stdout, /sandbox-ok/);
  assert.equal(readFileSync(join(workspace, "result"), "utf8"), "written");
  const ro = run(["--read-only", "--shell"], "printf no > /workspace/blocked\n");
  assert.notEqual(ro.status, 0);
  assert.match(ro.stderr, /Read-only file system/);
  mkdirSync(join(dir, "state", "cache"), { recursive: true });
  const overlap = spawnSync(join(root, "bin/pibox"), ["-C", join(dir, "state", "cache"), "--bare", "--no-sync", "--provider", "openai", "--read-only", "--shell"], { env: { ...process.env, PIBOX_HOME: join(dir, "state") }, encoding: "utf8", timeout: 10000 });
  assert.notEqual(overlap.status, 0);
  assert.match(overlap.stderr, /cache, state, and workspace must be separate/);
  const offline = run(["--network", "none", "--allow", "api.openai.com", "--shell"], "curl -sS --max-time 2 https://api.openai.com/v1/models\n");
  assert.notEqual(offline.status, 0);
  const unrestricted = run(["--network", "unrestricted", "--shell"], "test -z \"${HTTPS_PROXY:-}\" && curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://example.com\n");
  assert.equal(unrestricted.status, 0, unrestricted.stderr);
  assert.match(unrestricted.stdout, /200/);
  writeFileSync(join(dir, "state/config.json"), JSON.stringify({ defaultProvider: "local", providerEndpoints: { local: [`http://localhost:${ports.model}`] } }));
  mkdirSync(join(dir, "state/agent"), { recursive: true });
  writeFileSync(join(dir, "state/agent/models.json"), JSON.stringify({ providers: { local: {
    baseUrl: `http://localhost:${ports.model}/v1`, api: "openai-completions", apiKey: "fixture",
    models: [{ id: "fixture", name: "Local fixture", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 256 }],
  } } }));
  const local = run(["--provider", "local", "--shell"], `set -eu\ncurl -sS --max-time 5 http://localhost:${ports.model}/health\nif curl -sS --max-time 2 http://127.0.0.1:${ports.other}; then exit 9; fi\nif curl -sS --max-time 2 https://example.com; then exit 10; fi\n`);
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /local-service-ok/);
  const inference = run(["--provider", "local", "--model", "fixture", "-p", "Say hello"]);
  assert.equal(inference.status, 0, inference.stderr);
  assert.match(inference.stdout, /local-model-ok/);
  const noLocal = run(["--network", "none", "--shell"], `curl -sS --max-time 2 http://127.0.0.1:${ports.model}/health\n`);
  assert.notEqual(noLocal.status, 0);
  console.log("Live pi launch, host isolation, clean environment, read-write/read-only mounts, allowed provider HTTPS, blocked egress, and local provider completion passed.");
} finally { fixture.kill(); rmSync(dir, { recursive: true, force: true }); }
