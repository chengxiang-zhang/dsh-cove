/**
 * ssh host 服务域 —— agent 工具层（全新实现；行为契约参考旧包）。
 *
 * 工具名冻结：ssh_list / ssh_exec / ssh_upload / ssh_download / ssh_tunnel /
 * ssh_cluster。用 SDK 的 defineTool 声明；text 渲染与参数 schema 保持旧包
 * 可感知形状（模型侧契约不变）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SshEngine } from './engine.ts'
import type { HostStore } from './store.ts'
import type { ExecResult, SshHostSummary } from '../../../core/ssh/protocol.ts'

/** 纯文本内容块（这些工具唯一渲染形状）。 */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** 主机表格渲染。 */
function renderHosts(hosts: SshHostSummary[]): string {
  if (hosts.length === 0) return 'no hosts configured'
  const rows = hosts.map(host => [
    host.alias, host.host, String(host.port), host.user, host.auth,
    host.environment ?? '-', (host.tags.length > 0 ? host.tags.join(',') : '-'), host.description ?? '',
  ].join(' | '))
  return ['alias | host | port | user | auth | environment | tags | description', '--- | --- | --- | --- | --- | --- | --- | ---', ...rows].join('\n')
}

/** exec 结果文本。 */
function renderExec(result: ExecResult): string {
  if (!result.success) {
    const reason = result.error ?? (result.timedOut
      ? `timed out after ${result.durationMs}ms; remote command terminated (retry with a larger timeoutMs to allow more time)`
      : `exit ${result.exitCode ?? '?'}`)
    return `failed: ${reason}${result.stdout ? `\nstdout:\n${result.stdout.trimEnd()}` : ''}${result.stderr ? `\nstderr:\n${result.stderr.trimEnd()}` : ''}`
  }
  return result.stdout.trimEnd() || '(no output)'
}

export function sshListTool(engine: SshEngine) {
  return defineTool({
    name: 'ssh_list',
    description: 'List configured SSH hosts (alias, host, user, auth, environment, tags, description). Use ssh_exec etc. with the alias. Triggers: SSH, remote server, server IP/hostname, connect/login, check server/status, deploy, upload/download, jump host, tunnel, port forward.',
    parameters: {
      query: { type: 'string', description: 'Optional fuzzy match against alias, description, host, and tags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hosts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true },
                user: { type: 'string', required: true },
                auth: { type: 'string', enum: ['key', 'password', 'agent'], required: true },
                keyReady: { type: 'boolean', required: true },
                proxyJump: { type: 'array', items: { type: 'string' }, required: true },
                description: { type: 'string' },
                environment: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' }, required: true },
                location: { type: 'string' },
                createdAt: { type: 'integer', required: true },
                updatedAt: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { hosts?: SshHostSummary[] }) => text(renderHosts(value.hosts ?? [])),
    },
    async execute(args) {
      return { hosts: engine.list(args.query) }
    },
  })
}

export function sshExecTool(engine: SshEngine) {
  return defineTool({
    name: 'ssh_exec',
    description: 'Execute a command on a remote host and return the result. ' +
      'Every command has a timeout (120000 ms unless the call passes timeoutMs); on timeout the remote command is terminated instead of hanging. ' +
      'Triggers: SSH, remote server, server IP/hostname, connect/login, run command on server, deploy, check server status, jump host.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Configured host alias (see ssh_list).' },
      command: { type: 'string', required: true, description: 'The shell command to run.' },
      timeoutMs: { type: 'integer', description: 'Optional per-command timeout in milliseconds (default 120000). When it fires the channel is closed and the remote command is terminated.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          timedOut: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value: ExecResult) => text(renderExec(value)),
    },
    async execute(args) {
      const result = await engine.exec(args.alias, args.command, typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined)
      return result
    },
  })
}

export function sshUploadTool(engine: SshEngine) {
  return defineTool({
    name: 'ssh_upload',
    description: 'Upload a local file to a remote host over SFTP. ' +
      'Triggers: upload file to server, push file to remote host, deploy artifact, scp equivalent.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Configured host alias.' },
      localPath: { type: 'string', required: true, description: 'Absolute path of the local file.' },
      remotePath: { type: 'string', required: true, description: 'Absolute target path on the remote host.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bytes: { type: 'integer', required: true },
          files: { type: 'integer', required: true },
        },
      },
      render: (_args, value: { bytes: number; files: number }) => text(`uploaded ${value.files} file(s), ${value.bytes} bytes`),
    },
    async execute(args) {
      const result = await engine.upload(args.alias, args.localPath, args.remotePath)
      return { bytes: result.bytes, files: result.files }
    },
  })
}

export function sshDownloadTool(engine: SshEngine) {
  return defineTool({
    name: 'ssh_download',
    description: 'Download a remote file to the local machine over SFTP. ' +
      'Triggers: download file from server, fetch remote artifact, scp equivalent.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Configured host alias.' },
      remotePath: { type: 'string', required: true, description: 'Absolute source path on the remote host.' },
      localPath: { type: 'string', required: true, description: 'Absolute destination path on this machine.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          localPath: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value: { localPath: string; bytes: number }) => text(`downloaded to ${value.localPath} (${value.bytes} bytes)`),
    },
    async execute(args) {
      const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      const client = await engine.acquire(args.alias)
      const data = await new Promise<Buffer>((resolvePromise, rejectPromise) => {
        client.sftp((error, sftp) => {
          if (error !== undefined) { rejectPromise(error); return }
          sftp.readFile(args.remotePath, (readError, buf) => {
            if (readError !== undefined) { rejectPromise(readError); return }
            resolvePromise(buf)
          })
        })
      })
      mkdirSync(dirname(args.localPath), { recursive: true })
      writeFileSync(args.localPath, data)
      void readFileSync
      return { localPath: args.localPath, bytes: data.length }
    },
  })
}

export function sshTunnelTool(engine: SshEngine) {
  return defineTool({
    name: 'ssh_tunnel',
    description: 'Create a local port-forward tunnel to a remote service. ' +
      'Triggers: tunnel, port forward, access remote database/service, connect to internal network resource.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Configured host alias.' },
      remoteHost: { type: 'string', required: true, description: 'Remote host to reach (often 127.0.0.1 on the remote side).' },
      remotePort: { type: 'integer', required: true, description: 'Remote port to forward.' },
      localPort: { type: 'integer', description: 'Optional local listen port (0 = auto-assign).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          localPort: { type: 'integer', required: true },
          remoteHost: { type: 'string', required: true },
          remotePort: { type: 'integer', required: true },
        },
      },
      render: (_args, value: { localPort: number; remoteHost: string; remotePort: number }) =>
        text(`tunnel listening on 127.0.0.1:${value.localPort} -> ${value.remoteHost}:${value.remotePort}`),
    },
    async execute(args) {
      const result = await engine.tunnel(args.alias, typeof args.localPort === 'number' ? args.localPort : 0, args.remoteHost, args.remotePort)
      return { localPort: result.localPort, remoteHost: args.remoteHost, remotePort: args.remotePort }
    },
  })
}

export function sshClusterTool(engine: SshEngine) {
  return defineTool({
    name: 'ssh_cluster',
    description: 'Run the same command concurrently on multiple hosts and return per-host results. ' +
      'Triggers: run on all servers, batch operation, production servers, cluster command.',
    parameters: {
      aliases: { type: 'array', items: { type: 'string' }, required: true, description: 'Configured host aliases to run on.' },
      command: { type: 'string', required: true, description: 'The shell command to run on every host.' },
      timeoutMs: { type: 'integer', description: 'Optional per-host timeout in milliseconds (default 120000). When it fires the channel is closed and the remote command is terminated.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                timedOut: { type: 'boolean' },
                stdout: { type: 'string' },
                stderr: { type: 'string' },
                durationMs: { type: 'integer' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value: { results: Array<{ alias: string; ok: boolean; stdout?: string; stderr?: string; error?: string }> }) =>
        text(value.results.map(r => `=== ${r.alias} ===\n${[r.stdout, r.stderr].filter(Boolean).join('\n') || (r.ok ? 'ok' : r.error ?? 'fail')}`).join('\n')),
    },
    async execute(args) {
      const results = await engine.cluster({
        aliases: args.aliases,
        command: args.command,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      })
      return { results }
    },
  })
}

/** 全部 ssh agent 工具。 */
export function makeSshTools(engine: SshEngine, _store: HostStore): Array<ReturnType<typeof sshListTool>> {
  return [
    sshListTool(engine),
    sshExecTool(engine),
    sshUploadTool(engine),
    sshDownloadTool(engine),
    sshTunnelTool(engine),
    sshClusterTool(engine),
  ]
}