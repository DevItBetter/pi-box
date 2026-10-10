# pi-box

Run an interactive [pi](https://github.com/earendil-works/pi) session inside a Linux bubblewrap sandbox. Choose extra network endpoints, pi packages, and extensions before launch. The `pibox` command also supports shell sessions and noninteractive pi calls.

## Install

Requires x86_64 Linux, Node.js 23.6 or newer, bubblewrap, util-linux, and a working systemd user manager with cgroup resource controls. No VM image or KVM is needed.

```sh
git clone https://github.com/DevItBetter/pi-box.git
cd pi-box
npm ci --ignore-scripts
npm run build
./bin/pibox -C /path/to/project
```

On Debian or Ubuntu, install the system tools with `sudo apt install bubblewrap util-linux`. The command uses the terminal's current directory unless you pass `-C`. You can put `bin/pibox` on PATH or run `npm link` to install the command locally.

## Launch options

```sh
pibox -C ~/dev/project                 # interactive endpoint and capability pickers
pibox --bare                           # builtin pi tools; normal network policy
pibox --profile node-dev               # named endpoint selection
pibox --agent-profile research         # named package/extension selection
pibox --network restricted             # enforce configured endpoint sets
pibox --network unrestricted           # host network, endpoint sets inactive
pibox --network none                   # no networking at all
pibox --config /path/to/config.json     # use a shared endpoint catalog
pibox --allow api.example.com          # add one HTTPS host for this launch
pibox --read-only                      # read-only project
pibox --shell                          # bash with the same sandbox boundary
pibox --print-plan                     # show selections without syncing or launching
pibox --no-sync                        # reuse the sandbox's existing pi configuration
pibox --bare -- -p "Review this project"
```

`--network` controls networking. `restricted` is the default and enforces an allowlist consisting of the selected provider's endpoints, selected extra endpoint groups, and hosts added with `--allow` or `PIBOX_ALLOW`. `unrestricted` permits the host network without an allowlist. `none` disables networking entirely, including connections to the LLM provider. It is useful for offline work or sandbox shell checks; a remote model cannot respond in that mode.

The endpoint picker and `--profile` choose extra endpoints in restricted mode. Clear the picker to allow only the provider, or define an empty endpoint profile and select it with `--profile`. `--allow` always adds hosts to that restricted allowlist. Endpoint options have no effect in unrestricted or none mode.

`--bare` skips the capability picker and disables optional packages and extensions. Builtin pi tools remain available. It does not change network access.

Unknown arguments go to pi. Use `--` to pass arguments such as pi's own `--help`. `--no-sync` preserves the previous sandbox configuration, so a new capability selection takes effect on the next synced launch.

The two checkbox pickers select extra egress endpoints and global pi packages/extensions. Arrow keys or `j`/`k` move, Space toggles, `a` selects all, `n` clears, Enter confirms, and `q` aborts. First launch defaults to no extras. Confirmed selections are saved in `~/.pibox/state.json`; a noninteractive launch reuses them.

`~/.pibox/config.json` holds provider endpoint sets, the extra endpoint catalog, and named selections. Use `--config FILE` for a different catalog. Provider sets apply only when `--network restricted` is active. It is seeded on first launch and can be edited:

```json
{
  "defaultProvider": "openai",
  "providerEndpoints": {
    "openai": ["api.openai.com", "auth.openai.com"],
    "openai-codex": ["chatgpt.com", "auth.openai.com", "api.openai.com"],
    "openrouter": ["openrouter.ai"],
    "anthropic": ["api.anthropic.com"],
    "ollama": ["http://localhost:11434"]
  },
  "endpoints": {
    "npm": ["registry.npmjs.org"],
    "github": ["github.com", "api.github.com", "codeload.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com"]
  },
  "endpointProfiles": { "minimal": [], "node-dev": ["npm", "github"] },
  "agentProfiles": { "research": ["pkg:pi-web-access", "pkg:pi-lens"] }
}
```

Provider keys name integrations, not model families. An explicit `--provider openrouter` uses only the OpenRouter endpoint set even when `--model` contains an `openai/...` model ID. `--provider openai` uses the direct OpenAI set. With no explicit provider, a recognized leading integration in `--model provider/model` selects its set; otherwise pibox uses pi's saved `defaultProvider`, then the catalog's default. Model names such as `gpt` never select endpoint permissions. Use an explicit provider when a model vendor namespace could be ambiguous.

Add your own provider key and hostnames for custom gateways. Authentication and model-catalog hosts may differ from inference hosts, so include the endpoints your integration needs. An unknown provider is refused in restricted mode until its set is configured in the catalog. In unrestricted and none modes, provider endpoint sets and extra endpoint selections are inactive.

### Local models

Pi supports OpenAI-compatible local servers, including Ollama, LM Studio, and vLLM. Start the model server on the host, then configure it in `~/.pi/agent/models.json`. For example:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

Add `"ollama": ["http://localhost:11434"]` to pibox's `providerEndpoints`, then launch `pibox --provider ollama --model qwen2.5-coder:7b`. Pi's model config keeps the `/v1` path; pibox's endpoint config names only the origin.

In restricted mode, pibox forwards each explicitly configured local port to the host's `127.0.0.1` service. HTTP and HTTPS origins using `localhost` or `127.0.0.1` are supported. Other local ports remain inaccessible. This permits the service's full TCP interface, including any administrative routes it exposes. Only the selected provider's local endpoints are forwarded; `--allow` cannot enable local access. Local forwarding is disabled in none mode. Unrestricted mode reaches the host server directly.

At most 16 local origins are accepted. Port 18080 is reserved for the public HTTPS proxy. LAN servers and IPv6 loopback origins are not currently supported in restricted mode.

Package and extension keys are discovered from `~/.pi/agent/settings.json` and `~/.pi/agent/extensions`. Package settings may be strings or objects with a `source` and resource filters. npm and git packages are supported. Host-local package paths are refused because they do not resolve inside the sandbox. Installed package caches are seeded once; update packages inside pibox after that. Selected extension files must be regular `.ts` or `.js` files. Project-local pi resources are ignored by default.

## Sandbox boundary

Pi itself, its packages, extensions, and commands run inside bubblewrap. The sandbox shares the host kernel and runs as the invoking user. It has separate user, PID, IPC, UTS, cgroup, and mount namespaces, dropped capabilities, and a seccomp filter. The launcher refuses to run if required containment is unavailable.

The project is mounted at `/workspace`, read-write by default. The real host home, other projects, and credentials outside the chosen mounts are absent. `/usr` and selected certificate/runtime files under `/etc` are read-only. Node.js and the bundled pi dependency are mounted read-only. `/tmp` and the sandbox home use isolated tmpfs mounts. The host cache and copied pi state are writable.

The launcher refuses home-directory workspaces, hidden home directories, nested mounts, sockets, pipes, devices, and symlink `.git` entries. An existing `.git` is mounted read-only. Pi can edit project files but cannot commit or change Git metadata. Linked worktree pointers may name inaccessible host paths.

In restricted mode, the sandbox has an isolated network namespace with no direct network access. An external proxy allows HTTPS CONNECT tunnels only to selected public hostnames, checks TLS SNI, and refuses localhost, LAN, metadata, and other nonpublic addresses. Explicit local provider origins use separate relays with fixed destinations. Tools that ignore the proxy can reach only those configured local ports. Provider-specific sets come from the catalog; the picker, profiles, and `--allow` add extra public hosts. An allowed endpoint can receive project contents. Provider-side features such as web search use the provider connection.

Unrestricted mode shares the host network and does not start the endpoint proxy. The sandbox can reach localhost and the LAN in this mode. None mode keeps an isolated network namespace and starts no proxy, even if hosts were supplied. Filesystem, process, seccomp, and resource limits remain in force in every mode.

## Pi state

The sandbox uses `~/.pibox/agent`, separate from the host's `~/.pi/agent`. Host auth, model metadata, and keybindings sync one way when the host copy is newer. Tokens refreshed inside pibox survive later launches. Sessions stay in the pibox copy. Settings and selected extensions are regenerated on synced launches.

Copied provider credentials are readable inside the sandbox, including by selected extensions and shell commands. The sandbox can change its copy and cannot write to the original host pi directory through these mounts. Never choose a workspace that contains secrets you do not want pi to read.

One session may use a state directory at a time. A lock covers sync, launch, and cleanup. If a process was killed abruptly, inspect the corresponding `pibox-*.scope` before removing `active.lock`. A failed containment cleanup keeps the lock and reports the scope name.

## Resource limits

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PIBOX_HOME` | `~/.pibox` | Catalog, selections, sandbox state, and cache |
| `PIBOX_MEMORY` | `4G` | Cgroup memory limit; swap is disabled |
| `PIBOX_CPU_QUOTA` | `300%` | Cgroup CPU quota |
| `PIBOX_ALLOW` | empty | Additional HTTPS hosts, comma-separated |
| `PIBOX_FILE_MAX` | `4G` | Hard limit on an individual file |
| `PIBOX_CACHE_MAX` | `4G` | Monitored cache size limit |
| `PIBOX_WRITE_GROWTH_MAX` | `8G` | Monitored growth of other writable mounts |
| `PIBOX_DISK_QUOTA_ROOT` | unset | Optional quota-limited btrfs subvolume |

Disk monitoring can overshoot and cannot account for every open, unlinked file. It is not a hard aggregate disk bound. Every launch announces that limitation when no quota root is configured. To enforce a hard bound, configure a limited btrfs qgroup and set `PIBOX_DISK_QUOTA_ROOT` to its subvolume root. Every writable disk directory must live in that subvolume; the launcher verifies this and refuses failures. There is no fallback after a configured quota check fails.

## Integration

The launcher has no dependency on a particular orchestrator or repository layout. Consumers can invoke the CLI or import its session API. The API takes explicit workspace, state, and egress choices and returns the child exit code. It owns the state lock and cleanup; it does not schedule work, choose models, review changes, or capture Git commits.

```ts
import { runPiBox } from "pi-box";

const exitCode = await runPiBox({
  workspace: "/path/to/project",
  stateDir: "/path/to/isolated-state/agent",
  readOnly: true,
  networkMode: "restricted",
  allow: ["auth.openai.com", "api.openai.com", "chatgpt.com"],
  runShell: false,
  piArgs: ["-p", "Review this project"],
});
```

The caller supplies prepared state, or an optional `sync` object with `source`, `settings`, `packages`, and `extensions`. For local models, pass `localEndpoints: ["http://127.0.0.1:11434"]`; these apply only in restricted mode. Give each concurrent job a separate state directory. Resource limits use the documented environment variables. `pi-box/config` exports provider selection and endpoint resolution helpers. `pi-box/sandbox` exports mount construction, resource monitoring, and seccomp launch helpers; `pi-box/egress` exports the proxy for consumers that need lower-level assembly.

The package ships compiled JavaScript and TypeScript declarations. Install it from Git with `npm install git+https://github.com/DevItBetter/pi-box.git`. There is no npm registry release yet. The Git installation runs the build during preparation.

## Development

`npm run check` runs strict type checking and free tests. `npm run test:live` runs pi in a real bubblewrap sandbox and checks host isolation, read-write/read-only mounts, clean environment, allowed provider HTTPS, and blocked egress. It also completes a pi request against a temporary local API fixture and checks that an unapproved local service is inaccessible. It needs a working user manager and outbound HTTPS; it makes no paid model request.

Licensed under [Apache 2.0](LICENSE).
