# pai-cli 重构方案（协议 v0.1 定稿 + 模块化 + 权限门扩展）

> 状态：已核销（v0.1）；v0.2（auth）与 v0.3（会话元数据/树/分叉/命令/bash，含审查处置）增补已实施
> 级别：中（跨模块、外部契约定稿、并发/一致性语义）

## 契约（协议 v0.1，冻结）

传输：JSONL over stdio，**LF 为唯一记录分隔**；容忍行尾 `\r`；空行忽略；U+2028/U+2029 不是分隔符。

### 命令（stdin → hub），全部可选携带 `id`

| type                                         | 字段                                                | 语义                                                                   |
| -------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| `thread/start`                               | `cwd?` `provider?`+`modelId?` `trusted?`            | 新建对话；默认 cwd=hub cwd；`trusted` 默认 false                       |
| `thread/resume`                              | `sessionPath` `cwd?` `trusted?`                     | 恢复；本 hub 内已打开同一文件 → failure                                |
| `thread/register`                            | `sessionPath` `trusted?`                            | 会话文件按 parked 表项纳管（v0.12，host 本地零 worker；幂等）          |
| `thread/stop`                                | `threadId`                                          | dispose；幂等（未知 id 也 success）                                    |
| `thread/retire` / `thread/set_keepalive`     | `threadId` / `threadId`+`keepalive`                 | 手动闲置收编（v0.13，park 保留表项）/ 表项免闲置收编标志（v0.13）      |
| `set_idle_retire_ms`                         | `ms`                                                | 运行期调整闲置回收阈值（v0.13，钳制 1s..24h，host 本地）               |
| `thread/list` / `thread/list_saved`          | `threadId` 无 / `cwd?`                              | 活跃线程 / 落盘会话列表                                                |
| `prompt`                                     | `threadId` `message` `streamingBehavior?` `images?` | fire-and-accept；行首 `/compact` 例外（v0.11，见「恰好一次」）         |
| `steer` / `follow_up`                        | `threadId` `message` `images?`                      | 入队                                                                   |
| `abort` / `compact`                          | `threadId`（`customInstructions?`）                 |                                                                        |
| `get_state` / `get_messages`                 | `threadId`                                          | get_state 非 live thread 走 host 直读（v0.12）；get_messages 恒需 live |
| `set_model` / `get_models`                   | `provider`+`modelId` / 无                           | 模型目录全局共享                                                       |
| `set_thinking_level` / `get_thinking_levels` | `threadId` `level?`                                 |                                                                        |
| `ui_response`                                | `requestId` `payload`                               | 答复对话框；**总是**回 ack                                             |

### 帧与响应（stdout ← hub）

1. **恰好一次**：每个携带 `id` 的命令（含 `ui_response`）恰好产生一个 `response` 帧，`id` 回显；`success` 与 `data?|error` 互斥。`prompt` 的 response 在**接受时刻**经 SDK preflight 钩子发出；接受前的失败成为 failure response；接受后的失败走事件流（与 pi RPC 语义一致）。**例外（v0.11）**：命中 `/compact` 拦截的 prompt 不走 preflight——响应时序同 `compact` 命令（长操作完成才回包；语义见「契约 v0.11 增补」）。非对象 JSON（`null`、数组、标量）→ 无 id 的 parse failure。
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
- 匹配对象：`bash`→命令串；`write`/`edit`→工具入参 `path` 解析后的**绝对路径**（先词法 resolve 到会话 cwd，再 realpath 收缩最深已存在祖先目录）——匹配「实际写入效果」而非模型原始字符串（红测结论：原始前缀匹配可被 `..` 与符号链接目录逃逸）。残余边界：末端悬空符号链接按词法保留（写入会跟随目标）。
- glob 语义：`*` 跨任意字符（含 `/`），其余按字面；实现为分段顺序匹配（线性、无回溯，多星模式不可造成灾难性回溯）。
- 判定顺序（单一真相 `decide()`）：`mode=allow-all`→allow；`mode=block-all`→block；命中 blockPatterns→block；命中 allowPatterns→allow，**bash 例外：组合命令逐段校验**（`;` `&&` `&` `||` `|` 换行分段，每段去空白后须各自命中某条 allow 模式；反引号/`$(`/`<`/`>` 永不组合——出现即降级 ask；`"make *"` 不放行 `make x; curl evil|sh`，`"echo *"`+`"sleep *"` 放行 `echo a && sleep 1 && echo b`）；其余 ask。**用户裁决**：本次覆盖 bash + write + edit。
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

| type                | 字段                                                                                                                                 | 语义                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `get_entries`       | `threadId`, `since?`, `before?`, `limit?`（≤5000，取窗口内最近 N 条，响应带 `hasMore?`；`since` 前向/`before` 后向游标，防无界单帧） | 会话条目窗口（追加树，entry id 即持久游标）；`since`/`before` 不存在 → failure；非 live thread 走 host 直读（v0.12） |
| `get_tree`          | `threadId`                                                                                                                           | 会话树 + `leafId`                                                                                                    |
| `set_session_name`  | `threadId`, `name`（trim 后非空）                                                                                                    | 显示名                                                                                                               |
| `get_session_stats` | `threadId`                                                                                                                           | token/成本/上下文用量                                                                                                |
| `clear_queue`       | `threadId`                                                                                                                           | 清空排队 steer/followUp → `{steering, followUp}`                                                                     |
| `fork`              | `threadId`, `entryId`, `position?`（`before`\|`at`，默认 before）                                                                    | 从历史条目分叉 → 新 threadId                                                                                         |
| `clone`             | `threadId`                                                                                                                           | 在当前 leaf 处复制分叉（= fork at leaf；无 leaf → failure）                                                          |
| `navigate_tree`     | `threadId`, `targetId`, `summarize?`/`customInstructions?`/`replaceInstructions?`/`label?`                                           | 会话内跳转                                                                                                           |
| `get_fork_messages` | `threadId`                                                                                                                           | 可分叉的用户消息列表                                                                                                 |
| `get_commands`      | `threadId`                                                                                                                           | 斜杠命令/skills 枚举（extension/prompt/skill/builtin 四源，v0.11）                                                   |
| `bash`              | `threadId`, `command`, `excludeFromContext?`                                                                                         | 直执行 shell：结果在 response；流式输出经既有 `event` 帧（`bash_execution_update`，带 command 的 `id`）自动下发      |
| `abort_bash`        | `threadId`                                                                                                                           | 中止运行中的 bash                                                                                                    |

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

## v0.5 增补（子 agent/后台任务/权限 sidecar/agent 通信，2026-09-07 已实施）

纯增量（36 命令、8 帧），对外接口：[api.md](api.md)；实施与审查细节存于本地工作目录 `plans/`（不入库，本节为自足摘要）。要点：

- **每线程权限 sidecar**：`get/set_permission_rules`（host 本地、严格校验、`rules:null` 清除）；判定链 injected→sidecar→全局热读；fork/clone 复制。
- **子 agent 子系统**：`task` 工具（single/parallel/chain + `background:true`）→ 每任务一个 ephemeral 孙 worker（深度 1、in-memory、untrusted）；agent 定义 `.md` 热发现（项目级仅 trusted）；预算：≤8/调用、全局活孙 ≤4、在飞 ≤8（registry 同步闸门）、留存 ≤16（按完成序逐出）、弹窗帧 ≤64 KiB/条（超出处死，保留面字节上界 1 MiB/孙）、通知/消息/中继/产出/stderr 五级字节上限。中继 256KB/任务上限只丢弃非终态事件：无负载的 `agent_settled` 恒转发（其字节仍计入累计，上界 +4KB/任务；超限异常帧只转发无负载规范形态），且父侧对**已产生事件**的子 agent 兜底合成终态事件（被杀/崩溃/看门狗终止也有终态，客户端不会停在「进行中」）。
- **通知唤起链**：后台任务 settle → `[task-notification]` user-role 消息经回合边界投递（串行单飞；成功路径链式；失败回队 ≤3 次后 stderr 丢弃；streaming/compacting 挂起；killed/前台不通知；task_wait 抑制并回收已排队项）；worker isBusy 含在飞与待投递双窗口（retire 免疫）。
- **agent 通信三扇门**：`subagent/steer` 命令 + `task_steer` 工具（同管线，running-only）；孙内置 `report`/`send`（深度 1 无 task 工具；tools 白名单自动合并）→ `subagent_message` 帧（父重盖身份）+ 信封入通知队列（项目级 agent 标注 unverified data；10 条×8KB 双侧预算）；`task_send` 兄弟路由（父中介，`[from: lead]` 信封）。
- **U2 停止语义**：`abort`/`thread/stop`/shutdown → killAll（前台+后台+通知队列+抑制集）。
- **可观察面**：`subagent_event`/`subagent_message` 帧、心跳 `subagents` 计数、user-role 通知注入（自动 token 成本）。
- **孙权限热读**：thread/start 内部字段 `permissionThreadId` —— 孙的权限门每次调用重读父对话规则（sidecar→全局），收紧即时传导，无 spawn 快照冻结。

## 契约 v0.6 增补：可观测性与护栏（2026-09-09，已实施；来源 docs/plans/2026-09-09-production-hardening.md）

对外纯增量（37 命令 / 8 帧，帧不变）：

- **`get_host_info`**（host 本地，无字段）→ `{version, piVersion, bunVersion, pid, uptimeMs, rssBytes, threads:{live,parked,dead}, subagents:{running}, limits:{maxThreads, idleRetireMs, rssRetireBytes, workerStaleMs, workerExitTimeoutMs, maxSubagents, bashTimeoutMs}}`。版本启动期一次性读取；不回显路径/env/凭据。`subagents.running` = grant 账本的全局运行孙进程数（与心跳 `subagents`（在飞=queued+running）是两个口径，各自单一真相）。
- **`bash` 新增可选 `timeoutMs`**：正整数 ≤ 86_400_000；`0` 显式关闭；缺省 `PAI_BASH_TIMEOUT_MS`（默认 600_000，`0` 关闭）。到点服务端 `abortBash` → `success:true` + `BashResult.cancelled:true`（与 abort_bash 同形，恰好一响应不变）。非法值 failure。`user_bash` 扩展替换执行路径不套计时（与 pi RPC 一致）。
- **环境旋钮**：`PAI_MAX_SUBAGGENTS`（默认 16）——全局**正在运行**孙进程硬上限，经 host↔worker 内部 grant 仲裁强制执行（规格见 migration/design.md §3 增补）：worker 在任务 queued→running 前（spawn 前）向 host 申请租约，拒绝=任务立即失败（`global subagent limit reached`，模型可见可重试），不排队；settle/kill 释放；租约 TTL 5 分钟 + 心跳续约（worker 心跳 `subagents>0` 时刷新其全部租约）+ worker 死亡回收。线程内既有预算（≤8/调用、并发 ≤4、在飞 ≤8）不变，两道闸门串联。
- 验收口径：e2e-mock `subagent-global-quota` 场景（PAI_MAX_SUBAGGENTS=1 下并行 2 任务恰 1 运行 1 拒绝、settle 后租约归零）+ smoke 断言（get_host_info 形状、timeoutMs 校验矩阵、超时 cancelled 往返）+ worker-pool 单测（租约申请/释放/TTL/心跳续约/死亡回收）。

## 契约 v0.7 增补：agent 执行沙箱（2026-09-09，已实施；方案 docs/plans/2026-09-09-sandbox.md）

纯增量（38 命令 / 8 帧）：权限门之上的第二道防线，内联扩展形态对全部线程（含孙进程，untrusted 只读全局配置）生效。

- **配置**：`<agentDir>/sandbox.json` + 项目 `.pi/sandbox.json`（仅 trusted 合并）；坏文件降级默认；**会话创建快照**（fork/rebind 重取）；默认 enabled:true；`PAI_SANDBOX=off` 机器级关。
- **bash**：OS 级包裹（@anthropic-ai/sandbox-runtime 0.0.75；macOS sandbox-exec / Linux bwrap）——agent 工具经同名替换、直执行经 user_bash operations；降级 fail-open + `degraded` 可见 + stderr 一次警告。
- **write/edit/read**：进程内硬检查（不依赖 runtime，降级仍生效）；路径 = pi 工具语义归一 + gate-path realpath 效应空间（两侧对称）；比较 NFC + 平台大小写折叠；两份 sandbox.json 恒 denyWrite。
- **`get_sandbox_state`**（thread-scoped）：快照 + 降级态 + bashSandboxed 的单一真相。
- 判定顺序不变量：权限门先（原始输入）、沙箱后（强制）；恰好一响应等全部既有契约不受影响。
- 实测口径（darwin arm64 / bun 1.4.2）：cwd 内写通过、cwd 外/.env/~/.ssh/非白名单域名被 OS 层拒（Operation not permitted / 连接被断）、白名单 127.0.0.1 可达；对拍脚本见方案 §六批 0。

## 契约 v0.8 增补：后端能力包与事件词表自有化（2026-09-09；方案 docs/plans/2026-09-09-backend-capability-packs.md，双子 agent 对抗审查处置见其 §5）

对外**零破坏**：38 命令 / 8 帧不变；`event` 帧 JSON 与 v0.5-v0.7 **逐字节等价**（已知成员 1:1 提升，仅类型归属变更）。增量为能力协商与后端选择。

### 事件词表归 pai（用户裁决 R2）

- `protocol.ts` 持有 `PaiEvent` 封闭联合，成员 = 现 `AgentSessionEvent` 词表 1:1（23 个 type 名，A-2 全量枚举）：`agent_start`、`agent_end`（payload `messages`/`willRetry`）、`agent_settled`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`、`tool_execution_start/update/end`、`queue_update`、`compaction_start/end`、`entry_appended`、`session_info_changed`、`thinking_level_changed`、`auto_retry_start/end`、`summarization_retry_scheduled/attempt_start/finished`、`bash_execution_update`。负载类型 pai 自有声明：组合层实际消费的结构字段（strip 规则、`agent_end.messages`）显式声明，开放负载（message/entry/args/partialResult 等）为 `unknown`。
- **未知成员透传不变式**：上游新增事件类型经归一层**逐字节透传**（与 v0.5-v0.7 host 转发行为一致）——「封闭词表」指 pai 认领并保证语义的成员集合，不是线上过滤白名单。已知成员语义变化 = pai 词表 bump + 显式协议演进（ Electron 消费方文档同步）。
- `message_update` 剥离规则（顶层 `message` 与 `assistantMessageEvent.partial`，帧大小恒定）的唯一实现在 `backend/ports/event-strip.ts`，coding-agent 适配器、孙进程事件转发、agent-core 归一层共用。
- `SessionModel` 同步自有化：`import type { Model } from "@earendil-works/pi-ai"`——pi-ai 是 pai 的直接依赖与双后端共享通货（消息/模型类型同源），protocol 摘除的是 `pi-coding-agent`/`pi-agent-core` import。
- `subagent_event` 帧的 `event` 负载同为 PaiEvent（孙进程事件原样转发的语义不变）。

### 能力协商（用户裁决 R3：host 级后端）

- **核心必选命令**（任何后端必须实现）：`thread/start`、`thread/stop`、`thread/list`（宿主路由表，崩溃恢复依赖）、`prompt`、`abort`、`get_state`、`get_commands`（可返回空集）、`get_host_info`、`ui_response`、`get_permission_rules`、`set_permission_rules`（host 本地 sidecar 文件操作，与后端无关；软门执行是能力位）。其余 27 命令为能力门控。
- 能力位封闭枚举（29 位）：`session.fork`、`session.clone`、`session.tree`、`session.navigate`、`session.compact`、`session.entries`、`session.messages`、`session.stats`、`session.name`、`session.resume`、`session.listSaved`、`session.model.set`、`thinkingLevels`、`steer`、`followUp`、`queue.clear`、`bash.exec`、`dialogs`、`permission.soft`、`sandbox.bash`、`sandbox.fs`、`subagents`、`model.auth`、`model.list`、`image`、`extensions.project`、`resources.agents`、`resources.skills`。
- 命令 → 能力位映射表（38 行，表驱动）唯一真相 `src/backend/capabilities.ts`（镜像本表，测试对拍两处一致）。能力门控命令在后端不支持时回 `success:false`，error 形如 `Unsupported capability: session.fork on backend pi-agent-core`（英文中性）。
- `get_host_info` 响应增 `backend: { id, version, capabilities: [...] }`（字符串与枚举，**不含路径/env/凭据**——v0.6 承诺不变）。`get_commands` 为核心必选命令，返回后端实际提供的数据源（可为空集）；`resources.*` 能力位是对这些数据源可用性的声明面（advisory），不做结果过滤。
- **会话出生即绑定后端**：会话文件格式是后端实现细节（coding-agent v3 / agent-core harness 各自持有），不跨后端 resume/fork；`thread/resume` 的路径准入与 `thread/list_saved` 的枚举经后端端口解析，能力位 off 即结构化失败。

### worker 契约公开化（内部协议升格，详细规格 `docs/worker-contract.md` 为唯一真相，W4 落档）

- 新增内部帧 `hello`：worker 在 stdout 接管后、心跳定时器武装**之前**同步发出 `{type:"hello", protocolVersion:1, backendId, capabilities}`；host 校验版本与 boot 期望后端，不符走 spawning 失败回收（migration/design.md §6：撤占用表占位、pendingIds 补 failure、不发 thread_died——恰好一响应闭环不破）。外部协议（Electron ↔ host）不出现 hello。
- 内部协议帧词表全集：command（host→worker）/ response / event / heartbeat / grant / ui_request / hub_error / subagent_event / subagent_message / hello。行限不对称：host→worker 16 MiB / worker→host 128 MiB。
- 后端注册表（host 级 v1）：boot 经 `PAI_BACKEND=<id>`（缺省 `pi-coding-agent`）+ `<agentDir>/backends.json`（id → `{command,args,env}`）解析；**缺省项不落配置、保留 spawn 自身的动态自解析**（compile 单文件形态兼容）；注册表配置与权限规则文件同信任级（用户机器级）；实际 spawn spec 在 boot 时记 host stderr 一行供审计（不经 `get_host_info` 外显）。安全语义：注册表指定外部可执行 = 用户显式信任该 worker 的 containment 自声明——pai 的权限门/沙箱对外部 worker **不生效**（沙箱经后端端口提供，见下）。

### 沙箱与权限的后端口径（修正 v0.7 表述）

v0.7 沙箱的实现形态是 worker 内的内联扩展（经后端扩展基座注入），**不是 host 进程级物理强制**：coding-agent 后端下全线程（含孙进程）生效；agent-core / 外部 worker 后端下经能力位如实声明（`sandbox.bash`/`sandbox.fs` off 即无此防线），由 worker 契约要求适配器自述 containment。权限软门（ask 弹窗）同为端口能力（`permission.soft`）。

### 探针后端的既有口径（W3 实施落档）

- `pi-agent-core` 后端的事件提升：`agent_settled` 按 run 合成（每个 `agent_end` 后一个）——coding-agent 在 followUp 队列排空后才 settle，探针后端每个 run 即 settle 且新 run 接续启动；客户端在探针后端可能提前看到 settled（已知 fidelity 差异，随探针定位）。
- `get_commands` 在探针后端返回空集（无扩展/模板/skills 数据源）。

### skill 调用指针化（hub 预改写）

`prompt`/`steer`/`follow_up` 的消息在 worker 侧（`worker-commands.ts` 的处理器内）先经纯函数改写（唯一真相 `src/skill-pointer.ts`）：`/skill:name [args]` → `[name](url:filePath)`（args 以空行相接；description 不内联——系统提示的 available_skills 清单与 app 技能清单已携带）。改写后文本不再以 `/skill:` 开头，worker 内建的全量 SKILL.md 展开自然跳过——会话真相与模型上下文都不再内联正文，模型用 read/bash 自行加载文件。未知技能名时不改写（worker 内建展开为回退路径）。`resources.skills` 能力位语义不变（数据源声明面）。

### 环境旋钮（v0.8 新增）

`PAI_BACKEND`（缺省 `pi-coding-agent`）：host 级后端选择；worker/孙进程继承同一后端（孙进程 spawn 走同一注册表）。

## 契约 v0.9 增补：模型参数覆写（2026-09-09，已实施；方案 docs/plans/2026-09-09-model-overrides.md）

对外增量：新命令 `set_model_override`（38 → **39** 命令；帧数不变）、新能力位 `model.config`（能力位封闭集 28 → **29**；默认与 probe 后端声明，外部后端空集诚实失败——与 `get_models` 对外部后端口径一致）。

- **语义（用户裁决：全局持久化）**：app 经协议覆写任意已定义模型（凭据无关的 `getModel` 级校验）的 `contextWindow`/`maxTokens`，host 窄合并写 agentDir `models.json` 的 `providers[provider].modelOverrides[modelId]` 节（原子写：tmp+rename；读侧镜像上游 JSONC 宽容——BOM/`//` 注释/尾逗号，重写后规范化为纯 JSON，注释丢失已文档化），随后 `refresh({providers:[provider], allowNetwork:false})` 热刷新快照（模型目录不外联；auth 检查仍可能为已登录 OAuth provider 刷新 token，错误被内部吸收不影响命令结果），响应带刷新后解析的完整模型对象。**写后正向验证**：解析值 ≠ 设定值 → `override not applied`（捕获加载器拒绝合并结果的静默失效，例如文件他处 schema 错误）；不依赖 `getError()`（其混入网络可用性噪声）。模型预检未命中时先做一次同参数磁盘刷新重试（app 刚落盘的新 provider 免重启即可覆写，subagent-tool 先例）。
- **并发预算**：host 命令并发派发，models.json 读改写在模块级单写者 promise 链上串行；无跨进程锁（与上游 models.json 无锁一致），app 侧约定不与命令并发写同文件。
- **字段语义**：`null` 清单字段（清空后空条目自删，文件不长墓碑）；`remove:true` 删整条（幂等成功）；`remove` 与字段同给/全缺省/非正整数 → 校验失败不写文件。
- **生效边界**：已在运行的线程不热切换（模型对象在解析时注入 worker，既有 set_model 语义）；下次 set_model/新线程/resume 生效。live 线程在线换模型仍走既有 `set_model` 通道。
- **不处理**（方案 §问题域）：会话级临时覆写、contextWindow/maxTokens 以外字段、provider 增删与模型定义编辑（仍归 app 直接落盘）、worker 侧改动（解析单一真相在 host 不变）。

## 契约 v0.10 增补：沙箱违规确认流程（2026-09-10，已实施；方案 docs/plans/2026-09-10-sandbox-escalation.md）

对外零破坏增量：39 命令 / 8 帧不变；`onViolation:"deny"`（或无 UI / 孙进程 / 弹框失败）路径与 v0.7 **行为等价**。核心修订：沙箱第二防线从「恒物理硬拒」改为「默认用户在环的硬边界」（判定顺序不变量仍成立——权限门先、沙箱后；沙箱的确认层是其后置裁决，不是前置咨询）。

- **配置**：sandbox.json 增 `onViolation:"ask"|"deny"`（缺省 `"ask"`，用户裁决；坏值按未设置）。可确认面唯一真相处 api.md §沙箱表：write/edit 的 allowWrite 越界与 denyWrite 命中、bash 的 OS 拒绝（非零退出 + file-write/network-outbound 违规行）；**恒硬拦地板**（批 1 审查 P1/P2）：protected paths（效应空间比较——词法串会被符号链接 cwd 击穿）与「denyRead 命中且分类另有写违规」（凭据目录不进弹框；分类干净的写入保持 v0.7 放行，ask 姿态永不比 deny 松）。
- **三选对话框**：复用扩展 UI `select`（既有 ui_request 帧 method，无协议改动）：`Allow once` / `Allow for this session` / `Deny`；超时 300s、abort、取消、未知值、对话框通道异常一律 Deny（fail-closed）。
- **会话内豁免**（用户裁决）：write/edit 按效应空间精确路径（不折叠——折叠在大写敏感卷/NFC-NFD 混用下会并键，fail-open）、bash 按精确命令串；上界 64/32（满后仍弹框）；随会话快照生命周期（fork/clone/rebind 清空）、不落盘；`get_sandbox_state` 增量回显 `onViolation` + `sessionExemptions`。
- **bash 拒绝检测与重跑**（用户裁决，接受副作用可能重复）：`initialize` 开 `enableLogMonitor`；`wrapWithSandbox` 以唯一 commandId 归因（上游键按前 100 字符比较——复用键会串归因，必须唯一 id）。**触发 = file-write/network-outbound 违规行或失败输出 EPERM/allow-list 签名**（全量审查后定案：内核违规行可滞后 >10s 且被合并丢弃，行门控不可用；签名为 best-effort 一等证据）；denyRead 地板四通道兜读写歧义（任何 file-read 行免归因；file-write 目标经 denyEntryMatches 撞条目；失败文本与**命令文本**各撞 denyRead 双形态根——相对回显形态的命令串必含根子串）；豁免检查先于证据等待；中止信号贯穿弹框与重跑 spawn（中止后确认 = 拒绝）。确认后**重跑一次**裸命令注入标记行；拒绝/中止维持失败；重跑子进程登记于退出清扫表。
- **孙进程 / 无 UI fail-closed**：后台 agent 不产生弹框（社工面）；`onViolation` 对它们无行为差异。
- 后端口径：实现仍在 worker 内联扩展（sandbox.bash/sandbox.fs 能力位语义不变）；`permission.soft` 弹框通道复用。

## 契约 v0.11 增补：压缩命令 hub 化（2026-09-10，已实施）

对外零破坏增量：39 命令 / 8 帧 / 能力位封闭集均不变。`/compact` 从「客户端本地命令」收敛为 hub 目录下发 + prompt 通路拦截（与 skill 触发同型：`get_commands` 条目 + hub 编排层处理），命令目录真相单一回归 hub（客户端本地注册表下线）。

- **get_commands 第四源 `builtin`**：固定条目 `{name:"compact", description:"Manually compact the session context", source:"builtin"}`（文案镜像 SDK `BUILTIN_SLASH_COMMANDS` 同名条目——该常量未从包根导出；name 无前导斜杠，与三源约定一致）。条目按 `session.compact` 能力位门控（判定面 `WorkerContext.capabilities`，buildContext 组装时来自 backend）——不支持的后端目录里没有该条目（pi-agent-core 恒无，命令目录如实反映能力面）。
- **prompt 通路拦截语义**（「恰好一次」条款的例外路径，词法单一真相处 `src/compact-invocation.ts`）：
  - 词法：严格行首、大小写敏感——`message === "/compact"` 或 `/^\/compact\s/`；`customInstructions` = 后随文本 trim 首尾（内部空白原样），空串归 undefined；不命中（`/compactfoo`、`/compact-x`、前导空白、`/COMPACT`、文中段）原样作为消息发送，与未知 `/xxx` 一致。
  - 响应时序同 `compact` 命令（长操作完成才回包，非 fire-and-accept）：拦截路径注册 inflight（`abortCompaction`；shutdown 中止语义继承），成功回 `CompactionResult`、失败回 failure error string（响应 command 字段仍为 `prompt`）。`streamingBehavior` 在拦截路径不消费——无效值（非 `"steer"`/`"followUp"`）仍按 prompt 命令的既有形状校验先行拒绝。
  - 携非空 `images` → failure（固定英文句 `Compact command does not accept images`）；压缩中（`session.isCompacting`）→ failure `Compaction already in progress`；能力不支持 → **不拦截**（原样作为消息发送；目录本无条目，手输属未知命令）。
  - **拦截优先于 pi 扩展命令**（hub 编排层先于 SDK `_tryExecuteExtensionCommand`；与 skill 指针化同层同优先级）——扩展注册 `compact` 命令的冲突场景属边缘，落档此裁决；该场景下目录会同时列出扩展条目（经 prompt 通路不可达）与 builtin 条目，已知重复面，后续按需收敛。
- **并发预算**：`isCompacting` 判定与 `compact()` 调用之间存在受理窗口（SDK 到 `compact()` 内首个 await 才置压缩态）——窗口内二次提交直达 SDK；SDK 手动压缩**无互斥**（审查实证：同批双 `/compact` 可各自完成压缩；`Already compacted` 仅在会话末条已是 compaction 时触发），即窗口内可双压缩——与 `compact` 命令自身的同一窗口，属已接受的兜底语义，后续批次如需收紧再议。流式中的拦截路径不预置流态判定（SDK `compact()` 先 abort 当前轮再压缩，行为如实透传）。
- **不处理**（归属）：TUI 与 pi rpc-mode 的 `/compact`（SDK 既有机制，保持不动）；其他 builtin 命令（/subagents 等）提升进目录——仅入驻 compact 一条，后续按需逐条同型；pi-agent-core 后端的压缩支持（unsupported 照旧）；`reason` 结构化词表（hub 全局改造）；自动压缩（threshold/overflow）与 branch summary。

## 契约 v0.12 增补：parked 只读历史（2026-09-10，已实施；方案 docs/plans/2026-09-10-parked-read-history.md）

对外零破坏增量：命令/帧/能力位词表均不变。`get_entries`/`get_state` 对**非 live**（parked/dead）thread 的应答路径从「唤醒 worker」改为「host 本地直读会话文件」——读不唤醒、写才唤醒（Electron 侧浏览历史零 worker 成本）。推导与 worker 重放**同源**：条目/leafId 经 pi SDK 同一解析器，model/thinkingLevel/messages 经 `buildSessionContext`（路径序最后 model_change 或 assistant message 胜出），窗口经 `selectEntriesWindow`（两路径共用）；model 解析不到 → `null`（无瘦形状回落）。

- **`thread/register`（新命令，v0.12 收口增补）**：`{sessionPath, trusted?}` → host 本地把会话文件纳管为 parked 表项（读 header 取 threadId=sessionId 与 cwd；零 worker）。裁决序：同路径 live 写者 → failure（already open）；既有同 id / 同路径非 live 表项 → 幂等返回；否则建表。动因：冷启动 host 表为空（客户端经 `thread/list_saved` 对账不 resume），读命令是 threadId 寻址——**未纳管会话的读命令回 `Unknown threadId`**（Electron 症状「所有历史对话加载失败」）；客户端在只读水化链头部先 register（毫秒级幂等）。纳管表项参与既有闲置退役/写命令唤醒语义不变（resume admission 的 deleteNonLiveByPath 照常替换表项）。
- **环守卫**：get_state 直读前置 leaf 父链环检测（visited）——SDK 的父链行走无环保护，环形 parentId 文件在 host 进程内会死循环整机；检出即按不可用处理（fail-open 唤醒，worker 死循环有 30s stale-kill 兜底）。get_entries 不走链，不受影响。
- **路由**：host 命令分发在透传前的只读短路（`src/read-history-command.ts`）：命令 ∈ {get_entries, get_state} ∧ entry 非 live ∧ 有 sessionPath ∧ 后端 `resources.readHistory` 可用 → 直读应答；**任何不可用（live/未知 thread/无路径/后端不支持/文件缺失或无效/IO 错误）返回未处理，继续走唤醒路径**（fail-open：最坏行为 = 增补前）。可读快照上的游标/limit 错误是真命令失败（与 worker 路径同文案），不回退。
- **直读口径**（`src/read-history.ts`）：`isStreaming`/`isCompacting` 恒 false（无 worker 定义上无在途轮）；`sessionId` = header id；`sessionName` = 追加序最后 `session_info`（空名清除）；`messageCount` = compaction 感知的上下文消息数；`model` 经 host 快照 `resolveModel` 富解析、未命中回落瘦形状 `{provider, modelId}`（live 版经 runtime 恢复链可能为富或缺失——两者客户端都只按 provider/modelId 消费，差异落档于此）。直读**无副作用**：不 spawn、不改 thread 状态、不写文件（解析用 `parseSessionEntries`，不经 `SessionManager.open` 的迁移/修复路径）。
- **live 恒透传**（负向不变量）：worker 内存态领先文件 flush，live 读不得走文件。直读与唤醒竞态读到 append-only 一致前缀，过期响应由事件流 + 下次 live 读最终一致（不做排序协调）。
- **能力协商**：`resources.readHistory` 是 backend 资源端口方法而非能力位——核心必选命令的可用性不受后端影响；无文件概念的后端（pi-agent-core/external）报 unsupported，读命令退回唤醒路径。
- **`thread/list` state 描述修订**：`parked` = 已闲置收编（读命令本地直读，其余命令自动唤醒）；`dead` = worker 异常死亡（读命令本地直读，写命令自动重开）。「下条命令自动唤醒」语义收窄为「写命令自动唤醒」。
- **测试口径**：直读 ≡ SessionManager 重放（临时文件黄金对齐）；短路路由单测（live/未知/无路径/unsupported/invalid/not_found/IO 错误→未处理；游标错误→真失败）；e2e-mock `parked-read-history` 场景（retire → 直读零 worker → 写命令透明唤醒）。

### v0.12 对抗审查处置（直读与 worker 恢复链的已声明差异）

审查实证 worker 的 `get_state` 真值经 `createAgentSession` 恢复链五道加工（messages 门控、`getModel`+`hasConfiguredAuth`、`findInitialModel` 回落、settings 默认 thinkingLevel、`clampThinkingLevel` 钳制），直读不全部复刻——**对齐承诺从「逐字段相同」修正为「文件记录值或 null」**，差异面全部声明：

- **model**：直读 = 条目流推导（路径序最后 model_change 或 assistant message）经 host 快照富解析，解析不到 → `null`；**不**做 auth 检查、**不**回落初始/默认模型、无消息上下文 → `null`（与 worker 的 messages 门控一致）。浏览态显示「会话记录的模型」而非唤醒后的回落结果，语义上更符合只读浏览。
- **thinkingLevel**：直读 = 路径序最后 `thinking_level_change`，无条目恒 `"off"`；不复刻 settings 默认档与模型钳制（hub resources 端口无 settings 面；pi-ai 的 clamp 不跨包引入）。唤醒时 worker 物化默认档条目会使 `leafId` 变化一次——客户端游标失配由既有「失效全量重拉」兜底。
- **legacy 文件（version < 3）**：直读判 invalid → fail-open 唤醒，由 `SessionManager.open` 迁移重写后（文件变 v3）直读自然接管——直读永不迁移文件（无副作用不变量优先）。
- **大小上限**：直读超过 64 MiB 的会话文件判 invalid → 唤醒路径（防同步大解析阻塞 host 心跳）。
- **stop 竞态语义**（接受）：直读在途时 `thread/stop` 删除表项，直读仍以旧 sessionPath 应答停机前的一致历史快照（旧路径此时答 `Unknown threadId`）——恰好一响应保持，读到的是无副作用的历史数据。
- 测试口径修正：等价性不再用「直读 vs `SessionManager.open` 同函数对比」（循环验证）；改为 e2e-mock 真值对齐（同会话 parked 直读响应 vs 唤醒成 live 后透传响应逐字段对比）+ 差异面单测（model null 链、legacy invalid、大小上限）。

## 契约 v0.12 增补（二）：沙箱 v0.12——姿态档位 + 事前问询 + 粗粒度授予（已实施；方案 docs/plans/2026-09-10-sandbox-v2.md，对抗审查 20 项处置见 §十二）

v0.10 的确认流程在默认配置下弹框过密（精确路径/精确命令串豁免、不持久化、网络白名单外即失败重跑）。v0.12 重构为「沙箱内免打扰，出沙箱才问，问一次就学会」：

- **组件化（用户裁决）**：沙箱逻辑迁入 `src/sandbox/` 组件包（config/policy/grants/digest/ports/controller/runtime/bash-exec），零 host/worker/协议依赖（`scripts/check-import-boundary.mjs` 进 check 门强制）；backend 只剩 `sandbox-binding.ts` 粘合层。
- **posture 档位**：`sandbox.json` + `thread.start/resume` 的 `sandboxPosture` 参数（host 持久化进线程表，唤醒不丢）；strict（untrusted 缺省，有意收紧）/ balanced（trusted 缺省 = v0.10 策略）/ open（诚实全允许，硬底除外）。
- **沙箱内静默（B）**：权限门 fallback「ask」对「将入沙箱的 bash / 分类干净的 write/edit」自动放行（deny/block/显式 ask 规则仍先生效；runtime 降级时回退逐命令弹框，绝不 fail-open+静默叠加）。
- **事前问询（E，微复现实测）**：runtime 网络代理的 ask 回调在**连接建立前**触发——命令不失败、零重跑；`updateConfig` 对代理即时生效（会话/永久授予秒级生效）。
- **四选弹框 + 粗粒度授予（C+D）**：once / session / always / deny；域名/父目录/模式/前缀粒度（前缀 = 每复合段首两 token，rules.ts 分段器单一真相）；同键在途去重；fork/clone 保留授予（会话连续体，推翻 v0.10 快照清空裁决）；"Always" 由 host 单写者落盘全局 `grants` 节（worker→host `sandbox_grant_persist` 内部帧；**绝不改写 posture 相关系组**——跨档位污染是审查 P1 红线）。
- **沙箱内重跑**：分类违规（域名/目录）批准后经 per-invocation 策略覆写**仍在沙箱内**重跑（customConfig 整段合并，绝不丢 denyRead/denyWrite）；仅不可分类拒绝走 v0.10 出沙箱重跑兜底。
- **env 凭证过滤**：沙箱内 bash 匹配变量值 → 哨兵 `pai-sandboxed`（堵 env 外带洞；自研，不用 runtime credentials 的出口回填语义）。
- **预声明升级**：sandboxed bash 输入 `escalate+escalateReason`——执行前弹框，批准直接出沙箱（模型可教的半执行失败消除）。
- **血缘传播**：孙进程继承 posture + 域名/目录/模式授予快照；bashPrefixes（出沙箱特权）**永不传播**（审查 P4）。
- **get_sandbox_state v2（破坏性）**：见 api.md §沙箱（移除 `sessionExemptions`）。
- **不变量延续**：denyRead/保护路径恒硬拦、孙进程 fail-closed、deniedDomains/denyWrite 恒压一切授予、`PAI_SANDBOX=off` kill switch、`onViolation` 正交保留。

## 契约 v0.13 增补：运行时可观测性与手动回收（2026-09-10，已实施；方案 docs/plans/2026-09-10-runtime-observability.md）

对外零破坏增量：命令 40→43、帧 8→9，既有字段只增不改。动机：Electron 运行状态监控页（外部仓库 T29）——闲置回收对客户端静默（retire→parked 无帧，客户端视图滞留 live）、无手动回收命令（`thread/stop` 是删表项不是 park）、无 per-thread 观测与内存计量、闲置阈值运行期不可调。

- **`thread/retire`（新命令）**：`{threadId}` → 手动触发闲置回收同型路径（`retireIntent='retire'` + stdin.end + `workerExitTimeoutMs` 有界强杀），close 结算表项转 `parked`（会话文件保留、写命令自动唤醒）。幂等对齐 `thread/stop`：未知/非 live 线程 ack success 零副作用。streaming 线程允许 retire（在途命令由 close 对账合成 failure，恰好一响应不变）；与在途 stop 竞争时 stop（删表项）优先。
- **`thread/set_keepalive`（新命令）**：`{threadId, keepalive}` → host 本地置路由表项标志（零 worker）。未知线程 failure。sweep 对 keepalive live worker **跳过闲置收编**；stale 心跳强杀与 spawn 超时照旧（不是免死金牌）。标志不持久化——客户端注册表是持久真相，会话 live 化时 re-assert。
- **`set_idle_retire_ms`（新命令）**：`{ms}` → 运行期改闲置阈值（钳制 `[1_000, 86_400_000]`，响应回生效值；垃圾输入按钳制降级不崩）；`get_host_info.limits.idleRetireMs` 同步反映。替代「改档位需重启 hub 杀全部 worker」。
- **`thread/list` 行扩展**：`idleMs`（live=worker 心跳值/非 live=0）、`subagents`（live=最近心跳计数/非 live=0）、`rssBytes`（worker 心跳上报，未上报=null）、`keepalive`。
- **`thread_parked`（新帧）**：`{threadId, reason: "idle"|"manual"}`——settleClosedWorker 的 retire 分支（表项已转 parked 后）发射，恰好一次（以 close 结算为准）；stop/shutdown 不发。与 `thread_died` 互补：died=异常死亡，parked=正常收编。
- **宿主心跳帧扩展**：恒带 `rssBytes`（`process.memoryUsage().rss`）与 `cpuPercent`（`process.cpuUsage` 1s 差分、单核归一、可>100）。
- **worker 心跳帧扩展**（host↔worker 内部）：恒带 `rssBytes`，host 折叠进 WorkerHandle（未上报容错为 null）。
- **不处理**：per-worker CPU（RSS 是资源主相）；keepalive 持久化；died/parked 合并帧；streaming worker 的 EOF 主动中止（有界强杀兜底）。

### v0.13 对抗审查处置（2026-09-10 独立会话）

- **retire × 在途唤醒**：wake 在飞时 retire 不再 success-lie——置后置收编（`entry.wake` 落地为 live 后即以 reason=manual 收编；对称 stop 的 stopRequested 语义）。
- **未落盘会话**：`worker.sessionPath === null`（lazy-persist 首条消息前）的 live worker retire 回 failure `Session not persisted yet`——parking 会造成不可唤醒的幽灵表项（sweep 的同款守卫对齐）。
- **fork 不继承 keepalive**：rekeyFork 迁移表项时显式清零（新会话新策略；客户端按需 re-assert）。
- **`set_rss_retire_bytes`（RSS 硬顶）**：`{bytes}` → 运行期改 worker RSS 硬顶（0=关闭；有效域钳制 `[256 MiB, 2 TiB]`，响应回生效值；环境旋钮 `PAI_RSS_RETIRE_BYTES` 同语义、缺省 0=关；`get_host_info.limits.rssRetireBytes` 回显）。sweep 判据（stale/spawn-deadline 之后）：live worker 心跳 `rssBytes ≥ 阈值` → **已落盘**（sessionPath 非空）走 idle/manual 同一 `retireWorker` 入口回收，`thread_parked.reason = "rss"`；**未落盘**（首回合、无会话文件）走 kill（`thread_died` 诚实失败）——收编一个无文件表项会造出永远无法唤醒的 parked 僵尸。**硬顶语义：keepalive 与 busy 不豁免**（机器保护优先；mid-turn 回收丢在途轮、会话已落盘前缀无损，与 thread/retire 手动回收一致）。上下限 256 MiB..2 TiB 对**所有配置面**（命令与 `PAI_RSS_RETIRE_BYTES` env 一致）生效，防「低于 bun worker 基线 → resume 即回收」死循环。默认关（杀 busy worker 是破坏性动作，opt-in）。
- **在途快照尾部预判（热路径）**：`tool_execution_update` 携带累积快照——保留面从末块累计字节、已取部分 > cap 即停（每事件 O(cap)，头块永不 join/测量），结果与「全量 join + retainTail」逐字节等价、`truncated` 标志同样精确。
- **垃圾输入**：`set_idle_retire_ms` 非有限数字、`set_rss_retire_bytes` 非有限数字、`thread/set_keepalive` 非布尔 → failure（命令族惯例，不静默折叠加默认）。
- **cpuPercent 分母**：以实测 tick 间隔为分母（事件循环停顿拉长 tick 时不再系统性放大读数）。
- **cap 驱逐不发帧**：settleClosedWorker 的非 live 容量驱逐命中本表项时跳过 thread_parked（不给已消失的表项发帧）。

## 契约 v0.14 增补：收敛读口族（刷新/重连后仅靠只读快照即可收敛）（2026-09-11；方案 docs/plans/2026-09-11-convergence-read-surface.md）

**不变量（新增，协议级）**：任何由事件（`PaiEvent` / `ui_request` / `subagent_event` / `subagent_message`）派生的客户端视图面，**必须**存在一个只读快照命令；客户端在任意时点（首挂载 / 渲染层重载 / 重连 / 宿主重启回落）仅靠只读快照即可收敛，事件只承担低延迟增量。快照与增量的合并必须幂等（同实体同 id，或明文规定的前缀 / 整体替换规则）。事件 ↔ 读口 ↔ 合并规则登记表见方案 §3.1——**新增事件类型必须同表登记读口与合并规则**。

**新命令（3 条，均属 observer：只读、不发事件、不重置 worker idle 计时）**

| 命令                  | 响应                                                                                                                                                                 | 空形态                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `get_inflight`        | `{turnStartEntryId, turnStartedAt, message, toolOutputs, bash}`                                                                                                      | `{null, null, null, [], null}` |
| `get_subagents`       | `{subagents: SnapshotEntry[]}`（registry 快照原样）                                                                                                                  | `{subagents: []}`              |
| `get_pending_dialogs` | `{dialogs: [{requestId, threadId, method, payload}]}`（payload = 请求完整字段体〔帧头保留键已剥除〕，客户端 `{...payload}` 重建帧；**worker 作用域**，含子代理弹窗） | `{dialogs: []}`                |

- **`get_inflight.turnStartedAt`**：轮首时刻（epoch ms，与 `turnStartEntryId` 同点采集）——客户端刷新后**续算**轮计时，而不是从刷新时刻重新起算。
- **`get_inflight.turnStartEntryId`**：本轮持久前缀边界 = `agent_start` 时刻的 leaf entry id（无在途轮为 `null`）。这是「哪些条目属于当前轮」的**权威**判据——客户端不得用「末位用户消息」之类启发式重推（轮内注入的 user 消息与 steer 中途插话都会把启发式切错，切错即同轮双渲染）。
- **`get_inflight.message`**：在途 assistant partial，与 `message_end` 事件同源形状（客户端复用同一正规化路径）。**`get_messages` 恒不含它**（`agent.state.messages` 只在 `message_end` 收到消息，partial 在 `streamingMessage` 里）——在途内容一律走本条命令。
- **`get_inflight.toolOutputs / bash`**：运行中工具调用的输出尾部与直执行 bash 的输出尾部（bash 的生命周期由 begin/end 独立管理，**模型轮结算不清它**——并发直执行时轮结算不得清掉仍在跑的 bash 面），各带 `startedAt`（epoch ms，供重载后恢复时长/计时显示）。上界：每调用 / 每条 64 KiB（**按字节**，丢头保尾且不劈代理对），超出置 `truncated: true`；调用结束（tool_execution_end）/ 对应命令结束即除名。并发数上界分治：工具调用表至多 8 条（超出丢最旧——工具调用不承载准入信号，丢旧只损失读面）；直执行槽位表至多 8 条且**满表拒绝**（槽位全部运行中，逐出会同时丢在途面与无 id 并发的准入信号）——第 9 条并发直执行回 failure `too many concurrent direct bash executions (limit reached)`。**槽位认领在准入时同步完成，且认领/释放/执行全程使用准入时捕获的 inflight 状态与会话引用**（权限弹窗最长可挂 5 分钟，worker 又是并发分发，检查与登记之间不能有异步窗；fork/clone 的 rebind 会就地换掉两者，晚绑定会释放在新代状态上或对新会话执行——换绑同时结算旧 id 弹窗，被换绑中断的准入以干净失败收场）：无 id 直执行在任一无 id 槽在跑（含权限门挂起期）时回 failure `concurrent direct bash requires a command id`；非空 id 撞已在跑的同 id 回 failure `bash command id is already in use`（`id:""` 视同缺省）。**弹窗期 abort_bash 穿透准入窗**：立即 abort 该会话全部挂起准入（弹窗按未应答结算、命令永不执行、response failure `aborted before execution started` 恰一帧），再发会话级 abortBash。**并发直执行**（api.md 明示支持）：在途面按命令帧 id 隔离保留，互不覆盖、各自结束只清自己；读口 `bash` 是单面（与客户端横幅、live 事件同为单面）——取**最新仍在跑**的直执行，`bash === null` ⇔ 无任何直执行在跑（客户端收尾探测的判据）。
- **孙进程弹窗帧契约**：`requestId` 非非空字符串 = malformed 帧（fatal、不中继——中继会出现客户端永远无法应答、重载后消失的僵尸弹窗）；保留表 TTL 过期条目在插入路径清扫（死弹窗不占 cap，16 条上限只计可应答弹窗）；单帧 64 KiB 字节上限（超出 = 协议违例处死）——保留面的字节上界由此成立（16 × 64 KiB = 每孙进程 1 MiB），不再只依赖管道行上限。
- **`get_pending_dialogs`**：两个数据源合并成一个队列——broker 保留 request payload（原先只保留关联关系），以及子代理（grandchild）的在途弹窗帧（其实时帧直发客户端、不经 broker，registry 保留的原始帧是重载后唯一重建源；条目按实时 relay 同口径：threadId = 父会话 id，payload 追加 `subagentId`/`agent`；running 之外的 grandchild 条目随进程消亡）。「恰好 settle 一次」语义不变（payload 保留只是新增只读观察面）。
- **`get_state` 增字段 `queue: {steering, followUp}`**：排队文本的读口（读会话既有 getter；无队列后端回空数组）。**parked/dead 直读路径同批返回该字段（恒空数组）**——live/parked 形状必须闭合（v0.12 同源表纪律）。
- **非 live 短路**：三条读命令对 `parked`/`dead` 由 host 本地回**空形态**应答（不读文件、不 spawn、不改状态、不发事件）；`live` 透传 worker（内存态真相）。**能力门控先于短路**：后端不支持某读口（如探针后端无 `session.inflight`）时，非 live 读同样回 `success:false` 的能力错误——门控语义不受线程状态影响。
- **能力位**：新增 `session.inflight`（门控 `get_inflight`；pi-coding-agent 支持，探针后端 pi-agent-core 不支持）。`get_subagents` / `get_pending_dialogs` 读的是 hub 自有状态（子代理 registry / 对话框 broker），属**核心命令**（无能力位，任何后端恒可用）。外部命令数 43 → **46**。
- **客户端降级口径（写进 electron-integration.md）**：旧 hub 无该命令 → failure（不挂起）；**探测只允许对 live 会话发起**——对 parked 线程发未知命令会经 passthrough 走唤醒路径（`host.ts` handlePassthrough → `sendToThread` ensureAwake），违反 v0.12「读不唤醒」；探测结果按 hub 进程代际失效。
- **不处理（明确归属）**：事件序号补拉（`thread/events?since`）——客户端要的是"现在是什么"而非"曾经发生了什么"，且它仍需快照兜底；出现第二个消费方（多窗口/远端订阅）再立项。自动重试状态读口（SDK 私有字段，无稳定真相，缺它代价极低）。子代理 relayed 事件历史（只给快照）。
