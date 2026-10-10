import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bwrapArgv, canonicalGuestPath, parseSize, type BwrapSandboxSpec } from "../src/sandbox/bwrap.ts";
import { hostAllowed, isPrivateAddress } from "../src/sandbox/egress-proxy.ts";
import { lockState, packageSource, refuseLinks, syncAgent, unlockState } from "../src/state.ts";
import { DEFAULT_CONFIG, localProviderEndpoints, providerForArgs, restrictedHosts } from "../src/config.ts";
import { parseLocalEndpoints } from "../src/sandbox/local-relay.ts";

test("namespace, environment, mounts, and cgroup limits stay enforced", () => {
  const spec: BwrapSandboxSpec = { workspaceDir: "/project", workspaceMode: "ro", cacheDir: "/state/cache", roMounts: [], cmd: ["/bin/bash"], env: {}, caps: { memoryMax: "4G", cpuQuota: "300%" } };
  const argv = bwrapArgv(spec, "pibox-test", 3);
  for (const flag of ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--seccomp", "MemoryMax=4G", "MemorySwapMax=0", "CPUQuota=300%", "--fsize=4294967296"]) assert.ok(argv.includes(flag), flag);
  assert.ok(argv.join(" ").includes("--ro-bind /project /workspace"));
  assert.ok(!argv.includes("--share-net"));
  assert.ok(!argv.join(" ").includes("--ro-bind /etc /etc"));
  for (const path of ["/workspace/.", "//home", "/opt/../home", "/workspace/node_modules"]) assert.throws(() => canonicalGuestPath(path));
  assert.equal(parseSize("4G", "memory"), 4 * 1024 ** 3);
  assert.throws(() => parseSize("unlimited", "memory"));
});

test("egress refuses lookalikes, IPs, LAN and cloud metadata", () => {
  assert.ok(hostAllowed("API.OPENAI.COM", ["api.openai.com"]));
  for (const host of ["api.openai.com.evil.test", "notopenai.com", "127.0.0.1", "api.openai.com@evil.test"]) assert.ok(!hostAllowed(host, ["api.openai.com", ".openai.com"]));
  for (const ip of ["127.0.0.1", "169.254.169.254", "192.168.0.1", "::1", "::ffff:10.0.0.1"]) assert.ok(isPrivateAddress(ip));
  assert.ok(!isPrivateAddress("1.1.1.1"));
});

test("guest-planted symlinks cannot redirect config sync", () => {
  const dir = mkdtempSync(join(tmpdir(), "pibox-sync-test-"));
  try {
    const source = join(dir, "source"); const dest = join(dir, "agent");
    mkdirSync(source); mkdirSync(dest);
    const outside = join(dir, "outside"); writeFileSync(outside, "original");
    symlinkSync(outside, join(dest, "settings.json"));
    assert.throws(() => syncAgent(source, dest, {}, [], []), /symlink/);
    assert.equal(readFileSync(outside, "utf8"), "original");
    rmSync(join(dest, "settings.json"));
    refuseLinks(dest);
    syncAgent(source, dest, {}, [], []);
    assert.deepEqual(JSON.parse(readFileSync(join(dest, "settings.json"), "utf8")), { packages: [] });
    lockState(dir);
    assert.throws(() => lockState(dir), /another pibox session/);
    unlockState(dir);
    lockState(dir); unlockState(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a guest FIFO cannot block settings regeneration", () => {
  const dir = mkdtempSync(join(tmpdir(), "pibox-fifo-test-"));
  try {
    const agent = join(dir, "agent"); mkdirSync(agent);
    execFileSync("/usr/bin/mkfifo", [join(agent, "settings.json.tmp")]);
    const module = fileURLToPath(new URL("../src/state.ts", import.meta.url));
    const code = `import { syncAgent } from ${JSON.stringify(module)}; syncAgent(${JSON.stringify(join(dir, "absent"))}, ${JSON.stringify(agent)}, {}, [], []);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { timeout: 2000, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")), { packages: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("package objects preserve filters and resolve in launch planning", () => {
  const dir = mkdtempSync(join(tmpdir(), "pibox-package-test-"));
  try {
    const home = join(dir, "home"); const project = join(dir, "project");
    mkdirSync(join(home, ".pi/agent"), { recursive: true }); mkdirSync(project);
    const spec = { source: "npm:@example/pi-tools", extensions: ["extensions/test.ts"] };
    assert.equal(packageSource(spec), spec.source);
    writeFileSync(join(home, ".pi/agent/settings.json"), JSON.stringify({ packages: [spec] }));
    const cli = fileURLToPath(new URL("../src/pibox.ts", import.meta.url));
    const result = spawnSync(process.execPath, [cli, "-C", project, "--bare", "--print-plan"], { env: { ...process.env, HOME: home, PIBOX_HOME: join(dir, "state") }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /hosts = api.openai.com, auth.openai.com/);
    const agent = join(dir, "agent");
    syncAgent(join(home, ".pi/agent"), agent, { packages: [spec] }, [spec], []);
    assert.deepEqual(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).packages, [spec]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a symlink .git cannot create an extra host bind", () => {
  const dir = mkdtempSync(join(tmpdir(), "pibox-git-test-"));
  try {
    const project = join(dir, "project"); mkdirSync(project);
    symlinkSync(tmpdir(), join(project, ".git"));
    assert.throws(() => bwrapArgv({ workspaceDir: project, workspaceMode: "rw", cacheDir: join(dir, "cache"), roMounts: [], cmd: ["/bin/bash"], env: {}, caps: { memoryMax: "4G", cpuQuota: "300%" } }, "pibox-test"), /symlink .git/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provider integrations win over conflicting model vendor names", () => {
  const providers = DEFAULT_CONFIG.providerEndpoints;
  assert.equal(providerForArgs(["--provider", "openrouter", "--model", "openai/gpt-example"], "openai", providers), "openrouter");
  assert.equal(providerForArgs(["--model", "openrouter/openai/gpt-example"], "openai", providers), "openrouter");
  assert.equal(providerForArgs(["--model", "gpt-example"], "openrouter", providers), "openrouter");
  assert.deepEqual(restrictedHosts(DEFAULT_CONFIG, "openrouter", [], []), ["openrouter.ai"]);
  assert.deepEqual(restrictedHosts(DEFAULT_CONFIG, "openai", [], []), ["api.openai.com", "auth.openai.com"]);
  assert.deepEqual(restrictedHosts(DEFAULT_CONFIG, "openrouter", [], ["api.example.com"]), ["openrouter.ai", "api.example.com"]);
  assert.throws(() => restrictedHosts(DEFAULT_CONFIG, "unknown", [], []), /no endpoint set/);
});

test("CLI network modes govern endpoint rules independently of bare capabilities", () => {
  const dir = mkdtempSync(join(tmpdir(), "pibox-network-test-"));
  try {
    const home = join(dir, "home"); const project = join(dir, "project"); const state = join(dir, "state");
    mkdirSync(home); mkdirSync(project); mkdirSync(state);
    writeFileSync(join(state, "config.json"), JSON.stringify({ ...DEFAULT_CONFIG, endpointProfiles: { minimal: [] } }));
    writeFileSync(join(state, "state.json"), JSON.stringify({ endpoints: ["github"], agent: [] }));
    const cli = fileURLToPath(new URL("../src/pibox.ts", import.meta.url));
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, "-C", project, "--bare", "--print-plan", ...args], {
      env: { ...process.env, HOME: home, PIBOX_HOME: state, PIBOX_ALLOW: "" }, encoding: "utf8",
    });
    const restricted = run("--provider", "openrouter", "--model", "openai/gpt-example", "--profile", "minimal", "--allow", "api.example.com");
    assert.equal(restricted.status, 0, restricted.stderr);
    assert.match(restricted.stderr, /hosts = openrouter.ai, api.example.com\n/);
    assert.match(restricted.stderr, /agent  = bare pi/);
    for (const mode of ["unrestricted", "none"]) {
      const result = run("--network", mode, "--provider", "unknown", "--profile", "unknown", "--allow", "api.example.com");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /hosts = \(endpoint rules inactive\)/);
    }
    const invalid = run("--network", "invalid");
    assert.equal(invalid.status, 2);
    for (const flag of ["--none", "--provider-only", "--allow-only"]) {
      const result = run(flag);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /is not supported/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("local provider config authorizes only explicit loopback service ports", () => {
  const config = { ...DEFAULT_CONFIG, providerEndpoints: { ollama: ["http://localhost:11434", "http://127.0.0.1:11434", "api.example.com"] } };
  assert.deepEqual(restrictedHosts(config, "ollama", [], []), ["api.example.com"]);
  assert.deepEqual(parseLocalEndpoints(localProviderEndpoints(config, "ollama")), [{ host: "127.0.0.1", port: 11434 }]);
  for (const url of ["http://192.168.0.1:11434", "http://169.254.169.254", "http://example.com:11434", "http://127.0.0.1:18080", "http://user@localhost:1234", "http://localhost:1234/v1", "file:///tmp/socket"]) {
    assert.throws(() => parseLocalEndpoints([url]));
  }
});
