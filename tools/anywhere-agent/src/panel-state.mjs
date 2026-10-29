/**
 * The window's one state, decided from the two independent sources behind it.
 *
 * The product has two halves that fail apart: this machine's own host (installed
 * and kept resident by the client itself) and the private network that makes the
 * user's *other* machines reachable. Neither is required for the other, and the
 * screen must never conflate them - a client that cannot reach the fleet still
 * opens the machine it is running on, and a fresh install with no network at all
 * is a working product rather than a sign-in wall.
 *
 * So the state is derived, in one place, from those two readings:
 *
 *   local  checking | needs-install | ready | error
 *   fleet  off | starting | connecting | login-required | ready | empty | error
 *
 * The rule is deliberately asymmetric. A local host that is not ready outranks
 * everything: there is nothing to open and nothing to log into yet. Once it is
 * ready, the fleet link is an *addition* - "off" is the ordinary state of a
 * single-machine user, not a problem to solve.
 *
 * Keeping this out of the shell is what makes it verifiable without launching an
 * app, and keeps the acceptance run's seam (`globalThis.__awSnapshot.state`) and
 * the renderer from drifting: both read this function's answer.
 *
 * @module anywhere-agent/panel-state
 */

import { machineOfCanonical } from './netbird-names.mjs';

/** Every state the window can render, in the order they are reached. */
export const UI_STATES = [
  'provisioning',
  'local',
  'connecting',
  'login-required',
  'ready',
  'empty',
  'error',
];

/** The local host's own states, which the panel's words are chosen from. */
export const LOCAL_STATES = ['checking', 'needs-install', 'ready', 'error'];

/** The fleet link's states. `off` is a normal destination, not a failure. */
export const FLEET_STATES = ['off', 'starting', 'connecting', 'login-required', 'ready', 'empty', 'error'];

/**
 * The window state one (local, fleet) pair means.
 *
 * @param {unknown} localState the local host's state
 * @param {unknown} fleetState the fleet link's state
 * @returns {string} one of {@link UI_STATES}
 */
export function uiState(localState, fleetState) {
  const local = LOCAL_STATES.includes(localState) ? localState : 'checking';
  if (local === 'error') {
    return 'error';
  }
  if (local !== 'ready') {
    return 'provisioning';
  }
  const fleet = typeof fleetState === 'string' ? fleetState : 'off';
  if (fleet === '' || fleet === 'off') {
    return 'local';
  }
  if (fleet === 'starting' || fleet === 'connecting') {
    return 'connecting';
  }
  if (UI_STATES.includes(fleet)) {
    return fleet;
  }
  // An unreadable fleet state is not "connected": the honest answer is that the
  // link failed, which is the state that offers a retry.
  return 'error';
}

/**
 * The panel's own copy for one local step, so a person installing for the first
 * time is told what the client is doing instead of watching a spinner.
 *
 * @param {unknown} step one of {@link LOCAL_STATES}
 * @returns {{ title: string, body: string }}
 */
export function provisioningCopy(step) {
  const table = {
    checking: { title: '正在检查本机环境', body: '' },
    // Something is missing and this window installs nothing: the panel shows the
    // command the person runs in their own terminal.
    'needs-install': { title: '本机还没装好', body: '' },
    ready: { title: '本机已就绪', body: '' },
    error: { title: '本机服务起不来', body: '' },
  };
  return table[step] ?? table.checking;
}

/**
 * This machine's own row in the list.
 *
 * It is built from facts the client already owns - the machine's name and the
 * loopback address of the host it just started - rather than from the fleet, so
 * it is present with no network, no sign-in and no records published anywhere.
 *
 * @param {{ machine?: string, host?: string, url?: string, ip?: string }} facts
 * @returns {{ host: string, machine: string, ip: string, url: string, statusCode: number, local: true }}
 */
export function localEntry(facts = {}) {
  const machine = String(facts.machine ?? '');
  const host = String(facts.host ?? '');
  return {
    host,
    machine,
    ip: String(facts.ip ?? ''),
    url: String(facts.url ?? ''),
    statusCode: 200,
    local: true,
  };
}

/**
 * This machine's row when the fleet's own name for it is known.
 *
 * The name is not derived here: it is the authority the local host answered for, so the
 * row carries what the rest of the fleet reaches this machine by. The URL stays loopback
 * because this is the copy that is *this* machine - the fleet's copy is the same row and
 * is dropped, not shown twice.
 *
 * @param {unknown} authority the canonical name this machine answered for
 * @param {unknown} loopbackUrl this machine's own workspace URL
 * @returns {object|null} the row, or null when there is no authority
 */
export function localEntryFromAuthority(authority, loopbackUrl) {
  const host = typeof authority === 'string' ? authority.trim() : '';
  if (host === '') {
    return null;
  }
  return {
    host,
    machine: machineOfCanonical(host),
    ip: '127.0.0.1',
    url: String(loopbackUrl ?? ''),
    statusCode: 200,
    local: true,
  };
}

/**
 * This machine's row and the fleet's rows, split by address.
 *
 * A fleet row is a DNS record whose content is an overlay address; a record that points
 * at an address of this machine is this machine, whatever it is called. That is the whole
 * rule, and it needs no name comparison and no guess: one machine can hold several fleet
 * names (a second enrollment, a collision suffix), and every record that addresses it
 * collapses into the single local row.
 *
 * @param {object[]} entries the fleet's registry
 * @param {string[]} addresses this machine's addresses
 * @param {unknown} loopbackUrl this machine's own workspace URL
 * @returns {{ local: object|null, fleet: object[] }} the local row, and the rows that are not it
 */
export function localRowsFrom(entries, addresses, loopbackUrl) {
  const own = new Set(
    (Array.isArray(addresses) ? addresses : [])
      .map((address) => String(address ?? '').trim().split('/')[0].replace(/%.*$/, ''))
      .filter((address) => address !== ''),
  );
  const rows = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry && typeof entry === 'object' && typeof entry.host === 'string' && entry.host !== '',
  );
  const mine = rows.filter((entry) => own.has(String(entry.ip ?? '').trim().split('/')[0]));
  const authority = mine.map((entry) => entry.host).sort()[0] ?? '';
  const fleet = rows.filter((entry) => !mine.some((row) => row.host === entry.host));
  return { local: localEntryFromAuthority(authority, loopbackUrl), fleet };
}

/**
 * The rows the list shows: this machine first, then the fleet, keyed by host.
 *
 * A dedupe rather than a concatenation, because once the fleet is up the same
 * physical machine appears in both readings - the fleet's record for it and the
 * local host the client is running. Two rows for one machine is the kind of
 * duplicate a person reads as two machines, and the local reading wins because
 * it is the one the client can vouch for.
 *
 * @param {object|null} local the local row, or null when the host is not ready
 * @param {object[]} fleet the fleet's entries
 * @returns {object[]} the rows, local first
 */
export function mergeEntries(local, fleet = []) {
  const out = [];
  const seen = new Set();
  if (local && typeof local === 'object' && local.host) {
    out.push(local);
    seen.add(local.host);
  }
  for (const entry of Array.isArray(fleet) ? fleet : []) {
    if (!entry || typeof entry !== 'object' || !entry.host) {
      continue;
    }
    if (seen.has(entry.host)) {
      continue;
    }
    seen.add(entry.host);
    out.push(entry);
  }
  return out;
}