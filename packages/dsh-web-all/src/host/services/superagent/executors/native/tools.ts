import { createHash, randomUUID } from 'node:crypto'
import type { createControlledKernel, ExecutionEnvelope, ActionSpec } from '../../kernel/actions.ts'
import type { Json } from '../../protocol/managed-work.ts'
const helper = String.raw`
const fs=require('node:fs'),path=require('node:path');
try {
 const input=JSON.parse(process.argv[1]),root=process.cwd(),parts=input.path.split('/');
 if(!parts.length||parts.some(p=>!p||p==='.'||p==='..'||p.startsWith('.'))||path.isAbsolute(input.path))throw Error('PATH_DENIED');
 let current=root;
 for(const part of parts.slice(0,-1)){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink()||!fs.lstatSync(current).isDirectory())throw Error('PATH_DENIED')}
 const target=path.join(current,parts.at(-1));
 if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('PATH_DENIED');
 if(input.mode==='write'){
  const fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,input.content)}finally{fs.closeSync(fd)}
  console.log(JSON.stringify({success:true,text:'written'}));
 }else{
  const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let text;
  try{if(fs.fstatSync(fd).size>65536)throw Error('FILE_TOO_LARGE');text=fs.readFileSync(fd,'utf8')}finally{fs.closeSync(fd)}
  if(input.mode==='check'){if(text!==input.expected)throw Error('CONTENT_MISMATCH');console.log(JSON.stringify({success:true,text:'checked'}))}
  else console.log(JSON.stringify({success:true,text}));
 }
}catch(error){console.log(JSON.stringify({success:false,text:String(error.message)}));process.exitCode=1}
`
export const nativeFileToolSchemas: Json[] = [
  {
    type: 'function',
    name: 'read',
    description: 'Read one UTF-8 file in the assigned candidate directory. Relative paths only.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'write',
    description:
      'Write UTF-8 content to one file in the assigned candidate directory. No commands. Relative paths only.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'check',
    description:
      'Check that one candidate file exactly equals expected text. This is a content check, not code execution or acceptance.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, expected: { type: 'string' } },
      required: ['path', 'expected'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'ask',
    description:
      'Ask the coordinating host a technical question and wait for its answer. This does not contact the user.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
      additionalProperties: false
    }
  }
]
type ToolResult = { success: boolean; text: string }
const helperQueues = new Map<string, { pending: number; tail: Promise<void> }>()

/** A bounded candidate-domain queue. Other workspaces and technical questions remain independent. */
async function inHelperDomain(domain: string, execute: () => Promise<ToolResult>): Promise<ToolResult> {
  let queue = helperQueues.get(domain)
  if (!queue) {
    queue = { pending: 0, tail: Promise.resolve() }
    helperQueues.set(domain, queue)
  }
  if (queue.pending >= 9) return { success: false, text: 'HELPER_QUEUE_FULL' }
  queue.pending++
  const previous = queue.tail
  let release!: () => void
  queue.tail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await execute()
  } finally {
    queue.pending--
    release()
    if (queue.pending === 0) helperQueues.delete(domain)
  }
}

/** Trusted host helper factory. Model data never becomes host code or executable argv. */
export class ControlledFileTools {
  constructor(
    private readonly kernel: ReturnType<typeof createControlledKernel>,
    private readonly launch: ExecutionEnvelope,
    private readonly nodeExecutable: string,
    private readonly allocation?: { readonly writePaths: readonly string[] }
  ) {}
  async call(
    name: string,
    args: unknown,
    sourceRef = 'host:fixed-helper'
  ): Promise<{ success: boolean; text: string }> {
    if (
      !['read', 'write', 'check'].includes(name) ||
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args)
    )
      return { success: false, text: 'TOOL_UNSUPPORTED' }
    const value = args as Record<string, unknown>,
      allowed = name === 'write' ? ['path', 'content'] : name === 'check' ? ['path', 'expected'] : ['path']
    if (
      Object.keys(value).some((k) => !allowed.includes(k)) ||
      typeof value.path !== 'string' ||
      value.path.length > 512 ||
      value.path.split('/').some((p) => !p || p === '.' || p === '..' || p.startsWith('.')) ||
      allowed.some((k) => typeof value[k] !== 'string') ||
      JSON.stringify(value).length > 65536
    )
      return { success: false, text: 'TOOL_ARGUMENTS_DENIED' }
    if (name === 'write' && this.allocation && !this.allocation.writePaths.includes(value.path)) return { success: false, text: 'ROLE_WRITE_PATH_DENIED' }
    // Copy validated primitive arguments before waiting; callers cannot alter queued payloads.
    const snapshot = { ...value }
    return inHelperDomain(this.launch.workspace.root, () => this.execute(name, snapshot, sourceRef))
  }
  private async execute(
    name: string,
    value: Record<string, unknown>,
    sourceRef: string
  ): Promise<ToolResult> {
    const fence = this.kernel.host.fenceDispatch(this.launch.actionRef)
    if (fence.kind === 'denial') return { success: false, text: fence.code }
    if (
      sourceRef !== 'host:fixed-helper' &&
      !this.kernel.host.claimNativeRequest(this.launch.actionRef, 'helper:' + sourceRef)
    )
      return { success: false, text: 'TOOL_REQUEST_ALREADY_CLAIMED' }
    const id = 'helper:' + randomUUID(),
      argv = ['-e', helper, JSON.stringify({ mode: name, ...value })],
      capabilityId = 'helper-cap:' + randomUUID()
    this.kernel.host.grantCapability({
      id: capabilityId,
      revision: 1,
      expiresAt: this.launch.expiresAt,
      scopeRefs: this.launch.spec.scopeRefs,
      evidenceRefs: [sourceRef, 'fixed-helper:sha256:' + createHash('sha256').update(helper).digest('hex')],
      externalTools: 'blocked',
      revoked: false,
      launch: { executable: this.nodeExecutable, args: argv, processPolicy: 'single' }
    })
    const spec: ActionSpec = {
      ...this.launch.spec,
      id,
      idempotencyKey: id,
      kind: name === 'write' ? 'respond_request' : 'inspect',
      capabilityRef: { id: capabilityId, revision: 1 },
      executable: this.nodeExecutable,
      args: argv,
      timeoutMs: 5000,
      processPolicy: 'single'
    }
    delete spec.nativeRequestId
    delete spec.payloadDigest
    const action = this.kernel.actions.planAction(spec),
      borrowed = this.kernel.host.borrowSessionResources(action.ref, this.launch.actionRef)
    if (borrowed.kind === 'denial') return { success: false, text: borrowed.code }
    const result = await this.kernel.host.executeSessionHelper(action.ref)
    if ('kind' in result) return { success: false, text: result.code }
    if (result.receipt?.status === 'unknown') return { success: false, text: 'HELPER_OUTCOME_UNKNOWN' }
    try {
      return JSON.parse(result.receipt?.observation?.stdout ?? '') as { success: boolean; text: string }
    } catch {
      return { success: false, text: 'HELPER_OUTPUT_INVALID' }
    }
  }
}
