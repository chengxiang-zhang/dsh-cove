/**
 * NetBird status parsing.
 *
 * The client must map a canonical entry name to an overlay address by itself:
 * app-scope means the operating system resolver knows nothing about the overlay,
 * so system DNS cannot answer `dsh.<machine>.netbird`. The engine's own status
 * carries that mapping, and this module turns it into data.
 *
 * Two shapes are parsed. `netbird status` reports this machine; `netbird status
 * -d` additionally lists every peer in blocks:
 *
 *   Peers detail:
 *    peer-b.vpn:
 *     NetBird IP: 100.64.1.81
 *     Status: Connected
 *     -- detail --
 *     Connection type: Relayed
 *
 * The parser is deliberately tolerant about order and about upstream adding
 * lines: it keys on labels, not on line positions.
 */

/**
 * @typedef {{ name: string, fqdn: string, ip: string, ipv6: string, status: string, connectionType: string }} Peer
 */

/** Strips the `.vpn` suffix NetBird appends to a peer name. */
function machineName(fqdn) {
  return fqdn.toLowerCase().replace(/\.vpn$/, '');
}

/** Reads `Label: value` for a label that may repeat (first hit wins). */
function labelValue(block, label) {
  const match = block.match(new RegExp(`^\\s*${label}:\\s*(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

/**
 * Parses the local machine's own status lines.
 *
 * @param {string} text output of `netbird status`
 * @returns {{ fqdn: string, machine: string, ip: string, ipv6: string, interfaceType: string, managementConnected: boolean, peersConnected: string }}
 */
export function parseSelfStatus(text) {
  const body = typeof text === 'string' ? text : '';
  const fqdn = labelValue(body, 'FQDN');
  const peersCount = labelValue(body, 'Peers count');
  return {
    fqdn,
    machine: machineName(fqdn),
    ip: labelValue(body, 'NetBird IP').split('/')[0],
    ipv6: labelValue(body, 'NetBird IPv6').split('/')[0],
    interfaceType: labelValue(body, 'Interface type'),
    managementConnected: /^Connected$/i.test(labelValue(body, 'Management')),
    peersConnected: peersCount,
  };
}

/**
 * Parses the peer blocks of `netbird status -d`.
 *
 * @param {string} text output of `netbird status -d`
 * @returns {Peer[]}
 */
export function parsePeers(text) {
  const body = typeof text === 'string' ? text : '';
  const start = body.indexOf('Peers detail:');
  if (start === -1) {
    return [];
  }
  const lines = body.slice(start + 'Peers detail:'.length).split('\n');
  /** @type {Peer[]} */
  const peers = [];
  let block = null;
  let fqdn = '';

  const flush = () => {
    if (block === null || fqdn === '') {
      return;
    }
    peers.push({
      name: machineName(fqdn),
      fqdn: fqdn.toLowerCase(),
      ip: labelValue(block, 'NetBird IP').split('/')[0],
      ipv6: labelValue(block, 'NetBird IPv6').split('/')[0],
      status: labelValue(block, 'Status'),
      connectionType: labelValue(block, 'Connection type'),
    });
  };

  for (const line of lines) {
    // A peer block starts with an indented `name.vpn:` header.
    const header = line.match(/^\s+(\S+):\s*$/);
    if (header) {
      flush();
      fqdn = header[1];
      block = '';
      continue;
    }
    if (block !== null) {
      block += `${line}\n`;
    }
  }
  flush();
  return peers;
}

/**
 * Builds the name resolver the proxy uses: canonical entry name (or bare machine
 * name) to overlay address, using only engine data.
 *
 * @param {{ self?: ReturnType<typeof parseSelfStatus>, peers?: Peer[], zones?: string[] }} input
 * @returns {(host: string) => { ip: string, port: number, host: string } | null}
 */
export function createPeerResolver(input) {
  const zones = Array.isArray(input?.zones) && input.zones.length > 0 ? input.zones : ['netbird'];
  const table = new Map();
  const self = input?.self;
  if (self && self.machine && self.ip) {
    table.set(self.machine, self.ip);
  }
  for (const peer of Array.isArray(input?.peers) ? input.peers : []) {
    if (peer.name && peer.ip) {
      table.set(peer.name, peer.ip);
    }
  }

  return (host) => {
    const normalized = String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (normalized === '') {
      return null;
    }
    for (const zone of zones) {
      const prefix = `dsh.`;
      const suffix = `.${zone}`;
      if (!normalized.startsWith(prefix) || !normalized.endsWith(suffix)) {
        continue;
      }
      const machine = normalized.slice(prefix.length, normalized.length - suffix.length);
      const ip = table.get(machine);
      // A name that resolves to a machine of this network is the only thing the
      // proxy will connect to: the mapping, not the name, is the trust anchor.
      if (ip) {
        return { ip, port: 80, host: normalized };
      }
      return null;
    }
    return null;
  };
}