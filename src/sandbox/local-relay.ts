import { chmodSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";

export interface LocalEndpoint { host: "127.0.0.1"; port: number; }

/** Explicit loopback origins only. Public hosts continue through the HTTPS proxy. */
export function parseLocalEndpoints(origins: string[]): LocalEndpoint[] {
  if (origins.length > 16) throw new Error("at most 16 local provider endpoints are supported");
  const ports = new Set<number>();
  for (const origin of origins) {
    const url = new URL(origin);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || !Number.isInteger(port) || port < 1 || port > 65535 || port === 18080) {
      throw new Error(`local endpoint must be an HTTP(S) localhost or 127.0.0.1 origin with a port other than 18080: ${origin}`);
    }
    ports.add(port);
  }
  return [...ports].map((port) => ({ host: "127.0.0.1", port }));
}

/** Each Unix socket has one immutable destination. No guest-supplied address is parsed. */
export async function startLocalRelay(socketPath: string, endpoint: LocalEndpoint): Promise<{ close(): Promise<void> }> {
  if (endpoint.host !== "127.0.0.1" || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || endpoint.port === 18080) {
    throw new Error("local relay requires a validated loopback endpoint");
  }
  const live = new Set<Socket>();
  let clients = 0;
  const server = createServer((client) => {
    if (clients >= 64) return void client.destroy();
    clients++;
    const upstream = connect({ host: endpoint.host, port: endpoint.port });
    live.add(client); live.add(upstream);
    const drop = () => { client.destroy(); upstream.destroy(); };
    client.on("error", drop); upstream.on("error", drop);
    client.setTimeout(15 * 60_000, drop);
    upstream.setTimeout(8_000, drop);
    upstream.once("connect", () => upstream.setTimeout(15 * 60_000, drop));
    client.once("close", () => { clients--; live.delete(client); upstream.destroy(); });
    upstream.once("close", () => { live.delete(upstream); client.destroy(); });
    client.pipe(upstream); upstream.pipe(client);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        try { chmodSync(socketPath, 0o600); resolve(); } catch (err) { reject(err); }
      });
    });
  } catch (err) {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(socketPath, { force: true });
    }
    throw err;
  }
  return { close: async () => {
    for (const socket of live) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    rmSync(socketPath, { force: true });
  } };
}
