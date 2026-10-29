import { BetterSidebarError } from './wire.ts'

export function extractFrameAncestors(csp: string | null): string[] | undefined {
  if (!csp) return undefined
  for (const directive of csp.split(';')) { const parts = directive.trim().split(/\s+/); if (parts[0]?.toLowerCase() === 'frame-ancestors') return parts.slice(1).filter(Boolean) || undefined }
  return undefined
}
export interface BrowserProbe { url: string; status: number; ok: boolean; xFrameOptions?: string; frameAncestors?: string[]; embeddable: boolean }

/** A refused destination, or the normalized URL the probe may fetch. */
export type ProbeTargetVerdict = { kind: 'ok'; url: string } | { kind: 'blocked'; reason: string }

/** Redirect hops the probe follows before it reports the last response as-is. */
export const MAX_PROBE_REDIRECTS = 3

/** Hostnames that resolve inside the operator's own network. */
const PRIVATE_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa']

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0'
    || /^127\./u.test(hostname)
    || /^::ffff:7f/u.test(hostname)
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.')
  if (octets.length !== 4 || !octets.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)) return false
  const [a, b] = octets.map(Number) as [number, number, number, number]
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127)
    || a === 0
    || a >= 224
}

function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.startsWith(':')) return false
  return hostname === '::' || /^f[cd]/u.test(hostname) || /^fe[89ab]/u.test(hostname) || /^::ffff:(?:7f|0a|a9fe|c0a8)/u.test(hostname)
}

/**
 * Whether the HOST may fetch this URL on a caller's behalf.
 *
 * The probe is an outbound request the caller never sees the body of, but its
 * status and embeddability answer still make it a reconnaissance primitive:
 * only public http(s) destinations are allowed, and every redirect hop is
 * judged by the same rule.
 * @param raw - the caller-supplied URL.
 * @returns the normalized URL, or the reason the destination is refused.
 */
export function evaluateProbeTarget(raw: string): ProbeTargetVerdict {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { kind: 'blocked', reason: 'invalid url' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'blocked', reason: 'only http/https urls can be probed' }
  // WHATWG normalization rewrites exotic IPv4 spellings (integer, hex, octal)
  // into dotted-quad, so the hostname checks below see the real address.
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase()
  if (hostname === '') return { kind: 'blocked', reason: 'url has no host' }
  if (isLoopbackHost(hostname)) return { kind: 'blocked', reason: 'probe target is not allowed: loopback' }
  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) return { kind: 'blocked', reason: 'probe target is not allowed: private network' }
  if (PRIVATE_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix))) {
    return { kind: 'blocked', reason: 'probe target is not allowed: private network' }
  }
  return { kind: 'ok', url: url.href }
}

/** The probe target, or the refusal the route turns into a 400. */
function requireProbeTarget(raw: string): URL {
  const verdict = evaluateProbeTarget(raw)
  if (verdict.kind === 'blocked') throw new BetterSidebarError('bad-request', verdict.reason)
  return new URL(verdict.url)
}

/**
 * Probe one public URL for embeddability.
 *
 * Redirects are followed manually so each hop passes the destination policy;
 * after {@link MAX_PROBE_REDIRECTS} hops the last response is reported as-is.
 * @param raw - the caller-supplied URL.
 * @param fetchImpl - fetch implementation (injected for tests).
 * @param signal - abort signal bounding the whole probe.
 * @returns the probe result for the final response.
 */
export async function probeBrowserUrl(raw: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<BrowserProbe> {
  let target = requireProbeTarget(raw)
  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(target, { method: 'HEAD', redirect: 'manual', signal })
    const location = response.headers.get('location')
    const redirected = response.status >= 300 && response.status < 400 && location !== null
    if (redirected && hop < MAX_PROBE_REDIRECTS) {
      target = requireProbeTarget(new URL(location, target).href)
      continue
    }
    const xFrameOptions = response.headers.get('x-frame-options') ?? undefined
    const frameAncestors = extractFrameAncestors(response.headers.get('content-security-policy'))
    const blocksXfo = xFrameOptions ? /^(deny|sameorigin)$/i.test(xFrameOptions.trim()) : false
    const blocksCsp = frameAncestors?.includes("'none'") ?? false
    return { url: response.url || target.href, status: response.status, ok: response.ok, ...(xFrameOptions ? { xFrameOptions } : {}), ...(frameAncestors ? { frameAncestors } : {}), embeddable: !blocksXfo && !blocksCsp }
  }
}