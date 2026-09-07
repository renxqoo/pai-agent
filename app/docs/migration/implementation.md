# pai-cli worker 架构施工图（IMPLEMENTATION）

> 状态：定稿（对抗审查 20 项发现已全部处置，处置记录见 migration.md §2）
> 关联：[design.md](design.md)（架构基线）· [migration.md](migration.md)（行为规格与验收）
> 基线：`pai-inprocess` @ 07b294bf4（旧实现只读对照物）

## 1. 旧实现审计结论

审计证据 = 三轮实施期审查（v0.1 18 项 / v0.2 7 项 / v0.3 11 项，当时全部
处置）+ smoke/e2e/e2e-multi 测试（断言数以运行器实测为准，收口回填；当前
调用点：smoke 76、e2e 49、e2e-multi 24）+ 本迁移的独立对抗审查（2026-09-07）。

审查结论修正：**旧实现存在 2 个未发现真 bug**（原「无未处置真 bug」结论不实）：

- **F-1 fork/clone 在 teardown 后失败留僵尸**：`runtime.fork` 的
  `teardownCurrent`（dispose 当前会话）之后 `createRuntime` 抛错时，线程表仍
  持有已 dispose 的会话（agent-session-runtime.ts:322-330 路径；无测试覆盖）。
  迁移修复：`setBeforeSessionInvalidate` 钩子判定，teardown 后失败 → worker
  自退 → host 死亡流程（design §4）。
- **F-2 fork/clone 与 stop 无互斥**：v0.3 设计声称「fork/clone/stop 互斥」，
  实际只有 stop 走 `runExclusive`；fork/clone 期间并发 stop 可复活已停会话。
  迁移修复：worker 会话替换三操作统一串行（design §1）。

另：api.md「fork 失败 → 线程视为终止」与代码行为（线程保留，smoke 断言）
矛盾——文档错误，随迁移修正（用户裁决 U6）。

Worker 架构新引入的风险点（实现期重点验证）：

- R1 worker 自举三形态（design §7，已实测待代码化）；
- R2 retire/wake/death 状态机竞态（design §6 统一 close 语义）；
- R3 巨型响应行 vs 行上限与前缀分类（design §3）；
- R4 spawn 慢启动误判（design §8 预算）。

## 2. 逐模块裁决表

| 旧文件（行数）              | 裁决              | 审计状态                          | 动作                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ----------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| src/cli.ts (4)              | 重构              | 审计通过                          | 入口分流：无 flag → runHost；`--internal-worker` → runWorker                                                                                                                                                                                                                                                                                                                                              |
| src/hub.ts (797)            | 拆分              | 审计通过（F-1/F-2 见 threads 行） | thread 作用域 switch → worker.ts（fork 处理器增 teardown 判定与自退）；auth/\*、get_models、thread/list、thread/list_saved 处理器 + registerInflight + 关闭序 → 移入 host.ts（代码搬移，逐字保留红线注释）                                                                                                                                                                                                |
| src/threads.ts (358)        | 重构（减法+修复） | F-1、F-2 在此修复                 | ThreadManager → SessionHost：删跨线程 spawnQueue、spawningPaths 守卫（职责以跨进程占位形式移 host，design §5）、resolveModel（移 host）、多线程 stopAll 循环；**保留**会话替换三操作（fork/clone/stop）互斥串行（修复 F-2）、两段式工厂、rebind 闭包、toWireEvent、closed 竞态自清、单会话 start/resume/stop；**新增** beforeSessionInvalidate 判定（修复 F-1）、in-flight 命令计数与 idleMs（design §3） |
| src/protocol.ts (305)       | 复制+微修         | 审计通过                          | v0.3 对外类型不动（32 命令）；增 v0.4（ThreadDiedFrame、list state、hub_error 可选 threadId）；新增 host↔worker 内部类型分区（心跳载荷、内部 start/set_model 的 model 注入形状、SessionModel 移入）                                                                                                                                                                                                       |
| src/dialogs.ts (87)         | 复制+微修         | 审计通过                          | 增 `pendingCount()`（worker idle 判定），其余原样                                                                                                                                                                                                                                                                                                                                                         |
| src/ui-context.ts (126)     | 复制              | 审计通过                          | 原样（worker 侧）                                                                                                                                                                                                                                                                                                                                                                                         |
| src/permission-gate.ts (90) | 复制              | 审计通过                          | 原样（worker 侧）                                                                                                                                                                                                                                                                                                                                                                                         |
| src/rules.ts (104)          | 复制              | 审计通过                          | 原样                                                                                                                                                                                                                                                                                                                                                                                                      |
| src/jsonl.ts (64)           | 复制+微修         | 审计通过                          | `createJsonlSplitter` 增可选 `maxLineBytes`（默认仍 16MiB；worker→host 侧用 128MiB）                                                                                                                                                                                                                                                                                                                      |
| src/stdout-guard.ts (113)   | 复制              | 审计通过                          | 原样（host/worker 各自实例化）                                                                                                                                                                                                                                                                                                                                                                            |

新文件：

| 文件               | 职责（一个动词）                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| src/host.ts        | 对外协议面：stdin 循环、命令分发、本地命令（auth/models/list_saved/thread-list）、shutdown 编排            |
| src/worker-pool.ts | 进程管理：spawn/retire/wake/kill、sessionPath 占用表、路由表、健康扫描、帧前缀分类与透传、internal-id 集合 |
| src/worker.ts      | 单会话 worker：thread 作用域命令循环 + 心跳载荷 + fork 自退                                                |

裁决依据：六个复制文件三轮审查零缺陷且与进程模型无耦合；hub.ts/threads.ts
与多会话假设耦合，在新架构下按「零兼容层」（用户裁决 U4）做减法重构，但
并发防护（占位、互斥）以跨进程/单会话形态在 host/worker 重建，不是简单
删除（审查 #1、#4）。

## 3. 拆分与依赖方向

```
cli.ts ──► host.ts ──► worker-pool.ts ──► protocol.ts
              │              └──────────► jsonl.ts / stdout-guard.ts（帧层复用）
              └──► protocol.ts / stdout-guard.ts / jsonl.ts
worker.ts ──► session-host.ts（原 threads.ts）──► ui-context / permission-gate / rules / dialogs
```

- host 不得 import session-host/ui-context/permission-gate（不拉会话依赖链）；
- worker-pool 不得 import pi-coding-agent 运行时 API（只做进程与帧；类型除外）；
- protocol.ts 只放类型与常量（type-only import）。

## 4. 测试计划

| 层                                 | 内容                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单元（bun test）                   | rules/jsonl/stdout-guard 原样移植（jsonl 补 maxLineBytes 用例）；新增 worker-pool 纯逻辑：sessionPath 占用（含并发占位竞态）、fork/clone 表重键**先于**转发、internal-id 集合吸收、非 live 条目 1024 逐出、帧前缀分类（含巨型行不 parse body）与响应键序锁定                                                                                       |
| smoke（test/smoke.mjs）            | 对 host 进程黑盒，全部旧断言语义保持；auth 矩阵与 key 泄漏扫描打 host 不变；新增 state 字段断言                                                                                                                                                                                                                                                    |
| e2e（test/e2e.mjs）                | 真实 GLM 旅程保持；新增：kill -9 单 worker（in-flight 命令恰好一个补 failure）→ thread_died + 其余对话存活 + resume 恢复；fork 失败早期语义（线程仍可用）与 teardown 后自退（thread_died）；retire（短阈值）→ 观察类命令不阻止收编 → 命令自动唤醒；kill -9 host → 全部 worker 限时自灭（stdin 管道语义）；并发 thread/resume 同路径 → 恰好一个成功 |
| e2e-multi（test/e2e-multi.mjs）    | 4 并发对话隔离语义保持；RSS 改为进程树求和（阈值阶段 1b 实测定，登记为装置适配）；新增杀一 worker 其他存活                                                                                                                                                                                                                                         |
| 编译冒烟（test/compile-smoke.mjs） | `bun build --compile` 产物：--version、thread/start→prompt→get_state 全链、优雅停机退出码、worker 自举（编译形态 R1）                                                                                                                                                                                                                              |
| 三形态覆盖                         | dev（smoke/e2e：`bun src/cli.ts`）/ bundle（e2e-multi：`dist/cli.js`）/ compile（compile-smoke：bin）                                                                                                                                                                                                                                              |

装置说明：e2e 找 worker pid 用 `pgrep -P <hostPid>`（darwin 实测可用）。
门禁：`npm run check`（oxlint + oxfmt --check + tsc --noEmit）、`bun build`、
`npm run test`（bun test + smoke）、`npm run e2e`、`npm run e2e:multi`、编译
冒烟脚本。真上游（GLM）只进 e2e 门（沿既有约定）。

## 5. 实施顺序（每阶段四门 + 提交可回滚）

1. **阶段 1a（最小活物）**：protocol 增量 + jsonl 参数化 + cli 分流 +
   session-host.ts（threads 减法 + F-1/F-2 修复 + idleMs）+ worker.ts
   （原 hub 减法 + 心跳载荷 + fork 自退）。
   验收：`bun src/cli.ts --internal-worker` 以 worker 协议驱动单会话全绿，
   四门过。
2. **阶段 1b**：host.ts + worker-pool.ts。验收：`bun src/cli.ts`（host 形态）
   跑通 smoke 全量（语义等价），四门过；实测内存/延迟数字回填 migration.md。
3. **阶段 2**：e2e / e2e-multi 适配 + 新增 worker 旅程断言 + compile-smoke。
   验收：全部门绿。
4. **阶段 3**：文档同步（../design.md v0.4 节、../api.md 修正与增补、
   AGENTS.md、README）+ 实现对抗审查（对照 pai-inprocess 基线）+ 收口核销。

对抗审查批次：阶段 1（worker 减法 diff，验证未删行为与 F-1/F-2 修复）、
阶段 1b+2（host 新写 + 状态机，验证对外行为等价 + 无泄漏）、文档定稿前
（已完成 2026-09-07，处置见 migration.md §2）。
