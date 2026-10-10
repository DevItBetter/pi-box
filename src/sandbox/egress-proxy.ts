// An allowlisting egress proxy on a Unix socket: the only way out of a bwrap
// sandbox that was given one.
//
// A bwrap sandbox here has no network namespace route (`--unshare-all`). An
// agent step still has to reach its model provider. Sharing the host's network
// would hand it localhost and the LAN; a user-mode NAT would hand it every
// hostname on the internet. This gives it a FILE: a socket whose other end is
// else, and writes down every attempt. Inside the sandbox a forwarder
// (egress-forwarder.mjs) listens on the sandbox's own loopback and relays to
// the socket, and HTTPS_PROXY points at the forwarder. A tool that ignores the
// proxy variables has no network at all, which is the safe way to fail.
//
// CONNECT only. Every provider endpoint is HTTPS, and a plain-HTTP request
// through a proxy would let the proxy's allowlist be argued with by a Host
// header; a tunnel has one hostname, the one in the CONNECT line.
//
// What it does NOT do: inspect the TLS stream. An allowed hostname is trusted
// for whatever the agent says to it, including the contents of the workspace.
// The allowlist is the control; keep it to the provider's own hosts.
import { lookup as dnsLookup } from "node:dns/promises";
import { connect, createServer as createNetServer, isIP, type Socket } from "node:net";
import { chmodSync, existsSync, rmSync } from "node:fs";

export interface EgressLogEntry {
  ts: string;
  host: string;
  port: number;
  allowed: boolean;
  /** Why it was refused, or null. */
  reason: string | null;
  bytesUp: number;
  bytesDown: number;
}

export interface EgressProxyOpts {
  /** Hostnames. "example.com" matches exactly; ".example.com" matches any subdomain (not the apex). */
  allow: string[];
  /** Where to listen. Created 0600; an existing file is replaced. */
  socketPath: string;
  /** Ports a tunnel may name. Default [443]. */
  ports?: number[];
  /** Called once per finished tunnel or refusal. */
  onEntry?: (e: EgressLogEntry) => void;
  /** Test seam: resolve a hostname. Default: the system resolver. */
  lookup?: (host: string) => Promise<string | string[]>;
  /**
   * Test seam: permit a resolved address that is loopback, private or
   * link-local. Default false, so an allowlisted NAME that resolves inward
   * (a poisoned resolver, a DNS rebind) still cannot reach the host's own
   * services or the LAN.
   */
  allowPrivateAddresses?: boolean;
  /**
   * Test seam, default TRUE: carry only TLS whose ClientHello names the
   * allowlisted host (see `clientHelloSni`). The plain-HTTP fixtures this file's
   * tests tunnel to cannot send one; nothing else has a reason to turn it off.
   */
  requireTlsSni?: boolean;
  /** Test seam: how long a connection may take to send its request headers. Default `EGRESS_HEADERS_MS`. */
  headersTimeoutMs?: number;
}

/** Tunnels one proxy carries at once, and how long one may sit idle. */
export const EGRESS_MAX_TUNNELS = 64;
export const EGRESS_IDLE_MS = 15 * 60_000;
/** How long one resolved address gets to connect before the next is tried. */
export const EGRESS_DIAL_MS = 8_000;
/** How much a client may send before its tunnel exists. */
export const EGRESS_EARLY_BYTES = 64 * 1024;
/** Connections allowed beyond the tunnel cap while their headers are still arriving, and how long they get. */
export const EGRESS_HANDSHAKE_SLACK = 16;
export const EGRESS_HEADERS_MS = 10_000;

/** How many log entries the proxy keeps. The counters below are never truncated. */
export const EGRESS_LOG_CAP = 500;

export interface EgressProxy {
  socketPath: string;
  /**
   * The most recent `EGRESS_LOG_CAP` entries. Bounded because this array lives
   * in the PIBOX process, outside the sandbox's MemoryMax: sandboxed code can
   * open its forwarder in a loop, and an unbounded log would let it spend the
   * host's memory one refusal at a time.
   */
  entries: EgressLogEntry[];
  /** Tunnels carried and attempts refused, over the proxy's whole life. */
  readonly allowedTotal: number;
  readonly refusedTotal: number;
  /**
   * The first error `onEntry` threw, or null. The sink runs inside this
   * server's socket callbacks, where a throw would be an uncaught exception in
   * the pibox process rather than a failure of the one step that owns the
   * proxy — so it is caught here and left for that step to raise.
   */
  readonly sinkError: unknown;
  close(): Promise<void>;
}

/** True for an allowlist match. Case-insensitive; a trailing dot is ignored. */
export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "" || isIP(h) !== 0) return false; // names only: an IP literal skips the resolver check's premise
  return allow.some((entry) => {
    const a = entry.toLowerCase().replace(/\.$/, "");
    return a.startsWith(".") ? h.endsWith(a) && h.length > a.length : h === a;
  });
}

/**
 * Every block the IANA special-purpose address registries list as NOT globally
 * reachable, plus multicast and the reserved space. DATA, copied from the
 * registries, because the hand-written conditions this replaces had a gap found
 * in three separate reviews (site-local and benchmarking; two IPv6 ranges;
 * 192.88.99.0/24): a condition per remembered range is a list with holes, and
 * every hole is a route to the LAN for an allowlisted name with a poisoned
 * answer. To change it, change the table and cite the registry.
 *
 *   https://www.iana.org/assignments/iana-ipv4-special-registry
 *   https://www.iana.org/assignments/iana-ipv6-special-registry
 */
export const NON_PUBLIC_V4: ReadonlyArray<readonly [string, number, string]> = [
  ["0.0.0.0", 8, "this network"],
  ["10.0.0.0", 8, "private use"],
  ["100.64.0.0", 10, "shared address space (CGNAT)"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link local (cloud metadata lives here)"],
  ["172.16.0.0", 12, "private use"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation (TEST-NET-1)"],
  ["192.88.99.0", 24, "deprecated 6to4 relay anycast"],
  ["192.168.0.0", 16, "private use"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation (TEST-NET-2)"],
  ["203.0.113.0", 24, "documentation (TEST-NET-3)"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved, and limited broadcast"],
];

/** [first 32 bits, prefix length <= 32, what it is]. Global unicast is 2000::/3; all else is refused wholesale. */
export const NON_PUBLIC_V6_IN_GLOBAL_UNICAST: ReadonlyArray<readonly [number, number, string]> = [
  [0x20010000, 23, "IETF protocol assignments: Teredo, benchmarking 2001:2::/48, ORCHIDv2, AMT, AS112, DRIP, port control"],
  [0x20010db8, 32, "documentation"],
  [0x20020000, 16, "6to4 (wraps an IPv4 this function was never shown)"],
  [0x3fff0000, 20, "documentation"],
];

const v4ToInt = (ip: string): number => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
const inBlock = (value: number, base: number, bits: number): boolean =>
  bits === 0 || Math.floor(value / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits));

/** The first 32 bits of an IPv6 address, from its first two groups (`::` expands to zeroes). */
function v6Head(v6: string): number {
  const [left = ""] = v6.split("::");
  const groups = left === "" ? [] : left.split(":");
  const g = (n: number): number => parseInt(groups[n] ?? "0", 16) || 0;
  return g(0) * 65536 + g(1);
}

/** The IPv4 address inside a 64:ff9b::/96 address, or null. Accepts the hex and the dotted tail. */
function nat64Embedded(v6: string): string | null {
  const m = /^64:ff9b::(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/.exec(v6);
  if (m === null) return /^64:ff9b::([0-9a-f]{1,4})?$/.test(v6) ? "0.0.0.0" : null;
  if (m[3] !== undefined) return m[3];
  const hi = parseInt(m[1]!, 16);
  const lo = parseInt(m[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True unless the address is globally reachable unicast. Anything not recognised is inward. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return NON_PUBLIC_V4.some(([base, bits]) => inBlock(n, v4ToInt(base), bits));
  }
  if (isIP(ip) !== 6) return true;
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped !== null) return isPrivateAddress(mapped[1]!);
  // 64:ff9b::/96, the well-known NAT64 prefix, IS globally reachable (the
  // registry says so), and on an IPv6-only host with DNS64 it is the only
  // address an IPv4-only provider resolves to: refusing it cut such a host off
  // from its provider entirely. But the last 32 bits are an IPv4 address the
  // translator will connect to, so that address is judged like any other —
  // 64:ff9b::10.0.0.1 is the LAN in a different spelling.
  const nat64 = nat64Embedded(v6);
  if (nat64 !== null) return isPrivateAddress(nat64);
  const head = v6Head(v6);
  if (!inBlock(head, 0x20000000, 3)) return true;
  return NON_PUBLIC_V6_IN_GLOBAL_UNICAST.some(([base, bits]) => inBlock(head, base, bits));
}

/** The most bytes a ClientHello may take, and how long a client has to send one after its 200. */
export const EGRESS_HELLO_BYTES = 16 * 1024 + 5;
export const EGRESS_HELLO_MS = 10_000;

/**
 * The server name in a TLS ClientHello: the name, `null` when these bytes are
 * not a ClientHello that names one, or "more" when the record is not all here.
 *
 * Why the proxy reads it. A CONNECT decides which ADDRESS is dialled and nothing
 * else; after the 200 the client speaks TLS and picks the server name itself.
 * When the allowlisted name lives on a shared edge (a CDN, a cloud front door),
 * that address serves thousands of tenants, and an SNI naming another of them
 * turns "may reach the provider" into "may reach anything on that edge". So the
 * tunnel carries only a ClientHello whose SNI is the name that was allowlisted.
 *
 * What it does NOT close: a request INSIDE the encrypted stream whose Host
 * header names a different tenant than its SNI (domain fronting proper). That
 * is invisible without terminating TLS; most large edges refuse the mismatch
 */
export function clientHelloSni(buf: Buffer): string | null | "more" {
  if (buf.length < 5) return "more";
  if (buf[0] !== 0x16 || buf[1] !== 0x03) return null; // not a TLS handshake record
  const recordLen = buf.readUInt16BE(3);
  if (recordLen > 16 * 1024) return null;
  if (buf.length < 5 + recordLen) return "more";
  const hs = buf.subarray(5, 5 + recordLen);
  if (hs.length < 4 || hs[0] !== 0x01) return null; // not a ClientHello
  const helloLen = hs.readUIntBE(1, 3);
  // A hello split over several records is legal and unheard of from real
  // clients; it is refused rather than reassembled.
  if (helloLen + 4 > hs.length) return null;
  let o = 4 + 2 + 32; // handshake header, client_version, random
  const skip = (lenBytes: 1 | 2): boolean => {
    if (o + lenBytes > hs.length) return false;
    o += lenBytes + (lenBytes === 1 ? hs[o]! : hs.readUInt16BE(o));
    return o <= hs.length;
  };
  if (!skip(1) || !skip(2) || !skip(1)) return null; // session_id, cipher_suites, compression
  if (o + 2 > hs.length) return null;
  const extEnd = o + 2 + hs.readUInt16BE(o);
  o += 2;
  if (extEnd > hs.length) return null;
  while (o + 4 <= extEnd) {
    const type = hs.readUInt16BE(o);
    const len = hs.readUInt16BE(o + 2);
    o += 4;
    if (o + len > extEnd) return null;
    if (type === 0x0000) {
      // server_name_list: u16 length, then { u8 type, u16 length, name }
      if (len < 5 || hs[o + 2] !== 0x00) return null;
      const nameLen = hs.readUInt16BE(o + 3);
      if (5 + nameLen > len) return null;
      return hs.subarray(o + 5, o + 5 + nameLen).toString("latin1").toLowerCase();
    }
    o += len;
  }
  return null;
}

/** The most header bytes a request may send. A CONNECT line and a Host header are a few hundred. */
export const EGRESS_HEADER_BYTES = 8 * 1024;

/**
 * The server is a plain `net.Server` and every connection is ONE object with
 * ONE lifecycle, on purpose. The first version sat on `http.Server` and tracked
 * sockets by hand around it, and eight review passes kept finding the seam
 * between the two lifecycles: CONNECT sockets that `server.close()` does not
 * wait for, a header timeout Node owns and a deadline this file owned, a
 * refused client half-closed and still holding a slot, a lookup outliving the
 * client that asked for it. Here there is one accounting rule:
 *
 *   a connection holds its slot from `accept` until EVERYTHING it started has
 *   finished — its sockets closed AND any DNS lookup it began settled.
 *
 * So nothing a sandboxed client can start is left uncounted in this process,
 * which lives outside every limit the sandbox has.
 */
/**
 * Lookups in flight across EVERY proxy in this process, including proxies that
 * have already closed. A lookup cannot be cancelled, and `close()` does not
 * wait for one for ever, so a per-proxy bound alone lets each step of a run
 * abandon another batch against a stalled resolver. They share libuv's small
 * thread pool with the pibox's own file I/O; this is the bound that stays
 * charged until the lookup really settles.
 */
let lookupsInFlight = 0;
export const EGRESS_MAX_LOOKUPS = 128;
/** Test seam: the process-wide count. */
export const egressLookupsInFlight = (): number => lookupsInFlight;

export function startEgressProxy(opts: EgressProxyOpts): Promise<EgressProxy> {
  const ports = opts.ports ?? [443];
  const headersMs = opts.headersTimeoutMs ?? EGRESS_HEADERS_MS;
  const resolve =
    opts.lookup ?? (async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address));
  const entries: EgressLogEntry[] = [];
  let allowedTotal = 0;
  let refusedTotal = 0;
  let sinkError: unknown = null;
  let closing = false;
  /** Connections holding a slot, and those of them that got as far as a valid CONNECT. */
  let connections = 0;
  let tunnels = 0;
  const live = new Set<{ destroy(): void; done: Promise<void> }>();

  const record = (e: EgressLogEntry): void => {
    if (e.allowed) allowedTotal++;
    else refusedTotal++;
    entries.push(e);
    if (entries.length > EGRESS_LOG_CAP) entries.shift();
    try {
      opts.onEntry?.(e);
    } catch (err) {
      sinkError ??= err;
    }
  };

  const onConnection = (client: Socket): void => {
    if (closing || connections >= EGRESS_MAX_TUNNELS + EGRESS_HANDSHAKE_SLACK) return void client.destroy();
    connections++;
    let upstream: Socket | null = null;
    let lookupPending = false;
    let isTunnel = false;
    let clientClosed = false;
    let logged = false;
    let host = "";
    let port = 0;
    let up = 0;
    let down = 0;
    let settle!: () => void;
    const done = new Promise<void>((r) => (settle = r));
    let released = false;

    /** The slot goes back when the client is closed, the upstream is closed, and no lookup is running. */
    const maybeRelease = (): void => {
      if (released || !clientClosed || lookupPending || (upstream !== null && !upstream.destroyed)) return;
      released = true;
      connections--;
      if (isTunnel) tunnels--;
      live.delete(conn);
      settle();
    };
    const log = (allowed: boolean, reason: string | null): void => {
      if (logged) return;
      logged = true;
      record({ ts: new Date().toISOString(), host, port, allowed, reason, bytesUp: up, bytesDown: down });
    };
    const destroyAll = (): void => {
      upstream?.destroy();
      client.destroy();
    };
    const conn = { destroy: destroyAll, done };
    live.add(conn);

    // The header deadline is WALL-CLOCK, from accept to a parsed request. A
    // socket timeout measures silence, and a client that drips one byte inside
    // every window is never silent: it held its slot for the whole step. (Third
    // form of this bound: no deadline, then one cleared by the first byte, then
    // an inactivity timer. An absolute timer has no fourth.)
    const headerDeadline = setTimeout(destroyAll, headersMs);
    headerDeadline.unref();
    client.on("error", destroyAll);
    client.once("close", () => {
      clientClosed = true;
      clearTimeout(headerDeadline);
      upstream?.destroy();
      // A carried tunnel is logged when it ends; an allowlisted CONNECT whose
      // client left before any connection was made is logged as exactly that.
      // At shutdown a tunnel that WAS carrying traffic is still logged (the
      // step's summary must include it); an attempt that never got past its
      // lookup is not, because the step is over and nobody asked for it twice.
      if (isTunnel && upstream !== null) log(true, null);
      else if (isTunnel && !closing) log(true, "client closed before the name resolved; no connection was made");
      maybeRelease();
    });

    /** Answer, then CLOSE. `end()` alone half-closes, and a client that keeps its side open keeps the slot. */
    const refuse = (status: number, reason: string): void => {
      log(false, reason);
      client.end(`HTTP/1.1 ${status} Refused\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\negress refused: ${reason}\n`, destroyAll);
      setTimeout(destroyAll, 1_000).unref();
    };

    let buf = Buffer.alloc(0);
    const early: Buffer[] = [];
    let earlyBytes = 0;
    let headersDone = false;

    const onHeaders = (headerText: string, rest: Buffer): void => {
      const [requestLine = "", ...headerLines] = headerText.split("\r\n");
      const [method = "", target = ""] = requestLine.split(" ");
      if (method !== "CONNECT") {
        // Still an egress attempt, and the log promises every attempt.
        try {
          const u = new URL(target, "http://invalid.invalid");
          if (u.hostname !== "invalid.invalid") {
            host = u.hostname;
            port = Number(u.port || 80);
          }
        } catch {
          /* unparseable target: fall through to the Host header */
        }
        if (host === "") {
          const h = headerLines.find((l) => /^host:/i.test(l))?.slice(5).trim() ?? "";
          host = h.replace(/:\d+$/, "");
          port = Number(/:(\d+)$/.exec(h)?.[1] ?? 80);
        }
        log(false, `${method || "?"} is not CONNECT; this proxy tunnels CONNECT only`);
        client.end("HTTP/1.1 405 Method Not Allowed\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nthis proxy tunnels CONNECT only\n", destroyAll);
        setTimeout(destroyAll, 1_000).unref();
        return;
      }
      const m = /^([^:\s]+):(\d{1,5})$/.exec(target);
      host = m?.[1] ?? "";
      port = Number(m?.[2] ?? 0);
      if (m === null) return refuse(400, "malformed CONNECT target");
      if (!ports.includes(port)) return refuse(403, `port ${port} is not permitted`);
      if (!hostAllowed(host, opts.allow)) return refuse(403, `host ${host} is not on this step's egress allowlist`);
      if (tunnels >= EGRESS_MAX_TUNNELS) return refuse(429, `more than ${EGRESS_MAX_TUNNELS} tunnels are open`);
      if (lookupsInFlight >= EGRESS_MAX_LOOKUPS) {
        return refuse(503, `more than ${EGRESS_MAX_LOOKUPS} name lookups are in flight in this process`);
      }
      tunnels++;
      isTunnel = true;
      if (rest.length > 0) keepEarly(rest);
      client.setTimeout(EGRESS_IDLE_MS, destroyAll);

      lookupPending = true;
      lookupsInFlight++;
      void resolve(host).then(
        (answer) => {
          lookupPending = false;
          lookupsInFlight--;
          if (closing || clientClosed) return maybeRelease();
          const answers = Array.isArray(answer) ? answer : [answer];
          const usable = opts.allowPrivateAddresses === true ? answers : answers.filter((a) => !isPrivateAddress(a));
          if (usable.length === 0) {
            isTunnelRefused();
            return refuse(403, `host ${host} resolved to a non-public address (${answers.join(", ")})`);
          }
          dial(usable, 0);
        },
        (err: unknown) => {
          lookupPending = false;
          lookupsInFlight--;
          if (closing || clientClosed) return maybeRelease();
          isTunnelRefused();
          refuse(502, `could not resolve ${host}: ${String(err)}`);
        },
      );
    };
    /** A CONNECT that was counted as a tunnel and then refused is a refusal in the log, not a carried tunnel. */
    const isTunnelRefused = (): void => {
      if (isTunnel) {
        isTunnel = false;
        tunnels--;
      }
    };

    const dial = (usable: string[], n: number): void => {
      if (closing || clientClosed) return maybeRelease();
      const sock = connect({ host: usable[n]!, port });
      upstream = sock;
      let connected = false;
      // Until it connects, a slow address must not hold the tunnel from the next one.
      sock.setTimeout(EGRESS_DIAL_MS, () => sock.destroy(new Error("connect timed out")));
      sock.once("connect", () => {
        connected = true;
        sock.setTimeout(EGRESS_IDLE_MS, destroyAll);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.off("data", onData);
        const startPiping = (first: Buffer[]): void => {
          for (const c of first) {
            up += c.length;
            sock.write(c);
          }
          client.on("data", (c: Buffer) => (up += c.length));
          sock.on("data", (c: Buffer) => (down += c.length));
          client.pipe(sock);
          sock.pipe(client);
        };
        if (opts.requireTlsSni === false) return startPiping(early);

        // Nothing reaches the upstream until the client's first flight has been
        // read and names the host that was allowlisted.
        let hello = Buffer.concat(early);
        const helloDeadline = setTimeout(() => {
          log(false, `no TLS ClientHello within ${EGRESS_HELLO_MS} ms of the tunnel opening`);
          destroyAll();
        }, EGRESS_HELLO_MS);
        helloDeadline.unref();
        const judge = (): void => {
          const sni = clientHelloSni(hello);
          if (sni === "more") {
            if (hello.length > EGRESS_HELLO_BYTES) {
              clearTimeout(helloDeadline);
              log(false, "the tunnel's first bytes are not a TLS ClientHello");
              destroyAll();
            }
            return;
          }
          clearTimeout(helloDeadline);
          client.off("data", onHello);
          if (sni !== host.toLowerCase().replace(/\.$/, "")) {
            log(
              false,
              sni === null
                ? "the tunnel's first bytes are not a TLS ClientHello naming a server"
                : `TLS server name ${sni} is not the allowlisted host ${host} this tunnel was opened for`,
            );
            return destroyAll();
          }
          startPiping([hello]);
        };
        const onHello = (c: Buffer): void => {
          hello = Buffer.concat([hello, c]);
          judge();
        };
        client.on("data", onHello);
        client.once("close", () => clearTimeout(helloDeadline));
        if (hello.length > 0) judge();
      });
      sock.once("error", (err) => {
        if (!connected && n + 1 < usable.length && !clientClosed && !closing) {
          sock.destroy();
          return dial(usable, n + 1);
        }
        if (!connected && !client.destroyed) client.write(`HTTP/1.1 502 Bad Gateway\r\n\r\nupstream: ${err.message}\n`);
        log(true, `upstream error: ${err.message}`);
        destroyAll();
      });
      sock.once("close", () => {
        if (upstream === sock) {
          if (connected || n + 1 >= usable.length) {
            log(true, null);
            client.destroy();
          }
          maybeRelease();
        }
      });
    };

    /** Bytes a hasty client sends before its 200: kept, bounded, forwarded once the tunnel exists. */
    const keepEarly = (c: Buffer): void => {
      earlyBytes += c.length;
      if (earlyBytes > EGRESS_EARLY_BYTES) return destroyAll();
      early.push(c);
    };
    const onData = (chunk: Buffer): void => {
      if (headersDone) return keepEarly(chunk);
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > EGRESS_HEADER_BYTES) destroyAll();
        return;
      }
      headersDone = true;
      clearTimeout(headerDeadline);
      const headerText = buf.subarray(0, end).toString("latin1");
      const rest = buf.subarray(end + 4);
      buf = Buffer.alloc(0);
      onHeaders(headerText, rest);
    };
    client.on("data", onData);
  };

  const server = createNetServer(onConnection);
  return new Promise((ok, fail) => {
    if (existsSync(opts.socketPath)) rmSync(opts.socketPath);
    server.once("error", fail);
    server.listen(opts.socketPath, () => {
      chmodSync(opts.socketPath, 0o600);
      ok({
        socketPath: opts.socketPath,
        entries,
        get allowedTotal() {
          return allowedTotal;
        },
        get refusedTotal() {
          return refusedTotal;
        },
        get sinkError() {
          return sinkError;
        },
        // QUIESCENT when it resolves: no socket of ours is open and no callback
        // of ours will run again. A lookup still in flight is the one thing that
        // cannot be cancelled; it is left to settle into a connection object
        // that, with `closing` set, does nothing at all. Counters and the log
        // are final from here, which is why the caller reads them AFTER this.
        close: async () => {
          closing = true;
          const waiting = [...live].map((c) => c.done);
          for (const c of live) c.destroy();
          await new Promise<void>((r) => server.close(() => r()));
          await Promise.race([Promise.all(waiting), new Promise((r) => setTimeout(r, 2_000).unref())]);
          rmSync(opts.socketPath, { force: true });
        },
      });
    });
  });
}
