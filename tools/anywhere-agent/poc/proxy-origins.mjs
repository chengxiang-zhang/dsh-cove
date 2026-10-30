#!/usr/bin/env node
/**
 * The two questions that decide whether a tab may open something other than DSH.
 *
 * Q2 - a page that pulls from more than one origin. The overlay proxy resolves names
 *      through the engine's peer table and refuses everything else (403). DSH is
 *      single-origin, so this never bit; an arbitrary internal service is not.
 * Q4 - an https target. The proxy has a CONNECT implementation that has never been
 *      exercised, so what it does is unknown until this run.
 *
 * Both are answered here against the real proxy module, with a stubbed resolver: no
 * engine, no network, no machine is touched.
 *
 * Usage: node poc/proxy-origins.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { startOverlayProxy } from '../src/overlay-proxy.mjs';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}\n`);
}

/** The site the user thinks they are opening: it references a second origin. */
const site = http.createServer((req, res) => {
  if (req.url === '/asset.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'x-seen-host': String(req.headers.host ?? '') });
    res.end('png');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html', 'x-seen-host': String(req.headers.host ?? '') });
  res.end('<!doctype html><img src="http://cdn.other.local/asset.png"><h1>site</h1>');
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const sitePort = site.address().port;

/** The https target, represented by a TCP echo server: CONNECT tunnels bytes, and TLS is the client's business. */
const echo = net.createServer((socket) => socket.pipe(socket));
await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
const echoPort = echo.address().port;

/** Only `app.local` is a member of the overlay, which is what the engine's peer table would say. */
const resolve = (host) => {
  if (host === 'app.local') {
    return { ip: '127.0.0.1', port: sitePort, host };
  }
  // A target reached over https: the overlay peer listens on 443 and the tunnel carries
  // bytes, not HTTP. The stub points at an echo server so the tunnel itself is what runs.
  if (host === 'tunnel.local') {
    return { ip: '127.0.0.1', port: echoPort, host };
  }
  return null;
};

const proxy = await startOverlayProxy({ resolve, port: 0, log: () => {} });
const proxyPort = Number(new URL(proxy.url).port);

function viaProxy(authority) {
  return new Promise((resolveRequest) => {
    const request = http.request(
      { host: '127.0.0.1', port: proxyPort, method: 'GET', path: `http://${authority}/`, headers: { host: authority } },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolveRequest({ status: response.statusCode, headers: response.headers, body }));
      },
    );
    request.on('error', (error) => resolveRequest({ status: 0, error: error.message }));
    request.end();
  });
}

function connectThroughProxy(authority) {
  return new Promise((resolveTunnel) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let head = '';
    socket.once('data', (chunk) => {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) {
        return resolveTunnel({ status: 0, head });
      }
      const status = Number((head.match(/^HTTP\/1\.1 (\d{3})/) ?? [])[1] ?? 0);
      if (status !== 200) {
        socket.destroy();
        return resolveTunnel({ status, head });
      }
      socket.write('ping');
      socket.once('data', (echoed) => {
        socket.destroy();
        resolveTunnel({ status, echo: echoed.toString('latin1') });
      });
    });
    socket.on('error', (error) => resolveTunnel({ status: 0, error: error.message }));
  });
}

// 1. A member of the overlay opens, and the Host header survives untouched (the fence
//    and the vhost both depend on it).
const known = await viaProxy('app.local');
record('a known overlay host loads', known.status === 200, `status=${known.status}`);
record('the original Host header is preserved', known.headers['x-seen-host'] === 'app.local', `host=${known.headers['x-seen-host']}`);

// 2. A second origin on the same page is refused. This is Q2: the page renders, its
//    subresource does not, and nothing in the browser says why.
const other = await viaProxy('cdn.other.local');
record('a second origin is refused (Q2)', other.status === 403, `status=${other.status}`);

// 3. A subresource on the same origin is fine, so the failure above is specifically
//    about the origin, not about paths.
const asset = await new Promise((resolveRequest) => {
  const request = http.request(
    { host: '127.0.0.1', port: proxyPort, path: 'http://app.local/asset.png', headers: { host: 'app.local' } },
    (response) => {
      response.resume();
      response.on('end', () => resolveRequest(response.statusCode));
    },
  );
  request.on('error', () => resolveRequest(0));
  request.end();
});
record('a same-origin subresource loads', asset === 200, `status=${asset}`);

// 4. CONNECT: the tunnel an https target needs.
const tunnel = await connectThroughProxy('tunnel.local:80');
record('CONNECT establishes a tunnel (Q4)', tunnel.status === 200, `status=${tunnel.status}`);
record('bytes survive the tunnel', tunnel.echo === 'ping', `echo=${JSON.stringify(tunnel.echo ?? '')}`);

// 5. CONNECT to a name outside the overlay is refused, same rule as plain HTTP.
const refused = await connectThroughProxy('evil.example:443');
record('CONNECT outside the overlay is refused', refused.status === 403, `status=${refused.status}`);

await proxy.close();
site.close();
echo.close();

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(`\nproxy-origins: ${results.length - failed.length}/${results.length} checks passed\n`);
assert.equal(failed.length, 0, `${failed.length} check(s) failed`);
