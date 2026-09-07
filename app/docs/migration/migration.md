# pai-cli worker 架构迁移文档（MIGRATION）

> 状态：实施中（阶段 1 已完成：worker 减法重构 + host/pool 新写，smoke 178 断言全过）
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
- #A3 e2e-multi RSS 断言从单进程改为 host+Σworker 求和，阈值阶段 1b 实测
  后定（写明数值与日期）；
- #A4 「stdout 纯净度」断言复用于 host stdout；worker stdout 为内部管道，
  由 host 解析错误数隐式覆盖（parseErrors === 0）。

## 6. 回滚方案

每阶段独立提交（引用本文档节号），可独立 revert。无 schema/数据迁移——会话
文件格式是 pi 自有的，两架构完全互通；回滚 = 切回 `pai-inprocess` 分支，
无数据动作。

## 7. 验收清单（收口时逐项打勾）

- [ ] 四门全绿（check / build / test / e2e+multi+compile-smoke），数字如实
      报告（断言数以运行器输出为准）；
- [ ] smoke/e2e/multi 全部断言语义等价（§1 变更清单 + #A1–#A4 之外零漂移）；
- [ ] 假绿对抗抽查：无迁移矩阵之外的删除断言、无装置适配记录之外的断言改弱；
- [ ] 行为对照清单逐项（对话隔离 / key 零泄漏 / 权限门 / fork/clone 重键
      先于转发 / 恰好一响应（含 worker 死亡补 failure）/ 优雅停机退出码）；
- [ ] worker 韧性：kill -9 单 worker → thread_died + 其他对话不受影响 +
      resume 恢复；retire→wake 透明；kill -9 host → worker 限时自灭；
- [ ] F-1/F-2 回归用例（teardown 后 fork 失败自退；fork/stop 并发不复活）；
- [ ] 泄漏审计：internal-id 集合、路由/占用表、retire 定时器、子进程
      close/exit 监听全部有界清理；
- [ ] 文档同步：../design.md v0.4 节、../api.md（含 fork 语义修正）、
      AGENTS.md、README、本文档状态推进「已核销」；
- [ ] 实测数字回填：host/worker RSS、spawn 延迟、满载对话数、e2e-multi
      新 RSS 阈值。

## 8. 实施记录

（每波收口追加：交付物、门禁数字、新增裁决补录、修复的真实缺陷、挂账。）
