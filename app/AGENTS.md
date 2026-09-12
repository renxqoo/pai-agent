# pai-cli 开发规则

- 本目录是完全独立的项目：自己的工具链、锁文件、门禁。不读取、不依赖上层 `/Users/wrr/work/pi` 仓库的任何配置（biome/tsconfig/脚本）。
- 如果你需要了解项目代码逻辑，阅读代码是唯一标准，文档只是左证。

## 项目是什么

pai-cli 是 pi coding agent 的多会话宿主 CLI：**host 进程 + 每个活跃对话一个 worker 子进程**

## 工具链（全部最新，锁死精确版本）

| 用途                 | 工具              | 说明                                                                                                     |
| -------------------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| 运行时 / 测试 / 打包 | bun               | `bun test` 跑单测；`bun build --target=bun` 打包 CLI                                                     |
| lint                 | oxlint            | `.oxlintrc.json` 严格规则集（规模上限/类型严格/结构统一），0 警告 0 错误才算过；规模类限制对测试文件豁免 |
| 格式化               | oxfmt             | `.oxfmtrc.json` 全默认；`oxfmt .` 写入，`--check` 校验                                                   |
| 类型                 | TypeScript（tsc） | `tsconfig.json` 自足，strict + noUncheckedIndexedAccess + verbatimModuleSyntax + erasableSyntaxOnly      |

依赖：`@earendil-works/pi-coding-agent` 用 `file:../packages/coding-agent`（本地开发对源构建）；要切 npm 发布版就改成精确版本号并重装。devDependencies 全部精确版本；安装用 `bun install --exact --ignore-scripts`。

## 命令

```bash
bun install --exact --ignore-scripts   # 安装
npm run check                          # oxlint + oxfmt --check + tsc --noEmit
npm run fmt                            # oxfmt 写入
npm run build                          # bun build → dist/cli.js
npm run test                           # bun test（单元）+ test/smoke.mjs（契约级，真实 spawn host）
npm run ci                             # check + build + test 全门
npm start                              # 直接跑 host（stdio JSONL）
```

改动代码后必须 `npm run ci` 全绿才算完。真实 LLM 的 E2E 是独立 opt-in 门：`npm run e2e`（全接口旅程 + worker 韧性：kill/retire/orphan）、`npm run e2e:multi`（bun 打包产物上的 4 线程并发：数据不串/设置隔离/杀一 worker 其他存活/进程树 RSS）、`npm run e2e:compile`（`bun build --compile` 单文件形态冒烟），都需要 app/.env 提供 GLM_BASE_URL/GLM_API_KEY/GLM_MODEL；key 只经 env 注入，严禁打印/落盘/出现在断言输出。

## 代码纪律

- TypeScript：严格模式全覆盖；`.ts` 后缀导入；只用可擦除语法（bun 直接跑 TS，无构建转译层）；无 `any`（确需类型逃生用 `as never` 并注释原因）。
- 纯函数优先：`rules.ts`、`jsonl.ts` 保持无副作用、可表驱动测试；新增判定逻辑先进这两个模块再被引用。
- 错误 message 用英文中性语言。
- 迭代中会 delete 的 Map，遍历用 `Array.from(...)` 快照（oxlint 的 no-useless-spread 会误报 spread 写法）。
-

## 不能做哪些事

- 不能写 TODO：必须把当前任务完成到所有测试通过、无已知异常问题，交付一个生产可用的版本才算结束
- 不写兼容代码：不兼容老代码、不留旧路径别名或双轨字段，同一事实只需要一套接口实现，发现旧实现立即删除
- UI 使用同一套风格的组件：基于现有 shadcn 组件开发；后面会多次使用的 UI 必须封装成通用组件，避免重复开发
- 不能留有安全问题和内存泄漏问题：出现必须修复，不允许「先记着以后修」
- bug 修复不做最小修补：不能只基于现在的实现考虑修复方案，要为以后的项目扩展考虑，用可持续、可扩展的方案根治当前 bug
- 不写版本叙事：代码、注释、UI 文案里禁止出现「v1/v2 改了什么」「某版本修复了 XX」之类的内容；版本变更历史只属于 CHANGELOG/log 文档
- 对外文档只描述当前行为：README、用户文档等不写 v1/v2 版本相关问题与新旧对比；版本差异只出现在 CHANGELOG/发布说明
- 不允许假绿：禁止为过门禁加 skip、注释或删除断言、调低覆盖率阈值
- 禁止 `git stash` / `git reset --hard` 等一切销毁性 git 操作

## 提交与交付规范

- 只能提交自己改动的代码：只提交自己点名的文件路径；共享产物混有他人未提交变更时不提交，留待协调；他人在途的门禁失败如实标注归属，不越界代修
- 并行开发使用 git worktree 物理隔离，不共享工作区
- 没有 push 指令：只允许 commit，禁止任何 push / publish 操作
- 方案与代码同变：实现推翻方案时，同一提交内先改文档再改代码，禁止口头漂移
