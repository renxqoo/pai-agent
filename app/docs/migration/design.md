# pai-cli worker 架构设计（DESIGN）

> 状态：定稿（已过独立对抗审查，20 项发现全部处置，见 migration.md §2）
> 前置文档：[../design.md](../design.md)（v0.1–v0.3 线协议规格，仍是对外契约的唯一真相）
> 本文档只定义 worker 架构与 v0.4 增量；v0.3 线格式不在本文重复。

## 0. 背景与目标

pai-inprocess（分支 `pai-inprocess` @ 07b294bf4）是单进程多会话：所有对话共享一个
事件循环与一个 V8 堆。实测与 ZCode 形态对比后的问题（用户裁决：直接重构）：

- 单事件循环：任何对话的同步长操作（大文件 IO、失控扩展）冻结全部对话；
- 单 V8 堆（~4GB 上限）：一个重对话可 OOM 连坐全部对话；
- trusted 扩展是任意代码，影响面是全部对话。

目标形态（对齐 ZCode）：**host 进程 + 每个活跃对话一个 worker 进程**。
故障域、内存域、扩展执行域按对话隔离；对外协议 v0.3 不变，v0.4 只做增量。

明确不处理（归属）：

| 问题                        | 归属                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Electron UI、登录界面、渲染 | 外部 Electron 项目（既有裁决 D7）                                                                                   |
| OAuth 登录流                | 后续版本（既有裁决：v1 仅 API key）                                                                                 |
| 跨机器会话同步、远程会话    | 不做（无此需求）                                                                                                    |
| worker 间直接通信           | 不做（worker 互不知晓，host 是唯一枢纽）                                                                            |
| parked 对话的状态轮询       | Electron 用 `thread/list`（host 本地应答，不唤醒 worker）；对 parked threadId 反复 `get_state` 会造成唤醒风暴（§6） |

## 1. 进程模型与职责划分（D-W1 / D-W2）

```
Electron ── JSONL v0.3+v0.4 ──► host（单进程）
                                   ├─ 本地应答：get_models / auth/* / thread/list
                                   │            / thread/list_saved / ui_response ack
                                   ├─ 模型解析：provider+modelId → Model 对象（唯一点）
                                   └─ 路由与进程管理
                                        ├── worker A（对话 A，单会话）
                                        ├── worker B（对话 B，单会话）
                                        └── …（live ≤ PAI_MAX_THREADS）
```

单一真相原则（每件事只有一个实现点）：

| 事实                                 | 唯一实现点                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| 对话集合与状态（live/parked/dead）   | host 路由表                                                                                  |
| auth.json 写入                       | host ModelRuntime（worker 对 auth.json 只读；跨进程并发由 pi 的 proper-lockfile 文件锁保护） |
| provider+modelId → Model 解析        | host（thread/start 与 set_model 注入解析结果；Model 为纯数据对象，可经 JSONL 注入）          |
| 会话执行（prompt/steer/bash/fork/…） | worker（每 worker 恰好一个会话）                                                             |
| 一条会话的闲置时长（idleMs）         | worker 心跳（host 不做推断）                                                                 |
| 权限规则裁决                         | worker 内 rules.ts decide()（沿用，不变）                                                    |

worker 复用 pai-inprocess 的执行层原样：stdout-guard、jsonl、dialogs、
ui-context、permission-gate、rules、两段式 session 工厂、rebind 闭包。
**删除** worker 侧多会话机制（跨线程 spawn 串行化、双开路径守卫、resolveModel）
——会话多重性只存在于 host；**保留**单会话内会话替换操作（fork/clone/stop）
的互斥串行（旧实现仅 stop 串行、fork/clone 裸奔是潜在竞态，迁移修复，见
migration.md F-2）。

依据（pi 源码实证，2026-09-07）：

- `AuthStorage.readLatestData`（auth-storage.ts:401）每次读都 stat auth.json
  （`getFileRevision`：dev:ino:size:mtimeNs:ctimeNs），变更即重读。
  → host 写 auth.json 后，运行中 worker 的**请求路径**凭证自动新鲜；
- `ModelRuntime.snapshot.available` 只在本进程 login/refresh 时重建
  （model-runtime.ts:269 / :288）。→ 运行中 worker 的**快照**对 host 后写的
  凭证陈旧。因此模型解析收归 host：host 自己 login 后
  `synchronizeCredentialState` 立即重建快照，`set_model` 不会误报。
- `AgentSessionRuntime.setBeforeSessionInvalidate`（agent-session-runtime.ts:129）
  是公有 hook，teardownCurrent 前必调（:176）——fork 失败语义的判定信号（§4）。

## 2. 对外协议 v0.4 增量（D-W8 / D-W9）

对外 v0.3 的 32 个命令、帧形状、恰好一响应/线程事件时序全部不变。增量：

1. 新帧 `thread_died`：`{ type: "thread_died", threadId: string, reason: string }`。
   worker 异常死亡（崩溃/心跳陈旧被杀/fork 后会话损坏自退，见 §4）时恰好一次；
   retire、host 关闭不发。
2. `thread/list` 条目新增 `state: "live" | "parked" | "dead"`。
   - live：有 worker 进程；`isStreaming` 来自最近一次 worker 心跳（陈旧度 ≤ 1s，
     与 v0.3 即时值的有意差异，精确值用 `get_state`）；
   - parked：会话已落盘、worker 已退，下次命令自动唤醒（respawn+resume）；
     `isStreaming: false`；
   - dead：worker 异常死亡，条目保留供 UI 呈现与恢复决策；`isStreaming: false`。
3. `hub_error` 帧新增可选 `threadId`（worker 发出的经 host 注入来源线程；host
   自身的无此字段）。
4. 环境旋钮（host 读取，默认值只住在装配层）：
   - `PAI_MAX_THREADS`（默认 32）：live worker 上限；
   - `PAI_IDLE_RETIRE_MS`（默认 900000）：闲置收编阈值；
   - `PAI_WORKER_STALE_MS`（默认 30000）：心跳陈旧杀线；
   - `PAI_WORKER_EXIT_TIMEOUT_MS`（默认 10000）：优雅退出等待上限。

新增对外错误文案（英文中性，v0.3 承诺延续；worker 侧内部拒绝如
`Worker already hosts a conversation` 只出现在 host 路由异常时，正常流不可达）：

- 超限：`Too many concurrent conversations (limit <N>)`（thread/start 与唤醒时同文案）；
- spawn 未就绪：`Worker failed to start within <N>ms`（无 "worker died:" 前缀，
  与死亡补 failure 的前缀形态区分）；
- 跨进程双开：`Session already open (threadId: <T>); two writers would corrupt
the session file`（占位竞态落败方为 `Session already open in another
conversation; …` 同尾句）；
- 投递失败：`worker died: command could not be delivered (<原因>)`；
- 唤醒中死亡：`worker died while resuming`；
- 唤醒未落盘线程：`Cannot wake thread: session was never persisted`；
- worker 关闭窗口内到达的命令：`pai-cli worker is shutting down`
  （v0.3 同路径文案为 `pai-cli is shutting down`，主语更正为 worker，
  属记录在案的有意文案变更）。

## 3. 内部协议（host ↔ worker，D-W4 / D-W14 / D-W17）

- 传输：worker stdin/stdout 管道上的 JSONL，帧解析复用 jsonl.ts。
- 命令：v0.3 线形状，仅线程作用域子集（prompt、steer、follow_up、abort、
  compact、get_state、get_messages、set_model、set_thinking_level、
  get_thinking_levels、get_entries、get_tree、set_session_name、get_session_stats、
  clear_queue、fork、clone、navigate_tree、get_fork_messages、get_commands、bash、
  abort_bash、ui_response、thread/start、thread/resume、thread/stop）。
  内部形状差异（边界翻译，非双轨）：
  - `thread/start`/`set_model` 由 host 注入**已解析的 `model` 对象**，不带
    provider/modelId（解析唯一点在 host）；
  - **Electron 发起的命令按原 id 原样转发**（含 thread/start/resume/stop——
    其响应由 worker 生成、host 透传，host 不合成对外响应）；host **自发**命令
    （唤醒 resume、ui_response 广播）用内部 id（`pai-internal-<seq>` 生成约定），
    其响应由 host 吸收不上抛。吸收判定以 host 的「自发命令 pending id 集合」
    成员关系为准（前缀只是生成侧约定，不作为判据——Electron 的 id 空间不受
    约束，不得因前缀碰撞被误吸收）。
- worker → host 心跳（1Hz）：`{ type: "heartbeat", idleMs, streaming, sessionPath }`。
  `idleMs` = 距最近一次**非观察类**活动的毫秒数；观察类命令（get_state、
  get_messages、get_entries、get_tree、get_session_stats、get_commands、
  get_fork_messages）不重置它，变更类命令（其余全部，含 ui_response）重置。
  观察类清单写死在 worker（轮询客户端因此不会阻止收编）。`sessionPath` 为
  当前会话文件路径（首次落盘前为 null；host 收编 parked 条目与占用表都
  依赖它）。host 消化不转发。
- 行上限：Electron→host 与 host→worker 均沿 v0.3 的 16MiB；worker→host 为
  128MiB（单行 `get_messages` 响应可达数十 MB；worker 是自家二进制视为可信，
  超限视为 worker 异常 → 死亡流程并记 stderr）。
- 帧识别与透传：host 对 worker 行做**前缀分类**，不全量 parse——
  - `{"type":"event"` / `{"type":"ui_request"` / `{"type":"hub_error"`：小帧，
    hub_error 需注入 threadId 时重组（§2.3），event/ui_request 原始行透传；
  - `{"id":` 或 `{"type":"response"`：响应帧。控制类响应（command 为
    thread/start、thread/resume、thread/stop、fork、clone）全量 parse（小帧），
    承担表更新与吸收判定；数据类响应（get_messages 等可达数十 MB）以行首
    regex 提取 `id` 与 `command` 两个字段（不 parse body），按 id 决定转发或
    吸收，原始行透传。JSON.stringify 键序假设（type/id 在前）由单元测试锁定
    （worker 帧字面量的键序是自家代码，可控）；
  - `{"type":"heartbeat"`：parse（小帧）。
  - 无法分类的行：parse 兜底分类。
- ui_response 路由：host 恒定 ack 一次，并以内部 id**广播**给全部 live worker
  （requestId 是 worker 生成的 UUID，无关 worker 解析后忽略）。host 不持有
  per-dialog 状态（无泄漏面、无清理逻辑）。
- worker 单会话守卫：thread/start/thread/resume 在已有会话（或 spawn 进行中）
  时失败；threadId ≠ 当前会话 id 的命令失败（防御 host 竞态，显式好于静默）。

## 4. threadId 语义、fork/clone 与失败语义（D-W3）

外部 threadId = worker 当前 sessionId（v0.3 语义不变）。fork/clone 后 worker 内
rebind 换 id；host 收到成功响应（`data.{threadId, previousThreadId}`）后、
**转发该响应行之前**，同步完成路由表重键与 sessionPath 占用重键（顺序保证：
Electron 依响应立即发新 id 命令时表已就绪；单元测试断言此顺序）。
`cancelled: true` 时两 id 相等，统一按重键处理（无操作）。navigate_tree 不换 id。

fork/clone 失败语义（修正旧实现缺陷，见 migration.md F-1/F-2）：

- 失败发生在 teardown 之前（未落盘、entry 不存在、分支创建失败等校验类）：
  线程保留、可继续使用（v0.3 代码行为，smoke 断言为规格；api.md 原文
  「线程视为终止」与代码矛盾，属文档错误，随本迁移修正）；
- 失败发生在 teardown 之后（createRuntime/服务工厂抛错；worker 经
  `setBeforeSessionInvalidate` 钩子精确得知 teardown 已发生）：旧实现在此留
  「已 dispose 仍在线程表」的僵尸——worker 发出 failure 响应后**自行优雅
  退出**，host 按死亡流程处理（thread_died + dead 条目）。原会话文件在
  teardownCurrent 内已 abort 并落盘，Electron 可 thread/resume 恢复。

## 5. 会话文件互斥（D-W6）

host 维护 sessionPath 占用表，**spawning 即占位**：发起 thread/resume / 唤醒
spawn 时立刻登记目标路径；占用中的路径再次 resume/唤醒 → failure（跨进程
双写会损坏会话文件；这是旧实现进程内 `spawningPaths`+spawn 串行化守卫的跨
进程等价物，文案含 `already open` 保持正则兼容）。live 与 spawning 都算占用；
parked/dead 条目持有路径但不占用（无进程）。

`thread/resume` 语义：目标路径被 live/spawning 占用 → 失败；路径匹配某个
parked/dead 条目 → 先移除该条目再 spawn（无进程冲突）。表不变量：每 threadId
至多一条目；同一 sessionPath 的 live/spawning 占用至多一个；非 live（parked/
dead）条目总数上限 1024（FIFO 逐出，逐出后命令回 `Unknown threadId`——与
host 重启后的可观察行为一致，会话文件仍在盘上可 thread/resume）。
fork/clone 生成的时间戳新路径沿用 pi 的唯一性保证（v0.3 同样信任）。

## 6. worker 生命周期（D-W7）

```
spawning ──start/resume 成功──► live ──idleMs≥阈值──► retiring ──drain close──► parked
   │  │                          │                        │（EOF 后命令：排队至 close 再唤醒）
   │  │初始失败/spawn 超时         │─fork 后会话损坏自退───────┤
   │  └─► 回收（撤占位）           └─崩溃/心跳陈旧────────────┴─► dead（thread_died + 补 failure）
   └─thread/stop──► 取消 spawn、撤占位与表项
parked/dead ──任意线程命令──► spawning（respawn + thread/resume）──► live
live/parked/dead ──thread/stop──► 条目删除（live 走 retire 路径退出）
```

统一终止语义（顺序契约）：一切 worker 终止判定以 **stdout close**（流排空）
为准，不以进程 exit 事件为准——exit 可能先于管道残留数据派发。close 之后
host 才做状态迁移；对该 worker 全部 pending 命令按 id 对账：已收到响应的
不再补，未收到的合成 `failure`（"worker died: <reason>"），恰好一响应闭环。

- **retire**：worker 心跳 `idleMs ≥ PAI_IDLE_RETIRE_MS` 且 `sessionPath` 非空 → host
  关闭 worker stdin（EOF）→ drain 到 close → 表项转 parked
  `{threadId, sessionPath, cwd, trusted}`。未持久化的 idle worker 不收编（退了
  丢数据；与 v0.3「永不落盘的会话常驻」一致）。EOF 与 close 之间 worker 若
  开始新活动（≤1s 心跳盲区）：其 shutdown 先 abort in-flight 并发出对应
  failure 响应，这些响应在 drain 期正常送达（不静默丢失），盲区与后果记录
  在案。
- **retire 竞态**：retiring 中命令到达 → 排队到 close 后走唤醒。绝不与新
  worker 并存于同一会话文件。
- **stop 与唤醒竞态**（已闭环）：非 live 条目唤醒进行中收到 thread/stop →
  条目标记 stopRequested → 唤醒完成后回收 respawn 的 worker 并删除表项，
  不复活（触发唤醒的命令按 Unknown threadId 失败，诚实可接受）。
- **已知盲区**（与 retire 心跳盲区同列，接受并记录）：thread/start 的会话
  文件在「首次落盘 → start 响应/心跳上报占用」之间有亚秒级窗口，外部
  thread/resume 恰在该窗口命中同路径可短暂双开。缓解：占用检查除注册表外
  再扫描各 worker 心跳已上报的 sessionPath（pathHolder）。
- **唤醒**：对 parked/dead thread 的任何命令 → respawn + `thread/resume`
  （sessionPath/cwd/trusted 取自表项；路径须通过 §5 占用检查）→ resume 响应
  （内部 id，吸收）到达后转发原命令。resume 后 sessionId 应与表项一致，不一致
  以响应为准并记 stderr。唤醒受 PAI_MAX_THREADS 限制。
- **死亡**：非收编路径的 worker 退出（含 fork 后自退）、或心跳陈旧 >
  `PAI_WORKER_STALE_MS`（先 SIGTERM 予 2s 宽限再 SIGKILL）→ 统一终止语义 →
  `thread_died` → 表项转 dead。heartbeat 无法区分「忙」与「死」，阈值默认
  30s 兼顾两者；同步长任务 >30s 的 worker 会被杀——记录为已知边界，宁可
  杀错不放过（冻结对话在 v0.3 是全员冻结，新架构只损失一个对话）。
- **thread/stop**：live → 路由到 worker（dispose 语义）→ 响应后走 retire
  路径退出 → 表项删除；spawning → 取消（杀 worker、撤占位与表项，响应成功）；
  parked/dead → host 直接成功 + 表项删除（幂等，v0.3 语义）。
- **孤儿自灭（简化）**：worker stdin 即 host 管道；host 死亡（含 SIGKILL）→
  管道写端关闭 → worker 现有 stdin-end shutdown 优雅退出（v0.3 既有机制，
  不新增检测代码；stdout 侧 EPIPE 亦触发 shutdown）。不依赖 ppid/reparent。

## 7. 启动、关闭与自举（D-W13 / 自举三形态）

- host 启动序（沿用 v0.3 契约）：takeOverStdout → FrameWriter → 心跳 1Hz →
  `ModelRuntime.create()` → 挂 stdin（命令处理不早于 ModelRuntime 就绪）。
- host 关闭（stdin EOF / SIGTERM / SIGINT）：abort host 本地 in-flight（auth）→
  全部 worker stdin EOF → 等全部 close/exit（上限
  `PAI_WORKER_EXIT_TIMEOUT_MS`，超时 SIGKILL）→ flush → exit 0。**关闭期终止
  不走死亡流程**（不发 thread_died、不补 failure——连接本身在关闭，Electron
  不会再消费）。worker 内部沿用 v0.3 shutdown（abort in-flight、settle
  dialogs、dispose 会话、flush、exit 0）。
- worker 自举（三形态，2026-09-07 bun 1.4.2 实测）：
  - 脚本形态（`bun src/cli.ts` / `bun dist/cli.js` / shebang 直执行）：
    argv[1] 是盘上存在的脚本 → `spawn(execPath, [argv[1], "--internal-worker"])`；
  - 编译形态（`bun build --compile`）：argv[1] 是 `/$bunfs/…` 虚拟路径（盘上
    不存在）→ `spawn(execPath, ["--internal-worker"])`。
- worker 环境：全量继承 host env（`PI_CODING_AGENT_DIR` 等随行）与 cwd。

## 8. 并发与性能预算（D-W15 / D-W18）

预算违反 = 缺陷。标注「目标值」的数字在阶段 1b 实测回填 migration.md：

- host 路由一次命令（查表 + 一次管道写）< 1ms；禁止 host 在转发路径上做
  磁盘 IO；
- 帧透传不得因 host 复制大 payload 而放大内存（§3 前缀分类；行缓冲本身
  持有原始行是线协议固有成本）；
- 内存（目标值）：host 基准 ≈ 110–140MB RSS + 最近最大行的缓冲；每 live
  worker ≈ 100–130MB idle 起步、随对话增长（独立 V8 堆）；满载 32 对话 +
  host ≈ 3.5–4GB（目标值）。单对话失控不再连坐；
- 全局定时器：host = 心跳 1 + 健康扫描 1（陈旧杀线与收编检查合并在同一
  扫描里）；
  worker = 心跳 1。禁止每帧/每命令新建定时器；
- thread/start（含 worker 冷启动，目标值 P50 ≤ 2s）：超过
  `PAI_WORKER_EXIT_TIMEOUT_MS` 未就绪 → spawn 失败（回收 + failure）；
- 状态有界：内部 id 集合 ≤ pending 数；非 live 表项 ≤ 1024；retire 定时器
  随状态迁移清理；子进程全部有 exit/close 监听（无僵尸进程）。

## 9. 安全基线（沿用 + 新增）

- GLM_API_KEY 等 .env 凭证只经 env 注入，不出现在帧、stderr、磁盘（既有约束）；
- auth/set_api_key 的红线（首 secret 才应答 + 全错误路径 redact）随代码移入
  host，逐字保留；
- worker stderr 全量经 host 转发（前缀 `[pai:worker:<threadId>] `），不静默丢弃；
- 权限门不变：tool_call 门与直接 bash 共用 decide()（worker 内执行）；
- 新增面：host ↔ worker 管道是本机自有进程对，无鉴权需求；worker 不监听
  任何网络端口；host 关闭对 worker 的 SIGTERM/SIGKILL 仅作用于自有子进程。

## 10. 用户裁决记录

| 裁决 | 内容                                                                                                | 出处                                |
| ---- | --------------------------------------------------------------------------------------------------- | ----------------------------------- |
| U1   | 直接重构为每对话一进程；旧实现切 `pai-inprocess` 分支留档对比                                       | 用户 2026-09-07                     |
| U2   | bun 1.4.2 工具链（沿 app 独立配置）                                                                 | 用户 2026-09-07                     |
| U3   | 不写 TODO：交付生产可用版本，全部测试通过                                                           | 用户 2026-09-07                     |
| U4   | 零兼容层：无双轨字段/旧别名，旧实现立即删                                                           | 用户 2026-09-07                     |
| U5   | 安全与内存泄漏问题必须即修，不许挂账                                                                | 用户 2026-09-07                     |
| U6   | fork 失败语义以旧**代码**行为为规格（早期失败线程保留），api.md「线程视为终止」是文档错误随迁移修正 | 定稿裁决 2026-09-07（审查 #2 处置） |
| U7   | 心跳陈旧阈值取「宁可杀错」：30s 杀线优先于保护 >30s 同步长任务的 worker                             | 定稿裁决 2026-09-07                 |
