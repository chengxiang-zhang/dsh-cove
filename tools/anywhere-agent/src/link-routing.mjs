/**
 * Where a link goes: a tab in this window, or the platform's browser.
 *
 * The window's only network is the overlay. Its session proxy dials through NetBird's
 * userspace stack, which carries the fleet and nothing else - so a public address inside
 * this window cannot load at all. It fails as a page error, which reads as "the link is
 * broken" instead of "that link belongs to the system browser". The boundary therefore
 * has to be expressed once and decided before anything is loaded.
 *
 * The address decides, not the link: an overlay address (the fleet's own names, the
 * overlay address range, a service the deployment published, this machine's loopback)
 * stays here as a tab; anything else is handed to the platform browser, where a public
 * page actually works. An address nothing can open - `javascript:`, `about:blank`, a
 * malformed URL - is ignored rather than handed anywhere.
 *
 * This is deliberately a pure function of (url, what the deployment publishes): the two
 * places that route a link (the popup handler and the navigation handler) and the
 * acceptance run all ask the same question, and a name the deployment adds tomorrow is a
 * catalogue entry, not a release.
 *
 * @module anywhere-agent/link-routing
 */

/** What routing an address means. */
export const LINK_ROUTE = {
  /** Keep it in this window, as a tab. */
  tab: 'tab',
  /** Hand it to the platform browser. */
  external: 'external',
  /** There is nothing to open. */
  ignore: 'ignore',
};

/** Schemes whose only meaning is "let the operating system hand this on". */
const HAND_OFF_SCHEMES = new Set(['mailto:', 'tel:', 'sms:']);

/** The shortcut zone Windows hands out for hosts a machine reaches directly. */
const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain']);

/** A host name without the URL syntax around it: lower case, no brackets, no trailing dot. */
export function hostOfAddress(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') {
    return '';
  }
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

/** Four dotted numbers, or null. */
function ipv4Parts(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) {
    return null;
  }
  const numbers = parts.map((part) => Number(part));
  return numbers.every((number) => number >= 0 && number <= 255) ? numbers : null;
}

/**
 * Whether an address literal is one a private network hands out.
 *
 * Two ranges matter: the CGNAT block NetBird assigns overlay peers from, and the private
 * ranges a fleet's own machines sit in. Loopback is separate (it is this machine, which
 * needs no overlay at all), and every other address is public.
 */
function isOverlayAddress(host) {
  const ipv4 = ipv4Parts(host);
  if (ipv4 !== null) {
    const [a, b] = ipv4;
    return (
      a === 127 ||
      a === 10 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(':')) {
    // IPv6: loopback, unique local (fc00::/7) and link local (fe80::/10).
    return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }
  return false;
}

/** Whether a host name sits under one of the fleet's zones (`dsh.machine.<zone>`). */
function isUnderZone(host, zones) {
  return zones.some((zone) => host === zone || host.endsWith(`.${zone}`));
}

/** A catalogue host as a comparable name: its host name, a trailing dot removed. */
function normalizeHostEntry(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') {
    return '';
  }
  const host = hostOfAddress(raw.includes('://') ? raw : `http://${raw}`);
  return host;
}

/**
 * Routes one address.
 *
 * @param {unknown} rawUrl the address a page asked to open
 * @param {{ zones?: string[], hosts?: string[] }} [published] what the deployment offers:
 *   the fleet's DNS zones, and every host the catalogue or the machine list names
 * @returns {{ route: string, url: string, host: string, reason: string }} the decision,
 *   the address it applies to (normalized), and why it was made - the reason travels into
 *   the shell log so a link that went the unexpected way can be explained
 */
export function classifyLink(rawUrl, published = {}) {
  const zones = (Array.isArray(published.zones) ? published.zones : [])
    .map((zone) => String(zone ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, ''))
    .filter((zone) => zone !== '');
  const hosts = new Set(
    (Array.isArray(published.hosts) ? published.hosts : []).map(normalizeHostEntry).filter((host) => host !== ''),
  );
  const raw = String(rawUrl ?? '').trim();
  if (raw === '') {
    return { route: LINK_ROUTE.ignore, url: '', host: '', reason: 'empty' };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { route: LINK_ROUTE.ignore, url: raw, host: '', reason: 'unparsable' };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // A scheme whose whole job is to reach another application: the operating system is
    // the only thing that can open it. Everything else (`javascript:`, `about:`,
    // `data:`...) refers to the page itself and has nothing to open.
    const route = HAND_OFF_SCHEMES.has(parsed.protocol) ? LINK_ROUTE.external : LINK_ROUTE.ignore;
    return { route, url: parsed.href, host, reason: `scheme:${parsed.protocol.replace(':', '')}` };
  }
  if (host === '') {
    return { route: LINK_ROUTE.ignore, url: parsed.href, host, reason: 'no-host' };
  }
  if (LOOPBACK_NAMES.has(host) || host === '::1' || host.startsWith('127.')) {
    return { route: LINK_ROUTE.tab, url: parsed.href, host, reason: 'loopback' };
  }
  if (isOverlayAddress(host)) {
    return { route: LINK_ROUTE.tab, url: parsed.href, host, reason: 'overlay-address' };
  }
  // A single label is a name only the overlay's DNS answers ("tx", "superset"): there is
  // no public dot-com under it, so it cannot be a public address.
  if (!host.includes('.')) {
    return { route: LINK_ROUTE.tab, url: parsed.href, host, reason: 'overlay-name' };
  }
  if (isUnderZone(host, zones)) {
    return { route: LINK_ROUTE.tab, url: parsed.href, host, reason: 'fleet-zone' };
  }
  if (hosts.has(host)) {
    return { route: LINK_ROUTE.tab, url: parsed.href, host, reason: 'published-service' };
  }
  return { route: LINK_ROUTE.external, url: parsed.href, host, reason: 'public' };
}