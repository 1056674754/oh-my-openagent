# 主编排工作模型 — 设计实现方案

**日期:** 2026-08-27 | **状态:** 设计定稿，P0 待实施
**关联:** v5.0.0-beta.21 合并（6807369a0）；回调投递 E2E 证据（`local-ignore/qa-evidence/20260827-parent-wake-beta21/`）

## 0. TL;DR

目标模型：**编排代理是主力工程师**——做核心工作、积累最深上下文、工作时间最长；**子代理是跑腿**——只做不需要父上下文的轻量琐事（搜索、查文档、跑测试），**只把摘要交回父会话**，中间过程留在子会话里。

对照现状，唯一剩余的硬缺口是 **P0：`background_output` 默认返回是全文倾倒**。回调投递已被 beta.21 修复（已验证），上下文继承是 P2（结构性，需谨慎）。建议只做 P0 + 保持 P1 现状，P2 等真实痛感再动。

## 1. 模型定义

| 原则 | 机制含义 | 反面模式 |
|---|---|---|
| 编排做核心工作 | 文件读写、架构决策、实现、调试都在父会话 | 纯管理者编排，把核心实现也委派出去 |
| 子代理只做琐事 | 委派的只有：代码搜索、外部文档查询、测试执行等**自包含**任务 | 把"理解 X 然后设计 Y"整体甩给子代理 |
| 摘要式返回 | 父会话只收 deliverable（结论/位置/数据），不收中间过程 | 子会话的 grep 输出、读文件内容流进父上下文 |
| 反重复 | 委派了就不再自己再做一遍 | 编排委派 explore 后自己又 grep 同样的东西 |

关键洞察：**该模型天然消解"上下文传不出去"问题**——子代理任务自包含，不需要父上下文；父上下文的流失被"编排自己干活"保住。因此上下文继承（Codex `fork_turns` 类机制）优先级必须低于返回摘要。

## 2. 已验证的现状（post-beta.21 代码事实）

### 2.1 回调投递 ✅ 已修复，无需 fork 侧工作

beta.6→beta.21 重写了 `parent-wake-*` 家族（pending queue + dispatched tracker + window recovery + admit-only deposits + 60s 忙态强制上限）。E2E 实测（2026-08-27）：

- 父空闲：3 启动 / 3 通知 / 3 次 `background_output` 回收 — PASS
- 父忙（3 读文件 + 600 字综合）：忙窗内 42 次 defer（1/s 守门，不打断回合），回合结束送达并消费 — PASS

旧版 4.19.3 的 0/3 丢失即此问题的表现，随升级消失。

### 2.2 返回内容膨胀 ❌ P0 目标

`packages/omo-opencode/src/tools/background-task/task-result-format.ts`（默认路径）：

```
relevantMessages = 所有 assistant + tool 消息
extractedContent += text parts        ← 正文（合理）
extractedContent += reasoning parts   ← 思维链（不该进父上下文）
extractedContent += tool_result 内容  ← grep/read 原始输出（最大膨胀源）
return 全文拼接，无截断、无摘要
```

一个 explore 子代理跑 20 次 grep/read，其全部工具输出原样进入父会话——父上下文被子的过程日志烧掉，与"摘要式返回"直接矛盾。

已有的逃生口：`full_session=true` + `include_thinking` + `include_tool_results` 三个 flag——但**只作用于 full-session 分支**，默认路径零控制。

### 2.3 sync 路径已是摘要式 ✅ 参考实现

`delegate-task/sync-result-fetcher.ts` 的 `fetchSyncResult`：只取 final text parts（显式排除 reasoning），支持 envelope tag（如 `<plan>...</plan>`）确定性选择 deliverable，recency 兜底。P0 应把同语义带给后台路径。

### 2.4 上下文传递（结构性，P2）

`task()` 仍只传 raw prompt（本 fork 早期调研确认，beta.21 未变）。Codex 的 `fork_turns: none|N|all` + 任务边界标记是成熟参考，但按 §1 的洞察，该模型下子任务自包含、需求弱。

### 2.5 反重复（P1，prompt 层已在位）

上游 PR #2448（反重复规则）、#4609（plan 委派时拦主会话研究）**均未合并**，beta.21 不含。但 fork 的 Sisyphus agent prompt 已带 Anti-Duplication 纪律段（"委派后不得自己重复搜索"），prompt 层防线已在。

## 3. P0 — `background_output` 默认摘要式返回

**目标:** 默认返回 = deliverable 摘要；全文成为显式选择。

**改动点（单一文件为主）:** `task-result-format.ts` 的 `formatTaskResult`

1. **deliverable 选择**：取新消息中**最后一条**含非空 text parts 的 assistant 消息（recency 兜底，与 `fetchSyncResult` 一致）；排除 reasoning parts；**排除全部 tool_result 内容**。
2. **截断上限**：deliverable 超 8000 chars 时中间截断（保留头尾），尾注 `"[truncated — call again with full_session=true for complete output]"`。
3. **过程可见性提示**：摘要尾部附一行统计：`(summary of final message; N tool calls, M messages omitted — use full_session=true for details)`。让编排知道有细节可挖，而不是以为没有。
4. **cursor 语义不变**：`consumeNewMessages` 仍消费全部新消息（重复调用不会重放过程日志）。
5. **头部元数据保留**：Task ID / Description / Duration / Session ID 块照旧。
6. **空 deliverable 处理**：最后一条 assistant 无文本（如工具失败中断）时，回退最后两条中任一非空文本；再无则报 `(No final assistant text — use full_session=true)`，不再倾倒过程。

**兼容性:**
- `full_session=true` 路径零改动 → 需要全文的调用方有现成出口。
- 多轮 continuation 后台任务：deliverable=最后一条 assistant 文本，恰为最终结论。
- 风险点：依赖"从 background_output 里读工具输出细节"的既有工作流。缓解：统计提示行 + full_session 出口；上线后观察一轮再考虑收紧截断上限。

**测试计划:** 更新 `task-result-format` 相关测试（tool_result 不进默认输出、reasoning 不进、截断标记、空 deliverable 回退）；新增 E2E 断言沿用 `20260827-parent-wake-beta21` 方法（默认调用返回无 grep 输出原文）。

## 4. P1 — 轻任务通道与反重复（观察即可，暂不动代码）

- **轻任务已够轻**: explore/librarian 本就是受限工具集的子会话；P0 落地后其返回也变摘要——"航母钓鱼"问题主要剩 skill content 注入，量级小。
- **反重复靠 prompt 纪律**: fork agent prompt 的 Anti-Duplication 段保留即可；若日后观察到编排仍重复劳动，再评估上游 #2448/#4609 的移植。

## 5. P2 — 选择性上下文继承（有真实痛感再做）

`task()` 增加可选 `context_preset: "none"(默认) | "recent"`：

- `recent`: 注入父会话最近 N 轮的**摘要**（非原文）到子 prompt 前缀，复用 `buildTaskPrompt`。
- 必须带机器生成的任务边界标记（Codex #24150 教训——无边界标记的全量继承会导致子代理接管父任务、递归委派）：
  ```
  <parent_context>Reference only. Do not continue parent orchestration.</parent_context>
  <delegated_task>This is your active task.</delegated_task>
  ```
- 触发条件：真实使用中频繁出现"子代理因缺父上下文做无用功"且 prompt 层写不清时。

## 6. 实施顺序

1. **P0**（半天）：formatTaskResult 摘要化 + 测试 + E2E 证据 → 提交 fork 分支
2. **观察期**：日常使用 OMO，记录父上下文膨胀与子代理无用功的实际频率
3. **P1/P2 按痛感触发**，不预先建设
