# 记忆面板（只读）

侧栏「记忆」页是 OpenViking 记忆的浏览器入口：全局空间与当前工作区空间各一个页签，可逐层翻目录、看文档原文、做语义检索。它只读——不新建记忆、不修改记忆、不落任何本地存储，记忆本体始终是 OpenViking 插件写入的那一份。归属判定见 [native-capability-boundary.md](native-capability-boundary.md)。

## 两个作用域

| 作用域 | 记忆根 | 内容 |
| --- | --- | --- |
| 全局 | `viking://user/<user>/memories` | 用户档案、偏好、实体、事件、经验，跨仓库共享 |
| 工作区 | `viking://user/<user>/peers/<peer>/memories` | 按仓库分空间的记忆，随 `git` 身份走 |

工作区页签的 `peer` 由宿主从当前会话目录推导，顺序是 `remote.origin.url` 归一化（`git@github.com:owner/repo.git` 与 `https://github.com/owner/repo` 落到同一个 `github.com-owner-repo`），仓库没有 remote 时退回仓库根路径，不在 git 仓库里则为空。没有 `peer` 时工作区页签退回全局空间并给出提示，不会读到一个空目录。

## 端点

四个只读端点挂在 `/api/dsh-memory` 下，统一用 `{ ok: true, value }` / `{ ok: false, error }` 信封：

| 方法 | 路径 | 参数 | 返回 |
| --- | --- | --- | --- |
| GET | `/api/dsh-memory/status` | `cwd?` | 连接状态 + 工作区 peer |
| GET | `/api/dsh-memory/list` | `scope`、`path?`、`cwd?` | 目录列举 |
| GET | `/api/dsh-memory/read` | `uri`、`cwd?` | 文档原文 |
| POST | `/api/dsh-memory/search` | `{ query, scope?, limit? }`、`cwd?` | 检索命中 |

宿主把 OpenViking 的 `GET /api/v1/fs/ls`、`GET /api/v1/content/read`、`POST /api/v1/search/search` 转成上面的形状；浏览器永远拿不到 OpenViking 的 API key，也拿不到未经校验的 URI。

## 安全模型

- **围栏**：四个端点都先过共享宿主围栏 `accessTrustOf(ctx).isTrusted(request)`，不通过直接 403。只读接口同样是特权面，不因为是 GET 而放宽。
- **URI 归属**：只接受 `viking://user/<user>/memories` 与其下路径，以及当前请求目录推导出的那个 peer 空间；按路径段比较，`..`、反斜杠、控制字符、查询串一律拒绝，另起 scheme 一律拒绝。
- **身份不由客户端决定**：peer 由宿主自己跑 `git` 推导，再用推导结果校验 URI，客户端无法伪造 peer 标识。但 `cwd` 本身就是客户端给的输入，任何通过围栏的会话都能把它指向宿主上任意存在的目录，从而看到那个目录对应的记忆空间；边界是围栏与 OpenViking 的账号，不是 `cwd`。
- **密钥只在宿主**：OpenViking 的地址与 key 从 `~/.openviking/ovcli.conf`（或环境变量）读取，只用于宿主到 OpenViking 的请求，不进日志、不进响应、不进浏览器。

## 配置

| 项 | 环境变量 | 文件 |
| --- | --- | --- |
| 服务地址 | `OPENVIKING_URL` / `OPENVIKING_BASE_URL` | `ovcli.conf` 的 `url` |
| API key | `OPENVIKING_API_KEY` | `ovcli.conf` 的 `api_key` |
| 账号 | `OPENVIKING_ACCOUNT` | `ovcli.conf` 的 `account` |
| 用户 | `OPENVIKING_USER` | `ovcli.conf` 的 `user`（默认 `admin`） |

环境变量优先于文件。没有配置时面板显示未配置状态，不报错、不重试风暴。

## 失败形态

| 码 | 含义 | 面板表现 |
| --- | --- | --- |
| `not-configured` | 没有 `url` 或 `api_key` | 提示去配置 `~/.openviking/ovcli.conf` |
| `unreachable` | 服务不可达或超时 | 提示服务不可达，可重试 |
| `unauthorized` | 上游 401/403 | 提示 key 无效或已撤销 |
| `forbidden` | 请求越出允许的记忆根 | 提示该路径不在允许范围 |
| `not-found` | 上游 404 | 提示条目不存在 |
| `malformed` | 请求参数不合法（`scope`、`path`、`uri`、`cwd`、请求体），或上游返回形状不符 | 提示请求或响应异常 |
| `internal` | 其它宿主侧失败 | 提示未知错误 |

## 已知限制

- 只读：面板不提供写入、编辑、删除；写入由 OpenViking 插件在会话提交时完成，agent 侧用 `mcp__openviking__remember` 等工具。
- 目录列举不分页：OpenViking 的 `fs/ls` 没有分页参数，单目录条目很多时一次返回全部。
- 检索走 OpenViking 的语义检索，`scope` 选择只是限定空间，不是关键词过滤。
- 预览按 Markdown 的块级结构渲染标题、列表、引用与代码块，不做完整语法解析。
- 会话目录已被删除时按「没有工作区」处理并退回全局空间，不报错；此时工作区页签显示的记忆与全局页签相同。