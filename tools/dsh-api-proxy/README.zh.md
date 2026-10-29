# dsh-api-proxy

[English](README.md) | 中文

一个轻量级 OAuth 转 API 代理，把你的 Claude（Anthropic）、ChatGPT（OpenAI Codex）订阅，以及实验性的本地 Cursor 登录态变成可调用的 API，适配 Claude Code 与 OpenAI 兼容客户端。

dsh-api-proxy 的定位很克制：

- 用自己的 Claude / ChatGPT / Cursor 登录态（每个 provider 可挂多个账号）
- 一个本地或自托管代理
- 按模型名自动路由到对应 provider

它并不试图做成大型多 provider 网关。如果你想要的是一个体积小、容易理解、方便自己改的代理，dsh-api-proxy 就是为这个场景准备的。

## 功能特性

- **轻量优先**：代码量小、依赖和运行逻辑都尽量简单
- **多 provider 共存**：Claude OAuth、OpenAI Codex（ChatGPT）OAuth 与实验性 Cursor 本地登录态同时支持，按 provider 独立维护账号池、cooldown、token 刷新与统计
- **多账号支持**：每个 provider 都可加载多个 OAuth token，具备粘性路由、自动故障转移和逐账号用量统计
- **OpenAI 兼容 API**：支持 `/v1/chat/completions`、`/v1/responses`、`/v1/models`
- **Claude 原生透传**：支持 `/v1/messages` 与 `/v1/messages/count_tokens`
- **适配 Claude Code**：兼容 `Authorization: Bearer` 和 `x-api-key`
- **覆盖核心能力**：支持流式、工具调用、图片与 reasoning，而不引入大型框架
- **结构化 JSON 输出**：支持 `response_format`（Chat API）和 `text.format`（Responses API）的结构化输出
- **账号健康管理**：内置 cooldown、重试、带并发锁的 token 刷新、`/admin/accounts` 快照
- **默认安全设置**：timing-safe API key 校验、每 IP 限流、仅允许 localhost 浏览器 CORS

## 运行要求

- Node.js 20+
- 一个 Claude 账号（推荐 Claude Max）

## 安装

```bash
npm ci
npm run build
```

## 登录

dsh-api-proxy 支持以下上游 provider：

- `anthropic`（默认）：Claude OAuth，对应 `claude-*` 模型。
- `codex`：OpenAI 的 "Sign in with ChatGPT" OAuth，直连官方 codex 后端 `https://chatgpt.com/backend-api/codex/responses`，对应 `gpt-5*`/`gpt-6*`（含 `gpt-5-codex`）、`o\d*`、`codex-*` 模型。**需要 ChatGPT Plus 或 Pro 订阅** —— Free 账号也能登录，但首次调用会被后端拒绝(`model not supported`)。
- `cursor`：实验性 Cursor 账号支持，默认走浏览器 PKCE deep-link 流程授权，也可以选择导入本机 Cursor Desktop 已登录的 token。**路由规则**：多 provider 同时登录时，Cursor 只服务带显式 `cursor-*` / `cr/*` 前缀的模型；进入 **Cursor-exclusive 模式**（即只有 Cursor 账号、没有 `anthropic`/`codex` 账号）后，所有请求 —— 包括裸的 `claude-*` 或 `gpt-*` 模型名 —— 都会自动路由到 Cursor，方便 Claude Code / OpenAI 客户端零改造直接用。

通过 `--provider=` 选择登录哪个 provider，缺省为 `anthropic`。

### 自动模式（需要本地浏览器）

```bash
# Claude（默认）
node dist/index.js --login

# Codex（ChatGPT Plus/Pro）
node dist/index.js --login --provider=codex

# Cursor（实验性；默认打开浏览器走 PKCE 授权）
node dist/index.js --login --provider=cursor

# Cursor —— 改为从本机 Cursor Desktop 登录态导入
node dist/index.js --login --provider=cursor --cursor-import-local
node dist/index.js --login --provider=cursor --cursor-storage=/path/to/state.vscdb
```

Anthropic 和 Codex 会输出浏览器 URL。完成授权后，回调会自动处理。Anthropic 流程使用端口 `54545`，Codex 使用端口 `1455` —— 请确保两者都没被防火墙拦截。Cursor 走的是自己专属的 deep-link PKCE 流程：`dsh-api-proxy` 会打印一条 `https://cursor.com/loginDeepControl?...` URL，你在浏览器里点「Yes, Log In」确认后，`dsh-api-proxy` 会持续轮询 `api2.cursor.sh/auth/poll` 直到拿到 token——整个过程不需要本地回调端口。如果偏好直接导入 Cursor Desktop 已有的登录态，可以加 `--cursor-import-local`，或用 `--cursor-storage=/path/to/state.vscdb` 指向自定义安装位置。

### 手动模式（适合远程服务器）

```bash
node dist/index.js --login --manual
node dist/index.js --login --provider=codex --manual
```

在浏览器中打开输出的链接。授权完成后，浏览器会跳转到一个 `localhost` 地址，这个页面可能无法打开；请把地址栏中的完整 URL 复制回终端。

多个 provider 可以同时登录，每个 provider 也可以多次执行 `--login` 添加更多账号；token 文件会并存于 `auth-dir`（`claude-<email>.json`、`codex-<email>.json` 与 `cursor-<email>.json`），收到请求后按模型名自动路由到对应账号池。只登录其中一个也可以，未登录的 provider 不会出现在 `/v1/models` 中。

> **关于 Codex：** codex provider 中转的是你的 ChatGPT Plus/Pro 订阅额度。OpenAI 的 ToS 不允许通过第三方工具中转 ChatGPT 会话 —— 仅供本地个人自用。

> **关于 Cursor：** cursor provider 是研究性质集成，依赖非公开、逆向得到的 Cursor API（`api2.cursor.sh` 上的 HTTP/2 + Connect-RPC + protobuf）。Cursor 升级后可能随时失效，也可能违反 Cursor 服务条款或触发账号风险；仅建议本地个人实验使用。

## 启动服务

```bash
node dist/index.js
```

默认监听地址为 `http://127.0.0.1:8317`。首次启动时，如果 `config.yaml` 中没有配置 API key，会自动生成并写入该文件。

## 配置

复制 `config.example.yaml` 为 `config.yaml`，然后按需修改：

```yaml
host: "" # 绑定地址，空字符串表示 127.0.0.1
port: 8317

auth-dir: "~/.dsh-api-proxy" # OAuth token 存储目录

api-keys:
  - "your-api-key-here" # 客户端使用这个 key 访问代理

body-limit: "200mb" # 最大 JSON 请求体大小，适合大上下文场景

timeouts:
  messages-ms: 120000 # 非流式 /v1/messages 超时
  stream-messages-ms: 600000 # 流式 /v1/messages 超时（10 分钟，适合 Claude Code 长任务）
  count-tokens-ms: 30000 # /v1/messages/count_tokens 超时

# 请求指纹 — 控制 dsh-api-proxy 如何模拟 Claude Code CLI
cloaking:
  cli-version: "2.1.88" # 模拟的 CLI 版本号
  entrypoint: "cli" # 计费归属入口（cli、mcp、sdk 等）

debug: "off" # off | errors | verbose
```

`debug` 支持三级日志：

- `off`：不输出额外调试日志
- `errors`：记录上游/网络失败信息和上游错误响应正文
- `verbose`：在 `errors` 基础上，再输出每个请求的方法、路径、状态码和耗时

如果 Cursor 上游版本门禁变化，可以覆盖这些实验性请求头。`agent-base-url` 是 chat host 的兼容别名，目前与 `api-base-url` 都指向 `api2.cursor.sh`：

```yaml
cloaking:
  cursor:
    client-version: "2.3.41"
    client-type: "ide"
    agent-base-url: "https://api2.cursor.sh"
    api-base-url: "https://api2.cursor.sh"
```

## 使用方法

将任意 OpenAI 兼容客户端指向 `http://127.0.0.1:8317`：

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 1024
  }'
```

### 支持的模型

`GET /v1/models` 只列出已登录 provider 的模型。Codex 列表是从 `chatgpt.com/backend-api/codex/models` **实时拉取**(5 分钟缓存 + ETag),始终与你的账号实际可用模型一致。Cursor 会尽量从内部 AvailableModels 端点拉取，失败时使用少量 fallback 模型。当前 ChatGPT 账号支持的 codex 模型集合:

| 模型 ID                                              | Provider  | 说明                                         |
| ---------------------------------------------------- | --------- | -------------------------------------------- |
| `claude-opus-4-7`                                    | anthropic | Claude Opus 4.7                              |
| `claude-opus-4-6`                                    | anthropic | Claude Opus 4.6                              |
| `claude-sonnet-4-6`                                  | anthropic | Claude Sonnet 4.6                            |
| `claude-haiku-4-5-20251001`                          | anthropic | Claude Haiku 4.5                             |
| `claude-haiku-4-5`                                   | anthropic | Claude Haiku 4.5 别名                        |
| `gpt-6.1-sol`                                        | codex     | GPT-6.1-Sol（需要 CLI >= 0.162.0 才可见）    |
| `gpt-6-astra`                                        | codex     | GPT-6-Astra（需要 CLI >= 0.162.0 才可见）    |
| `gpt-6-sol`                                          | codex     | GPT-6-Sol（需要 CLI >= 0.162.0 才可见）      |
| `gpt-6-luna`                                         | codex     | GPT-6-Luna（需要 CLI >= 0.162.0 才可见）     |
| `gpt-5.6-sol`                                        | codex     | GPT-5.6-Sol                                  |
| `gpt-5.6-terra`                                      | codex     | GPT-5.6-Terra                                |
| `gpt-5.6-luna`                                       | codex     | GPT-5.6-Luna                                 |
| `gpt-5.5`                                            | codex     | GPT-5.5(reasoning model)                     |
| `cursor-claude-opus-4-7-medium`                      | cursor    | 通过 Cursor 转发的 Claude Opus 4.7           |
| `cursor-claude-sonnet-4-7-medium`                    | cursor    | 通过 Cursor 转发的 Claude Sonnet 4.7         |
| `cursor-default`                                     | cursor    | Cursor "Auto" 模型                           |
| `cursor-premium` / `cursor-fast` / `cursor-composer` | cursor    | AvailableModels 拉取失败时使用的 fallback id |

dsh-api-proxy 额外支持以下便捷别名：

- `opus` -> `claude-opus-4-7`
- `sonnet` -> `claude-sonnet-4-6`
- `haiku` -> `claude-haiku-4-5-20251001`

路由规则：根据模型名自动选择账号池。`claude-*` 与裸别名 `opus`/`sonnet`/`haiku` 走 Claude 账号；`gpt-5*`/`gpt-6*`、`o\d`(`o3`、`o4-mini` 等)、`codex-*` 走 Codex 账号；`cursor-*` 和 `cr/*` 走 Cursor 账号。其它型号(`gpt-3.5-*`、`gpt-4*` 等)两个后端都不支持，默认 fallback 到 anthropic。如果对应 provider 未登录，请求会返回 `503 no_account_for_provider`，错误信息中带有需要执行的 `--login` 命令。

#### "Cursor 独占" 模式（让 Claude Code / OpenAI SDK 零配置可用）

当 **只有 Cursor 一个 provider 登录了账号**（anthropic、codex 都为空）时，所有模型名自动走 Cursor，`cursor-` 前缀变成可选。这意味着 Cursor 单 provider 的 dsh-api-proxy 可以直接当 Anthropic API 或 OpenAI API 用：

| 客户端发送                                                 | dsh-api-proxy 行为                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `POST /v1/messages` `{"model":"claude-sonnet-4-5"}`        | 走 Cursor，把上游流重新编码成 Anthropic Messages SSE         |
| `POST /v1/messages` `{"model":"opus"}`                     | `opus` → `claude-opus-4-7-medium`，回 Anthropic Messages SSE |
| `POST /v1/responses` `{"model":"gpt-5.5"}`                 | `gpt-5.5` → `gpt-5.5-medium`，回 OpenAI Responses SSE        |
| `POST /v1/chat/completions` `{"model":"claude-haiku-4-5"}` | `claude-haiku-4-5` → `claude-4.5-haiku`                      |

内置一份小的别名映射表，覆盖 Anthropic / OpenAI SDK 与 Claude Code 默认会用的标准名（`claude-sonnet-4-5`、`claude-opus-4-7`、`opus`、`sonnet`、`haiku`、`gpt-5.5`、`o3` 等），翻译到 Cursor 内部 SKU（`claude-4.5-sonnet`、`claude-opus-4-7-medium`、`gpt-5.5-medium` 等）。可以通过环境变量 `CURSOR_MODEL_ALIASES="my-name=claude-opus-4-7-max,foo=composer-2"` 扩展。表里没有的名字会原样下发到 Cursor，所以 Cursor 的完整 SKU 列表（如 `claude-opus-4-7-thinking-max`）依然可用。

当 **多个 provider 都登录了账号** 时，按上面的历史路由表分发；显式前缀 `cursor-` / `cr/` 依然能强制走 Cursor，但 `claude-*` 会去你的 Anthropic OAuth 账号。

##### Cursor 上的 Claude Code Anthropic SSE

`POST /v1/messages` 命中 Cursor 服务的模型时，输出严格遵循 Anthropic Messages SSE 格式（`message_start` → `content_block_start`/`content_block_delta` → `message_delta` → `message_stop`）。Thinking 模型的 reasoning 字节会被路由到 `thinking` content block，再切换到 `text` block 输出正文 —— 与 Claude Code 的期待一致。Cursor 只支持流式，所以即使客户端没传 `stream:true`，命中 cursor 的 `/v1/messages` 也会以 SSE 形式回应。

### 端点 × Provider 支持矩阵

| Endpoint                         | anthropic | codex                                                         | cursor                                                                   |
| -------------------------------- | --------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST /v1/chat/completions`      | yes        | yes（Chat ↔ Responses 翻译；reasoning 走 `reasoning_content`） | yes（`chat.completion.chunk` SSE；reasoning 走 `reasoning_content` 字段） |
| `POST /v1/responses`             | yes        | yes（直通）                                                    | yes                                                                       |
| `POST /v1/messages`              | yes        | yes（Anthropic ↔ Responses 翻译，详见下文）                    | yes（Anthropic Messages SSE，详见下文）                                   |
| `POST /v1/messages/count_tokens` | yes        | no（501）                                                     | no（501）                                                                |

针对 Cursor，三个 OpenAI 兼容端点全部走原生实现（不经过 anthropic 翻译链）：`req.path` 决定 cursor provider 输出的协议格式（`openai-chat-completions` / `openai-responses` / `anthropic-messages`）。非流式 `/v1/chat/completions` 通过把上游 SSE 聚合成单个 `chat.completion` JSON 来支持。

针对 Codex（ChatGPT 账号后端），通过专用的 Chat ↔ Responses ↔ Anthropic 翻译器对（`src/upstream/responses-translator.ts`）也实现了相同覆盖：客户端发来的 Chat / Anthropic 请求被翻译成 OpenAI Responses 格式发到上游，上游返回的 Responses SSE 再翻译回原本的格式；非流式请求在 handler 内聚合 SSE 后输出单条 JSON。Tool calls、system prompts（被抬升到 `instructions`）、`reasoning_effort` / `thinking`、多轮对话、`response_format` `json_schema` 都已支持。Codex 特有的不兼容字段（`max_output_tokens`、`parallel_tool_calls`）会在 codex handler 里自动剥除，无需调用方关心。

#### Codex `/v1/responses` 请求体要求

ChatGPT 的 codex 后端会拒绝缺少 `stream: true`、`store: false`、`instructions` 任一字段的请求，并且对 `max_output_tokens`、`parallel_tool_calls` 这类公共 Responses 字段会直接 400。dsh-api-proxy 对所有三个 codex 端点（`/v1/chat/completions`、`/v1/messages`、`/v1/responses`）统一采用 sanitize + 强制流式的策略：

- 客户端没传 `store: false` / `instructions` 时**自动补默认值**。
- `max_output_tokens` 和 `parallel_tool_calls` 会被剥除 —— token 上限由 ChatGPT 套餐控制。
- 上游调用**始终**带 `stream: true`，与客户端传的 `stream` 值无关。客户端要求 `stream: false` 时，dsh-api-proxy 会在本地 drain 上游 SSE，再按原 wire 格式（Responses / Chat Completions / Anthropic Messages）输出单条 JSON —— 其中包括把 `response.output_item.done` 的 item 拼回 `output` 数组（因为 codex 的 `response.completed.response.output` 永远是 `[]`）。

OpenAI Responses / Chat / Claude Code 客户端无需关心 codex 的特殊行为，直接用即可。

#### Cursor `/v1/responses` 限制

Cursor 的 chat 协议是逆向得到的：请求走 `api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools`，HTTP/2 + `application/connect+proto`，响应被解码后再转换回 OpenAI Responses SSE delta。Cursor 只支持流式，所以 `stream` 会被强制开启。当前仅覆盖单轮流式文本：工具调用、图片、仓库上下文、编辑动作以及 Cursor 更完整的 agent 协议暂不转换。

Decoder 会把 Cursor 上游的 chain-of-thought（reasoning）字节路由到 `response.reasoning_summary_text.delta` 事件，避免污染主 `response.output_text.delta`。对于 Composer / Kimi 这种把整段（思考 + 答案）都塞进 reasoning 通道的模型，decoder 会按第一处 `</think>` 标签拆分——前面留在 reasoning，后面回到正文 `output_text`。

### 接口列表

| Endpoint                         | 说明                                                 |
| -------------------------------- | ---------------------------------------------------- |
| `POST /v1/chat/completions`      | OpenAI 兼容聊天接口                                  |
| `POST /v1/responses`             | OpenAI Responses API 兼容接口                        |
| `POST /v1/messages`              | Claude 原生消息透传                                  |
| `POST /v1/messages/count_tokens` | Claude token 计数                                    |
| `GET /v1/models`                 | 列出可用模型                                         |
| `GET /admin/accounts`            | 查看账号健康状态（需要 API key）                     |
| `GET /admin/stats`               | 按客户端/账号/接口三维聚合的调用统计（需要 API key） |
| `POST /admin/reload`             | 从磁盘重新加载 token（需要 API key）                 |
| `GET /health`                    | 健康检查                                             |

## Docker

```bash
# 构建
docker build -t dsh-api-proxy .

# 运行（挂载配置文件与 token 目录）
docker run -d \
  -p 8317:8317 \
  -v ~/.dsh-api-proxy:/data \
  -v ./config.yaml:/config/config.yaml \
  dsh-api-proxy
```

或者使用 docker-compose：

```bash
docker-compose up -d
```

## 与 Claude Code 配合使用

将 `ANTHROPIC_BASE_URL` 指向 dsh-api-proxy：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 \
ANTHROPIC_API_KEY=<your-api-key> \
claude
```

Claude Code 使用的是原生 `/v1/messages` 接口，dsh-api-proxy 会直接透传。`Authorization: Bearer` 与 `x-api-key` 两种认证头都支持。

## 多账号

dsh-api-proxy 支持多个 Claude OAuth 账号，每个账号的 token 作为独立文件存储在 auth 目录中。

- 每执行一次 `--login` 可以添加一个账号的 token
- 请求使用粘性选择策略 — 同一个账号会被持续使用，直到触发 cooldown
- 当遇到限流或故障时，dsh-api-proxy 会自动切换到下一个可用账号
- 逐账号追踪 token 用量（输入、输出、缓存），并定期输出日志
- 通过 `/admin/accounts` 可查看所有账号的状态

## 管理状态

通过 `/admin/accounts` 查看所有账号状态：

```bash
curl http://127.0.0.1:8317/admin/accounts \
  -H "Authorization: Bearer <your-api-key>"
```

响应结构(每个已登录 provider 一组):

```json
{
  "providers": {
    "anthropic": { "accounts": [...], "account_count": 1 },
    "codex":     { "accounts": [...], "account_count": 1 }
  },
  "generated_at": "2026-04-26T..."
}
```

每个账号 snapshot 包含:可用状态、cooldown 截止时间、失败计数、最近刷新时间、请求统计、按账号聚合的 token 用量(其中 `totalReasoningOutputTokens` 是 reasoning 模型如 `gpt-5.5` 隐藏推理消耗的 token,不计入可见输出)。Codex 账号还会带 `planType`(从 OAuth `id_token` 提取的 `"plus"`/`"pro"`/`"free"` 等)。如果 refresh token 被永久作废(`refresh_token_reused`/`expired`/`invalidated`),账号会进入 24 小时终态冷却,`lastError` 中会提示需要重新执行 `--login --provider=<provider>`。

### 在不停机的情况下重新登录

服务运行中跑 `--login` 会写入新 token 文件并**自动通知运行中的服务**(POST `/admin/reload`),新 token 立刻生效,不必重启。对 codex provider 尤其重要:OpenAI 每次刷新都会轮转 refresh token,如果不重载,运行中的服务还在用旧的 refresh token,刷新会被后端识别为 `refresh_token_reused`,导致账号进入终态冷却。

你也可以手动触发重载(Windows、Docker、自动化脚本场景):

```bash
curl -X POST http://127.0.0.1:8317/admin/reload \
  -H "Authorization: Bearer <your-api-key>"
```

响应结构:

```json
{
  "reloaded": {
    "anthropic": { "added": [], "updated": ["alice@…"], "unchanged": [] },
    "codex": { "added": [], "updated": [], "unchanged": ["bob@…"] }
  },
  "generated_at": "2026-04-26T..."
}
```

重载语义为 **upsert**:磁盘上新出现的 token 文件会被添加到内存池;已有账号若 `access_token` 变化则替换(同时清掉 cooldown / `lastError`,但请求/用量统计保留);磁盘上消失的账号文件**不会**从内存中移除,以免误删 token 文件丢失历史统计——如确需移除,请重启服务。

### 调用统计 `/admin/stats`

每一个通过 API key 鉴权的请求都会被记录一行到 `<auth-dir>/stats.jsonl`，同时维护一份内存聚合视图，服务启动时会自动重放磁盘上的事件以恢复历史数据。

`GET /admin/stats` 返回三个互相独立的聚合视图，外加一个全局 `totals`：

- `byClient[apiKeyHash]` —— 按客户端（sha256(API key)）聚合：请求数、成功/失败、五项 token、累计延迟、最近一次 IP 与 User-Agent
- `byAccount["<provider>:<email>"]` —— 按上游 OAuth 账号聚合
- `byApi["<endpoint>|<model>|<provider>"]` —— 按 endpoint × model × provider 三元组聚合
- `totals` —— 全局合计

```bash
curl http://127.0.0.1:8317/admin/stats \
  -H "Authorization: Bearer <your-api-key>"
```

```json
{
  "byClient": {
    "8f2a1d3c4e5f8f2a1d3c4e5f8f2a1d3c4e5f8f2a1d3c4e5f8f2a1d3c4e5f6789": {
      "apiKeyShort": "8f2a1d3c4e5f",
      "requests": 142, "successes": 140, "failures": 2,
      "totalInputTokens": 12345, "totalOutputTokens": 6789,
      "totalCacheReadInputTokens": 0, "totalLatencyMs": 286430,
      "lastIp": "127.0.0.1", "lastUa": "claude-cli/2.1.88",
      "firstSeenAt": "2026-05-09T08:00:00Z",
      "lastSeenAt":  "2026-05-09T12:00:00Z"
    }
  },
  "byAccount": {
    "anthropic:alice@example.com": { "provider": "anthropic", "email": "alice@example.com", "requests": 100, ... }
  },
  "byApi": {
    "POST /v1/chat/completions|claude-sonnet-4-6|anthropic": { "endpoint": "POST /v1/chat/completions", "model": "claude-sonnet-4-6", "provider": "anthropic", "requests": 80, ... }
  },
  "totals": { "requests": 142, "successes": 140, "failures": 2, ... },
  "generated_at": "2026-05-09T12:00:00Z"
}
```

数据会无限追加。如果文件过大，停服后直接删除 `stats.jsonl` 即可重置；停服时会主动 flush 一次。完全不想要这个功能可以在 `config.yaml` 里写：

```yaml
stats:
  enabled: false
```

`--login` 端的提示信息:

- `Notified running dsh-api-proxy server to reload tokens.` —— 成功,服务已加载新 token。
- `(no dsh-api-proxy server detected at <host>:<port> — token saved, will be loaded next start)` —— 连接被拒/超时。常见情形是当前没有服务在跑,不算错误。
- `dsh-api-proxy server is running but rejected the reload (HTTP 401/403). …restart the server to pick up the new token.` —— 可执行行动:把 config 改回原 api-key,或重启服务让其加载新 key。

## 测试

仓库内置了测试套件，使用 mocked upstream response，不会调用真实 Claude 服务：

```bash
npm run test:smoke
```

## License

MIT
