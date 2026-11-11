/** Length is measured on original bytes; UTF-8 is decoded only after the LF boundary. */
export class SandboxFrameDecoder {
  private readonly buffer: Buffer
  private bytes = 0
  private readonly maximum: number
  constructor(maximum: number) { if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2 * 1024 * 1024) throw new Error('SANDBOX_FRAME_LIMIT'); this.maximum = maximum; this.buffer = Buffer.allocUnsafe(maximum) }
  push(chunk: Buffer): Record<string, unknown>[] {
    const frames: Record<string, unknown>[] = []
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      this.bytes += part.length
      if (this.bytes > this.maximum) throw new Error('SANDBOX_PROTOCOL_TOO_LARGE')
      part.copy(this.buffer, this.bytes - part.length)
      if (newline < 0) break
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, this.bytes))
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('SANDBOX_PROTOCOL_OBJECT')
      frames.push(parsed as Record<string, unknown>); this.bytes = 0; offset = newline + 1
    }
    return frames
  }
  finish(): void { if (this.bytes) throw new Error('SANDBOX_PROTOCOL_TRUNCATED') }
}
export const exactWireKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
export function decodeSandboxBytes(value: unknown, maximum: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4) throw new Error('SANDBOX_BYTE_FRAME')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > maximum || bytes.toString('base64') !== value) throw new Error('SANDBOX_BYTE_FRAME')
  return bytes
}
export class SandboxEventValidator {
  private sequence = 1
  private spawned = false
  private exited = false
  private refused = false
  private ended = false
  private readonly handleId: string
  constructor(handleId: string) { this.handleId = handleId }
  accept(m: Record<string, unknown>): void {
    if (this.ended || m.version !== 1 || m.seq !== this.sequence) throw new Error('SANDBOX_EVENT_SEQUENCE')
    const keys = (fields: string[]) => exactWireKeys(m, ['version', 'seq', 'type', ...fields])
    const reason = () => typeof m.reason === 'string' && m.reason.length > 0 && m.reason.length <= 8192
    switch (m.type) {
      case 'spawned':
        if (this.spawned || this.refused || !keys(['handleId', 'pid', 'originalDigest', 'effectiveDigest']) || m.handleId !== this.handleId || !Number.isSafeInteger(m.pid) || Number(m.pid) < 1 || !/^[a-f0-9]{64}$/.test(String(m.originalDigest)) || !/^[a-f0-9]{64}$/.test(String(m.effectiveDigest))) throw new Error('SANDBOX_EVENT_SPAWN')
        this.spawned = true; break
      case 'stdout': case 'stderr':
        if (!this.spawned || !keys(['data'])) throw new Error('SANDBOX_EVENT_OUTPUT')
        decodeSandboxBytes(m.data, 65536); break
      case 'ack':
        if (!keys(m.error === undefined ? ['inputSeq'] : ['inputSeq', 'error']) || !Number.isSafeInteger(m.inputSeq) || Number(m.inputSeq) < 2 || (m.error !== undefined && (typeof m.error !== 'string' || m.error.length > 8192))) throw new Error('SANDBOX_EVENT_ACK')
        break
      case 'exit':
        if (!this.spawned || this.exited || !keys(['code', 'signal']) || !((Number.isInteger(m.code) && Number(m.code) >= 0 && Number(m.code) <= 255 && m.signal === null) || (m.code === null && typeof m.signal === 'string' && /^SIG[A-Z0-9]+$/.test(m.signal)))) throw new Error('SANDBOX_EVENT_EXIT')
        this.exited = true; break
      case 'refused':
        if (this.spawned || this.refused || !keys(['reason']) || !reason()) throw new Error('SANDBOX_EVENT_REFUSAL')
        this.refused = true; break
      case 'error':
        if (!keys(['reason']) || !reason()) throw new Error('SANDBOX_EVENT_ERROR')
        break
      case 'observation-end':
        if (!keys(['complete']) || typeof m.complete !== 'boolean' || (m.complete && !this.exited && !this.refused)) throw new Error('SANDBOX_EVENT_END')
        this.ended = true; break
      default: throw new Error('SANDBOX_EVENT_UNKNOWN')
    }
    this.sequence++
  }
}
