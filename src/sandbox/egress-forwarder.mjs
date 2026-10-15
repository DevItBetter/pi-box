// Runs INSIDE a bwrap sandbox: listens on the sandbox's own loopback and relays
// every connection to the egress proxy's Unix socket (src/sandbox/egress-proxy.ts).
//
//   node egress-forwarder.mjs <socket-path> <port> [local-config] -- <command> [args...]
//
// It exists because HTTPS_PROXY takes a host:port, not a socket path. It makes
// no decisions: the allowlist lives on the other side of the socket, outside
// the sandbox, where the code it constrains cannot edit it.
//
// It wraps the command rather than running beside it so the two share a
// lifetime: the forwarder is up before the command starts, the command's exit
// code is the wrapper's, and nothing is left listening afterwards. Plain
// JavaScript with no imports outside node: it must run with whatever node the
// sandbox was given and no node_modules.
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { readFileSync } from "node:fs";
import { constants } from "node:os";

const sep = process.argv.indexOf("--");
const [socketPath, portArg, localConfig] = process.argv.slice(2, sep);
const command = process.argv.slice(sep + 1);
if (sep < 0 || socketPath === undefined || !/^\d+$/.test(portArg ?? "") || command.length === 0) {
  console.error("usage: egress-forwarder.mjs <socket-path> <port> [local-config] -- <command> [args...]");
  process.exit(64);
}

function relay(socketPath) {
  return createServer((client) => {
    const upstream = connect(socketPath);
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", drop);
    upstream.on("error", drop);
    client.pipe(upstream);
    upstream.pipe(client);
  });
}
const server = relay(socketPath);

server.on("error", (err) => {
  console.error(`egress-forwarder: ${err.message}`);
  process.exit(69);
});

const locals = localConfig ? JSON.parse(readFileSync(localConfig, "utf8")) : [];
await Promise.all(locals.map(({ port, socketPath }) => new Promise((resolve, reject) => {
  const listener = relay(socketPath);
  listener.once("error", reject);
  listener.listen(port, "127.0.0.1", resolve);
})));
server.listen(Number(portArg), "127.0.0.1", () => {
  // Inherits exactly this process's environment, which carries no project
  const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => child.kill(sig));
  child.on("error", (err) => {
    console.error(`egress-forwarder: could not start ${command[0]}: ${err.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    server.close();
    process.exit(signal !== null ? 128 + constants.signals[signal] : (code ?? 1));
  });
});
