import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { hostUrlOf, isTrustedHostRequest, isLoopbackRequest, matchesTrustedAuthority } from '../src/host/services/access-trust/trust.ts'

function req(host: unknown, headers: Record<string, unknown> = {}, address = '127.0.0.1'): IncomingMessage {
  return { headers: { host, ...headers }, socket: { remoteAddress: address } } as unknown as IncomingMessage
}
const valid = ['localhost', 'localhost:3080', '127.0.0.1:3080', '[::1]:3080', '127.9.8.7']
const malformed = [
  'attacker.test@localhost:3080', 'localhost:3080/attacker', 'localhost:3080?x=1',
  'localhost:3080#ignored', ' localhost:3080', 'localhost:3080 ', 'localhost:3080\\anything',
  'localhost:3080\t', 'localhost:3080\n', 'localhost:3080/path@attacker.test',
]

describe('host fence adversarial authorities', () => {
  for (const host of valid) it(`accepts explicit loopback authority ${host}`, () => {
    expect(isLoopbackRequest(req(host))).toBe(true)
  })
  for (const host of malformed) it(`rejects malformed Host ${JSON.stringify(host)} before normalization`, () => {
    expect(hostUrlOf(req(host))).toBeUndefined()
    expect(isLoopbackRequest(req(host))).toBe(false)
    expect(isTrustedHostRequest(req(host))).toBe(false)
  })
  for (const host of [undefined, null, [], {}, '', 'evil.test', 'localhost.evil.test', '127.0.0.1.evil.test']) {
    it(`denies missing, shaped or suffix-spoofed Host ${JSON.stringify(host)}`, () => {
      expect(isLoopbackRequest(req(host))).toBe(false)
    })
  }
  it('ignores forwarded identity and never authenticates an undeclared authority', () => {
    for (const address of ['10.1.2.3', '::ffff:10.1.2.3', undefined]) {
      const request = req('localhost:3080', { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost' })
      Object.assign(request.socket, { remoteAddress: address })
      expect(isTrustedHostRequest(request, { trustedAuthorities: ['evil.test'], isAuthenticated: () => true })).toBe(false)
    }
    expect(isTrustedHostRequest(req('evil.test', { 'x-forwarded-host': 'localhost' }), { isAuthenticated: () => true })).toBe(false)
  })
  it('requires exact explicit nondefault trusted port and refuses invalid configured authorities', () => {
    const url = new URL('http://dsh.example:3080')
    expect(matchesTrustedAuthority(url, ['dsh.example:3081'])).toBe(false)
    for (const configured of [' dsh.example', 'dsh.example/path', 'user@dsh.example', '*.example', 'dsh.example:03080']) {
      expect(matchesTrustedAuthority(url, [configured])).toBe(false)
    }
    expect(matchesTrustedAuthority(url, ['dsh.example:3080'])).toBe(true)
  })
  it('does not trust throwing or truthy-shaped authentication predicates', () => {
    const request = req('dsh.example:3080')
    expect(isTrustedHostRequest(request, { trustedAuthorities: ['dsh.example'], isAuthenticated: () => { throw new Error('inactive') } })).toBe(false)
    expect(isTrustedHostRequest(request, { trustedAuthorities: ['dsh.example'], isAuthenticated: (() => 'yes') as never })).toBe(false)
  })
  for (const origin of ['null', 'https://evil.test', '//localhost:3080', 'http://localhost:3080@evil.test', 'http://localhost:3081']) {
    it(`denies attacker Origin ${origin}`, () => {
      expect(isLoopbackRequest(req('localhost:3080', { origin }))).toBe(false)
    })
  }
})
