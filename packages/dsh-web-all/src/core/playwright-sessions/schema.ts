/** Convert Playwright MCP's zod-style schema snapshots to plain JSON Schema. */

export type JsonSchema = Record<string, unknown>

interface ConvertedNode {
  schema: JsonSchema
  required: boolean
}

export function convertPlaywrightInputSchema(input: unknown): JsonSchema {
  const { schema } = convertNode(asRecord(input))
  return schema.type === 'object'
    ? schema
    : { type: 'object', properties: {}, additionalProperties: false }
}

function convertNode(node: Record<string, unknown>): ConvertedNode {
  const definition = asRecord(node.def)
  const type = typeof definition.type === 'string'
    ? definition.type
    : typeof node.type === 'string' ? node.type : undefined

  switch (type) {
    case 'object': {
      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      for (const [key, raw] of Object.entries(asRecord(definition.shape))) {
        const converted = convertNode(asRecord(raw))
        properties[key] = converted.schema
        if (converted.required) required.push(key)
      }
      const schema: JsonSchema = { type: 'object', properties }
      if (required.length > 0) schema.required = required
      return { schema, required: true }
    }
    case 'string': {
      const schema: JsonSchema = { type: 'string' }
      copyFlag(schema, 'format', node, definition, 'string')
      copyFlag(schema, 'minLength', node, definition, 'number')
      copyFlag(schema, 'maxLength', node, definition, 'number')
      return { schema, required: true }
    }
    case 'number': {
      const schema: JsonSchema = { type: flag(node, definition, 'isInt') === true ? 'integer' : 'number' }
      const minimum = flag(node, definition, 'minValue')
      const maximum = flag(node, definition, 'maxValue')
      if (typeof minimum === 'number' && Number.isFinite(minimum)) schema.minimum = minimum
      if (typeof maximum === 'number' && Number.isFinite(maximum)) schema.maximum = maximum
      return { schema, required: true }
    }
    case 'boolean':
      return { schema: { type: 'boolean' }, required: true }
    case 'enum': {
      const options = flag(node, definition, 'options')
      const values = Array.isArray(options) && options.length > 0
        ? options
        : Object.values(asRecord(definition.entries))
      const schema: JsonSchema = { type: 'string' }
      if (values.length > 0) schema.enum = values
      return { schema, required: true }
    }
    case 'array': {
      const items = convertNode(asRecord(definition.element)).schema
      return { schema: { type: 'array', items }, required: true }
    }
    case 'record': {
      const values = convertNode(asRecord(definition.valueType)).schema
      return { schema: { type: 'object', additionalProperties: values }, required: true }
    }
    case 'default': {
      const schema = convertNode(asRecord(definition.innerType)).schema
      const defaultValue = flag(definition, node, 'defaultValue')
      if (defaultValue !== undefined) schema.default = defaultValue
      return { schema, required: false }
    }
    case 'optional':
      return { schema: convertNode(asRecord(definition.innerType)).schema, required: false }
    default:
      return { schema: {}, required: false }
  }
}

function copyFlag(
  schema: JsonSchema,
  outputKey: string,
  node: Record<string, unknown>,
  definition: Record<string, unknown>,
  expectedType: 'string' | 'number',
): void {
  const value = flag(node, definition, outputKey)
  if (typeof value === expectedType) schema[outputKey] = value
}

function flag(node: Record<string, unknown>, definition: Record<string, unknown>, key: string): unknown {
  return node[key] !== undefined ? node[key] : definition[key]
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
