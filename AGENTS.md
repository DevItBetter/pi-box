# Working on pi-box

pi-box is a standalone Linux launcher for pi inside bubblewrap. Keep orchestration policy and consumer-specific workflows out of this repository.

The CLI calls `runPiBox` in `src/index.ts`. Consumers may use that API or launch the `pibox` command. Changes must preserve namespace isolation, seccomp, clean guest environment, cgroup limits, state serialization, and the external egress allowlist.

Run `npm run check` for code changes. Changes to mounts, network routing, process handling, or the launch command also need `npm run test:live` on Linux with a working systemd user manager. The live test uses public HTTPS but spends no model tokens. Review security boundary changes independently before publishing.

Do not commit credentials, host state, session transcripts, or private repository references.
