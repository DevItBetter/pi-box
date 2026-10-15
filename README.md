# pi-box

pi-box runs [pi](https://github.com/earendil-works/pi) inside a Linux bubblewrap sandbox. The `pibox` command lets you choose which endpoints, packages, and extensions pi can use. You can also run a shell or pass a prompt directly to pi.

## Install

You need x86_64 Linux, Node.js 23.6 or newer, bubblewrap, util-linux, and a working systemd user manager with cgroup resource controls.

```sh
git clone https://github.com/DevItBetter/pi-box.git
cd pi-box
npm ci --ignore-scripts
npm run build
./bin/pibox setup
./bin/pibox -C /path/to/project
```

On Debian or Ubuntu, install the system tools with `sudo apt install bubblewrap util-linux`.

On Fedora and other distributions that use DNF:

```sh
sudo dnf install bubblewrap util-linux
```

These commands install the sandbox tools. You still need the Node.js version and systemd user manager listed above.

Add `bin/pibox` to your PATH or run `npm link` to install the command. By default, pibox mounts your current directory as the workspace. Use `-C` to choose another directory.

### Let an agent set it up

Give your agent this instruction:

> Read https://github.com/DevItBetter/pi-box/blob/main/SETUP.md and follow it to set up pibox on my system.

[SETUP.md](SETUP.md) covers prerequisites, installation, provider configuration, and checks that prove the sandbox runs.

## Launch options

```sh
pibox setup                            # discover providers and configure their egress endpoints
pibox doctor                           # report authentication and endpoint problems
pibox profiles                         # list endpoint groups and selection profiles
pibox --save-defaults                  # choose default selections and exit
pibox -C ~/dev/project                 # choose extra endpoints, packages, and extensions
pibox --bare                           # built-in pi tools, no optional packages or extensions
pibox --no-tui                         # reuse remembered selections without prompts
pibox --profile node-dev               # allow the hosts in an endpoint profile
pibox --agent-profile research         # enable packages and extensions from a profile
pibox --network restricted             # enforce the allowlist; this is the default
pibox --network unrestricted           # use the host network without endpoint restrictions
pibox --network none                   # disable networking, including provider connections
pibox --config /path/to/config.json     # read endpoint settings from another file
pibox --allow api.example.com          # add an HTTPS host in restricted mode
pibox --read-only                      # read-only project
pibox --shell                          # run bash inside the sandbox
pibox --print-plan                     # show selections without syncing or launching
pibox --print-plan=json                # machine-readable launch plan, without prompts
pibox --no-sync                        # reuse the sandbox's existing pi configuration
pibox --bare -- -p "Review this project"
```

`--bare` skips the package and extension picker and disables those optional additions. Pi's built-in tools remain available. This flag does not change network access.

Unknown arguments go to pi. Use `--` to pass arguments such as pi's own `--help`. With `--no-sync`, pibox reuses its existing pi configuration. Package and extension selections take effect when you next launch with sync enabled.

Launch previews include workspace access, endpoint rules, state location, packages, extension paths, the guest command, and resource limits. `--print-plan=json` writes a versioned JSON object to stdout and skips the pickers. With `--no-sync`, previews report the packages and extensions already in sandbox state. The command is the guest Pi or shell command; restricted-mode network plumbing is started around it at launch. Previews do not probe containment or provider connectivity.

The launch pickers show extra endpoints and your global pi packages and extensions. Use arrow keys or `j`/`k` to move, Space to toggle, `a` to select all, `n` to clear, Enter to confirm, and `q` to cancel. On the first launch, all extras are off. Pibox saves your choices in `~/.pibox/state.json` and reuses them for noninteractive launches.

Optional `defaultSelections` in the config contains `endpoints` and `agent` arrays. Defaults apply only when the corresponding remembered selection is absent. Remembered empty arrays stay empty. Explicit profiles and `--bare` take precedence. `--save-defaults` saves the resolved selections to the chosen config and exits without launching or changing remembered selections. Combine it with `--no-tui` or explicit profiles to skip prompts. It cannot be combined with `--print-plan`.

## Networking

| Mode | Access |
| --- | --- |
| `restricted` | Selected provider endpoints, selected extra endpoint groups, and hosts added with `--allow` or `PIBOX_ALLOW`. This is the default. |
| `unrestricted` | The host network, including localhost and the LAN, without an allowlist. |
| `none` | No networking. Remote models and host-local model servers cannot respond. Use this for offline work or shell checks. |

In restricted mode, clear the endpoint picker to allow only the provider. For the same result without the picker, define an empty endpoint profile and select it with `--profile`. `--allow` adds hosts to the allowlist. Endpoint settings have no effect in unrestricted or none mode.

### Provider config

Run `pibox setup` after configuring or signing into a provider in Pi. It reads Pi settings, stored authentication, custom `models.json` providers, and built-in provider metadata. It adds exact API and known authentication hosts to `providerEndpoints`, including the account-specific Copilot API host. Existing entries, profiles, and other settings remain intact. `--config FILE` chooses another pibox config; `--provider NAME` includes a provider you want to configure before signing in.

`pibox doctor` performs the same discovery without writing files. Both commands report missing authentication, API-key commands that need manual verification, unsupported URLs, and unknown extension endpoints. Exit status is 0 when all discovered providers have usable offline authentication configuration and endpoint rules, 1 when something needs attention, or 2 for invalid input. Setup writes the endpoints it can discover even when authentication still needs attention.

These checks make no network or model requests, refresh no tokens, execute no API-key commands or extensions, and leave Pi credentials unchanged. They inspect the newer host or sandbox authentication and model files, matching normal sync behavior. Expired OAuth tokens are reported as needing refresh by Pi. Authentication validity and connectivity still need verification when you use the provider.

The sandbox does not inherit host API-key environment variables or cloud credential files. Use `/login` inside pibox to store credentials in its Pi state, or configure Pi's `models.json` for the sandbox. For a new provider, run `pibox setup --provider NAME`, launch `pibox --provider NAME`, complete `/login`, and rerun setup. Custom API-key commands and extension providers may need manual configuration. Providers with regional or account-specific URL placeholders need concrete endpoint rules.

Pibox creates `~/.pibox/config.json` on first launch. Edit it to define provider endpoints, extra endpoint groups, and profiles, or use `--config FILE` to read another file. For example:

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

Provider keys identify the integration serving the request. `--provider openrouter` selects OpenRouter's endpoints even when the model ID starts with `openai/`. `--provider openai` selects the direct OpenAI endpoints.

Without `--provider`, pibox checks the prefix in `--model provider/model`. If that prefix matches a configured provider, it uses that provider. Otherwise, it uses the `defaultProvider` in your host pi settings, falling back to the pibox config. Pass `--provider` when a model ID could refer to more than one integration.

For a custom gateway, add its provider key and hostnames to `providerEndpoints`. Include authentication and model-catalog hosts if the integration needs them. Restricted mode refuses providers that have no configured endpoint set.

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

Add `"ollama": ["http://localhost:11434"]` to pibox's `providerEndpoints`, then launch `pibox --provider ollama --model qwen2.5-coder:7b`. Keep `/v1` in pi's model config. The pibox entry contains only the scheme, host, and port.

In restricted mode, pibox forwards the selected provider's local ports to services on the host's `127.0.0.1`. Each relay carries all TCP traffic to its approved port, including requests to any administrative routes on that service. Other local ports remain inaccessible. `--allow` cannot enable local access.

Local entries accept HTTP or HTTPS URLs using `localhost` or `127.0.0.1`. Pibox creates no local relays in none mode. Unrestricted mode reaches the host server directly.

You can configure up to 16 local entries. Port 18080 is reserved for the public HTTPS proxy. Restricted mode does not support LAN servers or IPv6 loopback URLs.

## Packages and extensions

Pibox reads the available package and extension keys from `~/.pi/agent/settings.json` and `~/.pi/agent/extensions`. Use those keys in `agentProfiles` to save named selections.

Package settings can be strings or objects with a `source` and resource filters. Pibox supports npm and git packages. It refuses host-local package paths because they cannot resolve inside the sandbox. It copies installed package caches once; update packages inside pibox after that.

Endpoint and capability profiles accept a member array or an object with a label and description. Both the picker and `pibox profiles` display this metadata. For example:

```json
"agentProfiles": {
  "research": {
    "members": ["pkg:pi-web-access", "pkg:pi-lens"],
    "label": "Research tools",
    "description": "Web access and source inspection"
  }
}
```

Selected extensions must be regular `.ts` or `.js` files. Pi ignores project-local resources by default.

Pibox includes a built-in Pi UI extension, including in bare mode. It shows the launch network mode, workspace access, and provider in the footer. Use `/pibox` inside Pi to inspect the launch allowlist, local provider endpoints, and enabled capabilities. These details describe the launch configuration; they do not verify connectivity or track later provider changes.

## Sandbox boundary

Pi, its packages, extensions, and commands run inside bubblewrap. The sandbox shares the host kernel and runs as the invoking user. Bubblewrap creates separate user, PID, IPC, UTS, cgroup, and mount namespaces. Pibox drops capabilities and applies a seccomp filter. If required containment is unavailable, the launcher refuses to run.

Pibox mounts your project at `/workspace`, read-write by default. The host home, other projects, and credentials outside the chosen mounts are absent. It mounts `/usr`, selected certificate and runtime files under `/etc`, Node.js, and the bundled pi dependency read-only. `/tmp` and the sandbox home use isolated tmpfs mounts. The cache and copied pi state are writable.

The launcher refuses home-directory workspaces, hidden home directories, nested mounts, sockets, pipes, devices, and symlink `.git` entries. It mounts an existing `.git` read-only, so pi can edit project files but cannot commit or change Git metadata. Linked worktree pointers may refer to host paths the sandbox cannot access.

Restricted mode isolates the network namespace. An external proxy permits HTTPS CONNECT tunnels to allowed public hostnames, checks the TLS server name, and blocks localhost, LAN, cloud metadata, and other nonpublic addresses. Configured local provider ports use separate relays with fixed destinations. Tools that ignore the proxy can reach only those local ports.

An allowed endpoint can receive project contents. Provider features such as web search use the provider connection.

Unrestricted mode shares the host network without a proxy. None mode isolates the network and starts neither a proxy nor local relays, even if you supplied endpoints. Filesystem, process, seccomp, and resource limits apply in every mode.

## Pi state

The sandbox uses `~/.pibox/agent`. On synced launches, pibox copies authentication files, model metadata, and keybindings from `~/.pi/agent` when the host copy is newer. Tokens refreshed inside pibox survive later launches. Sessions stay in the pibox directory. Pibox rewrites settings and selected extensions on each synced launch.

Selected extensions and shell commands can read the copied provider credentials. The sandbox can change its copies, but these mounts give it no write access to the host's pi directory. Choose a workspace whose contents you are comfortable letting pi read.

Only one session can use a state directory at a time. Pibox holds a lock during sync, launch, and cleanup. After an abrupt stop, inspect the session's `pibox-*.scope` before removing `active.lock`. If pibox cannot confirm containment cleanup, it keeps the lock and reports the scope name.

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

Disk monitoring can overshoot and miss open files that have been unlinked. Without a quota root, pibox reports that it has no hard limit on total disk use.

For a hard limit, configure a btrfs qgroup with a size limit and set `PIBOX_DISK_QUOTA_ROOT` to its subvolume root. Every writable disk directory must be inside that subvolume. Pibox checks this before launch and refuses to run if the configured quota check fails.

## Integration

Call the CLI from another tool or import `runPiBox` to run a session. The API accepts the workspace, state directory, network settings, and pi arguments. It handles the state lock and cleanup, then returns the child process's exit code.

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

Prepare the state directory yourself or pass a `sync` object with `source`, `settings`, `packages`, and `extensions`. For local models in restricted mode, pass `localEndpoints: ["http://127.0.0.1:11434"]`. Give each concurrent job a separate state directory. Set resource limits through the environment variables listed above.

For direct access to individual components:

- `pi-box/config` exports provider selection and endpoint helpers.
- `pi-box/sandbox` exports mount construction, resource monitoring, and seccomp launch helpers.
- `pi-box/egress` exports the public HTTPS proxy.

Install the package with `npm install git+https://github.com/DevItBetter/pi-box.git`. The Git installation builds the JavaScript and TypeScript declarations. There is no npm registry release yet.

## Development

`npm run check` runs strict type checking, the build, and unit tests.

`npm run test:live` runs pi inside bubblewrap and checks host isolation, writable and read-only mounts, the guest environment, allowed provider HTTPS, and blocked connections. It also completes a pi request against a temporary local API fixture and checks that an unapproved local service is inaccessible. The live test needs a working systemd user manager and outbound HTTPS. It makes no paid model request.

Licensed under [Apache 2.0](LICENSE).
