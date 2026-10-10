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
  const run = (extra: string[], input?: string) => spawnSync(join(root, "bin/pibox"), ["-C", workspace, "--bare", "--no-sync", ...extra], {
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
  const overlap = spawnSync(join(root, "bin/pibox"), ["-C", join(dir, "state", "cache"), "--bare", "--no-sync", "--read-only", "--shell"], { env: { ...process.env, PIBOX_HOME: join(dir, "state") }, encoding: "utf8", timeout: 10000 });
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
