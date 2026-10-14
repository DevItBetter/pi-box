# Agent setup instructions

Follow this file when a user asks you to install and configure pibox. Your job is to leave them with a working command, a verified sandbox, and instructions for connecting their provider. Read [README.md](README.md) for the network options and config formats. [AGENTS.md](https://github.com/DevItBetter/pi-box/blob/main/AGENTS.md) governs changes to this repository's code.

Preserve existing pi settings, credentials, shell configuration, and unrelated files. Reuse working tools and install only what is missing. Run pibox and npm as the user who will use them. Use elevated permissions only for system packages or necessary host setup.

## 1. Inspect the host

Check the operating system, architecture, active Node.js version, and required commands:

```sh
uname -s
uname -m
cat /etc/os-release
node --version
npm --version
command -v git bash curl find readlink
ls -l /usr/bin/bwrap /usr/bin/prlimit /usr/bin/systemd-run /usr/bin/systemctl
systemctl --user show-environment >/dev/null
```

Pibox needs x86_64 Linux, Node.js 23.6 or newer, npm, bubblewrap, util-linux, and a working systemd user manager with cgroup resource controls. Use Node.js 24 or newer for a new installation. Git is needed to clone this repository; curl and GNU find are needed for the live checks and disk monitoring.

On another operating system or architecture, explain the unsupported requirement. WSL and container environments must pass the same sandbox checks as any other host. Installing the packages alone does not prove that namespaces or cgroup controls work.

## 2. Install missing prerequisites

Use the host's package manager. These commands include the tools used by the setup checks:

On Fedora and other distributions that use DNF:

```sh
sudo dnf install bubblewrap util-linux systemd git curl findutils ca-certificates
```

For package details, see Fedora's [bubblewrap](https://packages.fedoraproject.org/pkgs/bubblewrap/bubblewrap/) and [util-linux](https://packages.fedoraproject.org/pkgs/util-linux/util-linux/) pages.

Debian and Ubuntu:

```sh
sudo apt update
sudo apt install bubblewrap util-linux systemd dbus-user-session git curl findutils ca-certificates
```

For another distribution, find the packages that provide the required commands. Confirm that bubblewrap, prlimit, systemd-run, and systemctl exist at their `/usr/bin` paths; the launcher uses those paths.

Check the active Node.js version before installing another runtime. Reuse the user's runtime manager if they have one. Otherwise, install a suitable distribution package or follow the [official Node.js installation instructions](https://nodejs.org/en/download). Check its version after installation; a distribution's default Node.js package may be too old.

Pibox resolves Node.js after changing its working directory to `/`. Verify that the chosen runtime works there too:

```sh
(cd / && node --version && npm --version)
```

A runtime configured only for the checkout is insufficient. Put the selected runtime on the user's normal PATH. For a manual per-user installation, use a nested directory such as `~/.local/share/node/24`. Pibox refuses runtime mounts that would expose the whole home directory or one of its direct children.

## 3. Check the user session

Run these checks as the intended user, without sudo:

```sh
systemctl --user show-environment >/dev/null
systemd-run --user --scope --quiet \
  -p MemoryMax=256M -p MemorySwapMax=0 -p CPUQuota=100% -p TasksMax=64 \
  /usr/bin/true
```

If the user bus is unavailable, check whether the agent inherited the user's login-session environment. A normal desktop or SSH login usually supplies it. If `/run/user/$(id -u)/bus` exists and belongs to the current user, use that session:

```sh
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
```

Check the manager again after setting these variables. They cannot create a missing user session. On a headless host, diagnose the login/session configuration. If enabling linger is necessary, explain that it keeps the user's manager running after logout and use `loginctl enable-linger` for that user.

If namespace creation or cgroup controls fail, report the failing command and the host policy that blocks it. Keep SELinux, AppArmor, seccomp, and pibox's containment checks enabled. Unrestricted networking does not fix missing sandbox support.

## 4. Install pibox

Use an existing pi-box checkout if the user has one. Otherwise, clone into a user-owned directory, such as `~/dev/pi-box`:

```sh
mkdir -p "$HOME/dev"
git clone https://github.com/DevItBetter/pi-box.git "$HOME/dev/pi-box"
cd "$HOME/dev/pi-box"
npm ci --ignore-scripts
npm run build
./bin/pibox --help
```

If the destination already exists, inspect it before choosing a checkout. Preserve uncommitted work. Install dependencies and build in the pi-box checkout, not in the user's project. Pi is a dependency of pi-box; a separate global pi installation is unnecessary.

Make the command available on PATH. One option is a symlink from `~/.local/bin`. From the checkout, run this only if that destination is free:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$(pwd)/bin/pibox" "$HOME/.local/bin/pibox"
```

Ensure `~/.local/bin` is on the user's PATH. If a shell startup file needs an addition, preserve its contents and avoid duplicate entries. If another `pibox` command already exists, report its path and use this checkout's `bin/pibox` until the user chooses which installation to keep. Verify `pibox --help` from outside the checkout.

## 5. Verify the sandbox

First, use temporary state and a disposable workspace. This checks an actual pi launch without credentials, provider access, or changes to the user's pi settings. Run from the checkout:

```sh
pibox_command="$(pwd)/bin/pibox"
pibox_verify_dir="$(mktemp -d /tmp/pibox-setup-XXXXXX)"
mkdir -p "$pibox_verify_dir/workspace"
PIBOX_HOME="$pibox_verify_dir/state" "$pibox_command" \
  -C "$pibox_verify_dir/workspace" --bare --no-sync --network none -- --version
```

Require a zero exit code and pi's version output. A successful `--help` or `--print-plan` alone does not verify the sandbox. After a successful launch and cleanup, remove the temporary directory:

```sh
rm -rf -- "$pibox_verify_dir"
```

If launch or containment cleanup fails, keep the directory while diagnosing the error. Inspect the reported `pibox-*.scope` before removing a retained lock or state directory.

Then run the repository checks:

```sh
npm run check
npm run test:live
```

The live test checks filesystem isolation, writable and read-only mounts, the guest environment, all network modes, and a pi completion against a temporary local API fixture. It also verifies that an unapproved local port is blocked. It needs outbound HTTPS but makes no paid model request. If outbound access is unavailable, report that the live network checks remain unverified.

Pibox reports that disk growth is monitored unless a hard disk quota is configured. That message alone is not a setup failure. Leave the default limits unless the user requests different ones. Use the README's btrfs quota instructions when a hard total disk limit is required.

## 6. Connect the user's provider

Reuse the user's existing pi configuration. Pibox normally copies it from `~/.pi/agent` into `~/.pibox/agent`. Never print authentication files or copy credentials into the repository.

Run `pibox setup` to discover configured providers and add their API and authentication endpoints without replacing existing rules. Then run `pibox doctor` for a read-only authentication and endpoint check. These commands make no network requests and do not verify live token validity. Exit status 1 reports items needing attention; setup still saves endpoints it can discover. For a provider not yet configured in Pi, use `pibox setup --provider NAME` before sign-in.

Use an explicitly selected provider when an integration and a model's vendor name differ. For example, OpenRouter serving an OpenAI model needs `--provider openrouter` and the OpenRouter endpoint set. Add custom providers to `providerEndpoints` in `~/.pibox/config.json` without replacing other entries. Keep restricted networking as the default; `--allow HOST` adds extra public hosts.

For a local model, follow the README's [local model instructions](README.md#local-models). Configure pi's model and base URL, then add its loopback origin to that provider's pibox endpoint list. Verify that the server is listening on the host's `127.0.0.1` before launch. Keep the model URL's API path in pi's config and use only the origin in pibox's config.

If authentication is missing, explain how to launch pibox with the chosen provider and use pi's `/login` command. Let the user complete interactive sign-in. Do not make a paid inference request just to finish setup unless the user asked for one.

Rerun `pibox setup` after sign-in to capture account-specific endpoints, then run `pibox doctor` again. Host environment keys and cloud credential files are absent from the sandbox. Follow the doctor's guidance to configure authentication in pibox's Pi state. Unknown extension providers and unresolved regional URLs need explicit endpoint configuration.

## 7. Report the result

Tell the user where pibox is installed, which Node.js executable it uses, how to launch it in their project, and which checks passed. List any shell or host-session changes. Distinguish a working sandbox from provider authentication or network checks that still need attention.

Give them a command using their provider and workspace, such as `pibox -C /path/to/project --provider openrouter`. Explain any remaining blocker with the failing command and the next action needed.
