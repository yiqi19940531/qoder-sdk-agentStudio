# 03 · SDK 运行时、多轮会话与权限

## 目标与交付结果

Agent 用接收者当前登录的 Qoder 账号执行真实任务；运行台显示流式文本、工具调用、子任务、审批、用量和错误。任务完成后可以追问，页面刷新后恢复记录，服务重启后下一轮尝试恢复 SDK 会话。

## 前置模块

完成 [02 基础工程](02-foundation-and-agents.md)：`AgentConfig`、文件存储、两个示例 Agent、示例仓库和基本 API 可用。

## 技术栈规划

锁定 `@qoder-ai/qoder-agent-sdk@1.0.50`。Node 后端使用 SDK 的 `query`、异步输入和消息迭代实现会话；Express SSE 把事件送到 React；本地 JSON 存储可重放的会话状态。模型发现来自当前 Qoder 账号，不在 Web 项目保存 Token Plan 的凭据。

## 相关模块文件架构

| 层 | 文件与技术 | 职责 |
| --- | --- | --- |
| SDK 适配 | `server/runtime.ts`；Qoder SDK `query`、`qodercliAuth` | 发现模型／Skill，构造主 Agent、子 Agent 与 MCP 配置 |
| 会话引擎 | `server/conversations.ts`；AsyncIterable、SSE、本地 JSON | 持续输入、SDK 消息归一化、轮次／事件持久化与恢复 |
| 决策 | `server/agent-policy.ts`、`server/permissions.ts` | 调用者识别、路径范围、会话与全局工具授权 |
| 共享契约 | `shared/types.ts`、`shared/model-selection.ts` | 会话状态、事件、待决交互与模型回退 |
| API/UI | `server/index.ts`、`src/main.tsx` | 创建、追问、订阅、决策、中断及运行台显示 |
| 存储 | `data/conversations/<id>.json`、`data/permission-settings.json` | 每会话快照与可恢复事件、全局允许列表 |

`Conversation` 包含 `id/sdkSessionId`、状态、`config`、`turns`、`messages`、`events`、`pending` 与递增事件 ID。会话状态 `idle/running/waiting/interrupted` 和轮次状态 `running/done/error/interrupted` 不应混用；前者控制能否追问，后者说明上一轮结果。

## 需求契约

| ID | 必须成立的行为 | 失败／边界 |
| --- | --- | --- |
| RUN-01 | 模型列表来自当前登录账号；不可用的保存模型仅在新会话回退到内置 `auto` | 无可用 `auto` 时明确失败，不能悄悄改 `agents.json` |
| RUN-02 | 新会话固定主／子 Agent、规则、MCP 工具和实际模型 | 运行中修改装配不得影响旧会话 |
| RUN-03 | 一次 SDK 查询支持多轮输入，流式事件可按 ID 续订 | 同一会话一次只运行一轮；重复提交返回冲突 |
| RUN-04 | 工具审批与 Agent 结构化提问可在原轮次继续 | 关闭弹窗保持等待；只有明确拒绝记“用户拒绝” |
| RUN-05 | 服务重启把遗留执行轮次标为中断；下轮按 SDK 会话 ID 尝试恢复 | 旧待决请求不可复用 |
| RUN-06 | 规则和记忆按 Agent 隔离，写入结果按真实 SDK 状态报告 | `skipped` 不算成功写入 |

## 数据与调用链

1. `server/runtime.ts` 使用 SDK 发现账号模型、插件 Skill 与 MCP 能力，并将 Agent 配置映射为主查询和子 Agent 定义。`shared/model-selection.ts` 在新建会话时解析模型：不可用的已保存模型临时回退到可用的 Qoder `auto`，记录实际选择，不改保存值。
2. `POST /api/conversations` 调用 `server/conversations.ts` 创建会话，固定主／子 Agent、规则和 MCP 工具清单；会话、轮次、消息、事件写入 `data/conversations/`。
3. 后端以异步用户输入流调用 SDK `query()`。SDK 消息经 `digest` 整理成可持久化事件；`GET /api/conversations/:id/events` 用 SSE 发送增量，断线后按事件 ID 补发。
4. `POST /api/conversations/:id/messages` 只在上一轮不再执行时接受追问；`POST /api/conversations/:id/interrupt` 中断当前轮。服务重启发现运行／等待中的轮次时，标记中断、清除旧待决请求；下一条消息使用保存的 SDK 会话 ID 尝试 `resume`。
5. SDK `canUseTool` 进入决策流程：按 Agent 默认设置、全局工具、会话工具或同类操作授权判断；否则生成审批交互。`AskUserQuestion` 使用结构化问答交互。`POST /api/conversations/:id/interactions/:interactionId` 提交决定。只有用户明确拒绝才记为“用户拒绝”；关闭弹窗保持等待。

## 关键文件和接口

`server/conversations.ts` 负责持久会话与 SSE；`server/runtime.ts` 负责 SDK 配置和旧版一次性运行兼容；`server/agent-policy.ts` 判断调用者、工具与路径授权；`server/permissions.ts` 管理全局允许列表和操作类别；`shared/types.ts` 定义会话与事件；`server/index.ts` 验证 HTTP 输入与状态码。

主 Agent 的 `systemPrompt` 追加独立人格和规则；子 Agent 的 `prompt` 追加其人格、规则及显式记忆。主 Agent 的 SDK 自定义记忆根目录指向自己的 `INDEX.md`，加载与写入结果以事件呈现。`settingSources: []` 避免示例仓库的共享规则影响每个 Agent 的专属规则。

## 架构约束

- 创建会话时快照装配与规则；编辑 Agent 不改变旧会话。SSE 事件要有稳定 ID 和轮次 ID，刷新后能重建界面。
- 工具“可见”和“自动允许”分开。全局授权不自动为 Agent 装配工具；目录审批不被普通工具授权绕过。外部命令仍受本机用户权限影响。
- 用户提问始终需要用户回答；危险浏览器任意代码工具保持禁用。等待状态不设置会伪装成“用户拒绝”的自动超时。
- 自动记忆写入必须记录真实结果；`skipped`、`failed`、`no_change` 不算已保存。
- 无可用内置 `auto` 时明确失败。模型回退在会话配置和事件里可见。

## 实现步骤（Spec Coding Tasks）

1. **RUN-T1 · 模型发现与解析**：SDK 查询可用模型，补齐 `/api/models`；新会话调用 `resolveAvailableModels`，为主 Agent 和所有已挂子 Agent 返回“请求模型→实际模型”映射，先写无自定义模型测试。
2. **RUN-T2 · SDK 定义**：在 `server/runtime.ts` 生成工具名、子 Agent 定义和插件路径；验证 `tools` 与 `allowedTools` 分离、`Skill` 可见、`maxTurns` 真传入 SDK。安全读取类工具按代码中的内置白名单预授权，写入和网页导航等按策略审批。
3. **RUN-T3 · 会话快照**：创建会话时读 Agent、专属规则和 MCP 工具清单，持久化 `config` 和首轮消息，然后才启动 `query()`；单个会话的 JSON 写入串行化，避免事件顺序倒退。
4. **RUN-T4 · 流和事件**：实现异步输入队列、`query()` 结果迭代、文本增量、工具调用／结果、子任务、用量、模型、记忆结果归一化；SSE 按 `Last-Event-ID` 或 `after` 补发。
5. **RUN-T5 · 交互决策**：`canUseTool` 先判断危险工具与目录范围，再判断 Agent、全局和本会话授权；生成审批或结构化问题；提交决策后回到同一 SDK 轮次。超时／中断要与主动拒绝区分。
6. **RUN-T6 · 恢复与页面**：实现追问、中断、服务重启中断标记和下一轮 `resume`；运行台展示消息、事件、待决弹窗和保存的会话。
7. **RUN-T7 · 专属规则和记忆**：主 Agent 使用自己的 `systemPrompt` 与自定义记忆根，子 Agent 使用各自 `prompt` 和显式记忆文本；关闭示例仓库共享规则自动加载，记录记忆加载／生成状态。

每个任务的最小可运行点依次是：模型测试 → 一轮只读 SDK 回复 → 第二轮追问 → 审批继续 → 重启恢复 → 主子 Agent 记忆隔离。最后再运行完整流程。

## 可直接复制的构建提示词

> 在已完成阶段 1 的工程中接入真实 Qoder Agent SDK。保持 Agent 文件格式和已有 API。实现账号模型发现、主 Agent 与一层子 Agent 的 SDK 参数映射、Skill／MCP 工具名装配、maxTurns 传递和不可用模型到内置 auto 的新会话回退。新增持久多轮会话：创建、追问、详情、SSE 事件、交互决策、中断；每轮结束保留会话，服务重启将未完成轮次标为中断，再次追问时用保存 ID 恢复。会话创建时快照 Agent、子 Agent 和规则。把审批、结构化提问、会话／全局工具授权和本地目录授权分开；默认逐次审批、仅工作目录，关闭弹窗不作拒绝。每个 Agent 的规则和显式记忆必须隔离，自动写入仅报告 SDK 实际结果。添加模型回退及多轮流程测试，用当前账号完成一次只读仓库查询和一次子 Agent 委派；说明真实调用与模拟调用的区别。

## 验收方法

运行 `npm run test:models`、`npm run typecheck`、`npm run build`。用当前账号选择仓库协调 Agent 读取示例文件并委派代码审查；核对实际模型、`maxTurns`、子 Agent 工具调用与 SSE 事件。连续提问两轮，刷新后仍见消息；在审批处“稍后处理”仍等待，明确拒绝才产生拒绝事件。服务在等待时重启应显示“已中断”，不保留失效弹窗。测试模型回退时确认原保存配置没有被改写。

## 实现后的校验逻辑

| 对应需求 | 输入与操作 | 必须看到的证据 |
| --- | --- | --- |
| RUN-01 | 模拟仅有内置模型的列表，保存 Agent 指向不存在的自定义 ID | 新会话用 `auto`；`config.modelFallbacks` 与 diagnostic 说明回退，`agents.json` 不变 |
| RUN-02 | 创建会话后改子 Agent 模型和规则 | 旧会话详情仍是原快照，新会话使用新值 |
| RUN-03 | 发送两轮消息并断开／重连 SSE | 两轮 ID 不同，事件 ID 递增、已收事件不重复丢失 |
| RUN-04 | 请求写文件、选择“稍后处理”再允许一次；另试明确拒绝 | 前者保持等待后继续；后者才出现用户拒绝文案 |
| RUN-05 | 在运行／审批中停服务并重启 | 旧轮标中断、无可点的失效请求；新追问可执行或明确报告 SDK 恢复失败 |
| RUN-06 | 在两个 Agent 的记忆中写不同标记并各自新建会话 | 加载和回答不串用；自动生成状态按 SDK 原值显示 |

真实 SDK 验证应单列账号、模型和日期；`test:models` 只证明回退算法，不证明该账号当下能调用模型。
