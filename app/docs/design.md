# pai-cli 重构方案（协议 v0.1 定稿 + 模块化 + 权限门扩展）

> 状态：已核销（v0.1）；v0.2（auth）与 v0.3（会话元数据/树/分叉/命令/bash，含审查处置）增补已实施
> 级别：中（跨模块、外部契约定稿、并发/一致性语义）

## 契约（协议 v0.1，冻结）

传输：JSONL over stdio，**LF 为唯一记录分隔**；容忍行尾 `\r`；空行忽略；U+2028/U+2029 不是分隔符。

### 命令（stdin → hub），全部可选携带 `id`

| type                                         | 字段                                                | 语义                                             |
| -------------------------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| `thread/start`                               | `cwd?` `provider?`+`modelId?` `trusted?`            | 新建对话；默认 cwd=hub cwd；`trusted` 默认 false |
| `thread/resume`                              | `sessionPath` `cwd?` `trusted?`                     | 恢复；本 hub 内已打开同一文件 → failure          |
| `thread/stop`                                | `threadId`                                          | dispose；幂等（未知 id 也 success）              |
| `thread/list` / `thread/list_saved`          | `threadId` 无 / `cwd?`                              | 活跃线程 / 落盘会话列表                          |
| `prompt`                                     | `threadId` `message` `streamingBehavior?` `images?` | fire-and-accept                                  |
| `steer` / `follow_up`                        | `threadId` `message` `images?`                      | 入队                                             |
| `abort` / `compact`                          | `threadId`（`customInstructions?`）                 |                                                  |
| `get_state` / `get_messages`                 | `threadId`                                          |                                                  |
| `set_model` / `get_models`                   | `provider`+`modelId` / 无                           | 模型目录全局共享                                 |
| `set_thinking_level` / `get_thinking_levels` | `threadId` `level?`                                 |                                                  |
| `ui_response`                                | `requestId` `payload`                               | 答复对话框；**总是**回 ack                       |

### 帧与响应（stdout ← hub）

1. **恰好一次**：每个携带 `id` 的命令（含 `ui_response`）恰好产生一个 `response` 帧，`id` 回显；`success` 与 `data?|error` 互斥。`prompt` 的 response 在**接受时刻**经 SDK preflight 钩子发出；接受前的失败成为 failure response；接受后的失败走事件流（与 pi RPC 语义一致）。非对象 JSON（`null`、数组、标量）→ 无 id 的 parse failure。
2. **事件帧** `{type:"event", threadId, event}`：每个 `AgentSessionEvent` 恰好一帧；帧序=事件序；任意两帧不交错（stdout 写入串行化保证）。`message_update` 帧**剥离累积快照**（`message` 与 `assistantMessageEvent.partial`），每 delta 帧大小恒定（与 pi RPC 的 json-event 语义一致）。
3. **对话框** `ui_request` 恰好发出一次；settle 恰好一次（`ui_response` 到达 / 超时 / abort signal），超时与取消取默认值（confirm=false，select/input=undefined）；晚到的 `ui_response` 静默忽略。
4. **心跳** `heartbeat` 每 1s 一帧，进程存活期间不间断。
5. **`hub_error`**：uncaughtException / unhandledRejection / stdout 写失败的上报；进程不因此退出（写失败除外，见下）。

### 错误形态

`response.error` 为英文中性字符串。未知命令 / 未知 threadId / parse 失败 / 双开 session / 模型不存在 均为 `success:false` response，**不**中断进程。

### 退出语义

stdin EOF、SIGTERM、SIGINT → settle 全部挂起对话框（默认值）→ dispose 全部线程（flush 会话文件）→ flush 协议帧 → exit 0。stdout 写失败（客户端已断，EPIPE 类）→ stderr 记录 → 走同一路径退出；**满管（ENOBUFS/EAGAIN）是暂态，10ms 重试而非退出**。shutdown 重入不截断第一次的清理顺序；shuttingDown 期间到达的命令回 failure。心跳自进程接管 stdout 后立即开始（覆盖模型目录加载窗口）。超长输入行（>16 MiB）整行丢弃并回 parse failure，不累积缓冲。`thread/resume` 不带 `cwd` 时取**会话头记录的 cwd**（非 hub cwd）；双开守卫按 `path.resolve` 后的路径比较。

### 权限规则文件 `~/.pi/agent/permission-rules.json`（v2）

```json
{
  "mode": "ask" | "allow-all" | "block-all",
  "bash":  { "allowPatterns": ["git status"], "blockPatterns": ["sudo *"] },
  "write": { "allowPatterns": ["/Users/me/proj/*"], "blockPatterns": ["*/.env"] },
  "edit":  { "allowPatterns": [], "blockPatterns": ["*/.env*"] }
}
```

- 每次工具调用热读（设置 UI 改文件即时生效）；缺文件/坏 JSON → `{mode:"ask"}`。
- 匹配对象：`bash`→命令串；`write`/`edit`→工具入参的**原始 `path`**（未解析相对/绝对）。
- glob 语义：`*` 跨任意字符（含 `/`），其余按字面；regex 元字符转义。
- 判定顺序（单一真相 `decide()`）：`mode=allow-all`→allow；`mode=block-all`→block；命中 blockPatterns→block；命中 allowPatterns→allow；否则 ask。**用户裁决**：本次覆盖 bash + write + edit。
- ask 时经 `ctx.ui.confirm` 弹窗（5 分钟超时默认拒绝）；`ctx.hasUI=false` 时 ask 直接 block。

## 契约 v0.2 增补：auth 命令组（2026-09-07，用户裁决：v1 仅 API key，OAuth 延后）

| type               | 字段                               | 语义                                                                                                                            |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `auth/list`        | 无                                 | → `credentials: [{provider, type}]`（来自 ModelRuntime.listCredentials，永不含 key 本身）                                       |
| `auth/set_api_key` | `provider`, `apiKey`（均必填非空） | provider 必须存在于模型目录快照（防垃圾条目入 auth.json）；成功后运行时生效并落盘；**key 不得出现在任何输出帧中**（含错误路径） |
| `auth/remove_key`  | `provider`                         | 移除该 provider 的 api_key 凭据（运行时+落盘）                                                                                  |

安全规则（v0.2 审查后细化）：

- apiKey 只经 stdin 进入；所有输出帧、stderr、错误消息不得含 key——实现为**双重防线**：交互桥只应答**第一个 secret 提示**（select/text 提示→中性错误中止，防止 bedrock/vertex 把 key 嵌进方法选择错误、防止 cloudflare 把 key 写进 account ID 进请求 URL），且错误消息统一 `replaceAll(key, "[redacted]")` 兜底。
- 多提示 provider（需 select/text 额外字段的登录流）v0.2 不支持，返回中性失败；将来经 OAuth 式交互命令支持。
- **凭据类型保护**：已存在非 api_key 凭据（如 OAuth）时，set 拒绝（防静默覆盖）、remove_key 拒绝（防误删订阅登录）。remove_key 对无凭据 provider 幂等成功。
- shutdown 中止并等待在途 login（AbortController 集合），失败 response 仍恰好发出一次，不遗留 auth.json 锁。
- 自定义 provider（models.json 配置，凭据存于 models.json 而非 auth.json）v0.2 不在 set_api_key 范围（内置目录校验会拒绝）；见 electron-integration U11。
- 凭据存储（0600+lockfile+token 刷新）全由 pi SDK 管理，hub 不解析 auth.json。

审查处置（聚焦对抗审查 7 项）：#1/#2 key 经 select 错误消息泄漏→严格桥+脱敏（回归用例 a2b）；#3 cloudflare key 污染 URL→同修复（text 提示中止）；#4 remove/set 破坏 OAuth 凭据→类型保护门（回归 a7/a8/a9）；#5 自定义 provider 拒绝→裁决为 v0.2 范围外（U11）+remove 幂等落档；#6 shutdown 不等 login→inflightAuth 中止+等待；#7 smoke 盲区→stderr 捕获纳入零回显断言+三条回归。审查者确认无问题的点：跨 provider 并发（文件锁串行）、notify 吞噬无信息丢失、auth/list 新鲜度、auth.json 同步写无 flush 窗口、env key 不入 list（隔离断言稳定）。

## 契约 v0.3 增补（2026-09-07，用户裁决：缺口清单全部实施）

### threadId 语义修订

threadId 恒等于当前 session 的 sessionId。**fork/clone 后 session 被替换，thread 获得新 threadId**（旧 id 从 hub 移除；旧会话文件保留，可 `thread/resume` 回去）；响应携带 `previousThreadId` 供客户端重路由。`navigate_tree` 在会话文件内移动 leaf，threadId 不变。

### 新命令

| type                | 字段                                                                                       | 语义                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `get_entries`       | `threadId`, `since?`                                                                       | 会话全量/增量条目（追加树，entry id 即持久游标）；`since` 不存在 → failure                                      |
| `get_tree`          | `threadId`                                                                                 | 会话树 + `leafId`                                                                                               |
| `set_session_name`  | `threadId`, `name`（trim 后非空）                                                          | 显示名                                                                                                          |
| `get_session_stats` | `threadId`                                                                                 | token/成本/上下文用量                                                                                           |
| `clear_queue`       | `threadId`                                                                                 | 清空排队 steer/followUp → `{steering, followUp}`                                                                |
| `fork`              | `threadId`, `entryId`, `position?`（`before`\|`at`，默认 before）                          | 从历史条目分叉 → 新 threadId                                                                                    |
| `clone`             | `threadId`                                                                                 | 在当前 leaf 处复制分叉（= fork at leaf；无 leaf → failure）                                                     |
| `navigate_tree`     | `threadId`, `targetId`, `summarize?`/`customInstructions?`/`replaceInstructions?`/`label?` | 会话内跳转                                                                                                      |
| `get_fork_messages` | `threadId`                                                                                 | 可分叉的用户消息列表                                                                                            |
| `get_commands`      | `threadId`                                                                                 | 斜杠命令/skills 枚举（extension/prompt/skill 三源）                                                             |
| `bash`              | `threadId`, `command`, `excludeFromContext?`                                               | 直执行 shell：结果在 response；流式输出经既有 `event` 帧（`bash_execution_update`，带 command 的 `id`）自动下发 |
| `abort_bash`        | `threadId`                                                                                 | 中止运行中的 bash                                                                                               |

### 其他修订

- `get_state` 增加 `sessionName` 字段。
- `prompt`/`steer`/`follow_up` 的 `images` 增加形状校验（每项 `{type:"image", data:string, mimeType:string}`），不合 → failure（此前仅透传未验证）。
- ThreadManager 从 `createAgentSession` 切换到每 thread 一个 `AgentSessionRuntime`（fork/clone 的承载层），fork 引发的 session 替换经 `setRebindSession` 重绑：退订旧 session、更新引用与 Map 键、重绑扩展与订阅——事件流不中断、不重复。

### 审查后细化（聚焦对抗审查 11 项处置）

- **事件帧**：`message_update` 同时剥离顶层 `message` 与 `assistantMessageEvent.partial`（每 delta 帧恒定大小；顶层 `usage` 保留）。
- **直执行 bash 过权限门**：pi 的 user-bash 路径不触发 tool_call 且 `user_bash` 事件结果不支持 block——hub 的 `bash` 命令用**同一个 `checkPermission()`**（rules.ts 的 decide + 对话框）前置检查，随后 `emitUserBash`（扩展可观察/整体替换执行，镜像 pi RPC 模式）。权限规则文件路径 = **有效 agentDir**（`getAgentDir()`，尊重 `PI_CODING_AGENT_DIR`）下的 `permission-rules.json`。
- **每线程变更串行化**：fork/clone/stop 在同一 thread 上互斥（per-thread 队列）——stop 不会让已停线程以新 id 复活、并发双 fork 不会谎报 previousThreadId。**fork/clone 抛错 → 该线程从 hub 移除**（旧会话文件保留，可 `thread/resume` 恢复），不留 dispose 后的僵尸。
- **在途长操作**：login、bash、compact 注册到 inflight 表；shutdown 逐个中止（abort signal / abortBash / abortCompaction）并等待其响应发出——"恰好一个 response"对长命令也成立。
- **prompt 校验**：`streamingBehavior` 非法值拒绝（不再静默当作 steer）；无 `type` 的命令对象回 `command:"unknown"` 的 failure（command 字段恒为字符串）。
- **get_entries 语义**：`since` 切片按**追加序**；`navigate_tree` 移动分支后，切片可能包含已放弃分支的条目——重建活动分支对话必须配合 `get_tree`/`leafId` 走树，不得线性渲染增量。
- **fork cancelled 形状**：`success:true, cancelled:true, threadId=previousThreadId=原 id`（会话未变化，客户端忽略 threadId 字段）。

### 测试口径增补

- 契约：12 个新命令 happy/error 路径全表驱动；fork/clone 的 threadId 重键（旧 id 查询 → Unknown threadId，新 id 可用）；bash 的流式 `bash_execution_update` 事件帧到达断言；images 坏形状拒绝；规则阻断/放行的直执行 bash（规则文件在隔离 agentDir 下真实生效）；非法 streamingBehavior 拒绝；无 type 命令的 command 字段。
- 无 key 环境的可测链路：手工构造会话文件（v3 格式，含 user+assistant 条目）→ thread/resume → 真实 fork（rebind 重键）/clone/navigate_tree。注意：pi 的 resume 会追加 `thinking_level_change` 条目；未持久化会话（无 assistant 消息）被 pi 拒绝 fork。
- 审查处置汇总：#1 partial 回归修复；#2 每线程串行化+僵尸清除；#3 inflight 扩展 bash/compact；#4 bash 过门；#5 rulesPath 跟随 agentDir；#6/#8 契约文档化；#7 command 字段恒字符串；#9 枚举校验；#10 假绿断言修复为真实断言；#11 fixture 版本漂移风险落档（pi 升级时此段需人工复核）。审查确认无误：fork 响应时序（rebind 在 fork 返回前完成）、双开守卫、abort_bash settle、prompt 恰好一次、validateImages 全形状。

## 问题域

- 处理：单进程多会话宿主（thread 生命周期）、协议解析/分发/响应、stdout 独占与背压、对话框关联与超时、权限判定与拦截、心跳、优雅退出。
- 不处理（写清归属）：
  - 登录/OAuth → pi TUI（`pi` + `/login`）或未来的 hub 子命令；
  - Electron 端代码（supervisor/渲染）→ Electron 应用（**用户裁决**：本次范围仅 hub 本体）；
  - bun compile 单二进制与资源外置 → 后续打包任务（README 遗留项）；
  - 跨进程打开同一 session 文件（本 hub 之外）→ 客户端纪律，README 风险声明；
  - 规则文件并发写 → Electron 设置 UI 单一写入点；
  - 会话内存增长/压缩 → pi 自身 compaction。

## 并发/一致性预算

- stdout 帧写入：全局严格串行队列，任意帧不交错；管道满时等待 drain，不丢帧；写失败触发退出路径。
- 定时器：heartbeat 恰 1 个 interval；挂起对话框各 ≤1 个 timeout timer（无全局上限，与挂起对话框数相等）；线程退出时 timer 全清。
- 事件订阅：每线程恰 1 个，dispose 时移除。
- 会话文件：同一路径在本 hub 内至多一个写者（resume 双开拒绝）。
- 心跳频率 1s ±；检测预算（客户端侧）：>10s 无心跳判死。

## 拆分

```
src/
├── cli.ts            入口：参数（--version/--help）→ runHub（薄）
├── hub.ts            组装 + 命令分发 switch + stdin 心跳/退出（单一职责：编排）
├── protocol.ts       契约类型，唯一真相（v0.1）
├── jsonl.ts          JSONL 切割器（纯函数：push/flush，LF-only、\r 剥离、空行忽略）
├── stdout-guard.ts   stdout 接管 + 帧写入器（write 函数可注入；串行队列 + drain）
├── dialogs.ts        DialogBroker：requestId 关联 / 超时 / abort / settleAll
├── ui-context.ts     ExtensionUIContext 工厂（降级样板集中一处）
├── threads.ts        ThreadManager：spawn/resume(双开守卫)/stop/list/resolveModel
├── permission-gate.ts 内联扩展：热读规则 → decide() → ask/拦截（薄）
└── rules.ts          规则解析 + glob + decide()（纯函数，表驱动测试核心）
```

依赖方向：`cli → hub → {threads, dialogs, stdout-guard, protocol}`；`threads → ui-context? 否`（uiContext 由 hub 注入工厂）；`permission-gate → rules`；`jsonl/rules/stdout-guard` 不依赖任何 hub 模块。无环。

## 实施顺序

1. 纯函数层：`rules.ts`（含 decide + write/edit）、`jsonl.ts` + 单测（表驱动）。
2. 拆出 `dialogs.ts`、`ui-context.ts`；`threads.ts` 瘦身（uiContext 注入）；`stdout-guard.ts` 写入器化（可注入 + 失败回调）；`hub.ts` 改用 splitter/broker，emit 带 fatal catch。
3. 门禁脚手架：`app/tsconfig.json`（仅 include src，test 由 bun 运行时保证——**默认裁决**，否决窗口）、package.json scripts（check/build/test）。
4. smoke 扩展为契约矩阵（表驱动遍历命令 × happy/error）。
5. 四门全绿 → 对抗审查（独立子 agent）→ 逐条处置 → 复跑四门 → 收口。

过渡态：无（存量消费者仅 smoke test，随代码同步改）。提交纪律：按 AGENTS.md 不主动 commit；阶段划分保留在文档，用户要求时再落 commit。

## 裁决

- **用户裁决**：范围=仅重构 pai-cli 本体；权限门覆盖 bash + write + edit。
- **用户裁决（命名）**：产品/包名 `pai-cli`，可执行命令 `pai`（bin）。**协议线上常量不变**——帧与命令 `type`（含 `hub_error`）是已定稿契约，不随产品名变更；内部模块名（hub.ts 等）不动。
- **用户裁决（第二轮）**：app 完全独立于 pi 仓库——自有工具链 oxlint + oxfmt + TypeScript(tsc) + bun（运行/测试/打包），自有 `node_modules`/`bun.lock`/`AGENTS.md`/`.oxlintrc.json`/`.oxfmtrc.json`；不使用根仓库的 biome 与 tsconfig（根 biome.json 中为 app 添加的路径已撤销）。依赖仍以 `file:../packages/coding-agent` 指向本地源构建，切 npm 发布版只改 package.json。
- 默认裁决（否决窗口内可推翻）：
  - `mode=allow-all` 短路一切模式匹配（含 blockPatterns）——"全部放行"按字面语义；
  - typecheck 门只覆盖 `src/`（测试文件由 bun 运行时保证，不引 bun-types 依赖）；
  - 权限判定顺序 block 优先于 allow（安全优先）；
  - `thread/stop` 幂等；
  - 规则匹配 write/edit 的原始 `path` 入参，不做 cwd 解析；
  - stdout 接管两层（`process.stdout.write` 补丁 + `console.*` 补丁，后者为 bun 下 console 不走 write 的绕过修复）；直接 fd 写 / `Bun.write` 无法拦截——不可信代码本就不该被加载（trusted=false），trusted=true 时自担；
  - `editor` 对话框不带超时/abort——与 pi RPC 模式行为一致，超时责任归属扩展调用方（pai-cli 客户端不触发 editor）。

## 审查处置（对抗审查 18 项，2026-09-07）

修复（14）：#1 prompt preflight 恰好一次响应；#2 spawn 串行化消除双开竞态；#3 守卫按 resolve 路径比较；#4 console.* 补丁（bun 绕过）；#5 ENOBUFS/EAGAIN 重试；#6 message_update 剥离累积快照；#7 权限确认接 ctx.signal；#8 thread/stop settle 该线程对话框；#9 shutdown 与在途 spawn 竞态（closed 标志 + stopAll 等待队列）；#10 resume 默认取会话头 cwd；#11 非对象命令形状 → parse failure；#12 shutdown 重入不截断；#13 规则形状校验降级（含新增单测）；#14 16 MiB 行上限（含新增单测）；#15 心跳前移至接管后立即启动；#18 smoke parse 断言精确化（含 null/超长行探针）。
改文档（1）：#16 `set_thinking_level` 的 `level` 定为必填，契约表已更正。
驳回（1）：#17 editor 无超时（理由见裁决节）。
审查者确认无需复查的点：对话框 settle 恰好一次、帧串行、inline 权限门在 noExtensions 下仍加载、字段名一致性、订阅清理、心跳单 timer。

## 测试口径

- 契约断言（进程级 smoke，表驱动）：
  - 每命令 happy path 一行 + error path 一行（unknown cmd / unknown threadId / parse error / 双开 resume / 缺模型）；
  - 每个带 id 命令恰一个 response 且 id 回显（含 ui_response ack）；
  - prompt 拒绝路径错误信息落在 response.error；
  - heartbeat 在会话期间出现 ≥1 帧；stdin EOF → exit 0。
- 单元（bun:test，表驱动）：
  - `rules`：decide 矩阵（mode×block×allow×default 全枚举）、parseRules（缺文件/坏 JSON/空对象）、glob（`*` 跨 `/`、regex 元字符、空串、精确串）；
  - `jsonl`：粘包/半行跨 chunk/\r\n/空行/U+2028 不切/flush 残留；
  - `stdout-guard`：注入 fake write，断言帧序串行、drain 等待、失败回调触发。
- 越权/安全面：trusted=false 不加载项目扩展（现有行为回归断言留在 smoke 的 thread/start，加载面由 pi SDK 决定——hub 侧断言点为 loader 构造参数，属单测范围外，记为静态依赖）。
- e2e：smoke 即跨进程旅程（真实 spawn + stdio），真实 LLM 门 opt-in 不设。
- 覆盖率：`bun test --coverage` 如实报告行覆盖；新包起步阈值 ≥60%（只许补测试，不许调阈值）。

## 验收清单

- [x] 契约节 1-5 逐条（恰好一次含 prompt preflight 与 ui_response ack、事件序与 message_update 剥离、对话框 settle 三路径含 abort signal、心跳自接管起 1Hz、退出码 0 与重入不截断）— smoke 53 项断言 + 单测
- [x] 错误形态逐条（unknown cmd / unknown threadId / parse（坏 JSON、null、超长行）/ 双开 resume（含并发与相对路径变体）/ 模型不存在 / shutting-down）
- [x] 权限规则 v2 判定顺序逐条（decide 单测矩阵含形状降级）
- [x] 并发/一致性预算逐条（spawn 串行化 + spawningPaths + resolve 路径守卫；帧串行 + ENOBUFS 重试；每线程对话框随 stop settle；stopAll 等待 spawn 队列）
- [x] 不处理清单与归属无空白
- [x] 四门（独立工具链后）：oxlint 0 警告 0 错误 / oxfmt --check 全过 / tsc --noEmit 0 错误 / bun build 10.1MB / bun test 46 pass + smoke 53 断言 ALL PASS（`npm run ci` 一键全绿）；行覆盖：rules 100%、jsonl 93%（stdout-guard 的进程级接管由 smoke 进程级覆盖，bun 单测口径不计入；createFrameWriter 4 项单测）
- [x] 对抗审查问题清零（14 修 / 1 改文档 / 1 驳回，见「审查处置」）
- [x] 假绿抽查：单测无 skip；smoke 唯一 SKIP 为事件流断言（无 provider 认证环境，真实 LLM 门 opt-in，方案已声明）；无被注释/删除的断言
- [x] v0.2：auth/list / auth/set_api_key（未知 provider 拒绝、多提示 provider 拒绝、OAuth 保护、key 零回显含 stderr、auth.json 落盘验证）/ auth/remove_key（OAuth 保护、幂等）往返；smoke 隔离 agentDir；聚焦对抗审查 7 项处置完毕（1 项裁决范围外）

## v0.4 增补（worker 架构，2026-09-07 已实施）

进程模型从「单进程多会话」重构为 **host + 每对话一个 worker 进程**；对外 v0.3 协议不变，纯增量：

- 新帧 `thread_died {threadId, reason}`（worker 异常死亡时恰好一次；retire/关闭不发）；
- `thread/list` 条目新增 `state: live|parked|dead`（live 的 `isStreaming` 来自最近心跳，陈旧度 ≤1s）；
- `hub_error` 帧新增可选 `threadId`（worker 来源的注入）；
- fork/clone 失败语义修正为实际行为：校验类失败线程保留；替换中途失败 → `thread_died`（修复旧实现僵尸会话缺陷 F-1）；
- 环境旋钮：`PAI_MAX_THREADS`（32）/ `PAI_IDLE_RETIRE_MS`（900000）/ `PAI_WORKER_STALE_MS`（30000）/ `PAI_WORKER_EXIT_TIMEOUT_MS`（10000）。

完整架构规格（职责划分、内部 host↔worker 协议、生命周期状态机、预算）唯一真相：[migration/design.md](migration/design.md)；迁移审计与裁决见同目录 implementation.md / migration.md。旧单进程实现留档于 `pai-inprocess` 分支供对比。
