# pai-cli 对接文档（外部接口说明）

面向 Electron / 任何宿主客户端。本文覆盖**全部对外接口**：启动方式、协议帧、31 个命令、4 类输出帧、对话框子协议、权限规则。规格细节与裁决见 `docs/design.md`。

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

- 协议走 **stdin/stdout JSONL**，stderr 是日志（无协议含义）。
- 进程生命周期：stdin EOF / SIGTERM / SIGINT → hub 落盘全部会话并 exit 0。
- 心跳：stdout 每 1 秒一帧 `{"type":"heartbeat"}`；**超过 10 秒没有心跳 = 进程卡死**，杀掉重启后用 `thread/resume` 恢复各会话（`thread/list` 的 `sessionPath` 先持久化到你的注册表）。

## 2. 协议基础

- 请求：一行一个 JSON 对象，`type` 必填，`id` 可选（建议始终带，用于关联响应）。
- 响应契约：**每个带 `id` 的命令恰好收到一个 `response` 帧，`id` 回显**。`prompt` 的 response 表示"已接受"，回复内容走事件流。
- 行上限 16 MiB：超限整行丢弃并回 parse failure。
- 错误统一形态：`{"type":"response","success":false,"error":"英文描述"}`，进程不会因单条命令失败而退出。

## 3. 命令总览（31 个）

| 组           | 命令                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| 线程生命周期 | thread/start、thread/resume、thread/stop、thread/list、thread/list_saved                                             |
| 对话驱动     | prompt、steer、follow_up、abort、clear_queue、compact                                                                |
| 状态与历史   | get_state、get_messages、get_entries、get_tree、get_session_stats、set_session_name、get_commands、get_fork_messages |
| 会话树/分叉  | fork、clone、navigate_tree                                                                                           |
| 模型         | get_models、set_model、set_thinking_level、get_thinking_levels                                                       |
| 凭据         | auth/list、auth/set_api_key、auth/remove_key                                                                         |
| 直执行       | bash、abort_bash                                                                                                     |
| 对话框       | ui_response                                                                                                          |

## 4. 命令明细

### 线程生命周期

**`thread/start`** — 新建对话（= 新会话文件）。
字段：`cwd?`（工作目录，决定 agent 操作的项目与项目级 `.pi` 资源）、`provider?`+`modelId?`（初始模型，两者需成对）、`trusted?`（默认 false：不加载项目 `.pi/extensions` 里的任意代码扩展；true 才加载）。
响应：`{threadId, cwd, sessionPath}`。`threadId` = 会话 id，后续命令都靠它。

**`thread/resume`** — 恢复历史会话（窗口重开 / hub 重启恢复用）。
字段：`sessionPath`（必填）、`cwd?`（缺省取**会话文件头记录的 cwd**）、`trusted?`。
响应同 start。同一文件在本 hub 内已打开 → `success:false`（先 `thread/stop` 旧线程再 resume）。恢复后历史用 `get_entries`/`get_messages` 拉取渲染。

**`thread/stop`** — 释放对话（dispose，会话文件保留）。幂等：未知 id 也回 success。配合 resume 实现"闲置回收"。

**`thread/list`** — 活跃线程：`[{threadId, cwd, sessionPath, isStreaming}]`。崩溃恢复的注册表来源。

**`thread/list_saved`** — 落盘会话列表（历史会话页）。字段：`cwd?`。响应 `{sessions:[...]}`。

### 对话驱动

**`prompt`** — 发用户消息。字段：`threadId`、`message`、`images?`（`[{type:"image",data:base64,mimeType}]`）、`streamingBehavior?`。
关键语义：**agent 正在流式中再发 prompt 必须带 `streamingBehavior`**，`"steer"`（当前轮工具执行完、下次调模型前插入）或 `"followUp"`（本轮完全结束后投递），否则被拒。回复内容不在 response 里，看 `event` 帧（§5）。

**`steer` / `follow_up`** — 显式排队（字段：`threadId`、`message`、`images?`）。队列变化会推 `queue_update` 事件。

**`abort`** — 停止当前轮（也会 settle 该线程挂起的确认框）。
**`clear_queue`** — 清空排队消息并返回文本：`{steering:[], followUp:[]}`。Esc 键语义 = `clear_queue` + `abort`。

**`compact`** — 压缩上下文（LLM 总结历史）。字段：`customInstructions?`。响应含 summary/tokens；上下文太小会被 pi 拒（"too small"，属正常响应）。

### 状态与历史

**`get_state`** — 单次往返拿到面板所需的全部状态：`{model, thinkingLevel, isStreaming, isCompacting, sessionId, sessionName, sessionFile, messageCount}`。

**`get_messages`** — 当前分支全量消息（`AgentMessage[]`：user/assistant/toolResult/bashExecution）。**长会话建议用 get_entries**。

**`get_entries`** — 会话条目（追加序树），`since?` 为增量游标：传"已见的最后一条 entry id"，只返回其后条目——**跨进程重启也有效**（entry id 持久）。注意：切片按追加序，`navigate_tree` 切分支后增量里可能含已放弃分支的条目，重建活动分支对话要配合 `get_tree`/`leafId`。

**`get_tree`** — 会话树 `{tree, leafId}`（分支导航 UI 用）。

**`get_session_stats`** — `{userMessages, assistantMessages, toolCalls, toolResults, tokens:{...,total}, cost, contextUsage?}`（状态栏用量显示）。

**`set_session_name`** — 会话显示名（窗口标题/会话列表）。空串被拒。
**`get_commands`** — 斜杠命令/技能枚举（输入框 `/` 补全）：`[{name, description?, source: extension|prompt|skill}]`。
**`get_fork_messages`** — 可作为分叉点的用户消息列表（`[{entryId, text}]`，分叉选择器 UI）。

### 会话树 / 分叉

**`fork`** — 从历史条目分叉出新会话。字段：`threadId`、`entryId`（来自 get_entries/get_fork_messages）、`position?`：`"before"`（默认，从该用户消息之前重试——响应带 `text` 原文）或 `"at"`（含该条目复制）。
**响应 `{threadId: 新, previousThreadId: 旧, sessionPath, text, cancelled}`。threadId 已换新：旧 id 立即失效（查询回 Unknown threadId），把窗口路由到新 id。** `cancelled:true`（扩展拦截）时会话未变，忽略 threadId 字段。
**fork 失败 → 该线程视为终止**（旧会话文件仍在，可 thread/resume 恢复）。

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

**`bash`** — 字段：`threadId`、`command`、`excludeFromContext?`（不喂给模型）。**先过权限门**（与 agent 工具调用同一套规则+弹窗，§6），通过后执行。流式输出经事件帧 `bash_execution_update`（带命令 `id`）实时到达；最终 `BashResult` 在 response（output/exitCode/cancelled/truncated/fullOutputPath?）。输出会记入会话、在下一次 prompt 时进入模型上下文。
**`abort_bash`** — 中止运行中的直执行命令。

### 对话框应答

**`ui_response`** — 应答 `ui_request`（§6）。字段：`requestId`、`payload`（按 method 而定）。任何情况下都会收到 ack（晚到/未知 id 静默忽略并 ack）。

## 5. 输出帧（stdout → 客户端）

| 帧           | 说明                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `response`   | 命令应答（§2 契约）                                                                                      |
| `event`      | `{"type":"event","threadId":...,"event":{...}}`——全部 AgentSessionEvent 打 threadId 标签，全局有序不交错 |
| `ui_request` | 确认/输入请求（§6）                                                                                      |
| `heartbeat`  | 1Hz 心跳                                                                                                 |
| `hub_error`  | 进程内未捕获异常报告（进程不退出；心跳消失才需要杀进程）                                                 |

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

判定顺序：`allow-all` 全放行（含 block）→ `block-all` 全拦 → 命中 blockPatterns 拦 → 命中 allowPatterns 放 → 其余 `ask` 弹 confirm。`*` 跨任意字符（含 `/`）；bash 匹配命令串，write/edit 匹配原始 path 入参。坏文件/坏形状自动降级 `{mode:"ask"}`，永不抛错。

## 8. 端到端时序示例

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

- [ ] 心跳监督（>10s 无心跳 → 杀 + thread/list 注册表逐个 resume）
- [ ] response 按 id 关联；`agent_settled` 驱动输入框可用态
- [ ] 流式渲染只拼 `text_delta.delta`，以 `message_end.message` 为权威
- [ ] `fork/clone` 后用响应里的新 `threadId` 重路由窗口，旧 id 立即失效
- [ ] 弹窗应答永远回 `ui_response`（哪怕用户已关闭弹窗 → 回 `{"cancelled":true}`）
- [ ] 每线程记录 `sessionPath`（崩溃/闲置恢复的锚点）
