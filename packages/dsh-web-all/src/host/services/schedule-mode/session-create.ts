/**
 * 运行会话创建请求的纯构造逻辑。
 *
 * 刻意**不带** `workspaceId`：DSH 的「新建会话」会复用当前工作区里尚未产生第一轮
 * 对话的空会话（`dsh-client-ui-workspace` 的 `reuseOrCreateBlank`：`blank` 一直为真
 * 直到会话提交首个 `turn/start`），而「每次新会话」必须在投递前先把运行会话建出来。
 * 两者相遇时，用户刚点开的「新对话」会被认领成自动化的待运行会话——连带继承
 * `<任务名> · #N` 的名字和挂在上面的待投递提醒。因此运行会话先只按 `cwd` 创建，
 * 等它真正投递出第一轮后由引擎挂回工作区（见同目录 `index.ts` 的 `attachSession`
 * 端口）。`agentPreset` 原样透传，缺省时不发送。
 */

/** 引擎侧的会话创建输入。 */
export interface ScheduleModeSessionInput {
  readonly cwd?: string
  readonly agentPreset?: string
}

/** 传给 `sessionController.create` 的请求体。 */
export interface ScheduleModeSessionCreateRequest {
  readonly cwd?: string
  readonly agentPreset?: string
}

/**
 * 构造创建请求：只带 `cwd` 与 `agentPreset`，不请求工作区归属，
 * 让待运行会话留在工作区之外直到它产生第一轮对话。
 */
export function buildSessionCreateRequest(
  input: ScheduleModeSessionInput,
): ScheduleModeSessionCreateRequest {
  return {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }),
  }
}
