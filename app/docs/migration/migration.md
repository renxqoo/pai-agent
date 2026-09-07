# pai-cli worker 架构迁移文档（MIGRATION）

> 状态：已核销（2026-09-07：四门 + 三 e2e 门全绿；文档审查 20 项与实现审查 12 项全部处置）
> 迁移单元：pai-inprocess 单进程多会话 → host + 每对话一 worker
> 旧实现：`pai-inprocess` @ 07b294bf4（src 10 文件 2048 行；断言数以运行器
> 实测为准，当前调用点 smoke 76 / e2e 49 / e2e-multi 24）
> 目标位置：同仓 `app/`（分支 `pai-worker`）
> 关联：[design.md](design.md) · [implementation.md](implementation.md)

## 1. 行为规格基线

判定行为等价的规格 = 旧测试断言 + ../api.md 对外契约（除已裁决的文档错误）。
旧测试清单：

| 旧测试                                  | 测什么                                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| test/smoke.mjs                          | 隔离 agentDir 下的全命令黑盒矩阵：auth（含 key 泄漏扫描）、会话 CRUD、fork（手工会话文件夹具）、权限门（allowPatterns）、stdout 纯净度、stderr 捕获 |
| test/e2e.mjs                            | 真实 GLM 全旅程：login→start→prompt→流式事件→stats/fork/clone/navigate→权限对话往返→compact                                                         |
| test/e2e-multi.mjs                      | 4 并发对话（bundled 产物）：消息/事件/设置/队列零串扰、stdout 纯净、RSS 采样                                                                        |
| test/{rules,jsonl,stdout-guard}.test.ts | 纯函数规格（决定序、行分帧、写序/重试）                                                                                                             |

显式有意变更（引用 design.md 节号，非行为缺失）：

- `thread/list.isStreaming`（live 态）从即时值变为 ≤1s 心跳陈旧值（§2）；
- `thread/list` 新增 `state`、新帧 `thread_died`、`hub_error` 可选
  `threadId`（§2，纯增量）；
- 单进程内存模型 → 进程树内存模型（§8）；`thread/start` 含 worker 冷启动延迟；
- 进程内双开守卫 → host 跨进程 sessionPath 占用（§5，同语义推广；文案含
  `already open`，smoke 正则兼容——装置适配记录 #A1）；
- 观察类命令不重置 worker 闲置计时（§3）；
- **修复两处旧实现缺陷（行为变更，属修复非漂移）**：
  F-1 teardown 后 fork 失败不再留僵尸，改为 worker 自退 + thread_died（§4）；
  F-2 fork/clone 与 stop 并发不再可能复活已停会话（§1）；
- api.md「fork 失败 → 线程视为终止」修正为实际语义：早期失败线程保留可
  继续；仅 teardown 后失败（thread_died）线程终止（用户裁决 U6）。

无删除的测试用例；全部断言移植或改写（矩阵见 §5）。

## 2. 文档定稿前对抗审查处置记录（2026-09-07，20 项全处置）

| #   | 级别 | 发现                                                                               | 处置                                                                 |
| --- | ---- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | P0   | host 缺 spawning 期 sessionPath 占位，并发 resume 双写                             | 采纳：占位表 spawning 即占用（design §5）                            |
| 2   | P0   | fork 失败语义基线矛盾（api.md vs 代码）；teardown 后失败留僵尸                     | 采纳：U6 裁决 + F-1 修复（design §4、implementation §1）             |
| 3   | P0   | 死亡补 failure 与管道残留顺序未定                                                  | 采纳：统一以 stdout close 为准对账补缺（design §6）                  |
| 4   | P1   | 删 threadQueues 连 stop 串行化一起删；fork/clone 实际从未互斥                      | 采纳：三操作串行保留/修复 F-2（design §1）                           |
| 5   | P1   | 每帧 parse 与内存预算矛盾                                                          | 采纳：前缀分类 + 数据帧免 parse body（design §3）                    |
| 6   | P1   | internal 前缀与 Electron id 空间碰撞                                               | 采纳：pending id 集合判定吸收（design §3）                           |
| 7   | P1   | fork 表更新与转发顺序未定                                                          | 采纳：更新先于转发 + 单测（design §4）                               |
| 8   | P1   | dead 条目 resume 路径未定义                                                        | 采纳：与 parked 同路径，表不变量成文（design §5）                    |
| 9   | P1   | retire 与轮询客户端冲突                                                            | 采纳：worker 算 idleMs + 观察类豁免（design §3）                     |
| 10  | P1   | 预算未实测、multi RSS 阈值缺失                                                     | 采纳：标目标值，阶段 1b 实测回填（design §8）                        |
| 11  | P1   | ppid 孤儿自灭未验证                                                                | 改用更强方案：stdin 管道 EOF（v0.3 既有机制）+ e2e 验证（design §6） |
| 12  | P2   | 计数口径不实（31 命令/178 断言）                                                   | 采纳：32 命令；断言数以运行器为准（implementation §1）               |
| 13  | P2   | 新错误路径文案缺失                                                                 | 采纳：文案成文（design §2）                                          |
| 14  | P2   | hub_error 无 threadId                                                              | 采纳：v0.4 增可选字段（design §2）                                   |
| 15  | P2   | in-flight 计数缺失；误以为 host 合成 start 响应                                    | 采纳：计数入 worker；澄清 host 只透传不合成（design §3）             |
| 16  | P2   | 心跳 1s 盲区下 retire 竞态                                                         | 采纳：drain 语义统一兜底 + 记录盲区（design §6）                     |
| 17  | P2   | 关闭期杀误发 thread_died；spawning 态 stop 无边                                    | 采纳：关闭不走死亡流程；状态图补边（design §6/§7）                   |
| 18  | P2   | parked 条目无界                                                                    | 采纳：非 live 条目 1024 FIFO 上限（design §5）                       |
| 19  | P2   | 双开守卫文案漂移                                                                   | 采纳：新文案含 already open（装置适配 #A1）                          |
| 20  | P2   | 测试盲区（并发 resume、fork 失败存活性、kill 时补 failure、retire 竞态、pid 装置） | 采纳：测试计划全部补齐（implementation §4）                          |

审查同时核实并保留的结论：auth-storage stat 驱动重读、快照重建点、
`setBeforeSessionInvalidate` 公有 hook、Model 纯数据可 JSON 注入、auth.json
proper-lockfile 跨进程安全、行数表。

## 3. 审计结论引用

见 implementation.md §1（F-1/F-2 两处旧缺陷 + R1–R4 新风险）。

## 4. 逐模块裁决表

见 implementation.md §2（复制 4 / 复制+微修 4 / 减法重构+修复 2 / 新写 3）。

## 5. API 对照与测试迁移矩阵

对外（Electron 面）：v0.3 全部 32 命令签名与响应形状不变；增量仅
`thread_died` 帧、`thread/list.state`、`hub_error.threadId`、环境旋钮、
两条新错误文案（design §2）。

| 旧测试                                               | 新去处                 | 动作                                                                                  |
| ---------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| rules.test.ts / jsonl.test.ts / stdout-guard.test.ts | 原文件                 | 移植不动（jsonl 补 maxLineBytes 用例）                                                |
| smoke.mjs 全部                                       | smoke.mjs              | 改写：目标进程 = host；新增 state 字段断言；其余语义逐条等价                          |
| e2e.mjs 全部                                         | e2e.mjs                | 移植（旅程不变）+ 新增 worker 旅程（kill/retire/wake/fork 自退/孤儿自灭/并发 resume） |
| e2e-multi.mjs 全部                                   | e2e-multi.mjs          | 改写：RSS 进程树求和；新增杀一 worker 其他存活                                        |
| （无）                                               | test/compile-smoke.mjs | 新增：编译形态覆盖                                                                    |

装置适配记录（逐条，不许静默改断言）：

- #A1 双开守卫新文案含 `already open`，smoke 正则不改；
- #A2 smoke 夹具（手工会话文件、权限规则文件、隔离 agentDir）原样复用，
  `PI_CODING_AGENT_DIR` 由 host 经 env 继承传 worker；
- #A3 e2e-multi RSS 断言从单进程改为 host+Σworker 求和；实测（2026-09-07
  darwin arm64 / bun 1.4.2）：idle 518 MB、并发峰值 530 MB，阈值定为
  idle < 750 / peak < 900（约 40% 余量）；
- #A4 「stdout 纯净度」断言复用于 host stdout；worker stdout 为内部管道，
  由 host 解析错误数隐式覆盖（parseErrors === 0）。

## 6. 回滚方案

每阶段独立提交（引用本文档节号），可独立 revert。无 schema/数据迁移——会话
文件格式是 pi 自有的，两架构完全互通；回滚 = 切回 `pai-inprocess` 分支，
无数据动作。

## 7. 验收清单（2026-09-07 核销）

- [x] 四门全绿：oxlint 0-0 / oxfmt / tsc 0 错误 / bun build 11.1MB / bun
      test 63 pass / smoke 178 断言 ALL PASS；
- [x] e2e 门全绿：e2e ALL PASS（70 断言，含 12 项 worker 韧性新增）/
      e2e-multi ALL PASS（含杀一 worker 旅程）/ compile-smoke ALL PASS
      （编译形态真实 GLM 旅程）；
- [x] smoke/e2e/multi 断言语义等价（§1 变更清单 + #A1–#A4 之外零漂移）；
- [x] 假绿对抗抽查（独立审查确认）：smoke.mjs 零改动即全绿；e2e 无断言
      删除；e2e-multi 仅 #A3 记录的 RSS 阈值调整 + 新增旅程；键序测试已改
      为真实 builder 输出；
- [x] 行为对照清单逐项（对话隔离 / key 零泄漏 / 权限门 / fork/clone 重键
      先于转发 / 恰好一响应（含 worker 死亡补 failure 与投放失败补）/
      优雅停机退出码 / 数字 id 往返 / 旧文案语义恢复）；
- [x] worker 韧性：kill -9 单 worker → thread_died + 恰好一补 failure +
      透明恢复；retire→wake 透明且观察类轮询不阻止收编；stop-vs-wake 不
      复活；PAI_MAX_THREADS=1 边界正确；kill -9 host → worker 限时自灭；
- [x] F-1/F-2 回归用例：session-host.test.ts（stub 单测 6 项）+ e2e
      早期 fork 存活断言（teardown 真实触发不可确定性构造，判定逻辑单测
      覆盖、pi 钩子语义对照源码核实）；
- [x] 泄漏审计（独立审查确认）：internalIds/pendingIds/occupiedPaths/
      entries(1024 FIFO)/allWorkers/retire 定时器有界清理；孤儿 worker
      e2e 实测为零；
- [x] 文档同步：../design.md v0.4 节、../api.md（32 命令 + fork 语义修正 + thread_died/state）、AGENTS.md、README、本文档；
- [x] 实测数字回填：e2e-multi 进程树 RSS idle 518MB / 峰值 530MB（阈值
      750/900）；单 worker 冷启动实测 ~1–2s（e2e 全旅程内含）；host+4
      worker 形态；对照基线 pai-inprocess 同口径单进程 idle 116MB /
      峰值 127MB——隔离的代价是每对话 +~110MB 常驻与冷启动延迟，收益是
      故障/内存域按对话隔离（杀一 worker 其他存活，e2e-multi 实证）。

## 8. 实施记录

### 波次 1（阶段 1a+1b，提交 "feat: pai-cli worker-per-conversation architecture, phase 1"）

- 交付：src/{host,worker,session-host,worker-pool}.ts 新写/减法重构；protocol.ts
  v0.4 增量与内部协议分区；jsonl.ts maxLineBytes 参数化；dialogs.ts
  pendingCount()；cli.ts 入口分流；hub.ts/threads.ts 删除。
- 修复：F-1（SessionDestroyedError + beforeSessionInvalidate 判定 + worker
  自退）、F-2（fork/clone/stop 串行化）。
- 门禁：oxlint 0-0 / oxfmt / tsc 0 错误 / bun build 11.1MB / bun test 56 pass
  （新增 worker-pool.test.ts 10 项）/ smoke 178 断言 ALL PASS（对 host 进程，
  首跑即绿）；退出后 pgrep 无 worker 残留。
- 实现期裁决补录：心跳载荷定为 `{idleMs, streaming, sessionPath}`（host 收编
  需要 path；persisted 可由 path 推导），design §3 已同步；host 全局定时器
  实为 2 个（陈旧杀线与收编合并进同一扫描），design §8 已同步。

### 波次 3（实现对抗审查修复，2026-09-07）

独立审查（对照 pai-inprocess 基线）12 项发现，全部处置：

| #   | 级别 | 发现                                                             | 处置                                                                                                                                                                                |
| --- | ---- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P0   | liveBudgetExceeded 差一（N 上限实为 N-1，N=1 全灭）              | 修：spawn 后检查改 overBudget(>)；e2e PAI_MAX_THREADS=1 边界断言                                                                                                                    |
| 2   | P0   | thread/stop 与进行中 wake 竞态 → 停止的会话复活                  | 修：stopRequested 标记 + doWake 成功路径回收；e2e stop-vs-wake 旅程（含无 thread_died、无复活断言）                                                                                 |
| 3   | P1   | 帧分类无 parse 兜底，数字 id 响应被丢 → 好 worker 被误报启动超时 | 修：unclassified 行 JSON.parse 兜底；单测（数字 id 不匹配严格前缀）+ e2e 数字 id 往返                                                                                               |
| 4   | P1   | 单测缩水 + 键序测试是假绿（手写字面量非真实 builder）            | 修：responseSuccess/Failure 提升为模块级导出，键序测试改用真实 builder；新增 session-host.test.ts（F-1 判定/F-2 串行/执行期 id 校验，stub runtime）；implementation §4 同步如实记录 |
| 5   | P2   | internal-id 泄漏无测试可抓                                       | 修：e2e 全帧扫描不含 pai-internal-                                                                                                                                                  |
| 6   | P2   | design §2 文案清单不全（实约八条）                               | 修：design §2 补全含 `pai-cli worker is shutting down` 文案变更记录                                                                                                                 |
| 7   | P2   | 测试矩阵两处不实（smoke 未改、F-1 teardown 无测试）              | 修：矩阵如实化；F-1 以 stub 单测覆盖（teardown 真实触发无法确定性构造，pi 钩子语义已对照源码核实）                                                                                  |
| 8   | P2   | thread/start 落盘→占用登记的亚秒盲区                             | 缓解：pathHolder 占用检查叠加心跳已上报路径；design §6 记录盲区                                                                                                                     |
| 9   | P2   | 并发双 fork 从防御失败变错位成功                                 | 修：fork/clone 执行期校验 expectedThreadId；单测覆盖                                                                                                                                |
| 10  | P2   | host default 分支文案分叉                                        | 修：THREAD_SCOPED_COMMANDS 集合 + 恢复 v0.3 文案（Unknown command / Unknown threadId: undefined）                                                                                   |
| 11  | P2   | worker stderr 超限行静默丢弃                                     | 修：onOverflow 记截断告警                                                                                                                                                           |
| 12  | P2   | spawn 超时补 failure 带 worker died 前缀，与 design §2 承诺不符  | 修：该路径裸文案                                                                                                                                                                    |

门禁（修复后全量复跑）：check 0-0 / build / bun test 63 pass / smoke 178 /
e2e ALL PASS（含新增 12 断言）/ e2e-multi ALL PASS / compile-smoke ALL PASS。

### 波次 2（阶段 2，提交 "test: pai-cli worker-architecture e2e journeys, phase 2"）

- 交付：e2e.mjs 五个 worker 旅程（早期 fork 存活、kill -9 恰好一补
  failure+thread_died+透明恢复、并发同路径 resume 恰一胜者、retire→parked→
  唤醒（观察类轮询不阻止收编）、host SIGKILL 无孤儿）；e2e-multi.mjs 进程树
  RSS + state 断言 + 杀一 worker 其他存活段；compile-smoke.mjs（编译形态
  真实 GLM 旅程）；package.json e2e:compile。
- 装置适配补录：e2e 以 PAI_IDLE_RETIRE_MS=3000 跑全程（收编在旅程中可透明
  发生）；e2e-multi 杀 worker 段用「最高子 pid = 最后启动」启发式选定受害者，
  断言放宽为 died ∈ 非流式线程（不依赖精确映射）。
- 门禁：check / build / bun test 56 / smoke 178 / e2e ALL PASS（62 断言）/
  e2e-multi ALL PASS（树 RSS idle 518MB、峰值 530MB）/ compile-smoke ALL PASS。
- 实施期缺陷（测试装置自身，非产品代码）：compile-smoke 轮询 id 固定导致
  永远读缓存首帧——改为每轮唯一 id；调试脚本裸用 .env baseUrl 未剥
  `/chat/completions` 导致 404 空回复（已订正为与 e2e 一致的 replace）。
