# pai-cli worker 契约（公开版，v1）

> 本文档是 host↔worker 内部协议的**唯一真相**（v0.8 起从 docs/migration/design.md §3 升格公开；
> migration 文档保留演进史并互引此处）。任何想替换 pai-cli 会话后端的人（「任意 agent 接入」）
> 实现本契约并通过 `test/conformance/` 即可被 host 接载。
> 对外（Electron ↔ host）协议不受本文影响——见 docs/design.md。

## 1. 进程模型

host 按**每会话一个 worker 进程**spawn 你（`PAI_BACKEND` + `<agentDir>/backends.json` 注册你的
`{command, args, env}`；`env` **覆盖**继承的 host 环境——同名变量以注册表为准；内置后端由 pai
自 spawn，不经过注册表）。你与 host 一对 stdio 管道相连：

- stdin/stdout 各为 UTF-8 JSONL，**LF 是唯一记录分隔**；
- 行上限**不对称**：host→worker 每行 ≤ 16 MiB（超限整行丢弃 + parse failure）；worker→host 每行 ≤ 128 MiB（超限 worker 被 kill——为数十 MB 的 get_messages 响应设计，别贴着上限发）；
- stderr 是日志通道（host 加 `[pai:worker:<threadId>]` 前缀转发），无协议含义。

## 2. 帧词表（worker → host）

| 帧                                    | 语义                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `hello`                               | **必须且只能是第一条**（见 §3）                                                                                                     |
| `response`                            | 命令应答；每个携带 `id` 的命令**恰好一个** response                                                                                 |
| `event`                               | 会话事件（pai 事件词表，`message_update` 必须剥离累积快照：顶层 `message` 与 `assistantMessageEvent.partial`；帧大小按 delta 恒定） |
| `heartbeat`                           | 1Hz；worker 侧真值 `{idleMs, streaming, sessionPath, subagents?}`——host 只信这里                                                    |
| `grant` / (host 回 `grant_result`)    | v0.6 全局孙进程配额仲裁（不实现 subagents 则永不发送）                                                                              |
| `ui_request`                          | 对话框中继（requestId 由 worker 分配；host 透传 `ui_response` 回来）                                                                |
| `hub_error`                           | worker 内未捕获异常上报（进程不退出）                                                                                               |
| `subagent_event` / `subagent_message` | 孙进程可观察面（不实现 subagents 则永不发送）                                                                                       |

## 3. hello 握手（v1）

stdout 接管后、任何其他帧（含心跳）之前，发出：

```json
{ "type": "hello", "protocolVersion": 1, "backendId": "<你的后端 id>", "capabilities": ["..."] }
```

host 校验 `protocolVersion === 1` 且 `backendId` 与 boot 选择一致；不符或首帧不是 hello →
**经 spawning 失败回收拒载**：占用表撤位、pending 命令各补恰一个 failure、不发 `thread_died`。
`capabilities` 为声明面（字符串数组，词表见 design.md v0.8）；v1 host 按自身注册的能力集保守门控。

## 4. 生命周期语义

- **stdin EOF / SIGTERM / SIGINT** → 优雅退出：settle 挂起对话框（默认值）、dispose 会话（flush）、
  flush 帧后 exit 0；
- **stdout close = 死亡信号**：host 从 `close`（drain 完）做状态迁移与 pendingIds 对账，只对未见
  响应的 id 补 failure；`thread_died` 恰好一次（retire/stop/关闭期不发）；
- 心跳断流超阈值（默认 30s）或 spawn 超时（默认 10s）→ host SIGTERM → 宽限 → SIGKILL。

## 5. 命令面与能力

host→worker 的命令是线程作用域子集（`prompt`/`steer`/`fork`/`bash`/…，形状同对外协议，
`thread/start`/`set_model` 由 host 注入已解析 `model` 对象）。核心必选命令（不实现即
conformance 不过）：`thread/start`、`thread/stop`、`prompt`、`abort`、`get_state`、
`get_commands`（可返回空）、`ui_response`（恒 ack）、`thread/resume` 之外的全部按能力位声明——
不支持的命令由 **host 门控**先行失败（`Unsupported capability: <bit> on backend <id>`），
worker 不会收到它们；你的 hello.capabilities 应如实声明。会话文件格式是你自己的实现细节
（**会话出生即绑定你的后端**，不跨后端 resume）。

`get_commands` 的第四源 `builtin`（v0.11，`compact` 条目）与 prompt 通路的行首 `/compact`
拦截是 **pai 默认 worker（共享 handler 代码）的行为**，不在本契约面内：外部 worker 自行决定
`get_commands` 的返回与 prompt 消息的处理；`session.compact` 能力位只如实声明 compact 命令
可用性，不隐含上述目录条目或拦截。

## 6. 安全与信任

注册表（backends.json）是**用户机器级信任**：指向你的可执行文件 = 用户显式信任你的
containment 自声明。pai 的权限确认与执行沙箱对默认后端以外的 worker **不自动生效**——
你的 worker 自行负责其执行的 containment。任何 stderr/帧中不得回显 env 注入的凭据。

## 7. 一致性套件

`test/conformance/`：参考实现（reference worker，脚本化模型行为）+ 场景 + 畸变拒载用例。
接入方在等价装置上跑通即视为契约达成：

```bash
bun test/conformance/run.mjs            # reference worker 全场景 + 畸变拒载
bun test/conformance/run.mjs --list
```

## v0.12 增补：沙箱授予帧与血缘字段

- **worker→host `sandbox_grant_persist`**（无 id，fire-and-forget）：`{type, grant:{kind:"domain"|"writeDir"|"bashPrefix", value}}`。worker 在用户选择 "Always allow" 时发出（会话侧已即时生效）；host 是全局 `sandbox.json` grants 节的唯一写者（read-merge-atomic-write，host 事件循环天然串行）。外部后端可不实现（缺帧 = 该后端的 Always 仅会话内生效）。
- **host→worker `thread/start` 增列**（内部）：`sandboxPosture?`（v0.12 档位，缺省按 trusted 推断）与孙进程专属 `sandboxGrants?: {writeDirs, writePatterns, domains}`（血缘快照；bashPrefixes 永不传播）。worker 必须容忍未知增列（既有契约）。
