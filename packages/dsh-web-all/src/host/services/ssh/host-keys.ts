/** Server identity only: no TOFU writes; inspect only the wire key type prefix. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isHostKeyFingerprint, type SshHostEntry } from '../../../core/ssh/protocol.ts'

export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

function equal(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

function decodeBase64(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) return undefined
  const decoded = Buffer.from(value, 'base64')
  const canonical = decoded.toString('base64')
  return (value === canonical || value === canonical.replace(/=+$/, '')) ? decoded : undefined
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith('|1|')) {
    const parts = pattern.split('|')
    if (parts.length !== 4) return false
    const salt = decodeBase64(parts[2]!)
    const hash = decodeBase64(parts[3]!)
    return salt !== undefined && hash?.length === 20 && equal(createHmac('sha1', salt).update(host).digest(), hash)
  }
  // Bounded dynamic programming: never compile a trusted-file glob to regex.
  // A deliberately oversized pattern fails closed rather than blocking the host.
  if (pattern.length > 4096 || host.length > 1024 || pattern.length * host.length > 1_000_000) return false
  let previous = new Uint8Array(host.length + 1)
  previous[0] = 1
  for (const character of pattern.toLowerCase()) {
    const next = new Uint8Array(host.length + 1)
    if (character === '*') next[0] = previous[0]!
    for (let i = 1; i <= host.length; i++) {
      next[i] = character === '*' ? (previous[i]! | next[i - 1]!)
        : ((character === '?' || character === host[i - 1]) ? previous[i - 1]! : 0)
    }
    previous = next
  }
  return previous[host.length] === 1
}

function keyTypeOf(key: Buffer): string | undefined {
  if (key.length < 4) return undefined
  const length = key.readUInt32BE(0)
  if (length === 0 || length > 128 || length + 4 > key.length) return undefined
  const type = key.subarray(4, 4 + length).toString('utf8')
  return /^[A-Za-z0-9@._+-]+$/.test(type) ? type : undefined
}

function hostListMatches(patterns: string, host: string): boolean {
  let matched = false
  for (const pattern of patterns.split(',')) {
    if (pattern.startsWith('!')) {
      if (hostMatches(pattern.slice(1), host)) return false
    } else if (hostMatches(pattern, host)) matched = true
  }
  return matched
}

/**
 * Match OpenSSH known_hosts host lists (including |1| hashes and [host]:port).
 * @cert-authority is intentionally not a raw host-key trust grant; certificates
 * need separate validation. A matching @revoked key always denies trust.
 * An explicit pin is authoritative, not a fallback for a mismatching pin.
 */
export function makeHostVerifier(entry: SshHostEntry, knownHostsPath = join(homedir(), '.ssh', 'known_hosts')): (key: Buffer) => boolean {
  const host = entry.port === 22 ? entry.host.toLowerCase() : `[${entry.host.toLowerCase()}]:${entry.port}`
  return (key) => {
    let contents: string
    try {
      contents = readFileSync(knownHostsPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      contents = ''
    }
    let trusted = false
    for (const line of contents.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/)
      if (fields[0]?.startsWith('#') || fields[0] === '') continue
      const marker = fields[0]?.startsWith('@') ? fields.shift() : undefined
      const [hosts, type, encoded] = fields
      if (hosts === undefined || encoded === undefined || !hostListMatches(hosts, host)) continue
      const decoded = decodeBase64(encoded)
      if (decoded === undefined || type !== keyTypeOf(key) || !equal(decoded, key)) continue
      if (marker === '@revoked') return false
      if (marker === undefined) trusted = true
    }
    if (entry.hostKeyFingerprint !== undefined) {
      return isHostKeyFingerprint(entry.hostKeyFingerprint) && entry.hostKeyFingerprint === hostKeyFingerprint(key)
    }
    return trusted
  }
}
