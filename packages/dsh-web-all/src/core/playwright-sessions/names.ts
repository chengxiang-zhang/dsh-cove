/** Deterministic public tool and safe per-session directory names. */

const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const MAX_PUBLIC_NAME_LENGTH = 64
const HASH_LENGTH = 12

/** A small synchronous SHA-256 implementation keeps this core module host/client pure. */
function sha256Hex(value: string): string {
  const rightRotate = (word: number, amount: number): number => (word >>> amount) | (word << (32 - amount))
  const constants: number[] = []
  const initial: number[] = []
  for (let candidate = 2; constants.length < 64; candidate += 1) {
    let prime = true
    for (let divisor = 2; divisor * divisor <= candidate; divisor += 1) {
      if (candidate % divisor === 0) {
        prime = false
        break
      }
    }
    if (!prime) continue
    if (initial.length < 8) initial.push((Math.sqrt(candidate) * 0x100000000) | 0)
    constants.push((Math.cbrt(candidate) * 0x100000000) | 0)
  }

  const bytes = new TextEncoder().encode(value)
  const bitLength = bytes.length * 8
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)

  const hash = initial.slice()
  const words = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false)
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15] ?? 0
      const word2 = words[index - 2] ?? 0
      const sigma0 = rightRotate(word15, 7) ^ rightRotate(word15, 18) ^ (word15 >>> 3)
      const sigma1 = rightRotate(word2, 17) ^ rightRotate(word2, 19) ^ (word2 >>> 10)
      words[index] = (((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0)
    }
    let [a, b, c, d, e, f, g, h] = hash as [number, number, number, number, number, number, number, number]
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + choice + (constants[index] ?? 0) + (words[index] ?? 0)) >>> 0
      const sum0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    const current = [a, b, c, d, e, f, g, h]
    for (let index = 0; index < 8; index += 1) hash[index] = ((hash[index] ?? 0) + (current[index] ?? 0)) >>> 0
  }
  return hash.map((word) => word.toString(16).padStart(8, '0')).join('')
}

export function publicPlaywrightToolName(rawName: string): string {
  const joined = `mcp__playwright__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = sha256Hex(`playwright\0${rawName}`).slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

export function sanitizePlaywrightSessionKey(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (cleaned.length > 0 && cleaned.length <= 80) return cleaned
  const hash = sha256Hex(sessionId).slice(0, HASH_LENGTH)
  if (cleaned.length === 0) return hash
  return `${cleaned.slice(0, 60)}-${hash}`
}
