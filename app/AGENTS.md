# pai-cli 开发规则

本目录是完全独立的项目：自己的工具链、锁文件、门禁。不读取、不依赖上层 `/Users/wrr/work/pi` 仓库的任何配置（biome/tsconfig/脚本）。

## 项目是什么

pai-cli 是 pi coding agent 的多会话宿主 CLI：**host 进程 + 每个活跃对话一个 worker 子进程**（v0.4 架构，见 `docs/migration/`），stdin/stdout JSONL 协议，供 Electron 等富客户端渲染。**本项目边界 = 仅为外部 Electron 项目提供接口**（协议 + CLI 产物 + 文档）；Electron 端代码一律不进本仓库。线协议规格的唯一真相是 `docs/design.md`，worker 架构规格是 `docs/migration/design.md`，Electron 对接约定见 `docs/electron-integration.md`，对外接口文档是 `docs/api.md`（新增命令必须同步它）；改协议先改文档再改代码，同一提交落档。

## 工具链（全部最新，锁死精确版本）

| 用途                 | 工具              | 说明                                                                                                |
| -------------------- | ----------------- | --------------------------------------------------------------------------------------------------- |
| 运行时 / 测试 / 打包 | bun               | `bun test` 跑单测；`bun build --target=bun` 打包 CLI                                                |
| lint                 | oxlint            | 零基线配置：默认 correctness 规则集，0 警告 0 错误才算过                                            |
| 格式化               | oxfmt             | `.oxfmtrc.json` 全默认；`oxfmt .` 写入，`--check` 校验                                              |
| 类型                 | TypeScript（tsc） | `tsconfig.json` 自足，strict + noUncheckedIndexedAccess + verbatimModuleSyntax + erasableSyntaxOnly |

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

改动代码后必须 `npm run ci` 全绿才算完。真实 LLM 的 E2E 是独立 opt-in 门：`npm run e2e`（全接口旅程 + worker 韧性：kill/retire/orphan）、`npm run e2e:multi`（bun 打包产物上的 4 线程并发：数据不串/设置隔离/杀一 worker 其他存活/进程树 RSS）、`npm run e2e:compile`（`bun build --compile` 单文件形态冒烟），都需要 app/.env 提供 GLM_BASE_URL/GLM_API_KEY/GLM_MODEL；key 只经 env 注入，严禁打印/落盘/出现在断言输出。协议命令增删改后：跑两个 e2e + 更新 `docs/api.md`。已知口径：自定义 provider 模型未声明 reasoning 时思考档被 pi 统一 clamp 为 off（models.json 加 `"reasoning": true` 可启用）。

## 代码纪律

- TypeScript：严格模式全覆盖；`.ts` 后缀导入；只用可擦除语法（bun 直接跑 TS，无构建转译层）；无 `any`（确需类型逃生用 `as never` 并注释原因）。
- 单一真相：协议类型只在 `src/protocol.ts`；权限判定顺序只在 `src/rules.ts` 的 `decide()`；stdout 写入语义只在 `src/stdout-guard.ts`；模型解析只在 host（`resolveModel`）；auth.json 写入只在 host；会话多重性只在 `src/worker-pool.ts` 的路由表。
- 纯函数优先：`rules.ts`、`jsonl.ts` 保持无副作用、可表驱动测试；新增判定逻辑先进这两个模块再被引用。
- 错误 message 用英文中性语言。
- 迭代中会 delete 的 Map，遍历用 `Array.from(...)` 快照（oxlint 的 no-useless-spread 会误报 spread 写法）。

## 契约要点（详见 docs/design.md「契约」节）

- 每个带 `id` 的命令恰好一个 `response`（prompt 在接受时刻经 preflight 发出；`ui_response` 恒 ack）。
- `event` 帧按 threadId 打标、全局有序不交错；`message_update` 剥离累积快照。
- 对话框 settle 恰好一次（response / 超时 / abort）；晚到忽略。
- stdout 是唯一协议通道：接管两层（`process.stdout.write` + `console.*`），协议帧走原始句柄串行写入；满管（ENOBUFS）重试，断连（EPIPE）走优雅退出。
- 会话文件同路径至多一个写者：host 的跨进程占用表，**spawning 即占位**（design/migration §5）。
- worker 终止一律以 stdout close（drain 完）为准做状态迁移与 pendingIds 对账；补 failure 只补未见响应的 id（恰好一响应闭环）。
- `thread_died` 恰好一次；retire/关闭期终止不发；fork/clone 表重键先于响应转发。
- 输入行 16 MiB 上限，超限整行丢弃 + parse failure。

## 安全模型

- 扩展即任意代码：线程默认 `trusted:false` 只加载内联权限门；`trusted:true` 才启用项目 `.pi` 扩展发现。
- 权限规则热读 `~/.pi/agent/permission-rules.json`（bash 命令串 / write·edit 原始 path），坏文件降级到 `{mode:"ask"}` 永不抛错。
- 直接 fd 写无法被接管拦截——不可信代码本就不应被加载。

## Git

- 遵循上层仓库的多会话并行纪律：只提交本目录内自己改动的文件；不 `git add -A`；不主动 commit。
- 提交信息引用 design.md 节号（如 `feat: xxx (design.md §契约)`）。
