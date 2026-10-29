/**
 * The app-scope contract.
 *
 * The overlay this client builds is a VPN plus a virtual network, but it must
 * stay inside the application: joining the private network may not take over the
 * machine. Nothing here is a system-wide tunnel, a system resolver, or a shared
 * identity — the app carries its own traffic through its own engine and its own
 * loopback proxy, and every other program on the machine keeps working exactly
 * as it did before the client was installed.
 *
 * Each invariant below names the observable state that must hold and the
 * concrete remedy when it does not, so the agent can audit itself at runtime and
 * report a violation instead of silently degrading into a system-level VPN.
 */

/** Overlay engine kinds this client may run. */
export const OVERLAY_ENGINE = {
  /** netstack inside this client's own process: no OS interface at all. */
  embedded: 'embedded',
  /** the vendor's system daemon: acceptable only as a stopgap, never app-scoped. */
  systemDaemon: 'system-daemon',
};

/**
 * The invariants, in the order a violation would surface to the user.
 *
 * `remedy` is deliberately a concrete engine setting or flag rather than advice,
 * because the stopgap path (official daemon) is the one that drifts.
 */
export const APP_SCOPE_INVARIANTS = [
  {
    id: 'engine-embedded',
    title: 'The overlay runs inside the app',
    detail: 'The private network is carried by this client process, not by a system service.',
    remedy: 'Run the embedded userspace engine; do not delegate to a system daemon.',
  },
  {
    id: 'interface-userspace',
    title: 'Userspace networking',
    detail: 'The engine implements the tunnel in userspace; the app never owns a kernel interface.',
    remedy: 'Use the userspace engine (netstack). A kernel TUN belongs to a system-wide VPN.',
  },
  {
    id: 'no-system-dns',
    title: 'The system resolver is untouched',
    detail: 'No overlay domain may appear in the operating system resolver configuration.',
    remedy: 'Keep DNS unmanaged (the daemon equivalent is --disable-dns); resolve names inside the app.',
  },
  {
    id: 'no-client-routes',
    title: 'No system client routes',
    detail: 'Routes received from the control plane must not be applied to the operating system.',
    remedy: 'Ignore client routes (the daemon equivalent is --disable-client-routes); route app traffic through the proxy.',
  },
  {
    id: 'no-system-interface',
    title: 'No persistent system interface',
    detail: 'No overlay interface or route survives this process outside the app.',
    remedy: 'Withdraw the overlay interface when the app exits; nothing about the network may outlive it.',
  },
  {
    id: 'loopback-proxy',
    title: 'App traffic leaves through a loopback proxy',
    detail: 'The only way into the private network is an HTTP proxy bound to loopback.',
    remedy: 'Bind the proxy to 127.0.0.1 or ::1 — a proxy reachable from the network is an open relay.',
  },
  {
    id: 'private-state',
    title: 'The identity belongs to the app',
    detail: 'Engine configuration and state live under the app directory, not a shared system profile.',
    remedy: 'Use a private config/state directory so the overlay identity is this app installation.',
  },
];

/** Loopback check for a `host:port` or bare-host address. */
function isLoopbackHost(address) {
  const raw = String(address ?? '').trim();
  if (raw === '') {
    return false;
  }
  let host = raw;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    host = end === -1 ? raw.slice(1) : raw.slice(1, end);
  } else if (raw.split(':').length > 2) {
    // A bare IPv6 address has more than one colon, so the whole value is the host
    // (there is no port to strip). `::1` is loopback just as much as `127.0.0.1`.
    host = raw;
  } else {
    host = raw.split(':')[0];
  }
  // A scoped address (`fe80::1%lo0`) carries a zone id that is not part of the host.
  host = host.split('%')[0];
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }
  const octets = normalized.split('.');
  if (octets.length !== 4) {
    return false;
  }
  const first = Number(octets[0]);
  return Number.isInteger(first) && first === 127;
}

/**
 * Audits the observed runtime state against the app-scope contract.
 *
 * @param {{
 *   engine?: string,
 *   interfaceType?: string,
 *   systemDnsDomains?: string[],
 *   clientRoutesApplied?: boolean,
 *   exposesSystemInterface?: boolean,
 *   proxyAddress?: string,
 *   stateDirectory?: string,
 *   sharedProfileDirectory?: string,
 * }} observed
 * @returns {{ ok: boolean, violations: Array<{ id: string, title: string, detail: string, remedy: string }> }}
 */
export function auditAppScope(observed) {
  const state = observed ?? {};
  const violations = [];
  const fail = (id) => {
    const invariant = APP_SCOPE_INVARIANTS.find((entry) => entry.id === id);
    if (invariant) {
      violations.push({ ...invariant });
    }
  };

  if (state.engine !== OVERLAY_ENGINE.embedded) {
    fail('engine-embedded');
  }
  if (String(state.interfaceType ?? '').toLowerCase() !== 'userspace') {
    fail('interface-userspace');
  }
  // An unknown state is not a clean state: the probe must report the resolver
  // domains it observed, even when there are none. A missing field is a violation.
  const dnsDomains = state.systemDnsDomains;
  if (!Array.isArray(dnsDomains) || dnsDomains.some((domain) => String(domain ?? '').trim() !== '')) {
    fail('no-system-dns');
  }
  if (state.clientRoutesApplied !== false) {
    fail('no-client-routes');
  }
  if (state.exposesSystemInterface !== false) {
    fail('no-system-interface');
  }
  if (!isLoopbackHost(state.proxyAddress)) {
    fail('loopback-proxy');
  }
  const stateDirectory = String(state.stateDirectory ?? '').trim();
  const sharedProfile = String(state.sharedProfileDirectory ?? '').trim();
  if (stateDirectory === '' || (sharedProfile !== '' && stateDirectory === sharedProfile)) {
    fail('private-state');
  }

  return { ok: violations.length === 0, violations };
}

export { isLoopbackHost };