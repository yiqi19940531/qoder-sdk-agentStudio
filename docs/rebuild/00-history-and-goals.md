# 00 · 需求演进与真实边界

## 资料来源

本章根据本工程可访问的相关历史任务、当前源码、原工程 `EXPLORATION.md`／`TEST_RESULTS.md` 和公开版 `VALIDATION.md` 整理。历史任务只用于确认需求出现的顺序和当时的问题；以下是**归纳**，不引用私人对话、登录页面、凭据或私人文件路径。后续各章的“复建提示词”是重写后的工程指令。

## 复建需求基线

| ID | 目标 | 最终可观察结果 |
| --- | --- | --- |
| GOAL-01 | 本地装配多个主 Agent 和一层子 Agent | 保存后重启仍能看到各自模型、工具、Skill、MCP、人格、规则和记忆 |
| GOAL-02 | 用 Qoder SDK 真正执行任务 | 可看到模型输出、工具调用、子 Agent 委派、审批和多轮追问 |
| GOAL-03 | 让能力可管理、可追溯 | MCP 与 Skill 有独立管理页；会话、事件、流程图和媒体可回看 |
| GOAL-04 | 形成可分享的安全演示 | 新用户只用自己的 Qoder 账号即可体验核心功能，历史存档可读但不可续接 |

这些目标限定在**本地单用户原型**。团队登录、RBAC、远程运行代理、数据库和自动跨设备同步不属于本次复建 spec；如另建产品，需要重新设计身份、隔离和审计。

| 阶段 | 当时要解决的问题 | 当前落点与证据 |
| --- | --- | --- |
| SDK 可行性 | 能否用 Qoder SDK 做 Agent、Sub-Agent、Skill、MCP、人格和记忆的 Web 装配页 | `server/runtime.ts`、`server/storage.ts`、`src/main.tsx`；`EXPLORATION.md` 记录了真实 SDK 查询 |
| 真实装配 | 静态配置是否能被 SDK 发现并真正调用，能否选择账号自定义模型 | `data/agents.json`、`plugins/workbench/`、`server/runtime.ts`；模型从当前账号发现 |
| 网页探索 | Agent 缺浏览器工具，需 Playwright 与 Chrome DevTools | `server/runtime.ts` 的内置 MCP 配置；`server/mcp-check.ts` 的连接检查 |
| 运行台 | 一次性任务无法追问，审批超时被误判为用户拒绝 | `server/conversations.ts` 持续输入、SSE、交互决策和恢复；`src/main.tsx` 展示 |
| 权限与隔离 | 工具弹窗过多、不同 Agent 的规则／记忆互相影响 | `server/permissions.ts`、`server/agent-policy.ts`；`data/profiles/<Agent ID>/` 各自保存文件 |
| AIGC | 主 Agent 按图片或视频需求委派不同子 Agent | `server/aigc.ts`、两个百炼 Skill、媒体元数据和测试 |
| 可视化与配置中心 | 需要动态委派流程图、独立 MCP 和 Skill 管理界面 | `shared/agent-flow.ts`、`src/AgentFlow.tsx`、`src/McpManager.tsx`、`src/SkillManager.tsx` |
| 对外演示 | 接收者应看到历史效果，却不能拿到原作者凭据 | `scripts/package-public.mjs`、`scripts/quickstart.mjs`、演示存档和公开 README |

## 最初设想与当前形态

最初只是验证“Web 页面装配 Agent”是否可行。当前实现为本地 Express 服务监听 `127.0.0.1`，React 页面通过 HTTP/SSE 访问它；SDK 在 Node 进程中调用本机 Qoder 运行时。Agent 的配置、提示词、规则、记忆、会话、Skill 与 MCP 定义分开保存。用户创建会话时，装配配置被快照化；后续改配置只影响新会话。

推荐复建顺序与上表时间顺序略有不同：先实现公共数据契约和运行时，再扩展 MCP/Skill/AIGC，最后做可视化和发布。这样每阶段均有可运行的中间成果。

## 关键架构决策及其原因

| 决策 | 为什么这样做 | 对复建步骤的约束 |
| --- | --- | --- |
| Web UI + 本地 Node 执行 | 浏览器适合装配和回看；Qoder 工具需要在本机运行 | 不让前端直接调用 SDK 或读取本机私有文件 |
| 文件型配置与会话 | 原型需要可检查、可携带的演示数据 | 先定义磁盘契约和原子写入，再接页面 |
| Agent 人格／规则／记忆分离 | 历史实现曾出现不同 Agent 共享规则或记忆的问题 | 每个 Agent 独立目录，会话创建时固定规则 |
| 保存与运行分离 | 编辑配置不应回头改变旧会话 | 新会话快照，旧会话按已保存事件重放 |
| MCP／Skill 独立管理 | 多 Agent 共享定义，但装配关系不同 | 先注册／校验，再由 Agent 选择，装配不自动执行 |
| 发布包采用白名单 | 原工程含私人凭据和历史本机路径 | 公开数据必须脱敏、双重扫描、再从干净目录验证 |

## 不要误写成“已实现”的能力

- 显式的 Agent 记忆文件可读、可编辑、可隔离；SDK 自动生成并跨会话写入长期记忆，原工程实验并未稳定证明成功。
- 被委派子 Agent 的专属记忆会载入提示词；不能据此声称 SDK 会自动写回其独立记忆目录。
- 本工程已验证单用户本地运行；没有团队账户、RBAC、服务端工作区隔离和操作系统级沙箱。
- 浏览器 MCP 的连接与基本工具可用；网页的实际结果受目标网站、网络和页面变化影响。
- Skill 格式与 SDK 发现校验，不等于其中脚本安全或运行正确。
- Apify 和百炼属于接收者自行配置的可选能力。演示媒体可查看，不代表新机器无需凭据也能调用这些服务。
- 公开版历史是只读演示存档。历史页新提问会创建接收者账号下的新会话，旧 SDK 上下文不会自动继承。

## 复建完成标准

核心路径是：配置一个主 Agent 和子 Agent → 使用当前 Qoder 账号创建会话 → 流式展示回答、工具和委派事件 → 必要时让用户审批 → 保存并继续对话。完整演示路径再加上浏览器 MCP、Skill 管理、可选媒体任务、动态流程图和安全公开包。各阶段的具体验收见 [10-verification.md](10-verification.md)。
