/**
 * The control surface an agent uses to work inside this window.
 *
 * The window has no address bar and no scripting hole of its own, so an agent cannot
 * simply aim at a URL: it has to be told which tab exists and be granted one. That is what
 * this loopback service is - a small, token-guarded contract between the shell and
 * whatever is driving it.
 *
 * What it deliberately does not do is enforce read-only. A client attached over CDP can
 * do anything the page can; pretending otherwise would be a lie in the interface. The
 * tier is a declared, visible state (the tab carries an A badge and the bar says 只读 or
 * 可写), and the guarantee that a read-only session stays read-only belongs to the agent's
 * own tool surface, where it can be enforced. The shell's job is to make the claim
 * visible, revocable and attributable.
 */

import { createServer } from 'node:http';

/** The only tiers a claim may declare. */
export const TIERS = ['read-only', 'control'];

/**
 * The claims themselves: who is driving which tab, and since when.
 *
 * Kept separate from the HTTP surface so the rules can be tested without sockets.
 *
 * @param {{ now?: () => number }} [options]
 */
export function createClaimState(options = {}) {
  const now = options.now ?? Date.now;
  /** @type {Map<string, { tabId: string, tier: string, by: string, since: number }>} */
  const claims = new Map();

  return {
    /**
     * Grants a claim. One tab has one driver: a second agent has to wait for the first to
     * release, because two cursors in one page is not something a person can follow.
     */
    claim(tabId, { tier = 'read-only', by = '' } = {}) {
      const id = String(tabId ?? '');
      const who = String(by ?? '').trim();
      if (id === '') {
        return { ok: false, reason: 'tabId is required' };
      }
      if (!TIERS.includes(tier)) {
        return { ok: false, reason: `tier must be one of ${TIERS.join(', ')}` };
      }
      if (who === '') {
        return { ok: false, reason: 'by is required: a claim has to be attributable' };
      }
      const existing = claims.get(id);
      if (existing && existing.by !== who) {
        return { ok: false, reason: `${existing.by} is already driving this tab` };
      }
      // Re-claiming is how an agent says "still me, still read-only" - it must not create a
      // second claim or move the clock, or the badge would flicker on every heartbeat.
      const claim = existing ?? { tabId: id, tier, by: who, since: now() };
      claim.tier = tier;
      claims.set(id, claim);
      return { ok: true, claim: { ...claim } };
    },

    /** Releases a claim; releasing someone else's is refused. */
    release(tabId, { by = '' } = {}) {
      const id = String(tabId ?? '');
      const existing = claims.get(id);
      if (!existing) {
        return { ok: true, released: false };
      }
      if (existing.by !== String(by ?? '').trim()) {
        return { ok: false, reason: `${existing.by} is driving this tab, not ${by}` };
      }
      claims.delete(id);
      return { ok: true, released: true };
    },

    /** Drops every claim held by one client (it disconnected, or it gave up). */
    releaseAll(by) {
      const who = String(by ?? '').trim();
      let dropped = 0;
      for (const [tabId, claim] of claims) {
        if (claim.by === who) {
          claims.delete(tabId);
          dropped += 1;
        }
      }
      return dropped;
    },

    /** The claim on one tab, or null. */
    get(tabId) {
      return claims.get(String(tabId ?? '')) ?? null;
    },

    /** Every live claim, for the state response. */
    list() {
      return [...claims.values()].map((claim) => ({ ...claim }));
    },

    /** Drops claims whose tab no longer exists, so a closed tab cannot keep the badge. */
    prune(knownTabIds) {
      const known = new Set(knownTabIds);
      let dropped = 0;
      for (const tabId of [...claims.keys()]) {
        if (!known.has(tabId)) {
          claims.delete(tabId);
          dropped += 1;
        }
      }
      return dropped;
    },
  };
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

function readBody(request) {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => {
      text += chunk;
      if (text.length > 64 * 1024) {
        request.destroy();
      }
    });
    request.on('end', () => resolve(text));
    request.on('error', () => resolve(''));
  });
}

/**
 * Serves the contract on loopback.
 *
 * Bound to 127.0.0.1 on purpose: this is a hatch for the agent on the same machine, not a
 * remote control plane, and a token is required even there so another local process cannot
 * quietly take the window.
 *
 * @param {{ claims: ReturnType<typeof createClaimState>, tabs: () => Array<object>, port?: number, token: string, onChange?: () => void, log?: (line: string) => void }} options
 */
export function startAgentBridge(options) {
  const { claims, tabs, token } = options;
  const log = options.log ?? (() => {});
  const authorised = (request) => {
    const header = String(request.headers.authorization ?? '');
    return header === `Bearer ${token}`;
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      json(response, 200, { ok: true });
      return;
    }
    if (!authorised(request)) {
      json(response, 401, { ok: false, reason: 'a bearer token is required' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/state') {
      const known = tabs();
      claims.prune(known.map((tab) => tab.id));
      json(response, 200, {
        ok: true,
        tabs: known.map((tab) => ({ ...tab, agent: claims.get(tab.id) ? { tier: claims.get(tab.id).tier, since: claims.get(tab.id).since } : null })),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/claim') {
      const body = JSON.parse((await readBody(request)) || '{}');
      const known = tabs();
      if (!known.some((tab) => tab.id === body.tabId)) {
        json(response, 404, { ok: false, reason: 'no such tab' });
        return;
      }
      const result = claims.claim(body.tabId, body);
      if (!result.ok) {
        json(response, 409, result);
        return;
      }
      log(`claim ${result.claim.tabId} by ${result.claim.by} (${result.claim.tier})`);
      options.onChange?.();
      json(response, 200, { ok: true, claim: result.claim });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/release') {
      const body = JSON.parse((await readBody(request)) || '{}');
      const result = claims.release(body.tabId, body);
      if (!result.ok) {
        json(response, 409, result);
        return;
      }
      log(`release ${body.tabId}${result.released ? '' : ' (was not claimed)'}`);
      options.onChange?.();
      json(response, 200, result);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/release-all') {
      const body = JSON.parse((await readBody(request)) || '{}');
      const dropped = claims.releaseAll(body.by);
      options.onChange?.();
      json(response, 200, { ok: true, dropped });
      return;
    }
    json(response, 404, { ok: false, reason: 'unknown path' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
