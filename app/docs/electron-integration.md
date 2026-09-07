# Electron 集成：鉴权与配置目录（讨论稿）

> 状态：草稿（裁决已定，协议 v0.2 草案待实施；本轮不改代码）
> 关联：`docs/design.md`（hub 协议 v0.1）

## 裁决（2026-09-07，用户确认）

| #   | 决策         | 内容                                                                                                                   |
| --- | ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| D1  | **用户裁决** | 登录能力 v1 直接做全：API key + OAuth，统一走 `auth/login` 命令                                                        |
| D2  | **用户裁决** | `agentDir` 指向 Electron `app.getPath("userData")/agent`，彻底脱离 `~/.pi`                                             |
| D3  | **用户裁决** | 严格隔离：spawn hub 时清洗全部 provider key 环境变量，凭据只认 app 内登录                                              |
| D4  | 默认裁决     | key 只存 hub 侧 auth.json（pi 管 schema/加密权限/token 刷新），Electron 不留副本、不写该文件                           |
| D5  | 默认裁决     | 遥测与外联关闭：`enableInstallTelemetry: false` + `PI_SKIP_VERSION_CHECK=1`（不用 `PI_OFFLINE`，保留模型目录刷新能力） |
| D6  | 默认裁决     | `settings.json` 单一写入者 = Electron；hub 只读（改设置 → 写文件 → 重启 hub 生效）                                     |

## 事实基础（已核实，带出处）

1. **目录整体搬迁零改动**：`PI_CODING_AGENT_DIR` 环境变量覆盖 `getAgentDir()`（`packages/coding-agent/src/config.ts:508,528`），auth.json、models.json、models-store.json、settings.json、sessions/、extensions/、skills/、themes/、trust.json 全部跟走。hub 现有代码里的 `getAgentDir()` 调用同样受控。
2. **key 传递**：`ModelRuntime.setRuntimeApiKey(provider, key)`（`core/model-runtime.ts:536`）= 运行时生效 + 同步落盘 auth.json（`0600` + proper-lockfile，`core/auth-storage.ts`）。Electron 全程不接触 auth.json 内部格式。
3. **OAuth 无 TUI 可行**：`ModelRuntime.login(providerId, "api_key"|"oauth", AuthInteraction)`（`model-runtime.ts:681`）。`AuthInteraction = { prompt(AuthPrompt): Promise<string>, notify(AuthEvent): void }`（`packages/ai/src/auth/types.ts:156`）——回调式交互，天然映射到 hub 现有 `ui_request`/`ui_response` 对话框协议。
4. **凭据枚举**：`ModelRuntime.listCredentials()` 返回各 provider 登录状态（不含 key），设置页数据源。
5. **ambient 来源不止 env**：api-key 型 provider 还会读 AWS profile、ADC 文件等（`packages/ai/src/auth/types.ts:167` 注释）。env 清洗挡不住文件型 ambient（见未决 U2）。
6. **清洗清单权威来源**：`packages/ai/src/env-api-keys.ts`（根仓库 `pi-test.sh` 内有完整变量名清单可对照）。

## 目标形态

### 目录布局（D2）

```
<UserData>/                          ← Electron app.getPath("userData")
├── agent/                           ← PI_CODING_AGENT_DIR
│   ├── auth.json                    0600+lockfile，pi 管理（D4 单一写入者=hub）
│   ├── models.json / models-store.json
│   ├── settings.json                D6 单一写入者=Electron
│   ├── sessions/<cwd-hash>/*.jsonl  会话文件（app 负责清理/备份策略）
│   ├── extensions/ skills/ themes/  全局资源（app 首装写入、版本管理）
│   └── trust.json
└── …（Electron 自身文件）
```

### Electron spawn hub（D2/D3/D5）

```js
spawn(piHubBin, [], {
  cwd: <项目目录>,
  env: {
    ...scrubProviderKeyEnv(process.env),   // D3：按 env-api-keys.ts 清单清洗
    PI_CODING_AGENT_DIR: path.join(app.getPath("userData"), "agent"),
    PI_SKIP_VERSION_CHECK: "1",
  },
});
```

首装时 Electron 预写 `settings.json`：`{ "enableInstallTelemetry": false }`。（按 D7：本节的 env 注入、清洗、文件预写均由外部 Electron 项目执行；pai-cli 只定义上述约定。）

### 登录流（D1，经 hub 协议，Electron 只做 UI）

```
Electron 设置页 ──auth/login{provider,type}──▶ hub
hub: ModelRuntime.login(provider, type, 桥接 AuthInteraction)
  notify(AuthEvent)  ──ui_request{method:"auth_notify", url?}──▶ Electron（提示/开浏览器）
  prompt(AuthPrompt) ──ui_request{method:"auth_prompt"}──▶ Electron 输入框（授权码/key）
                       ◀─ui_response{value}──
完成/失败 ◀──response{success|error}──── hub（写 auth.json，刷新模型目录）
```

## 协议 v0.2 草案（本轮不实现）

| 命令          | 字段                                                              | 语义                                                                                                             |
| ------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `auth/list`   | 无                                                                | → `credentials: [{provider, type, status}]`（listCredentials，无 key）                                           |
| `auth/login`  | `provider`, `type: "api_key"\|"oauth"`, `apiKey?`（api_key 必带） | 长时操作：完成/失败时恰好一个 response；进度经 `auth_notify`；用户取消经 `ui_response{cancelled}` → abort signal |
| `auth/logout` | `provider`                                                        | ModelRuntime.logout                                                                                              |

新增 `ui_request.method`：`auth_prompt`（需回 value）、`auth_notify`（fire-and-forget）。对话框 settle 语义复用 v0.1 第 3 条。

实现时需对齐的依赖点：`AuthPrompt` 的变体集合（URL/文本/选择）、`AuthEvent` 的字段——以 `packages/ai/src/auth/types.ts` 为准。

## 未决问题（U 系列，逐项给归属）

| #   | 问题                                                                                   | 归属/建议                                                             |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| U1  | OAuth 浏览器交互形态：pi 的 OAuth 是 loopback 回调还是授权码粘贴，逐 provider 实测     | 实施前 spike：`auth/login(oauth)` 对 anthropic/openai/google 各跑一次 |
| U2  | 文件型 ambient（`~/.aws`、ADC）在 D3 下仍可用，严格隔离是否要扩展到文件源              | 待用户后续裁决；v1 建议接受（AWS/GCP 类 provider 天然如此），文档声明 |
| U3  | 多 hub 分片共享同一 agentDir：auth.json 有 lockfile 安全；models-store.json 双写未核实 | 分片方案启动前 spike                                                  |
| U4  | 内置扩展随 app 分发（放 agentDir/extensions + 版本管理）                               | 后续任务，Electron 首装逻辑                                           |
| U5  | 会话目录清理/备份/迁移 UI                                                              | Electron 后续任务                                                     |
| U6  | bun compile：wasm/主题资源外置 + electron-builder `extraResources` 目录布局            | 打包阶段（已知遗留）                                                  |
| U7  | pi 依赖升级时 auth/session schema 兼容回归                                             | 锁 `file:` 本地版；升级时补 auth 登录 + thread/resume 回归用例        |
| U8  | Windows：userData 路径、auth.json 权限（0600 在 NTFS 语义不同）                        | 打包阶段处理                                                          |
| U9  | 环境清洗清单随上游 env-api-keys.ts 演进的同步维护                                      | 写入 AGENTS.md 维护点                                                 |
| U10 | 二次开发分支与上游 pi 的长期同步策略（rebase 节奏、改动最小面）                        | 建议改动集中在 fork 分支 + 定期同步；目前 hub 依赖 SDK 无需改 pi 源   |

## 顺带记录：hub 现有 spawn 的 cwd 语义

`thread/start` 的 `cwd` 决定项目上下文（AGENTS.md、项目级 `.pi`、bash 工作区）；项目级资源属项目不属于 app（与 D2 的用户级目录独立），`trusted` 门已在 v0.1 生效。
