/**
 * How the window's traffic chooses a network.
 *
 * The desktop client is a browser for two networks at once: the machine's own (whatever
 * the operating system can reach) and the fleet's private one, which is only reachable
 * through the agent's loopback proxy. One Chromium session has one proxy setting, so the
 * choice between them has to be made per request - which is exactly what a PAC script is
 * for.
 *
 * The rule is the address, and only the address:
 *
 *   - a name the overlay answers for (a single label, a fleet zone, a host the
 *     deployment published) goes to the agent's proxy, because the operating system's
 *     resolver cannot see those names at all;
 *   - everything else goes DIRECT, because the machine's own network is the right
 *     network for it - and proxying it through the overlay is what made public pages
 *     (an identity provider, a report link) fail to load inside this window.
 *
 * Loopback is deliberately DIRECT even though it looks like an overlay address: this
 * machine's own workspace must keep working while the fleet is down, and it is the one
 * entry that never needs the private network.
 *
 * The script is generated rather than served, so the decision travels with the facts the
 * window already has (the fleet's zones and the hosts it published) instead of with a
 * second configuration file to keep in sync.
 *
 * @module anywhere-agent/proxy-pac
 */

/** How a PAC script says "use this proxy" / "use the machine's own network". */
const DIRECT = 'DIRECT';

/** The PAC runtime's helpers this script relies on. */
const PAC_RUNTIME = ['isPlainHostName', 'shExpMatch'];

/**
 * The proxy entry a PAC script should return, from the agent's proxy URL.
 *
 * @param {string} upstream the agent's loopback proxy, e.g. `http://127.0.0.1:19001`
 * @returns {string} a PAC proxy entry, or '' when the address is not usable
 */
export function proxyEntryOf(upstream) {
  try {
    const url = new URL(String(upstream ?? ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '';
    }
    if (url.hostname === '') {
      return '';
    }
    return `PROXY ${url.hostname}:${url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : url.port}`;
  } catch {
    return '';
  }
}

/** A host as the PAC script compares it: lower case, brackets and trailing dot removed. */
function pacHost(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/** Zones as the script walks them: lower case, no leading or trailing dot. */
function pacZones(list) {
  const out = [];
  for (const value of Array.isArray(list) ? list : []) {
    const zone = pacHost(value).replace(/^\.+|\.+$/g, '');
    if (zone !== '' && !out.includes(zone)) {
      out.push(zone);
    }
  }
  return out;
}

/** Published hosts as a lookup object the script can index. */
function pacHosts(list) {
  const out = {};
  for (const value of Array.isArray(list) ? list : []) {
    const host = pacHost(value).replace(/:\d+$/, '');
    if (host !== '' && host.includes('.') && out[host] !== 1) {
      out[host] = 1;
    }
  }
  return out;
}

/**
 * Builds the PAC source.
 *
 * @param {{ upstream: string, zones?: string[], hosts?: string[] }} options the agent's
 *   proxy, the fleet's DNS zones, and every host the deployment published
 * @returns {string} JavaScript for a PAC script, or '' when there is no usable proxy
 */
export function pacScript(options = {}) {
  const proxy = proxyEntryOf(options.upstream);
  if (proxy === '') {
    return '';
  }
  const zones = pacZones(options.zones);
  const hosts = pacHosts(options.hosts);
  // JSON.stringify output is a valid JS literal; the script is otherwise static, so the
  // only values in it are the ones passed here (a zone name or a published host).
  // The constants are top-level on purpose: PAC helpers are plain functions, so a `var`
  // inside FindProxyForURL would not be visible to them.
  return `var PROXY = ${JSON.stringify(proxy)};
var DIRECT = ${JSON.stringify(DIRECT)};
var ZONES = ${JSON.stringify(zones)};
var HOSTS = ${JSON.stringify(hosts)};

function FindProxyForURL(url, host) {
  if (host === '' || host === null || host === undefined) {
    return DIRECT;
  }
  host = String(host).toLowerCase();
  // This machine: never through the fleet. The local workspace must open with the
  // private network down, and it is not a name the overlay answers for anyway.
  if (host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.indexOf('127.') === 0) {
    return DIRECT;
  }
  if (isOverlayName(host)) {
    return PROXY;
  }
  if (isOverlayAddress(host)) {
    return PROXY;
  }
  return DIRECT;
}

function isOverlayName(host) {
  // A single label is a name only the overlay's resolver answers: there is no public
  // dot-com under it, so it cannot be reached the machine's own way.
  if (isPlainHostName(host) && host.indexOf('.') === -1) {
    return true;
  }
  for (var index = 0; index < ZONES.length; index += 1) {
    var zone = ZONES[index];
    if (host === zone) {
      return true;
    }
    var suffix = '.' + zone;
    if (host.length > suffix.length && host.slice(-suffix.length) === suffix) {
      return true;
    }
  }
  return HOSTS[host] === 1;
}

function isOverlayAddress(host) {
  var parts = host.split('.');
  if (parts.length !== 4) {
    // The fleet's peers are IPv4; an IPv6 literal is not one of them.
    return false;
  }
  for (var index = 0; index < 4; index += 1) {
    var octet = Number(parts[index]);
    if (!isFinite(octet) || octet < 0 || octet > 255) {
      return false;
    }
  }
  // NetBird hands overlay peers addresses from the CGNAT block. Private LAN ranges are
  // the machine's own network, so they stay DIRECT.
  var first = Number(parts[0]);
  var second = Number(parts[1]);
  return first === 100 && second >= 64 && second <= 127;
}
`;
}

/**
 * The PAC script as the data URL Chromium accepts in `session.setProxy`.
 *
 * A data URL rather than a served file: there is no second endpoint to keep alive, and a
 * PAC fetch that fails is a window with no proxy at all, which is exactly the state this
 * module exists to avoid.
 *
 * @param {string} script the PAC source
 * @returns {string} a data: URL, or '' for an empty script
 */
export function pacDataUrl(script) {
  if (String(script ?? '') === '') {
    return '';
  }
  return `data:application/x-javascript;base64,${Buffer.from(script, 'utf8').toString('base64')}`;
}

/** The helpers a PAC runtime provides; exported so a test can run the generated script. */
export const PAC_HELPERS = PAC_RUNTIME;