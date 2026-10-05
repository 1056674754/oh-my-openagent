# OpenCode 2.x 支持路线调研（OMO fork）

- 调研日期：2026-10-04
- 调研对象：本 fork（`1056674754/oh-my-openagent`，`5.0.0-beta.21-sscity`，分支 `codex/session-single-flight`，已含 v2 宿主适配层 `83777cde5`）
- 问题：OMO 对 OpenCode 2.x（fork 基线 `v2.0.21-sscity`，上游 tag `v2.0.21`/`v2.0.22`）的正确长期支持路线
- 方法：本地 git 考古（`sst/opencode` upstream dev / 2.0 分支 / v2.0.21 / v2.0.22 tag；`code-yeongyu/oh-my-openagent` dev / v5.1.16 tag）+ GitHub issues/PR/releases + 官方文档站。全文来源带链接或 commit 引用。

---

## 结论速览（TL;DR）

1. **OpenCode 上游没有、也不打算提供 V1 插件兼容层。** 官方迁移指南明文：*"Port plugins, because V1 plugin implementations do not run in V2."*（[opencode.ai/v2/docs/migrate-v1](https://opencode.ai/v2/docs/migrate-v1)）。`{id, server}` 导出在 2.x 加载器直接报 `LoadError`。
2. **上游 OMO（截至 v5.1.16，2026-10-04）仍然只有 V1 契约的 OpenCode 插件**（`@opencode-ai/plugin` 1.18.31，入口 `{id, server}`），它的 OpenCode 支持面 = opencode **1.18.x 稳定线**。上游对 OpenCode v2 的官方口径（5.0.0 changelog）：*"We know about OpenCode v2. Our answer to it is coming, and it takes time. Until then, please run OmO Native."*
3. **上游的方向已经明确但没有日程**：2026-10-01 维护者在 [#6169](https://github.com/code-yeongyu/oh-my-openagent/issues/6169) 拍板「additive dual-host」——在 `packages/omo-opencode/src/v2/` 增加 V2 setup 入口、单入口导出 `{ id, setup, server }`、V1 行为不动，分片合入；slice 1 即 [PR #9391](https://github.com/code-yeongyu/oh-my-openagent/pull/9391)（OPEN，未合）。另有 #9094 / #8626 / #8297 / #9016 四个 V2 PR 均 OPEN。
4. **本 fork 的 `v2-host-adapter.ts`（83777cde5）与社区做法同构**：[#9389](https://github.com/code-yeongyu/oh-my-openagent/issues/9389) 里 herjarsa 的 v2-bridge（生产跑在 OpenCode **2.0.22** 上）就是同一思路——V2 `setup(ctx)` 翻译成 V1 形状、委托 V1 server 实现，且同样报告 `command.execute.before` 等 2 个 GAP。
5. **推荐**：短期走 (a) 补齐现有适配层缺口（约 1-2 周）；中期盯 #9391/#9389，上游 dual-host 可用后切 (b')（rebase 上游双导出、fork 只留 sscity 定制层）；(b) 换 OmO Native 二进制架构对本产品语境（OpenChamber → fork opencode → 插件）**不成立**，不建议。

---

## 1. 上游 OpenCode 2.x 的官方插件兼容机制（调研问题 1）

### 1.1 版本拓扑（重要前提）

sst/opencode 是**双线并行**，不是 1.x→2.x 单线演进：

| 线 | 载体 | 版本 | npm SDK |
| --- | --- | --- | --- |
| 稳定线 | `dev` 分支（GitHub default branch） | 根 package.json `1.18.34`，最新 release [v1.18.34](https://github.com/sst/opencode/releases)（2026-09-30） | `@opencode-ai/plugin` latest = **1.18.34**；`@opencode-ai/sdk` 同轨 |
| 2.x 线 | tag `v2.0.x`（本地检得 `v2.0.21` 2026-09-30、`v2.0.22` 2026-10-02）+ 早已存在的 [`2.0` 分支](https://github.com/sst/opencode/tree/2.0)（HEAD `7a6ce05d09` "2.0 exploration"，2026-04） | `2.0.21` / `2.0.22` | **`@opencode/plugin`** latest = **2.0.22**、`@opencode/client` 2.0.22（npm 实查，2026-10-04） |

- 2.x 的 SDK 包**改名**为 `@opencode/plugin`（去掉 `-ai`），与 fork 内 `packages/plugin/package.json`（name `@opencode/plugin`, version `2.0.21`）一致。
- v2.0.21 → v2.0.22 之间插件面只有小改（`packages/core/src/plugin/host.ts` 13 行、`packages/plugin/src/promise/adapter.ts` +2，`git diff v2.0.21 v2.0.22 --stat`），无新增兼容层；`v2.1+` 无任何 tag。

### 1.2 加载契约（v2.0.21，即 fork 基线）

`packages/core/src/plugin/module.ts`（v2.0.21:50-66）的 Module Schema 只接受两种 default 导出：

```
{ id: string, effect: Function }  // Effect 风格
{ id: string, setup: Function }   // Promise 风格
```

否则：`LoadError: Plugin must export a default definition with an id and an effect or setup function.`（#8485 实测贴出同样错误）。注意 loader 里那句注释 *"Legacy auto-discovery still admits standalone server sources"* 指的是**入口文件解析**（`Host.Entrypoints.server` = 插件的 JS 入口文件），不是 V1 的导出形状——V1 插件的入口文件照样会被找到，但其中的 `{id, server}` 导出过不了上面的 Schema。

`setup(ctx)` 收到的 PromiseContext（`packages/plugin/src/promise/adapter.ts`）按命名空间暴露宿主能力：`agent / command / event / mcp / permission / plugin / reference / rpc / skill / storage / tool / integration / ...`。其中"client 等价物"是各命名空间下经 `adaptApiMethod(...Endpoints[...])` 适配的宿主 API 方法，**没有** V1 的 `client / directory / serverUrl / $`。

### 1.3 官方兼容结论

官方迁移指南 [Migrate from V1](https://opencode.ai/v2/docs/migrate-v1)：

> V2 has three intentional breaking changes: **Plugins use a new plugin API.** The server API and clients have new contracts. Terminal client configuration moves ... to one global cli.json file (auto migrated).
>
> ... Port plugins, **because V1 plugin implementations do not run in V2**.

即：**配置/agents/commands/skills 等文件级 V1 形态大多保持兼容（官方称之为 compatibility bug 可报 issue），唯独插件 API 无兼容层，必须移植。** 现实中第三方（fazulfi、herjarsa，见 §2.3）已经用两种不同架构证明了移植可行。

---

## 2. 上游 OMO 对 OpenCode 2.x 的支持声明（调研问题 2）

### 2.1 产品转向：OmO Native 为主，OpenCode 插件降级

[README](https://github.com/code-yeongyu/oh-my-openagent#readme) 与 [5.0.0 release notes](https://github.com/code-yeongyu/oh-my-openagent/releases/tag/v5.0.0)（2026-09-26，标题即 *"PLEASE REMOVE OPENCODE V1 FOR OMO, LAZYCODEX, IMMEDIATELY."*）：

> Strictly speaking you don't have to remove anything. The OmO plugin for OpenCode v1 and LazyCodex keep running, but from here on they get **degraded support**: new features land in OmO Native first, and some never reach the plugins because the hosts cannot carry them.

- **OmO Native** = 独立 `omo` 命令（npm 包 `omo-ai`），跑在 **senpi**（上游对 [badlogic/pi-mono](https://github.com/badlogic/pi-mono) 的 fork）引擎上；不是 OpenCode 插件，**不依赖任何 OpenCode 版本**。
- 安装器 `bin/oh-my-opencode.js`（v5.1.16）确实如背景所述是**平台二进制 launcher**：按 OS/arch/libc（glibc/musl）/AVX2 从 12 个 `packages/oh-my-opencode-<platform>` 包里选 Bun 编译的单文件二进制 spawn。但这服务于 OmO Native CLI，**不是**新的插件分发形态。
- 5.1.x 仍然自带 OpenCode 插件版：`packages/omo-opencode`（自述 *"OpenCode harness adapter (Ultimate edition plugin)"*），依赖 `@opencode-ai/plugin` **1.18.31** + `@opencode-ai/sdk` 1.18.31，入口 `packages/omo-opencode/src/index.ts`：`export const omoPlugin = pluginModule.server`，包内 AGENTS.md 明确 *"default-exports `pluginModule: PluginModule` with `{ id, server }`"*。**即上游 OMO 至今未迁移 2.x 契约。**

### 2.2 对 OpenCode v2 的正式声明

[v5.0.0 CHANGELOG](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/CHANGELOG.md)（v5.1.16 中同段保留）：

> ### OpenCode v2
> We know about OpenCode v2. Our answer to it is coming, and it takes time. Until then, please run OmO Native: it is the version we use every day, and the one this release was built with.

（注意语境：这句写于 2026-09-26，早于下述 dual-host 决策——当时 "our answer" 更可能指 OmO Native 本身；10 月之后证据显示答案收敛为 dual-host 插件，见下。）

[ROADMAP.md](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/ROADMAP.md)（dev）专节 **"Why Not OpenCode-Native"**：OpenCode 被明确定位为 *"one adapter target among several. Not the center of the architecture"*，理由：`session.prompt` 未持久化即返回+`session.error` 后多个钩子重复注入、TUI 烧 CPU、破坏性变更频繁。架构分层 Core(19 个纯 TS 包) → MCP → **Adapters（OpenCode、Codex、Senpi、standalone Pi）** → 平台 launcher。

### 2.3 V2 迁移的 issue/PR 时间线（路线 c 的全部证据）

| 日期 | 事件 | 状态 |
| --- | --- | --- |
| 2026-07-17 | [#6169](https://github.com/code-yeongyu/oh-my-openagent/issues/6169) "OpenCode V2 plugin API migration: timeline and plan?" | OPEN |
| 2026-09-19 | [#8485](https://github.com/code-yeongyu/oh-my-openagent/issues/8485) 完整根因分析（V1 形状 → LoadError；TUI 侧 "Invalid V2 TUI plugin module"；附官方迁移指南链接） | OPEN（重复 #8490 closed） |
| 2026-09~10 | 用户报障：[#7847](https://github.com/code-yeongyu/oh-my-openagent/issues/7847)、[#8295](https://github.com/code-yeongyu/oh-my-openagent/issues/8295)、[#9107](https://github.com/code-yeongyu/oh-my-openagent/issues/9107)、[#9241](https://github.com/code-yeongyu/oh-my-openagent/issues/9241)、[#9530](https://github.com/code-yeongyu/oh-my-openagent/issues/9530) | OPEN |
| 2026-10-01 | [#9389](https://github.com/code-yeongyu/oh-my-openagent/issues/9389) **fazulfi 的生产级 V2 原生移植**：fork [fazulfi/omo-v2](https://github.com/fazulfi/omo-v2)（branch `port/v2`，base v5.1.4，exact pins `@opencode/plugin` + `@opencode/client` 2.0.20）。347 个文件全量 API 盘点（`docs/v2-api-mapping.md`，137 行映射 + **17 行 GAP**）；25 行 runtime parity matrix（19 PASS + 5 PASS*）；生产 cutover 16 agents / 118 tools | OPEN |
| 2026-10-01 | **维护者 code-yeongyu 拍板**：采纳 **additive dual-host**（`packages/omo-opencode/src/v2/` + 单入口 `{ id, setup, server }` 双导出、V1 不动、parity matrix 变成 CI 测试、按子系统分片合入）；同日在 #6169 更新：*"there's no firm date yet"*，并开出行 1 [PR #9391](https://github.com/code-yeongyu/oh-my-openagent/pull/9391)（scaffold，OPEN 未合） | 进行中 |
| 2026-10-03 | [#9389](https://github.com/code-yeongyu/oh-my-openagent/issues/9389) 中 herjarsa 报告**另一条 V2 桥路线**：branch `contrib/v2-bridge-9389`（base v5.0.0-beta.90），`const dualPluginModule = { ...pluginModule, ...omoV2Plugin }`，V2 `setup(ctx)` 把 hooks/tools/MCP/agents 翻译成 V1 形状后**委托现有 V1 server 实现**；生产跑在 OpenCode **2.0.22**；`V2-HOOK-MAP.md`：9 DIRECT / 4 ADAPT / **2 GAP**（GAP 含 `command.execute.before`，V2 无对应钩子） | OPEN |
| — | 其余 V2 PR：[#9094](https://github.com/code-yeongyu/oh-my-openagent/pull/9094)、[#8626](https://github.com/code-yeongyu/oh-my-openagent/pull/8626)、[#8297](https://github.com/code-yeongyu/oh-my-openagent/pull/8297)、[#9016](https://github.com/code-yeongyu/oh-my-openagent/pull/9016) | 均 OPEN |

dev 分支 `packages/omo-opencode/src/v2` 至今（2026-10-04）不存在——**没有任何 V2 代码合入主线**。

---

## 3. 用户依赖面的差距（调研问题 3）

用户依赖的 agents：**Sisyphus(-ultraworker)/Prometheus/Atlas/Metis/Momus** 等（fork 实测 18 个 agents 经适配层注册成功）。

### 3.1 三种形态对照

| | **5.0.0-beta.21 插件版 + fork 适配层**（现状） | **5.1.16 插件版**（上游最新） | **5.1.x OmO Native 二进制** |
| --- | --- | --- | --- |
| OpenCode 契约 | V2 host（2.0.21-sscity）经 `v2-host-adapter.ts` 投影 | **V1 only**（`@opencode-ai/plugin` 1.18.31）→ **装不上 2.0.21-sscity** | 不适用（自带 senpi 引擎，与 OpenCode 无关） |
| 用户 agents | 全套注册（sisyphus / prometheus / atlas / metis / momus / hephaestus / oracle / librarian / explore / sisyphus-junior ...） | 同一套都在（`packages/omo-opencode/src/agents/`：sisyphus、sisyphus-junior、prometheus/、atlas/、metis、momus、hephaestus/、oracle、librarian、explore、multimodal-looker 等）+ 5.1.x 两周数十个修复 | **名册换血**：OpenCode 版 agents 不在 Native 内置（Native 的 agents 是 explore / librarian / plan-consultant / plan-reviewer / omo-native-* reviewers，见 [migrating-from-opencode.md](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/guide/migrating-from-opencode.md)；用户 agents 的能力部分由 `mass ulw` DAG + categories 承接，**不是同名 agent**） |
| 需要的 OpenCode 版本 | 2.0.21-sscity（现状可用） | 1.18.x（上游插件版的真实目标） | 无 |
| 在 OpenChamber 中可见/可编排 | 是（作为插件注入 fork opencode） | 不适用 | **否**（独立 CLI 会话，OpenChamber 的 opencode UI 看不到） |

### 3.2 现有适配层的已知缺口（来自 `83777cde5` + `packages/omo-opencode/src/shared/v2-host-adapter.ts`）

- **显式跳过的钩子**（v2-host-adapter.ts，跳过时经 `log` 报告而非静默）：`command.execute.before`（斜杠命令拦截）、`experimental.chat.messages.transform`、`tool.definition`、`experimental.compaction.autocontinue`、`auth`、`provider`。
- **事件流桥接不全**：v2 event 以 V1 properties 形状桥接，缺 `message.updated` / `message.removed` / `session.error` 映射 → 依赖这些事件刷新的 UI/状态特性不工作。（**2026-10-05 已修** `060fdb991`：实测 v2 事件为 `{id,type,created,data}` 信封且**完全删除**了消息实体事件——现已解包 `data` 为 properties、由 `session.step.started/ended` 合成 `message.updated`、`session.execution.failed` 映射为 `session.error`；`message.removed` 在 v2 无任何事件源，结构性不可合成。）
- **`permission.ask` 走 stub** → 权限询问交互降级。（**2026-10-05 已处置**：v2 `Tool.Context` 仅 `{sessionID,agent,messageID,id,progress}`，工具无法发起权限请求，`permission.reply` 只能应答宿主创建的请求——工具级 ask 在翻译式路线**结构性无解**。原静默放行 stub 已移除：monitor_start 落回 allowlist fail-closed，skill 显式跳过提示并记日志、由宿主权限规则接管。运行时 QA 由子代理验证中。）
- **`chat.message` 无 v2 同名钩子** → variant 门/首消息模型覆盖/十几个注入器失效。（**2026-10-05 评估后已桥接**：v2 `session.hook("prompt")` 的 `prompt` 字段是 DeepMutable，且**斜杠命令渲染结果也汇入同一点**（v2 内建/MCP/config 命令的 execute 都调 `ctx.session.prompt`）——已实现桥接：prompt.text 投影为 legacy parts（纯文本投影）、agent/model 经 `session.get` best-effort 解析（`SessionPrompt` 不携带 agent）、首消息模型覆盖经 `session.switchModel` 落为会话级选择（v2 无单消息模型覆盖）。已知降级：OMO 自身的续跑/自动提示在 v2 上无 synthetic 标记，会过 chat.message 处理器（关键词检测可能对续跑文本重复触发）；handler 注入的非文本 parts 无 v2 prompt 落点，丢弃并记日志。）
- **`command.execute.before` 无 v2 拦截点**（**2026-10-05 评估确认**）：v2 `command.transform` editor 是 **add-only**（`Map.set` by name，且 `Command.get` 只返回 Info 不含 execute，无法包装既有定义），命令执行路径不触发任何 pre-execute 事件；命令名在 `session.hook("prompt")` 时点已丢失，无法从渲染文本可靠重建。**移植路径存在但未实施**：仿照宿主自己的 config 命令加载器（`config/plugin/command.ts`：agent/model 切换 + `ctx.session.prompt`），OMO 用 `command.transform(add)` **自行注册** `goal` / `stop-continuation` / `ulw-execute` 三个命令，把 before 逻辑内联进自有 execute——对该三命令保真，对第三方命令仍无通用拦截。列入后续工作项。）
- 对照参考：herjarsa 桥的 9 DIRECT / 4 ADAPT / 2 GAP 与 fazulfi 全量映射的 17 GAP（`docs/v2-api-mapping.md`）说明部分缺口是 **V2 宿主本身没有对应能力**（如 `command.execute.before`），不是适配层偷懒——这类缺口在"翻译式"路线里无解，只有 V2 原生重写或宿主补钩子能解决。

#### 3.2.1 运行时 QA 记录（2026-10-05，事件桥 + ask stub 移除）

被测 `b23dac4c5`（含 `060fdb991`），真实 fork v2 宿主（sscity-v2 源码直跑）+ 真实模型驱动，证据 `/tmp/omo-v2-qa/qa-evidence/`（00-summary.md + 每场景原始 SSE/日志）：

| 场景 | 结果 | 要点 |
| --- | --- | --- |
| S1 Boot | PASS | plugin input projection / config hook applied {agents:18} / tools registered {count:13} 全齐 |
| S2 Streaming | PASS | 单轮恰 1×step.started+1×step.ended，wire 字段与桥接输入精确匹配；event handler failed=0 |
| S3 session.error | PASS | wire `error.type:"provider.no-route"` → OMO 收到 `error.name` 同值；单订阅无重复派发 |
| S4 Restart | PASS | 两次重启后 step 1:1 配对，无残留双订阅 |
| S4' ask stub | PASS（三轮） | 一轮配置放错层（monitor 须放 `.omo/omo.jsonc` 的 `[opencode]` 节）→ 二轮挖出工具全丢 bug（下）→ 三轮 17/17 工具落进宿主目录 + monitor_start 非白名单命令 fail-closed（error 状态、无 monitor 创建、无子进程） |

S4' 过程中挖出并修复的 **两个真 bug**（子代理发现 + 主线复核）：

- **v2 工具全量静默丢弃**（修复 `9ce671cf4`）：`normalizeToolArgSchemas` 给每个 arg 字段装的 v1 兼容 shim（`_zod.toJSONSchema`）使 v2 宿主 standard-interface 转换崩溃（flattenRef `seen.ref` TypeError），宿主只留 server-log ERROR、插件无感知——OMO 侧 "tools registered" 计数是自说自话。修法：v2 桥剥 shim + 本地 zod 转**纯 JSON Schema** 传入（宿主 `inputJsonSchema` verbatim 分支），宿主 zod 出局；转换失败降级为未校验 schema + 日志，不丢工具。**教训：v2 侧工具注册必须做宿主侧接受度验证（宿主日志 + 模型目录），插件侧计数无效。**
- **v2 工具结果被 die 打死**（修复 `c988d0ab3`）：`bridgeToolResult` 恒返回 `{output}`，而 v2 对无 output schema 的工具把 `output` 键视为 defect（`Effect.die("Tool result declared output without an output schema")`）——连应成功的调用（monitor_list）也 error，拒绝文本也无法存活。修法：结果折入 `content`（字符串或 Content parts）；execute.after 回写同步改为仅 patch 实际改动字段、不写 output 键、无改动保持原引用（该 hook 覆盖宿主全部工具，原实现对外来带 schema 工具是破坏性改写）。

QA 顺带发现的新缺口（非本次 commits 引入，列此为 backlog）：

- **O1 seed 鉴权单点** ✅ 已修（`c47d79eb7`，2026-10-05）：`buildConfigSeed` 只认 OpenChamber managed-auth 文件；裸 v2 宿主带密码时 `GET /api/config` 401 → seed 为空（boot 日志有记录，不静默）。OMO 自身 client 走 `OPENCODE_SERVER_PASSWORD` env 不受影响——**非 OpenChamber v2 部署会丢宿主侧 config 合并**。修法：seed fetch 回退到 client 同款 env Basic header（`getServerBasicAuthHeader`）。
- **O2 idle 事件缺失** ✅ 已修（`7b5e5d26e`，2026-10-05）：v2 无 `session.idle` 事件，`execution.succeeded/failed` 原样透传——v1 侧 idle 挂钩（`dispatchIdleOnlyHooks`/monitor 空闲触发）在 v2 不触发。修法：以 v2 宿主自身语义为准（`message-updater.ts` 把 succeeded/failed/非 shutdown interrupted 当 idle 边界），桥接为 succeeded/failed/interrupted(非 shutdown) 追加 v1 `session.status {type:"idle"}` 伴随事件，交由现成 normalizer→合成 idle 全套去重管道；shutdown 中断保留 claim 不发 idle。附带修复：`dispatchSyntheticIdle` 补上真实 idle 分支已有的 monitor flush（此前凡只经 status 信号空闲的宿主——含本桥——monitor 永不触发）。

**四轮终局（2026-10-05）**：全部场景 PASS。四轮双验证点：monitor_list 成功路径 `status: completed` + content 携带真实输出文本（无 output 键）；monitor_start 非白名单拒绝文本 `[ERROR] monitor_start denied: command not in allowed_commands` 双向存活（模型逐字引用），fail-closed 不变（零 monitor、零子进程）。**三轮"宿主 Code Mode 全工具空渲染"结论已撤回**——同宿主四轮渲染完全正常，根因是 OMO 旧 execute.after 无条件回写把宿主所有工具的 result 改写为 `{output:"",metadata}`（含 core 工具与探针），`c988d0ab3` 修复后消失；sscity-v2 宿主无此 bug，无需移交 opencode-v2 线。

---

## 4. 路线建议（调研问题 4）

### (a) 维持并补齐 v2-host-adapter —— **推荐主路线（短期）**

- **利**：全链路（OpenChamber → fork opencode 2.0.21-sscity → OMO agents）已通；改动局部（748 行适配器 + 入口探测）；与上游已认可的社区桥法同构，上游 dual-host 落地后可整体替换；不受上游 5.1.x 二进制转向影响。
- **弊**：跟随 V2 host API 演进维护 shim（目前 v2.0.21→v2.0.22 插件面变化极小，风险低）；"翻译式"路线的剩余硬缺口（`command.execute.before` 通用拦截）无宿主钩子可用——评估确认 v2 command editor add-only、无 pre-execute 事件；`chat.message` 已非缺口（经 `session.hook("prompt")` 桥接，2026-10-05）。
- **工作量粗估**（2026-10-05 更新）：
  - ~~补事件映射 `message.updated` / `message.removed` / `session.error`~~（✅ `060fdb991`，2026-10-05）；
  - ~~`permission.ask`~~（✅ `b23dac4c5` 结构性处置：删静默放行 stub，落回 allowlist fail-closed，2026-10-05）；
  - ~~`chat.message` variant 门评估~~（✅ 评估推翻"宿主无钩子"预设：`session.hook("prompt")` DeepMutable，已实现桥接，2026-10-05）；
  - `command.execute.before`：评估完成（无拦截钩子，add-only）；如需保真，按"自有注册"路径移植 `goal`/`stop-continuation`/`ulw-execute` 三命令（~1 天）；否则维持已知限制。

### (b) 把 sscity 定制移植到上游 5.1.x 二进制架构（OmO Native）—— **不推荐（对本产品语境）**

- 实质是**放弃 OpenCode 集成**：OmO Native 是独立引擎，18 agents 要重写成 senpi extension/skills；OpenChamber 无法呈现/编排其会话；sscity 的 multi-instance 目录权威等定制与其无关。
- 只有当把 OMO 当**独立 CLI 工具**与 OpenChamber 并行使用时才成立。工作量以「周到月」计且脱离主线，不建议投入。

### (b') 跟随上游 dual-host（V1+V2 双导出）—— **推荐中期路线（(a) 的终点）**

- 上游已拍板方向（#9389 + PR #9391 分片计划）。落地后 fork 的动作是：rebase 上游 `packages/omo-opencode/src/v2/`，把 sscity agents/特性保留在核心层，`v2-host-adapter.ts` 退役为纯 V1 fallback 或直接删除。
- 风险：**无时间表**（"no firm date yet"，至今 0 行 V2 代码合入 dev）。观察点：#9391 是否合入、后续子系统分片节奏、#6169 更新。

### (c) 原地等上游原生支持 2.0.21 契约 —— **不能作为主路线**

- 有方向、无日程、零合入。作为 (a) 的终点预期合理，作为现状的应对则把产品绑在一个不受自己控制的开放 PR 上。

### 决策触发点

1. PR #9391 合入 dev（scaffold）→ 开始评估 (b')；
2. 上游发布含 "OpenCode v2 support" 的 release note / #6169 宣布可用 → 执行 (b')；
3. 出现 `v2.1` tag 或 `@opencode/plugin` 2.1 → 复查适配层兼容性；
4. (a) 路线累计维护成本超过一次 (b') 迁移成本时 → 提前切 (b')。

---

## 5. 信息源清单（调研问题 5）

**sst/opencode（本地 git：`/Users/song/dev_ai/opencode-v2`，remote `upstream` = github.com/sst/opencode）**

- `upstream/dev` @ `907b3bc518`（2026-10-02）：根 package.json 1.18.34；`packages/core/src/plugin.ts`（PluginV2 Effect 宿主）；release 列表 latest v1.18.34
- `v2.0.21` = `8a8bd622a3`（2026-09-30）：`packages/core/src/plugin/module.ts:50-66`（Module Schema）、`packages/plugin/src/promise/adapter.ts`（PromiseContext）、`packages/plugin/package.json`（name `@opencode/plugin`）
- `v2.0.22` = `527f0b931d`（2026-10-02）与 `2.0` 分支（HEAD `7a6ce05d09`）
- npm（2026-10-04 实查）：`@opencode-ai/plugin` latest 1.18.34；`@opencode/plugin` latest 2.0.22；`@opencode/client` 2.0.22
- 官方迁移指南：https://opencode.ai/v2/docs/migrate-v1 （"V1 plugin implementations do not run in V2"）

**code-yeongyu/oh-my-openagent（本地 git remote `code-yeongyu`）**

- `v5.1.16` tag（2026-10-04）：`packages/omo-opencode/package.json`（@opencode-ai/plugin 1.18.31）、`src/index.ts`（`omoPlugin = pluginModule.server`）、`src/agents/`（sisyphus/prometheus/atlas/metis/momus/hephaestus/oracle/librarian/explore）、`bin/oh-my-opencode.js`（平台二进制 launcher）、`CHANGELOG.md`（5.0.0 "OpenCode v2" 节 + degraded support）、`docs/guide/migrating-from-opencode.md`
- `code-yeongyu/dev`：`ROADMAP.md`（Why Not OpenCode-Native）；`packages/omo-opencode/src/v2` 不存在
- Issues/PRs：#6169、#8485、#9389（fazulfi port + 维护者 dual-host 拍板 + herjarsa v2-bridge）、PR #9391；#7847 #8295 #9094 #9107 #9241 #9530 #8626 #8297 #9016
- Releases：https://github.com/code-yeongyu/oh-my-openagent/releases （v5.0.0 起转向声明）

**本 fork**

- `83777cde5` "fix(host): add OpenCode v2 plugin contract adapter"（2026-10-04）
- `packages/omo-opencode/src/shared/v2-host-adapter.ts`（748 行；跳过钩子清单 :730）

---

## 附：方法与局限

- 基于 2026-10-04 的 tag/分支快照与 npm dist-tags；社区进展（尤其 #9391）变化快，引用前建议复核。
- 未覆盖：Discord/邮件列表讨论、sst/opencode 的 2.x 发布分支归属（v2.0.x tag 不在 `dev` 与 `2.0` 分支的本地可见祖先里，发布流程分支未定位——不影响本文结论）、fazulfi/omo-v2 与 herjarsa fork 的逐文件审读（结论取自其 issue 自述与维护者回应）。
