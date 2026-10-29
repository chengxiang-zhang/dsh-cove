/**
 * The loopback overlay proxy.
 *
 * This is the one door between the application and the private network. The
 * browser shell is configured to send its traffic here; the proxy resolves the
 * requested canonical name through the engine's own peer table (never through
 * the system resolver) and connects straight to that peer's overlay address,
 * forwarding the original Host header untouched.
 *
 * Preserving Host is what makes the DSH remote-access fence work over a proxy: a
 * request is admitted only when its Host is the declared canonical authority, so
 * rewriting the authority to an address would turn every privileged route into a
 * 403. It also keeps cookie scoping intact, because the browser still believes it
 * is talking to `dsh.<machine>.netbird`.
 *
 * The proxy speaks plain HTTP, CONNECT (for https) and WebSocket upgrade, since
 * a DSH workspace keeps a long-lived `/api/remote.mux` socket open.
 */

import http from 'node:http';
import net from 'node:net';

/** Headers that describe this hop and must not be forwarded upstream. */
const HOP_BY_HOP = new Set([
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'transfer-encoding',
]);

/**
 * Extracts the destination from a proxied request.
 *
 * A browser configured with an HTTP proxy sends an absolute-form request target
 * (`GET http://dsh.peer-a.netbird/ HTTP/1.1`); a transparent client sends the
 * origin form and puts the authority in Host. Both carry the canonical authority,
 * which is what the resolver needs.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ authority: string, path: string, absolute: boolean } | null}
 */
export function requestTarget(req) {
  const raw = String(req.url ?? '');
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return { authority: url.host, path: `${url.pathname}${url.search}`, absolute: true };
    } catch {
      return null;
    }
  }
  const authority = String(req.headers.host ?? '').trim();
  if (authority === '') {
    return null;
  }
  return { authority, path: raw === '' ? '/' : raw, absolute: false };
}

/** Splits `host:port`, defaulting to port 80. */
function splitAuthority(authority) {
  const value = String(authority ?? '').trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    const host = end === -1 ? value : value.slice(1, end);
    const rest = end === -1 ? '' : value.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : 80;
    return { host, port: Number.isInteger(port) ? port : 80 };
  }
  const index = value.lastIndexOf(':');
  if (index === -1) {
    return { host: value, port: 80 };
  }
  const port = Number(value.slice(index + 1));
  return { host: value.slice(0, index), port: Number.isInteger(port) ? port : 80 };
}

/**
 * Starts the proxy.
 *
 * @param {{
 *   resolve: (host: string) => { ip: string, port: number, host: string } | null,
 *   host?: string,
 *   port?: number,
 *   log?: (message: string) => void,
 * }} options
 * @returns {Promise<{ url: string, close: () => Promise<void>, stats: () => { permitted: number, refused: number, upgraded: number, connected: number } }>}
 */
export function startOverlayProxy(options) {
  const resolve = options.resolve;
  const listenHost = options.host ?? '127.0.0.1';
  const log = options.log ?? (() => {});
  const counters = { permitted: 0, refused: 0, upgraded: 0, connected: 0 };

  /** Resolves an authority to a destination, refusing anything unknown. */
  const target = (authority) => {
    const { host, port } = splitAuthority(authority);
    const resolved = resolve(host);
    if (!resolved) {
      counters.refused += 1;
      return null;
    }
    counters.permitted += 1;
    return { ip: resolved.ip, port: port === 80 ? resolved.port : port, authority: resolved.host };
  };

  const forwardHeaders = (headers, authority) => {
    /** @type {Record<string, string | string[]>} */
    const out = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
      const name = key.toLowerCase();
      if (HOP_BY_HOP.has(name)) {
        continue;
      }
      if (name === 'host') {
        continue;
      }
      if (value !== undefined) {
        out[name] = value;
      }
    }
    out.host = authority;
    return out;
  };

  const server = http.createServer((req, res) => {
    const tried = requestTarget(req);
    if (tried === null) {
      res.writeHead(400).end('bad request target\n');
      return;
    }
    const dest = target(tried.authority);
    if (dest === null) {
      // The refusal is the security property: a name of this network is the only
      // thing this proxy will ever connect to.
      res.writeHead(403, { 'content-type': 'text/plain' }).end('unknown overlay host\n');
      return;
    }
    const upstream = http.request({
      host: dest.ip,
      port: dest.port,
      method: req.method,
      path: tried.path,
      headers: forwardHeaders(req.headers, dest.authority),
    });
    upstream.on('response', (up) => {
      counters.connected += 1;
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', (error) => {
      log(`upstream error for ${dest.authority}: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end('overlay upstream failed\n');
    });
    req.pipe(upstream);
  });

  // WebSocket and any other protocol upgrade: hand the raw socket over after
  // replaying the request line with the canonical authority.
  server.on('upgrade', (req, socket, head) => {
    const tried = requestTarget(req);
    const dest = tried === null ? null : target(tried.authority);
    if (tried === null || dest === null) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(dest.port, dest.ip, () => {
      counters.upgraded += 1;
      const headerLines = Object.entries(forwardHeaders(req.headers, dest.authority))
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
        .join('\r\n');
      upstream.write(`${req.method} ${tried.path} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
      if (head && head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', (error) => {
      log(`upgrade failed for ${dest.authority}: ${error.message}`);
      socket.destroy();
    });
    socket.on('error', () => upstream.destroy());
  });

  // CONNECT, for a future https entry.
  server.on('connect', (req, clientSocket, head) => {
    const dest = target(String(req.url ?? ''));
    if (dest === null) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(dest.port, dest.ip, () => {
      counters.connected += 1;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  return new Promise((resolvePromise) => {
    server.listen(options.port ?? 0, listenHost, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const url = `http://${listenHost}:${port}`;
      log(`overlay proxy listening on ${url}`);
      resolvePromise({
        url,
        stats: () => ({ ...counters }),
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}