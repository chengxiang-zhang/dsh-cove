/**
 * LAN address derivation for the advertised gateway URL. Mirrors the dsh
 * CLI's boot-time sampling (apps/cli/src/app-cli-entry.ts `resolveLanTrust`):
 * the same non-internal IPv4 derivation applies here so the plugin never
 * advertises an address the deployment cannot actually serve.
 */

import { networkInterfaces } from 'node:os'

/**
 * Non-internal IPv4 interface addresses of this machine — the IP-literal
 * authorities an all-interfaces bind is reachable by on the LAN.
 * @returns the addresses in interface order (possibly empty).
 */
export function lanIPv4Addresses(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter((iface): iface is NonNullable<typeof iface> => { return iface !== undefined && iface.family === 'IPv4' && !iface.internal })
    .map(iface => iface.address)
}
