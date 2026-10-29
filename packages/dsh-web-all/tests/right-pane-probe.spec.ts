/**
 * The workbench browser probe makes the HOST fetch a client-supplied URL. It
 * was validated by scheme only, so a caller that passed the fence could point
 * it at loopback, link-local metadata, or any private-range service and read
 * back the status and embeddability of that request (a blind SSRF oracle).
 *
 * The probe now refuses non-public destinations and re-checks every redirect
 * hop instead of following redirects blindly.
 */
import { describe, expect, it, vi } from 'vitest'
import { BrowserProbe, evaluateProbeTarget, probeBrowserUrl } from '../src/host/services/right-pane/browser.ts'

function headResponse(headers: Record<string, string> = {}, status = 200, url = 'https://example.com/'): Response {
  return new Response(null, { status, headers, url }) as unknown as Response
}

describe('probe destination policy', () => {
  it('refuses loopback, private, link-local and non-http destinations', () => {
    const blocked = [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:3080/api/session/list',
      'http://127.1/',
      'http://2130706433/',
      'http://0x7f.0.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://localhost./',
      'http://localhost:3080/',
      'http://10.0.0.5/',
      'http://172.16.9.9/',
      'http://192.168.1.1/',
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://printer.local/',
      'http://service.internal/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://example.com/',
      'not a url',
    ]
    for (const url of blocked) {
      expect(evaluateProbeTarget(url).kind, url).toBe('blocked')
    }
    expect(evaluateProbeTarget('https://example.com/page').kind).toBe('ok')
    expect(evaluateProbeTarget('http://93.184.216.34/').kind).toBe('ok')
  })

  it('never issues the request for a refused destination', async () => {
    const fetchImpl = vi.fn(async () => headResponse())
    await expect(probeBrowserUrl('http://169.254.169.254/latest/meta-data/', fetchImpl as unknown as typeof fetch))
      .rejects.toThrow(/not allowed/u)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('re-checks redirect hops and never follows one into a private target', async () => {
    const fetchImpl = vi.fn(async () => headResponse({ location: 'http://127.0.0.1:3080/api/gateway/session' }, 302))
    await expect(probeBrowserUrl('https://example.com/redirect', fetchImpl as unknown as typeof fetch))
      .rejects.toThrow(/not allowed/u)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const publicHop = vi.fn(async (url: string | URL) => String(url).includes('second')
      ? headResponse({ 'x-frame-options': 'DENY' }, 200, 'https://second.example/')
      : headResponse({ location: 'https://second.example/' }, 302))
    const probe = await probeBrowserUrl('https://example.com/first', publicHop as unknown as typeof fetch)
    expect(publicHop).toHaveBeenCalledTimes(2)
    expect(probe).toEqual({
      url: 'https://second.example/',
      status: 200,
      ok: true,
      xFrameOptions: 'DENY',
      embeddable: false,
    })
  })

  it('stops after the redirect budget instead of looping', async () => {
    let hop = 0
    const fetchImpl = vi.fn(async () => headResponse({ location: `https://example.com/hop-${hop += 1}` }, 302))
    const probe = await probeBrowserUrl('https://example.com/start', fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(probe.status).toBe(302)
  })

  it('keeps the probe shape for an embeddable public page', async () => {
    const fetchImpl = vi.fn(async () => headResponse({}, 200, 'https://example.com/ok'))
    const probe: BrowserProbe = await probeBrowserUrl('https://example.com/ok', fetchImpl as unknown as typeof fetch)
    expect(probe).toEqual({ url: 'https://example.com/ok', status: 200, ok: true, embeddable: true })
  })
})