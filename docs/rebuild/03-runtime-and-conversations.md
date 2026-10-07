# 03 · SDK 运行时、多轮会话与权限

## 要实现的效果

Agent 用接收者当前登录的 Qoder 账号执行真实任务；运行台显示流式文本、工具调用、子任务、审批、用量和错误。任务完成后可以追问，页面刷新后恢复记录，服务重启后下一轮尝试恢复 SDK 会话。

## 前置模块

完成 [02 基础工程](02-foundation-and-agents.md)：`AgentConfig`、文件存储、两个示例 Agent、示例仓库和基本 API 可用。

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

## 可直接复制的复建提示词

> 在已完成阶段 1 的工程中接入真实 Qoder Agent SDK。保持 Agent 文件格式和已有 API。实现账号模型发现、主 Agent 与一层子 Agent 的 SDK 参数映射、Skill／MCP 工具名装配、maxTurns 传递和不可用模型到内置 auto 的新会话回退。新增持久多轮会话：创建、追问、详情、SSE 事件、交互决策、中断；每轮结束保留会话，服务重启将未完成轮次标为中断，再次追问时用保存 ID 恢复。会话创建时快照 Agent、子 Agent 和规则。把审批、结构化提问、会话／全局工具授权和本地目录授权分开；默认逐次审批、仅工作目录，关闭弹窗不作拒绝。每个 Agent 的规则和显式记忆必须隔离，自动写入仅报告 SDK 实际结果。添加模型回退及多轮流程测试，用当前账号完成一次只读仓库查询和一次子 Agent 委派；说明真实调用与模拟调用的区别。

## 验收方法

运行 `npm run test:models`、`npm run typecheck`、`npm run build`。用当前账号选择仓库协调 Agent 读取示例文件并委派代码审查；核对实际模型、`maxTurns`、子 Agent 工具调用与 SSE 事件。连续提问两轮，刷新后仍见消息；在审批处“稍后处理”仍等待，明确拒绝才产生拒绝事件。服务在等待时重启应显示“已中断”，不保留失效弹窗。测试模型回退时确认原保存配置没有被改写。
