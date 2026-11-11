import type { Json, Extension } from './managed-work.ts'

export interface ExtensionSchema {
  namespace: string
  schema: number
  owner: string
  validate(payload: unknown): boolean
}
/** Host-injected validation only: schemas cannot write core fields or grant authority. */
export interface ExtensionRegistry { validate(name: string, extension: Extension): void }

export function createExtensionRegistry(schemas: readonly ExtensionSchema[]): ExtensionRegistry {
  const registered = new Map<string, (payload: Json) => boolean>()
  for (const schema of schemas) {
    if (!/^[a-z][a-z0-9.-]*\/[a-zA-Z0-9_.-]+$/.test(schema.namespace) || !schema.owner.trim() || !Number.isSafeInteger(schema.schema) || schema.schema < 1 || typeof schema.validate !== 'function') throw new Error('INVALID_EXTENSION_SCHEMA')
    const key = `${schema.namespace}@${schema.schema}`
    if (registered.has(key)) throw new Error('EXTENSION_SCHEMA_CONFLICT')
    const validator = schema.validate
    registered.set(key, payload => validator(structuredClone(payload)))
  }
  return Object.freeze({ validate(name: string, extension: Extension) {
    const validator = registered.get(`${name}@${extension.schema}`)
    if (!validator) {
      if (extension.required) throw new Error('UNKNOWN_REQUIRED_EXTENSION')
      return
    }
    let valid = false
    try { valid = validator(extension.payload) === true } catch { /* fail closed */ }
    if (!valid) throw new Error('INVALID_EXTENSION_PAYLOAD')
  } })
}
