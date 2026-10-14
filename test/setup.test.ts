import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { discoverProviders, endpointForUrl } from "../src/setup.ts";

test("endpoint discovery keeps exact HTTPS hosts and explicit loopback ports", () => {
  assert.equal(endpointForUrl("https://gateway.example/v1?key=secret"), "gateway.example");
  assert.equal(endpointForUrl("http://localhost:11434/v1"), "http://localhost:11434");
  for (const url of ["http://gateway.example/v1", "https://gateway.example:8443", "https://user:secret@gateway.example", "https://169.254.169.254", "http://localhost:18080", "https://{region}.example", "https://[::1]"]) {
    assert.throws(() => endpointForUrl(url));
  }
});

test("setup discovers Copilot OAuth endpoints, preserves config, and doctor is read-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "pibox-setup-test-"));
  try {
    const home = join(dir, "home"); const agent = join(home, ".pi/agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "github-copilot" }));
    symlinkSync(join(dir, "settings.json"), join(agent, "settings.json"));
    const auth = JSON.stringify({ "github-copilot": { type: "oauth", access: "secret;proxy-ep=proxy.business.githubcopilot.com;", refresh: "private", expires: Date.now() + 3600000 } });
    writeFileSync(join(agent, "auth.json"), auth);
    const path = join(dir, "config.json");
    const config = { ...DEFAULT_CONFIG, providerEndpoints: { "github-copilot": ["custom.example"] }, extraSetting: "keep" };
    writeFileSync(path, JSON.stringify(config));
    const cli = fileURLToPath(new URL("../src/pibox.ts", import.meta.url));
    const env = { HOME: home, PIBOX_HOME: join(dir, "state"), PATH: process.env.PATH };
    const run = (command: string) => spawnSync(process.execPath, [cli, command, "--config", path], { env, encoding: "utf8", timeout: 15000 });
    const before = readFileSync(path, "utf8");
    const doctor = run("doctor");
    assert.equal(doctor.status, 1, doctor.stderr);
    assert.match(doctor.stdout, /egress endpoints missing/);
    assert.equal(readFileSync(path, "utf8"), before);
    const setup = run("setup");
    assert.equal(setup.status, 0, setup.stderr + setup.stdout);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(saved.defaultProvider, "github-copilot");
    assert.equal(saved.extraSetting, "keep");
    assert.deepEqual(saved.providerEndpoints["github-copilot"], ["custom.example", "api.business.githubcopilot.com", "github.com", "api.github.com"]);
    assert.equal(readFileSync(join(agent, "auth.json"), "utf8"), auth);
    assert.ok(!readFileSync(path, "utf8").includes("private"));
    assert.ok(!setup.stdout.includes("secret"));
    assert.equal(run("doctor").status, 0);
    const after = readFileSync(path, "utf8");
    assert.equal(run("setup").status, 0);
    assert.equal(readFileSync(path, "utf8"), after);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("discovery checks sandbox auth, custom endpoints and unresolved key commands without executing them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pibox-discovery-test-"));
  try {
    const source = join(dir, "source"); const guest = join(dir, "guest");
    mkdirSync(source); mkdirSync(guest);
    const marker = join(dir, "executed");
    writeFileSync(join(source, "models.json"), JSON.stringify({ providers: {
      ollama: { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
      gateway: { baseUrl: "https://gateway.example/v1", apiKey: `!touch ${marker}` },
      broken: { baseUrl: "https://{region}.example/v1", apiKey: "test" },
    } }));
    const report = await discoverProviders(source, guest, DEFAULT_CONFIG, "openai", { OPENAI_API_KEY: "host-secret" });
    const findings = new Map(report.providers.map((p) => [p.id, p]));
    assert.deepEqual(findings.get("ollama")?.endpoints, ["http://127.0.0.1:11434"]);
    assert.equal(findings.get("ollama")?.auth, "models.json API key");
    assert.match(findings.get("openai")!.issues.join(" "), /host environment/);
    assert.match(findings.get("gateway")!.issues.join(" "), /command was not executed/);
    assert.equal(findings.get("broken")?.endpoints.length, 0);
    assert.ok(!existsSync(marker));
    // A login performed inside pibox is retained and diagnosed on subsequent setup runs.
    writeFileSync(join(guest, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "guest-key" } }));
    const retained = await discoverProviders(source, guest, DEFAULT_CONFIG, "openai", {});
    assert.equal(retained.providers.find((p) => p.id === "openai")?.auth, "stored API-key configuration");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("doctor does not create config or state on a fresh installation", () => {
  const dir = mkdtempSync(join(tmpdir(), "pibox-doctor-test-"));
  try {
    const cli = fileURLToPath(new URL("../src/pibox.ts", import.meta.url));
    const result = spawnSync(process.execPath, [cli, "doctor"], { env: { HOME: dir, PIBOX_HOME: join(dir, "state"), PATH: process.env.PATH }, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /authentication missing/);
    assert.ok(!existsSync(join(dir, "state")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
